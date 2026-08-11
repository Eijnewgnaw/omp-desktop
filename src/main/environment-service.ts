import os from "node:os";
import type { EnvironmentInfo, OmpInstallation } from "../shared/contracts";
import { execFileAsync } from "./exec";
import { assertDistro, assertWslPath } from "./security";

const WSL_EXECUTABLE = "wsl.exe";

export async function execInDistro(distro: string, command: string, args: string[] = []): Promise<string> {
  const safeDistro = assertDistro(distro);
  const result = await execFileAsync(WSL_EXECUTABLE, ["-d", safeDistro, "--exec", command, ...args]);
  return result.stdout;
}

export async function runOmp(
  installation: Pick<OmpInstallation, "distro" | "executablePath" | "direct">,
  args: string[],
): Promise<string> {
  if (installation.direct) {
    return (await execFileAsync(installation.executablePath, args)).stdout;
  }
  return execInDistro(installation.distro, assertWslPath(installation.executablePath, "OMP executable"), args);
}

async function probeWindowsDistro(distro: string): Promise<OmpInstallation | null> {
  try {
    const executablePath = await execInDistro(distro, "sh", ["-lc", "command -v omp"]);
    if (!executablePath.startsWith("/")) return null;
    const partial = { distro, executablePath, direct: false };
    const versionOutput = await runOmp(partial, ["--version"]);
    const agentDir = await runOmp(partial, ["config", "path"]);
    return {
      ...partial,
      version: versionOutput.replace(/^omp\//, "").trim(),
      agentDir: assertWslPath(agentDir, "agent directory"),
    };
  } catch {
    return null;
  }
}

async function detectWindows(): Promise<EnvironmentInfo> {
  const diagnostics: string[] = [];
  try {
    const { stdout } = await execFileAsync(WSL_EXECUTABLE, ["--list", "--quiet"]);
    const distros = stdout
      .split(/\r?\n/)
      .map(value => value.trim())
      .filter(Boolean);
    if (distros.length === 0) diagnostics.push("未检测到 WSL 发行版。");
    const installations = (await Promise.all(distros.map(probeWindowsDistro))).filter(
      (value): value is OmpInstallation => value !== null,
    );
    if (installations.length === 0 && distros.length > 0) diagnostics.push("WSL 中未找到 omp 命令。");
    return {
      platform: process.platform,
      mode: "windows-wsl",
      installations,
      diagnostics,
    };
  } catch (error) {
    diagnostics.push(`无法连接 WSL：${error instanceof Error ? error.message : String(error)}`);
    return { platform: process.platform, mode: "windows-wsl", installations: [], diagnostics };
  }
}

async function detectDirect(): Promise<EnvironmentInfo> {
  const diagnostics: string[] = ["当前为开发兼容模式；正式版本面向 Windows + WSL2。"];
  try {
    const { stdout: executablePath } = await execFileAsync("sh", ["-lc", "command -v omp"]);
    const partial = { distro: "direct", executablePath, direct: true };
    const version = (await runOmp(partial, ["--version"])).replace(/^omp\//, "").trim();
    const agentDir = await runOmp(partial, ["config", "path"]);
    return {
      platform: process.platform,
      mode: "linux-direct",
      installations: [{ ...partial, version, agentDir }],
      selectedDistro: "direct",
      diagnostics,
    };
  } catch (error) {
    diagnostics.push(`未找到 omp：${error instanceof Error ? error.message : String(error)}`);
    return { platform: process.platform, mode: "linux-direct", installations: [], diagnostics };
  }
}

export async function detectEnvironment(): Promise<EnvironmentInfo> {
  if (process.platform === "win32") return detectWindows();
  if (process.platform === "linux" && (process.env.WSL_DISTRO_NAME || os.release().toLowerCase().includes("microsoft"))) {
    return detectDirect();
  }
  return {
    platform: process.platform,
    mode: "unsupported",
    installations: [],
    diagnostics: ["当前版本仅支持 Windows + WSL2。"],
  };
}
