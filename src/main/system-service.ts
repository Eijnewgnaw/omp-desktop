import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import path from "node:path";
import { dialog } from "electron";
import type { HandoffSessionInput, OmpInstallation } from "../shared/contracts";
import { execInDistro } from "./environment-service";
import {
  assertDistro,
  assertLogicalPath,
  assertWslPath,
  ompArgumentsForInstallation,
} from "./security";

async function selectedPathToWsl(installation: OmpInstallation, selectedPath: string): Promise<string> {
  const distro = assertDistro(installation.distro ?? "");
  if (process.platform !== "win32") return assertWslPath(selectedPath);
  const prefixes = [`\\\\wsl.localhost\\${distro}\\`, `\\\\wsl$\\${distro}\\`];
  const prefix = prefixes.find(value => selectedPath.toLowerCase().startsWith(value.toLowerCase()));
  if (prefix) {
    return assertWslPath(`/${selectedPath.slice(prefix.length).split("\\").join("/")}`);
  }
  return assertWslPath(await execInDistro(distro, "wslpath", ["-u", selectedPath]));
}

export async function chooseWorkspace(installation: OmpInstallation): Promise<string | null> {
  const defaultPath = (() => {
    if (installation.kind === "windows-native") {
      return process.env.USERPROFILE ?? path.win32.dirname(installation.agentDir);
    }
    if (installation.kind === "wsl") {
      return `\\\\wsl.localhost\\${assertDistro(installation.distro ?? "")}\\home`;
    }
    return process.cwd();
  })();
  const result = await dialog.showOpenDialog({
    title: "选择 OMP 工作区",
    properties: ["openDirectory", "createDirectory"],
    defaultPath,
  });
  const selected = result.filePaths[0];
  if (result.canceled || !selected) return null;
  if (installation.kind === "wsl") return selectedPathToWsl(installation, selected);
  return assertLogicalPath(installation, selected, "workspace path");
}

export interface TerminalLaunch {
  command: string;
  args: string[];
  options: SpawnOptions;
  displayName: string;
}

type SpawnTerminal = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

const TERMINAL_STARTUP_WINDOW_MS = 250;

// Windows Terminal treats semicolons inside the child command line as action
// separators. Prefix literal semicolons so paths stay in the single new-tab
// command that we construct.
function escapeWindowsTerminalArgument(value: string): string {
  return value.replaceAll(";", "\\;");
}

export function buildOmpTerminalLaunch(
  installation: OmpInstallation,
  input: HandoffSessionInput,
  platform: NodeJS.Platform = process.platform,
  terminal = process.env.TERMINAL || "x-terminal-emulator",
): TerminalLaunch {
  const cwd = assertLogicalPath(installation, input.path, "workspace path");
  const ompPath = assertLogicalPath(installation, installation.executablePath, "OMP executable");
  const ompArgs = [ompPath, ...ompArgumentsForInstallation(installation, ["--cwd", cwd])];
  if (input.sessionPath) {
    ompArgs.push("--resume", assertLogicalPath(installation, input.sessionPath, "session path"));
  }
  if (installation.kind === "windows-native") {
    if (platform !== "win32") throw new Error("Native Windows OMP requires Windows Terminal");
    const commandline = ["--startingDirectory", cwd, ...ompArgs].map(escapeWindowsTerminalArgument);
    return {
      command: "wt.exe",
      args: ["-w", "new", "new-tab", ...commandline],
      options: {
        detached: true,
        stdio: "ignore",
      },
      displayName: "Windows Terminal",
    };
  }
  if (installation.kind === "wsl") {
    if (platform !== "win32") throw new Error("WSL OMP terminal handoff requires Windows Terminal");
    const distro = assertDistro(installation.distro ?? "");
    const commandline = ["wsl.exe", "-d", distro, "--cd", cwd, "--exec", ...ompArgs]
      .map(escapeWindowsTerminalArgument);
    return {
      command: "wt.exe",
      // Always create a visible window. Reusing an existing hidden Windows
      // Terminal server can successfully launch OMP while leaving its tab
      // inaccessible to the user.
      args: ["-w", "new", "new-tab", ...commandline],
      options: {
        detached: true,
        stdio: "ignore",
      },
      displayName: "Windows Terminal",
    };
  }

  return {
    command: terminal,
    args: ["-e", ompPath, ...ompArgs.slice(1)],
    options: {
      cwd: path.posix.normalize(cwd),
      detached: true,
      stdio: "ignore",
    },
    displayName: "terminal",
  };
}

function launchError(displayName: string, detail: string, cause?: unknown): Error {
  return new Error(`Failed to start ${displayName}: ${detail}`, cause === undefined ? undefined : { cause });
}

export async function spawnDetachedTerminal(
  launch: TerminalLaunch,
  spawnTerminal: SpawnTerminal = spawn,
  startupWindowMs = TERMINAL_STARTUP_WINDOW_MS,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    let spawned = false;
    let settled = false;
    let startupTimer: NodeJS.Timeout | undefined;

    const resolveOnce = (): void => {
      if (settled) return;
      settled = true;
      if (startupTimer) clearTimeout(startupTimer);
      resolve();
    };
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (startupTimer) clearTimeout(startupTimer);
      reject(error);
    };

    try {
      child = spawnTerminal(launch.command, launch.args, launch.options);
    } catch (error) {
      rejectOnce(launchError(launch.displayName, error instanceof Error ? error.message : String(error), error));
      return;
    }

    child.once("error", error => {
      rejectOnce(launchError(launch.displayName, error.message, error));
    });
    child.once("spawn", () => {
      spawned = true;
      startupTimer = setTimeout(resolveOnce, Math.max(0, startupWindowMs));
    });
    child.once("exit", (code, signal) => {
      if (!spawned || code !== 0 || signal !== null) {
        const detail = signal ? `exited with signal ${signal}` : `exited with code ${String(code)}`;
        rejectOnce(launchError(launch.displayName, detail));
        return;
      }
      resolveOnce();
    });
    child.unref();
  });
}

export async function openOmpTerminal(installation: OmpInstallation, input: HandoffSessionInput): Promise<void> {
  await spawnDetachedTerminal(buildOmpTerminalLaunch(installation, input));
}
