import path from "node:path";
import type { OmpInstallation } from "../shared/contracts";

const distroPattern = /^[\p{L}\p{N}._ -]{1,96}$/u;
const ompProfilePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const windowsReservedProfilePattern = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/iu;

export function assertDistro(value: string): string {
  if (!distroPattern.test(value) || value.includes("..")) {
    throw new Error("Invalid WSL distribution name");
  }
  return value;
}

/**
 * Mirrors OMP's cross-platform profile-name contract. Empty, whitespace and
 * the explicit `default` sentinel all select the implicit default profile.
 */
export function normalizeOmpProfileName(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized === "default") return undefined;
  if (
    normalized === "."
    || normalized === ".."
    || normalized.endsWith(".")
    || !ompProfilePattern.test(normalized)
    || windowsReservedProfilePattern.test(normalized)
  ) {
    throw new Error("Invalid OMP profile name");
  }
  return normalized;
}

export function assertOmpProfileName(value: string): string {
  const normalized = normalizeOmpProfileName(value);
  if (!normalized) throw new Error("A named OMP profile is required");
  return normalized;
}

export function ompArgumentsForInstallation(
  installation: Pick<OmpInstallation, "profile">,
  args: readonly string[],
): string[] {
  // Explicitly select the default as well. Otherwise an OMP_PROFILE inherited
  // by the desktop process could silently redirect a default installation.
  const profile = normalizeOmpProfileName(installation.profile) ?? "default";
  return ["--profile", profile, ...args];
}

export function assertWslPath(value: string, label = "path"): string {
  if (!value.startsWith("/") || value.includes("\0") || value.includes("\r") || value.includes("\n")) {
    throw new Error(`Invalid WSL ${label}`);
  }
  return path.posix.normalize(value);
}

export function assertWindowsPath(value: string, label = "path"): string {
  if (
    value.includes("\0")
    || value.includes("\r")
    || value.includes("\n")
    || /^(?:\\\\[?.]\\|\\\?\?\\)/u.test(value)
    || !/^[a-zA-Z]:[\\/]/u.test(value)
  ) {
    throw new Error(`Invalid Windows ${label}`);
  }
  const normalized = path.win32.normalize(value);
  if (!/^[a-zA-Z]:\\/u.test(normalized)) throw new Error(`Invalid Windows ${label}`);
  return normalized;
}

type LogicalPathInstallation = Pick<OmpInstallation, "kind">;
type HostPathInstallation = Pick<OmpInstallation, "kind" | "distro">;
type MetadataInstallation = Pick<
  OmpInstallation,
  "kind" | "distro" | "profile" | "executablePath" | "agentDir"
>;

export function assertLogicalPath(
  installation: LogicalPathInstallation,
  value: string,
  label = "path",
): string {
  return installation.kind === "windows-native"
    ? assertWindowsPath(value, label)
    : assertWslPath(value, label);
}

export function joinLogicalPath(installation: LogicalPathInstallation, ...parts: string[]): string {
  const implementation = installation.kind === "windows-native" ? path.win32 : path.posix;
  return assertLogicalPath(installation, implementation.join(...parts));
}

export function basenameLogicalPath(
  installation: LogicalPathInstallation,
  value: string,
  suffix?: string,
): string {
  const safePath = assertLogicalPath(installation, value);
  return installation.kind === "windows-native"
    ? path.win32.basename(safePath, suffix)
    : path.posix.basename(safePath, suffix);
}

/**
 * OMP routes sessions through its data-class root. With XDG enabled this is a
 * flattened root (for example `.../profiles/work`), not an `agent/` directory.
 * The optional field is absent on non-XDG installations and old fixtures.
 */
export function installationDataDir(
  installation: Pick<OmpInstallation, "kind" | "agentDir" | "dataDir">,
): string {
  return assertLogicalPath(
    installation,
    installation.dataDir ?? installation.agentDir,
    "OMP data directory",
  );
}

export function installationMetadataKey(installation: MetadataInstallation): string {
  const profile = normalizeOmpProfileName(installation.profile);
  if (installation.kind === "wsl") {
    const distro = assertDistro(installation.distro ?? "");
    const executablePath = assertWslPath(installation.executablePath, "OMP executable");
    const agentDir = assertWslPath(installation.agentDir, "agent directory");
    // Do not change the default serialization: existing WSL metadata is keyed
    // by these exact bytes. The effective data directory is deliberately not
    // part of the identity: enabling or moving XDG storage must not detach the
    // user's selection, metadata, recent workspaces, or handoff lease.
    return profile
      ? JSON.stringify(["wsl-profile", distro, executablePath, profile, agentDir])
      : JSON.stringify(["wsl", distro, executablePath, agentDir]);
  }
  if (installation.kind === "windows-native") {
    const executablePath = assertWindowsPath(installation.executablePath, "OMP executable").toLowerCase();
    const agentDir = assertWindowsPath(installation.agentDir, "agent directory").toLowerCase();
    return JSON.stringify(profile
      ? ["windows-native-profile", executablePath, profile, agentDir]
      : ["windows-native", executablePath, agentDir]);
  }
  const executablePath = assertWslPath(installation.executablePath, "OMP executable");
  const agentDir = assertWslPath(installation.agentDir, "agent directory");
  const kind = installation.kind === "macos-native" ? "macos-native" : "linux-direct";
  return JSON.stringify(profile
    ? [`${kind}-profile`, executablePath, profile, agentDir]
    : [kind, executablePath, agentDir]);
}

export function assertRuntimeId(value: string): string {
  if (!/^[a-f0-9-]{16,64}$/i.test(value)) throw new Error("Invalid runtime id");
  return value;
}

export function wslPathToHostPath(distro: string, wslPath: string): string {
  const safeDistro = assertDistro(distro);
  const safePath = assertWslPath(wslPath);
  if (process.platform !== "win32") return safePath;
  const suffix = safePath.slice(1).split("/").join("\\");
  return `\\\\wsl.localhost\\${safeDistro}\\${suffix}`;
}

export function toHostPath(installation: HostPathInstallation, logicalPath: string): string {
  const safePath = assertLogicalPath(installation, logicalPath);
  if (installation.kind !== "wsl") return safePath;
  return wslPathToHostPath(assertDistro(installation.distro ?? ""), safePath);
}

export function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
