import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { OmpInstallation, RpcFrame, RuntimeDescriptor, RuntimeState, StartRuntimeInput } from "../shared/contracts";
import { assertDistro, assertWslPath } from "./security";
import { RpcFrameDecoder } from "./rpc-frame-decoder";

interface OmpRpcClientEvents {
  frame: [RpcFrame];
  status: [RuntimeDescriptor];
  exit: [number | null, NodeJS.Signals | null];
}

export class OmpRpcClient extends EventEmitter<OmpRpcClientEvents> {
  readonly descriptor: RuntimeDescriptor;
  readonly #installation: OmpInstallation;
  readonly #input: StartRuntimeInput;
  readonly #decoder = new RpcFrameDecoder();
  #process?: ChildProcessWithoutNullStreams;
  #stderr = "";
  #ready = false;

  constructor(runtimeId: string, installation: OmpInstallation, input: StartRuntimeInput) {
    super();
    this.#installation = installation;
    this.#input = input;
    this.descriptor = {
      runtimeId,
      state: "starting",
      sessionPath: input.sessionPath,
      cwd: input.path,
      distro: input.distro,
    };
  }

  async start(): Promise<RuntimeDescriptor> {
    const cwd = assertWslPath(this.#input.path, "workspace path");
    const ompArgs = ["--mode", "rpc-ui", "--cwd", cwd];
    if (this.#input.profile) ompArgs.push("--profile", this.#input.profile);
    if (this.#input.sessionPath) ompArgs.push("--resume", assertWslPath(this.#input.sessionPath, "session path"));

    if (this.#installation.direct) {
      this.#process = spawn(this.#installation.executablePath, ompArgs, {
        cwd,
        env: { ...process.env, COLORTERM: "truecolor" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      const distro = assertDistro(this.#input.distro);
      this.#process = spawn(
        "wsl.exe",
        ["-d", distro, "--cd", cwd, "--exec", assertWslPath(this.#installation.executablePath), ...ompArgs],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
    }
    this.descriptor.pid = this.#process.pid;
    this.#emitStatus("starting");
    this.#process.stdout.on("data", chunk => this.#handleStdout(chunk as Buffer));
    this.#process.stderr.on("data", chunk => {
      this.#stderr = `${this.#stderr}${String(chunk)}`.slice(-32_768);
    });
    this.#process.on("error", error => {
      this.descriptor.error = error.message;
      this.#emitStatus("failed");
    });
    this.#process.on("exit", (code, signal) => {
      if (!this.descriptor.error && code && code !== 0) {
        this.descriptor.error = this.#stderr.trim() || `OMP exited with code ${code}`;
      }
      this.#emitStatus(this.descriptor.error ? "failed" : "exited");
      this.emit("exit", code, signal);
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(this.#stderr.trim() || "OMP RPC startup timed out")), 15_000);
      const onFrame = (frame: RpcFrame): void => {
        if (frame.type !== "ready") return;
        clearTimeout(timeout);
        this.off("frame", onFrame);
        resolve();
      };
      this.on("frame", onFrame);
      this.#process?.once("error", error => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    if (this.#input.initialPrompt) {
      this.send({ id: crypto.randomUUID(), type: "prompt", message: this.#input.initialPrompt });
    }
    return { ...this.descriptor };
  }

  send(frame: RpcFrame): void {
    if (!this.#process || !this.#process.stdin.writable) throw new Error("OMP runtime is not writable");
    const payload = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(payload) > 1024 * 1024) throw new Error("RPC command exceeds the OMP frame limit");
    this.#process.stdin.write(payload);
  }

  async stop(): Promise<void> {
    const child = this.#process;
    if (!child || child.killed || this.descriptor.state === "exited") return;
    this.#emitStatus("aborting");
    try {
      this.send({ id: crypto.randomUUID(), type: "abort" });
    } catch {
      // The process may already have closed its input.
    }
    child.stdin.end();
    await new Promise<void>(resolve => {
      const force = setTimeout(() => {
        child.kill("SIGTERM");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(force);
        resolve();
      });
    });
  }

  #handleStdout(chunk: Buffer): void {
    try {
      for (const frame of this.#decoder.push(chunk)) this.#handleFrame(frame);
    } catch (error) {
      this.descriptor.error = error instanceof Error ? error.message : String(error);
      this.#emitStatus("failed");
    }
  }

  #handleFrame(frame: RpcFrame): void {
    if (frame.type === "ready" && !this.#ready) {
      this.#ready = true;
      const supported = Array.isArray(frame.supportedProtocolVersions) ? frame.supportedProtocolVersions : [];
      if (supported.includes(2)) {
        this.send({ id: "protocol-v2", type: "negotiate_protocol", protocolVersion: 2 });
      }
      this.#emitStatus("ready");
    } else if (["agent_start", "message_update", "tool_execution_start"].includes(frame.type)) {
      this.#emitStatus("running");
    } else if (frame.type === "agent_end") {
      this.#emitStatus("completed");
    } else if (frame.type === "extension_ui_request") {
      const method = frame.method;
      if (["select", "confirm", "input", "editor"].includes(String(method))) this.#emitStatus("waiting_for_user");
    } else if (frame.type === "response" && frame.success === false) {
      this.descriptor.error = typeof frame.error === "string" ? frame.error : "OMP command failed";
    } else if (frame.type === "session_info_update") {
      const sessionFile = frame.sessionFile;
      if (typeof sessionFile === "string" && sessionFile !== this.descriptor.sessionPath) {
        this.descriptor.sessionPath = sessionFile;
        this.#emitStatus(this.descriptor.state);
      }
    }
    this.emit("frame", frame);
  }

  #emitStatus(state: RuntimeState): void {
    this.descriptor.state = state;
    this.emit("status", { ...this.descriptor });
  }
}
