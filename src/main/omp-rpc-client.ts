import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import type { OmpInstallation, RpcFrame, RuntimeDescriptor, RuntimeState, StartRuntimeInput } from "../shared/contracts";
import {
  assertDistro,
  assertLogicalPath,
  installationDataDir,
  joinLogicalPath,
  ompArgumentsForInstallation,
} from "./security";
import { RpcFrameDecoder } from "./rpc-frame-decoder";

const STARTUP_TIMEOUT_MS = 15_000;
const GRACEFUL_STOP_TIMEOUT_MS = 2_000;
const SIGNAL_STOP_TIMEOUT_MS = 1_500;
const WSL_HELPER_TIMEOUT_MS = 5_000;
const NATIVE_HELPER_TIMEOUT_MS = 5_000;
const WSL_PROCESS_GROUP_MARKER = "OMP_DESKTOP_PROCESS_GROUP";

// Every value controlled by the caller is passed after the shell program as a
// positional argument. Keep this script constant: interpolating paths here
// would turn an otherwise safe spawn into shell injection.
const WSL_LAUNCH_SCRIPT = `
pid_file=$1
shift
/usr/bin/setsid --fork --wait /bin/sh -c '
  pid_file=$1
  shift
  umask 077
  printf "%s\\n" "$$" > "$pid_file"
  printf "\\036${WSL_PROCESS_GROUP_MARKER}=%s\\037\\n" "$$" >&2
  exec "$@"
' omp-desktop-process "$pid_file" "$@"
status=$?
/bin/rm -f -- "$pid_file"
exit "$status"
`;

const WSL_SIGNAL_SCRIPT = `
signal=$1
process_group=$2
pid_file=$3
if [ -z "$process_group" ] && [ -r "$pid_file" ]; then
  IFS= read -r process_group < "$pid_file"
fi
case "$signal" in TERM|KILL) ;; *) exit 2 ;; esac
case "$process_group" in ''|*[!0-9]*) exit 2 ;; esac
[ "$process_group" -gt 1 ] || exit 2
/bin/kill "-$signal" -- "-$process_group" 2>/dev/null || true
`;

const WSL_CLEANUP_SCRIPT = `
pid_file=$1
/bin/rm -f -- "$pid_file"
`;

interface OmpRpcClientEvents {
  frame: [RpcFrame];
  status: [RuntimeDescriptor];
  exit: [number | null, NodeJS.Signals | null];
}

interface ValidatedRuntimeFrame {
  frame: RpcFrame;
  sessionFile?: string;
}

function assertRuntimeSessionFile(installation: OmpInstallation, rawSessionFile: unknown): string | undefined {
  if (rawSessionFile === undefined || rawSessionFile === null) return undefined;
  if (typeof rawSessionFile !== "string") {
    throw new Error("OMP runtime reported a non-string session path");
  }

  const sessionFile = assertLogicalPath(installation, rawSessionFile, "OMP runtime session path");
  const sessionsRoot = joinLogicalPath(installation, installationDataDir(installation), "sessions");
  const pathApi = installation.kind === "windows-native" ? path.win32 : path.posix;
  const comparableRoot = installation.kind === "windows-native" ? sessionsRoot.toLowerCase() : sessionsRoot;
  const comparableSession = installation.kind === "windows-native" ? sessionFile.toLowerCase() : sessionFile;
  const relative = pathApi.relative(comparableRoot, comparableSession);
  if (
    !relative
    || relative === ".."
    || relative.startsWith(`..${pathApi.sep}`)
    || pathApi.isAbsolute(relative)
  ) {
    throw new Error("OMP runtime reported a session path outside its trusted data directory");
  }
  return sessionFile;
}

function validateRuntimeFrame(installation: OmpInstallation, frame: RpcFrame): ValidatedRuntimeFrame {
  if (frame.type === "session_info_update") {
    const sessionFile = assertRuntimeSessionFile(installation, frame.sessionFile);
    return {
      frame: sessionFile !== undefined && sessionFile !== frame.sessionFile
        ? { ...frame, sessionFile }
        : frame,
      sessionFile,
    };
  }

  if (frame.type === "response" && frame.command === "get_state") {
    const data = frame.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return { frame };
    const rawSessionFile = (data as Record<string, unknown>).sessionFile;
    const sessionFile = assertRuntimeSessionFile(installation, rawSessionFile);
    return {
      frame: sessionFile !== undefined && sessionFile !== rawSessionFile
        ? { ...frame, data: { ...data, sessionFile } }
        : frame,
      sessionFile,
    };
  }

  return { frame };
}

