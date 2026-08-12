import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import path from "node:path";
import { dialog, shell } from "electron";
import type { OpenTerminalInput, WorkspaceInput } from "../shared/contracts";
import { execInDistro } from "./environment-service";
import { assertDistro, assertWslPath, wslPathToHostPath } from "./security";

async function selectedPathToWsl(distro: string, selectedPath: string): Promise<string> {
  if (process.platform !== "win32") return assertWslPath(selectedPath);
  const prefix = `\\\\wsl.localhost\\${distro}\\`;
  if (selectedPath.toLowerCase().startsWith(prefix.toLowerCase())) {
    return assertWslPath(`/${selectedPath.slice(prefix.length).split("\\").join("/")}`);
  }
  return assertWslPath(await execInDistro(distro, "wslpath", ["-u", selectedPath]));
}

export async function chooseWorkspace(distro: string): Promise<string | null> {
  const safeDistro = assertDistro(distro);
  const result = await dialog.showOpenDialog({
    title: "选择 OMP 工作区",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: process.platform === "win32" ? `\\\\wsl.localhost\\${safeDistro}\\home` : process.cwd(),
  });
  const selected = result.filePaths[0];
  if (result.canceled || !selected) return null;
  return selectedPathToWsl(safeDistro, selected);
}

export async function openWorkspacePath(input: WorkspaceInput): Promise<void> {
  const hostPath = wslPathToHostPath(input.distro, input.path);
  const error = await shell.openPath(hostPath);
  if (error) throw new Error(error);
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
// separators. Prefix literal semicolons so paths and profile names stay in the
// single new-tab command that we construct.
function escapeWindowsTerminalArgument(value: string): string {
  return value.replaceAll(";", "\\;");
}

export function buildOmpTerminalLaunch(
  input: OpenTerminalInput,
  platform: NodeJS.Platform = process.platform,
  terminal = process.env.TERMINAL || "x-terminal-emulator",
): TerminalLaunch {
  const distro = assertDistro(input.distro);
  const cwd = assertWslPath(input.path, "workspace path");
  const ompPath = assertWslPath(input.installationPath, "OMP executable");
  const ompArgs = [ompPath, "--cwd", cwd];
  if (input.profile) ompArgs.push("--profile", input.profile);
  if (input.sessionPath) ompArgs.push("--resume", assertWslPath(input.sessionPath, "session path"));
  if (platform === "win32") {
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

export async function openOmpTerminal(input: OpenTerminalInput): Promise<void> {
  await spawnDetachedTerminal(buildOmpTerminalLaunch(input));
}
