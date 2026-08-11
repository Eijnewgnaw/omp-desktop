import { spawn } from "node:child_process";
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

export function openOmpTerminal(input: OpenTerminalInput): void {
  const distro = assertDistro(input.distro);
  const cwd = assertWslPath(input.path, "workspace path");
  const ompPath = assertWslPath(input.installationPath, "OMP executable");
  const ompArgs = [ompPath, "--cwd", cwd];
  if (input.profile) ompArgs.push("--profile", input.profile);
  if (input.sessionPath) ompArgs.push("--resume", assertWslPath(input.sessionPath, "session path"));
  if (process.platform === "win32") {
    const child = spawn("wt.exe", ["new-tab", "--", "wsl.exe", "-d", distro, "--cd", cwd, "--exec", ...ompArgs], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.unref();
    return;
  }
  const terminal = process.env.TERMINAL || "x-terminal-emulator";
  const child = spawn(terminal, ["-e", ompPath, ...ompArgs.slice(1)], {
    cwd: path.posix.normalize(cwd),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