export class OmpRpcClient extends EventEmitter<OmpRpcClientEvents> {
  readonly descriptor: RuntimeDescriptor;
  readonly #installation: OmpInstallation;
  readonly #input: StartRuntimeInput;
  readonly #decoder = new RpcFrameDecoder();
  #process?: ChildProcessWithoutNullStreams;
  #stderr = "";
  #stderrBuffer = "";
  #ready = false;
  #stopping = false;
  #wslPidFile?: string;
  #wslProcessGroup?: number;
  #wslCleanupPromise?: Promise<void>;
  #processGroupReady?: Promise<number>;
  #resolveProcessGroup?: (processGroup: number) => void;
  #rejectProcessGroup?: (error: Error) => void;
  #processGroupSettled = false;
  #shutdownVerificationError?: Error;
  #protocolFailed = false;

  constructor(runtimeId: string, installation: OmpInstallation, input: StartRuntimeInput) {
    super();
    this.#installation = installation;
    this.#input = input;
    if (input.installationId !== installation.id) {
      throw new Error("Runtime installation does not match the selected OMP installation");
    }
    const cwd = assertLogicalPath(installation, input.path, "workspace path");
    const sessionPath = input.sessionPath
      ? assertLogicalPath(installation, input.sessionPath, "session path")
      : undefined;
    this.descriptor = {
      runtimeId,
      state: "starting",
      sessionPath,
      cwd,
      installationId: installation.id,
      runtimeKind: installation.kind,
      profile: installation.profile,
      distro: installation.distro,
    };
  }

  get shutdownUnverified(): boolean {
    return this.#shutdownVerificationError !== undefined;
  }

  get installation(): OmpInstallation {
    return { ...this.#installation };
  }

  async start(): Promise<RuntimeDescriptor> {
    const cwd = this.descriptor.cwd;
    const executablePath = assertLogicalPath(this.#installation, this.#installation.executablePath, "OMP executable");
    const launchArgs = ["--mode", "rpc-ui", "--cwd", cwd];
    if (this.descriptor.sessionPath) {
      launchArgs.push("--resume", this.descriptor.sessionPath);
    }
    const ompArgs = ompArgumentsForInstallation(this.#installation, launchArgs);

    if (this.#installation.kind === "windows-native") {
      this.#process = spawn(executablePath, ompArgs, {
        cwd,
        env: { ...process.env, COLORTERM: "truecolor" },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else if (this.#installation.kind === "linux-direct" || this.#installation.kind === "macos-native") {
      this.#process = spawn(executablePath, ompArgs, {
        cwd,
        env: { ...process.env, COLORTERM: "truecolor" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      const distro = assertDistro(this.#installation.distro ?? "");
      this.#wslPidFile = `/tmp/omp-desktop-${this.descriptor.runtimeId}.pid`;
      this.#processGroupReady = new Promise<number>((resolve, reject) => {
        this.#resolveProcessGroup = resolve;
        this.#rejectProcessGroup = reject;
      });
      this.#process = spawn(
        "wsl.exe",
        [
          "-d",
          distro,
          "--cd",
          cwd,
          "--exec",
          "/bin/sh",
          "-c",
          WSL_LAUNCH_SCRIPT,
          "omp-desktop-supervisor",
          this.#wslPidFile,
          executablePath,
          ...ompArgs,
        ],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
    }
    this.descriptor.pid = this.#process.pid;
    this.#emitStatus("starting");
    this.#process.stdout.on("data", chunk => this.#handleStdout(chunk as Buffer));
    this.#process.stderr.on("data", chunk => this.#handleStderr(chunk as Buffer));
    this.#process.on("error", error => {
      this.descriptor.error = error.message;
      this.#rejectProcessGroupOnce(error);
      this.#emitStatus("failed");
    });
    this.#process.on("exit", (code, signal) => {
      this.#flushStderr();
      this.#rejectProcessGroupOnce(new Error(this.#stderr.trim() || "OMP exited before reporting its process group"));
      if (!this.#stopping && !this.descriptor.error && code && code !== 0) {
        this.descriptor.error = this.#stderr.trim() || `OMP exited with code ${code}`;
      }
      if (this.#shutdownVerificationError) {
        this.#shutdownVerificationError = undefined;
        this.descriptor.error = undefined;
        this.#emitStatus("exited");
      } else {
        this.#emitStatus(!this.#stopping && this.descriptor.error ? "failed" : "exited");
      }
      void this.#cleanupWslPidFile();
      this.emit("exit", code, signal);
    });

    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(this.#stderr.trim() || "OMP RPC startup timed out")), STARTUP_TIMEOUT_MS);
      const onFrame = (frame: RpcFrame): void => {
        if (frame.type !== "ready") return;
        clearTimeout(timeout);
        this.off("frame", onFrame);
        this.#process?.off("exit", onExit);
        resolve();
      };
      const onExit = (code: number | null): void => {
        clearTimeout(timeout);
        this.off("frame", onFrame);
        reject(new Error(this.#stderr.trim() || `OMP exited before RPC became ready${code === null ? "" : ` (code ${code})`}`));
      };
      this.on("frame", onFrame);
      this.#process?.once("error", error => {
        clearTimeout(timeout);
        this.off("frame", onFrame);
        this.#process?.off("exit", onExit);
        reject(error);
      });
      this.#process?.once("exit", onExit);
    });

    try {
      await Promise.all([ready, this.#waitForProcessGroup()]);
      if (this.#input.initialPrompt) {
        this.send({ id: crypto.randomUUID(), type: "prompt", message: this.#input.initialPrompt });
      }
      return { ...this.descriptor };
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  send(frame: RpcFrame): void {
    if (!this.#process || !this.#process.stdin.writable) throw new Error("OMP runtime is not writable");
    const payload = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(payload) > 1024 * 1024) throw new Error("RPC command exceeds the OMP frame limit");
    this.#process.stdin.write(payload);
  }

  async stop(): Promise<void> {
    if (this.#shutdownVerificationError) throw this.#shutdownVerificationError;
    const child = this.#process;
    if (!child) {
      await this.#cleanupWslPidFile();
      return;
    }
    if (this.descriptor.state === "exited") {
      await this.#cleanupWslPidFile();
      return;
    }
    this.#stopping = true;
    this.#emitStatus("aborting");
    try {
      this.send({ id: crypto.randomUUID(), type: "abort" });
    } catch {
      // The process may already have closed its input.
    }
    child.stdin.end();
    if (await this.#waitForExit(GRACEFUL_STOP_TIMEOUT_MS)) {
      await this.#cleanupWslPidFile();
      return;
    }

    if (this.#installation.kind === "linux-direct" || this.#installation.kind === "macos-native") {
      child.kill("SIGTERM");
      if (!(await this.#waitForExit(SIGNAL_STOP_TIMEOUT_MS))) {
        child.kill("SIGKILL");
        if (!(await this.#waitForExit(SIGNAL_STOP_TIMEOUT_MS))) {
          const error = new Error("OMP process did not exit after SIGTERM and SIGKILL");
          this.#shutdownVerificationError = error;
          this.descriptor.error = error.message;
          this.#emitStatus("failed");
          throw error;
        }
      }
    } else if (this.#installation.kind === "windows-native") {
      const helperErrors: Error[] = [];
      await this.#taskkillNativeProcessTree(false).catch(error => {
        helperErrors.push(error instanceof Error ? error : new Error(String(error)));
      });
      if (!(await this.#waitForExit(SIGNAL_STOP_TIMEOUT_MS))) {
        await this.#taskkillNativeProcessTree(true).catch(error => {
          helperErrors.push(error instanceof Error ? error : new Error(String(error)));
        });
        if (!(await this.#waitForExit(SIGNAL_STOP_TIMEOUT_MS))) {
          const detail = helperErrors.map(error => error.message).filter(Boolean).join("; ");
          const error = new Error(
            `Could not verify that the native OMP process tree exited${detail ? `: ${detail}` : " after taskkill /T and /T /F"}`,
          );
          this.#shutdownVerificationError = error;
          this.descriptor.error = error.message;
          this.#emitStatus("failed");
          throw error;
        }
      }
    } else {
      const signalErrors: Error[] = [];
      await this.#signalWslProcessGroup("TERM").catch(error => {
        signalErrors.push(error instanceof Error ? error : new Error(String(error)));
      });
      if (!(await this.#waitForExit(SIGNAL_STOP_TIMEOUT_MS))) {
        await this.#signalWslProcessGroup("KILL").catch(error => {
          signalErrors.push(error instanceof Error ? error : new Error(String(error)));
        });
        if (!(await this.#waitForExit(SIGNAL_STOP_TIMEOUT_MS))) {
          const detail = signalErrors.map(error => error.message).filter(Boolean).join("; ");
          const error = new Error(
            `Could not verify that the OMP WSL process group exited${detail ? `: ${detail}` : " after TERM and KILL"}`,
          );
          this.#shutdownVerificationError = error;
          this.descriptor.error = error.message;
          this.#emitStatus("failed");
          throw error;
        }
      }
    }
    await this.#cleanupWslPidFile();
  }

  #handleStderr(chunk: Buffer): void {
    this.#stderrBuffer += String(chunk);
    const marker = new RegExp(`\\x1e${WSL_PROCESS_GROUP_MARKER}=(\\d+)\\x1f\\r?\\n?`);
    let match = marker.exec(this.#stderrBuffer);
    while (match) {
      const processGroup = Number(match[1]);
      this.#stderrBuffer = `${this.#stderrBuffer.slice(0, match.index)}${this.#stderrBuffer.slice(match.index + match[0].length)}`;
      if (!this.#processGroupSettled && Number.isSafeInteger(processGroup) && processGroup > 1) {
        this.#wslProcessGroup = processGroup;
        this.#resolveProcessGroupOnce(processGroup);
      }
      match = marker.exec(this.#stderrBuffer);
    }
    if (this.#stderrBuffer.length > 512) {
      this.#appendStderr(this.#stderrBuffer.slice(0, -256));
      this.#stderrBuffer = this.#stderrBuffer.slice(-256);
    }
  }

  #flushStderr(): void {
    if (!this.#stderrBuffer) return;
    this.#appendStderr(this.#stderrBuffer);
    this.#stderrBuffer = "";
  }

  #appendStderr(value: string): void {
    this.#stderr = `${this.#stderr}${value}`.slice(-32_768);
  }

  #resolveProcessGroupOnce(processGroup: number): void {
    if (this.#processGroupSettled) return;
    this.#processGroupSettled = true;
    this.#resolveProcessGroup?.(processGroup);
  }

  #rejectProcessGroupOnce(error: Error): void {
    if (this.#processGroupSettled || !this.#processGroupReady) return;
    this.#processGroupSettled = true;
    this.#rejectProcessGroup?.(error);
  }

  async #waitForProcessGroup(): Promise<number> {
    const processGroupReady = this.#processGroupReady;
    if (!processGroupReady) return 0;
    return new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(this.#stderr.trim() || "OMP did not report its WSL process group")),
        STARTUP_TIMEOUT_MS,
      );
      void processGroupReady.then(
        processGroup => {
          clearTimeout(timeout);
          resolve(processGroup);
        },
        error => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });
  }

  async #waitForExit(timeoutMs: number): Promise<boolean> {
    const child = this.#process;
    if (!child || child.exitCode !== null || child.signalCode !== null) return true;
    return new Promise<boolean>(resolve => {
      const timeout = setTimeout(() => {
        child.off("exit", onExit);
        resolve(false);
      }, timeoutMs);
      const onExit = (): void => {
        clearTimeout(timeout);
        resolve(true);
      };
      child.once("exit", onExit);
    });
  }

  async #signalWslProcessGroup(signal: "TERM" | "KILL"): Promise<void> {
    const pidFile = this.#wslPidFile;
    if (!pidFile) return;
    await this.#runWslHelper([
      "/bin/sh",
      "-c",
      WSL_SIGNAL_SCRIPT,
      "omp-desktop-signal",
      signal,
      this.#wslProcessGroup ? String(this.#wslProcessGroup) : "",
      pidFile,
    ]);
  }

  async #taskkillNativeProcessTree(force: boolean): Promise<void> {
    const pid = this.descriptor.pid;
    if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 1) {
      throw new Error("Native OMP process did not report a valid root PID");
    }
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    await new Promise<void>((resolve, reject) => {
      const helper = spawn("taskkill.exe", args, {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => {
        helper.kill("SIGTERM");
        finish(new Error(`taskkill ${force ? "/T /F" : "/T"} helper timed out`));
      }, NATIVE_HELPER_TIMEOUT_MS);
      helper.stderr.on("data", chunk => {
        stderr = `${stderr}${String(chunk)}`.slice(-4096);
      });
      helper.once("error", error => finish(error));
      helper.once("exit", code => {
        if (code === 0) finish();
        else finish(new Error(stderr.trim() || `taskkill exited with code ${String(code)}`));
      });
    });
  }

  async #cleanupWslPidFile(): Promise<void> {
    if (this.#wslCleanupPromise) return this.#wslCleanupPromise;
    const pidFile = this.#wslPidFile;
    if (!pidFile) return;
    this.#wslPidFile = undefined;
    this.#wslCleanupPromise = this.#runWslHelper([
      "/bin/sh",
      "-c",
      WSL_CLEANUP_SCRIPT,
      "omp-desktop-cleanup",
      pidFile,
    ]).catch(() => undefined);
    await this.#wslCleanupPromise;
  }

  async #runWslHelper(command: string[]): Promise<void> {
    if (this.#installation.kind !== "wsl") return;
    const distro = assertDistro(this.#installation.distro ?? "");
    await new Promise<void>((resolve, reject) => {
      const helper = spawn("wsl.exe", ["-d", distro, "--exec", ...command], {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => {
        helper.kill("SIGTERM");
        finish(new Error("WSL helper timed out"));
      }, WSL_HELPER_TIMEOUT_MS);
      helper.stderr.on("data", chunk => {
        stderr = `${stderr}${String(chunk)}`.slice(-4096);
      });
      helper.once("error", error => finish(error));
      helper.once("exit", code => {
        if (code === 0) finish();
        else finish(new Error(stderr.trim() || `WSL helper exited with code ${String(code)}`));
      });
    });
  }

  #handleStdout(chunk: Buffer): void {
    if (this.#protocolFailed) return;
    try {
      for (const frame of this.#decoder.push(chunk)) this.#handleFrame(frame);
    } catch (error) {
      this.#protocolFailed = true;
      this.descriptor.error = error instanceof Error ? error.message : String(error);
      this.#emitStatus("failed");
      void this.stop().catch(stopError => {
        const message = stopError instanceof Error ? stopError.message : String(stopError);
        this.descriptor.error = `${this.descriptor.error ?? "OMP RPC decoding failed"}; ${message}`;
        this.#emitStatus("failed");
      });
    }
  }

  #handleFrame(rawFrame: RpcFrame): void {
    const validated = validateRuntimeFrame(this.#installation, rawFrame);
    const frame = validated.frame;
    if (frame.type === "ready" && !this.#ready) {
      this.#ready = true;
      const supported = Array.isArray(frame.supportedProtocolVersions) ? frame.supportedProtocolVersions : [];
      if (supported.includes(2)) {
        this.send({ id: "protocol-v2", type: "negotiate_protocol", protocolVersion: 2 });
      }
      this.#emitStatus("ready");
    } else if (["agent_start", "message_update", "tool_execution_start"].includes(frame.type)) {
      this.descriptor.error = undefined;
      this.#emitStatus("running");
    } else if (frame.type === "agent_end" && frame.isTerminal !== false) {
      this.#emitStatus("completed");
    } else if (frame.type === "extension_ui_request") {
      const method = frame.method;
      if (["select", "confirm", "input", "editor"].includes(String(method))) this.#emitStatus("waiting_for_user");
    } else if (frame.type === "response") {
      if (frame.success === false) {
        this.descriptor.error = typeof frame.error === "string" ? frame.error : "OMP command failed";
      } else if (frame.success === true) {
        this.descriptor.error = undefined;
      }
    }
    if (validated.sessionFile && validated.sessionFile !== this.descriptor.sessionPath) {
      this.descriptor.sessionPath = validated.sessionFile;
      this.#emitStatus(this.descriptor.state);
    }
    this.emit("frame", frame);
  }

  #emitStatus(state: RuntimeState): void {
    this.descriptor.state = state;
    this.emit("status", { ...this.descriptor });
  }
}
