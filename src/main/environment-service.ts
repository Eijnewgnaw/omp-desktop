import { createHash } from "node:crypto";
import path from "node:path";
import type { EnvironmentInfo, OmpInstallation, OmpRuntimeKind } from "../shared/contracts";
import { execFileAsync } from "./exec";
import {
  assertDistro,
  assertLogicalPath,
  assertOmpProfileName,
  assertWindowsPath,
  assertWslPath,
  installationMetadataKey,
  ompArgumentsForInstallation,
} from "./security";

const WSL_EXECUTABLE = "wsl.exe";
const AUTHORITATIVE_DATA_DIR_MINIMUM_VERSION = [17, 2, 12] as const;
export const POSIX_PROFILE_DISCOVERY_SCRIPT = `
scan_root() {
  root=$1
  [ -d "$root" ] || return 0
  for entry in "$root"/*; do
    [ -d "$entry" ] || continue
    printf '%s\n' "\${entry##*/}"
  done
}
scan_root "$HOME/\${PI_CONFIG_DIR:-.omp}/profiles"
[ -z "\${XDG_DATA_HOME-}" ] || scan_root "$XDG_DATA_HOME/omp/profiles"
[ -z "\${XDG_STATE_HOME-}" ] || scan_root "$XDG_STATE_HOME/omp/profiles"
[ -z "\${XDG_CACHE_HOME-}" ] || scan_root "$XDG_CACHE_HOME/omp/profiles"
`;
export const WINDOWS_PROFILE_DISCOVERY_SCRIPT = "$ErrorActionPreference='Stop'; $config=if($env:PI_CONFIG_DIR){$env:PI_CONFIG_DIR}else{'.omp'}; $root=[IO.Path]::GetFullPath([IO.Path]::Combine($env:USERPROFILE,$config,'profiles')); if(Test-Path -LiteralPath $root -PathType Container){Get-ChildItem -LiteralPath $root -Directory -Name}";

type InstallationProbe = Pick<OmpInstallation, "kind" | "executablePath"> &
  Partial<Pick<OmpInstallation, "distro" | "profile">>;

class OmpDataDirProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OmpDataDirProbeError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function versionBeforeAuthoritativeDataDir(version: string): boolean {
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (!match) return false;
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (const [index, minimum] of AUTHORITATIVE_DATA_DIR_MINIMUM_VERSION.entries()) {
    const value = actual[index] ?? 0;
    if (value !== minimum) return value < minimum;
  }
  return false;
}

function explicitlyUnsupportedGc(error: unknown): boolean {
  const message = errorMessage(error);
  return /(?:unknown|unsupported|unrecognized|invalid)\s+(?:command|subcommand)[^\n]*\bgc\b|\bgc\b[^\n]*(?:unknown|unsupported|unrecognized)\s+(?:command|subcommand)/iu.test(message);
}

export async function execInDistro(distro: string, command: string, args: string[] = []): Promise<string> {
  const safeDistro = assertDistro(distro);
  const result = await execFileAsync(WSL_EXECUTABLE, ["-d", safeDistro, "--exec", command, ...args]);
  return result.stdout;
}

export async function runOmp(installation: InstallationProbe, args: string[]): Promise<string> {
  const ompArgs = ompArgumentsForInstallation(installation, args);
  if (installation.kind !== "wsl") {
    const executable = assertLogicalPath(installation, installation.executablePath, "OMP executable");
    return (await execFileAsync(executable, ompArgs)).stdout;
  }
  return execInDistro(
    assertDistro(installation.distro ?? ""),
    assertWslPath(installation.executablePath, "OMP executable"),
    ompArgs,
  );
}

function installationLabel(kind: OmpRuntimeKind, distro?: string, profile?: string): string {
  const runtime = kind === "windows-native"
    ? "Windows (native)"
    : kind === "wsl"
      ? `${distro ?? "WSL"} (WSL)`
      : "Linux (direct)";
  return profile ? `${runtime} · Profile · ${profile}` : runtime;
}

function installationId(installation: Omit<OmpInstallation, "id" | "label" | "version">): string {
  const digest = createHash("sha256")
    .update(installationMetadataKey(installation))
    .digest("hex")
    .slice(0, 24);
  return `${installation.kind}:${digest}`;
}

function physicalInstallationOwnerKey(installation: OmpInstallation): string {
  const rawDataDir = installation.dataDir ?? installation.agentDir;
  const normalizedDataDir = installation.kind === "windows-native"
    ? path.win32.normalize(rawDataDir).toLowerCase()
    : path.posix.normalize(rawDataDir);
  return JSON.stringify([
    installation.kind,
    installation.kind === "wsl" ? installation.distro ?? null : null,
    installation.profile ?? null,
    normalizedDataDir,
  ]);
}

/**
 * Several executable discovery hints can resolve to the same physical OMP
 * owner. Preserve discovery order so the higher-priority candidate wins while
 * keeping distinct Profiles and data roots isolated.
 */
function deduplicatePhysicalInstallations(installations: readonly OmpInstallation[]): OmpInstallation[] {
  const seen = new Set<string>();
  return installations.filter(installation => {
    const key = physicalInstallationOwnerKey(installation);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function dataDirFromGcPlan(
  installation: Pick<OmpInstallation, "kind">,
  output: string,
  expectedAgentDir: string,
): string | undefined {
  const plan = JSON.parse(output) as unknown;
  if (!plan || typeof plan !== "object" || (plan as { apply?: unknown }).apply !== false) return undefined;
  const rawAgentDir = (plan as { agentDir?: unknown }).agentDir;
  if (typeof rawAgentDir !== "string") return undefined;
  const planAgentDir = assertLogicalPath(installation, rawAgentDir, "OMP GC agent directory");
  const configAgentDir = assertLogicalPath(installation, expectedAgentDir, "OMP agent directory");
  const sameAgentDir = installation.kind === "windows-native"
    ? planAgentDir.toLowerCase() === configAgentDir.toLowerCase()
    : planAgentDir === configAgentDir;
  if (!sameAgentDir) return undefined;
  const wal = (plan as { wal?: unknown }).wal;
  if (!wal || typeof wal !== "object") return undefined;
  const databases = (wal as { databases?: unknown }).databases;
  if (!Array.isArray(databases)) return undefined;

  const pathApi = installation.kind === "windows-native" ? path.win32 : path.posix;
  const recognized = new Map<string, string>();
  for (const database of databases) {
    if (!database || typeof database !== "object") continue;
    const rawPath = (database as { dbPath?: unknown }).dbPath;
    if (typeof rawPath !== "string") continue;
    const dbPath = assertLogicalPath(installation, rawPath, "OMP GC database path");
    const name = pathApi.basename(dbPath).toLowerCase();
    if (name === "history.db" || name === "models.db") {
      recognized.set(name, assertLogicalPath(installation, pathApi.dirname(dbPath), "OMP data directory"));
    }
  }
  if (!recognized.has("history.db") || !recognized.has("models.db")) return undefined;
  const directories = [...recognized.values()];
  const canonicalDirectories = new Set(
    directories.map(value => installation.kind === "windows-native" ? value.toLowerCase() : value),
  );
  return canonicalDirectories.size === 1 ? directories[0] : undefined;
}

async function probeDataDir(probe: InstallationProbe, agentDir: string, version: string): Promise<string> {
  try {
    // `gc` is dry-run unless --apply is provided. Asking OMP for its own WAL
    // plan incorporates inherited variables and OMP's safely parsed .env files.
    const output = await runOmp(probe, ["gc", "--json", "--wal"]);
    const dataDir = dataDirFromGcPlan(probe, output, agentDir);
    if (!dataDir) throw new Error("GC plan is missing a consistent history.db/models.db data root");
    return dataDir;
  } catch (error) {
    // Only a version known to predate the authoritative plan may use the old
    // root, and only when OMP explicitly reports that the command is absent.
    if (versionBeforeAuthoritativeDataDir(version) && explicitlyUnsupportedGc(error)) return agentDir;
    throw new OmpDataDirProbeError(`无法权威确认 OMP ${version} 数据目录：${errorMessage(error)}`);
  }
}

async function probeInstallation(probe: InstallationProbe): Promise<OmpInstallation> {
  const executablePath = assertLogicalPath(probe, probe.executablePath, "OMP executable");
  const trustedProbe = { ...probe, executablePath };
  const [versionOutput, agentDirOutput] = await Promise.all([
    runOmp(trustedProbe, ["--version"]),
    runOmp(trustedProbe, ["config", "path"]),
  ]);
  const version = versionOutput.replace(/^omp\//iu, "").trim();
  const agentDir = assertLogicalPath(probe, agentDirOutput, "agent directory");
  const dataDirOutput = await probeDataDir(trustedProbe, agentDir, version);
  const dataDir = dataDirOutput !== agentDir
    ? dataDirOutput
    : undefined;
  const base = {
    kind: probe.kind,
    executablePath,
    agentDir,
    ...(dataDir ? { dataDir } : {}),
    ...(probe.profile ? { profile: assertOmpProfileName(probe.profile) } : {}),
    ...(probe.kind === "wsl" ? { distro: assertDistro(probe.distro ?? "") } : {}),
  } satisfies Omit<OmpInstallation, "id" | "label" | "version">;
  return {
    ...base,
    id: installationId(base),
    label: installationLabel(base.kind, base.distro, base.profile),
    version,
  };
}

/**
 * Profile roots are only an enumeration hint. Every candidate is still passed
 * through OMP itself so XDG-aware and future path resolution stays authoritative.
 */
async function listProfileNames(
  installation: InstallationProbe,
): Promise<string[]> {
  let output: string;
  if (installation.kind === "windows-native") {
    // Named profiles ignore PI_CODING_AGENT_DIR, so enumerate the canonical
    // config root rather than deriving a sibling from the default agent path.
    output = (await execFileAsync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_PROFILE_DISCOVERY_SCRIPT,
    ])).stdout;
  } else if (installation.kind === "wsl") {
    output = await execInDistro(
      assertDistro(installation.distro ?? ""),
      "/bin/sh",
      ["-c", POSIX_PROFILE_DISCOVERY_SCRIPT, "omp-desktop-profiles"],
    );
  } else {
    output = (await execFileAsync(
      "/bin/sh",
      ["-c", POSIX_PROFILE_DISCOVERY_SCRIPT, "omp-desktop-profiles"],
    )).stdout;
  }

  const seen = new Set<string>();
  const profiles: string[] = [];
  for (const rawName of output.split(/\r?\n/u)) {
    try {
      const profile = assertOmpProfileName(rawName.trim());
      if (!seen.has(profile)) {
        seen.add(profile);
        profiles.push(profile);
      }
    } catch {
      // Directory names are untrusted discovery hints. Invalid names can never
      // become OMP argv or part of an installation identity.
    }
  }
  return profiles.sort((left, right) => left.localeCompare(right));
}

async function expandProfiles(defaultInstallation: OmpInstallation): Promise<{
  installations: OmpInstallation[];
  diagnostics: string[];
}> {
  let names: string[];
  try {
    names = await listProfileNames(defaultInstallation);
  } catch (error) {
    return {
      installations: [defaultInstallation],
      diagnostics: [`无法枚举 ${defaultInstallation.label} 的 OMP Profiles：${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const results = await Promise.allSettled(names.map(profile => probeInstallation({
    kind: defaultInstallation.kind,
    executablePath: defaultInstallation.executablePath,
    distro: defaultInstallation.distro,
    profile,
  })));
  const installations = [defaultInstallation];
  const diagnostics: string[] = [];
  for (const [index, result] of results.entries()) {
    if (result?.status === "fulfilled") installations.push(result.value);
    else diagnostics.push(
      `无法加载 ${defaultInstallation.label} 的 Profile ${names[index] ?? "unknown"}：${result?.reason instanceof Error ? result.reason.message : String(result?.reason)}`,
    );
  }
  return { installations, diagnostics };
}

async function probeBackend(probe: InstallationProbe): Promise<{
  installations: OmpInstallation[];
  diagnostics: string[];
}> {
  try {
    return expandProfiles(await probeInstallation(probe));
  } catch (error) {
    if (!(error instanceof OmpDataDirProbeError)) throw error;

    // A broken default Profile must not hide independently valid named
    // Profiles on the same executable/backend.
    const runtimeLabel = installationLabel(probe.kind, probe.distro);
    const diagnostics = [`无法加载 ${runtimeLabel} 的 Default Profile：${error.message}`];
    let names: string[];
    try {
      names = await listProfileNames(probe);
    } catch (profileError) {
      diagnostics.push(`无法枚举 ${runtimeLabel} 的 OMP Profiles：${errorMessage(profileError)}`);
      return { installations: [], diagnostics };
    }
    const results = await Promise.allSettled(names.map(profile => probeInstallation({ ...probe, profile })));
    const installations: OmpInstallation[] = [];
    for (const [index, result] of results.entries()) {
      if (result?.status === "fulfilled") installations.push(result.value);
      else diagnostics.push(
        `无法加载 ${runtimeLabel} 的 Profile ${names[index] ?? "unknown"}：${errorMessage(result?.reason)}`,
      );
    }
    return { installations, diagnostics };
  }
}

export function windowsNativeCandidatePaths(
  env: NodeJS.ProcessEnv,
  whereOutput = "",
): string[] {
  const values: string[] = [];
  if (env.LOCALAPPDATA) values.push(path.win32.join(env.LOCALAPPDATA, "omp", "omp.exe"));
  if (env.USERPROFILE) values.push(path.win32.join(env.USERPROFILE, ".local", "bin", "omp.exe"));
  values.push(...whereOutput.split(/\r?\n/u).map(value => value.trim()).filter(Boolean));

  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    try {
      const normalized = assertWindowsPath(value, "OMP executable");
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(normalized);
    } catch {
      // Ignore untrusted or non-drive-absolute output returned by PATH discovery.
    }
  }
  return result;
}

async function detectWindowsNative(env: NodeJS.ProcessEnv): Promise<{
  installations: OmpInstallation[];
  diagnostics: string[];
}> {
  const diagnostics: string[] = [];
  const whereOutput = await execFileAsync("where.exe", ["omp"]).then(result => result.stdout, () => "");
  const candidates = windowsNativeCandidatePaths(env, whereOutput);
  const results = await Promise.allSettled(
    candidates.map(executablePath => probeBackend({ kind: "windows-native", executablePath })),
  );
  const available = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  const installations = deduplicatePhysicalInstallations(
    available.flatMap(result => result.installations),
  );
  diagnostics.push(...available.flatMap(result => result.diagnostics));
  if (installations.length === 0) {
    diagnostics.push("未检测到可用的 Windows 原生 OMP。已检查常见安装位置和 Windows PATH。");
  }
  return { installations, diagnostics };
}

async function probeWindowsDistro(distro: string): Promise<{
  installations: OmpInstallation[];
  diagnostics: string[];
} | null> {
  try {
    const safeDistro = assertDistro(distro);
    const executablePath = await execInDistro(safeDistro, "sh", ["-lc", "command -v omp"]);
    if (!executablePath.startsWith("/")) return null;
    // Await inside this try so a broken OMP/Profile in one distribution is
    // contained here instead of rejecting the aggregate WSL discovery and
    // hiding every healthy distribution.
    return await probeBackend({ kind: "wsl", distro: safeDistro, executablePath });
  } catch {
    return null;
  }
}

async function detectWindowsWsl(): Promise<{
  installations: OmpInstallation[];
  diagnostics: string[];
}> {
  const diagnostics: string[] = [];
  try {
    const { stdout } = await execFileAsync(WSL_EXECUTABLE, ["--list", "--quiet"]);
    const distros = stdout
      .split(/\r?\n/u)
      .map(value => value.trim())
      .filter(Boolean);
    if (distros.length === 0) diagnostics.push("未检测到 WSL 发行版。");
    const results = (await Promise.all(distros.map(probeWindowsDistro))).filter(
      (value): value is NonNullable<Awaited<ReturnType<typeof probeWindowsDistro>>> => value !== null,
    );
    const installations = deduplicatePhysicalInstallations(
      results.flatMap(result => result.installations),
    );
    diagnostics.push(...results.flatMap(result => result.diagnostics));
    if (installations.length === 0 && distros.length > 0) diagnostics.push("WSL 中未找到可用的 omp 命令。");
    return { installations, diagnostics };
  } catch (error) {
    diagnostics.push(`无法连接 WSL：${error instanceof Error ? error.message : String(error)}`);
    return { installations: [], diagnostics };
  }
}

export async function detectWindowsEnvironment(env: NodeJS.ProcessEnv = process.env): Promise<EnvironmentInfo> {
  // A broken native installation must not suppress WSL, and a broken WSL setup
  // must not suppress a healthy native installation.
  const [native, wsl] = await Promise.all([detectWindowsNative(env), detectWindowsWsl()]);
  return {
    platform: "win32",
    mode: "windows-dual",
    installations: [...native.installations, ...wsl.installations],
    diagnostics: [...native.diagnostics, ...wsl.diagnostics],
  };
}

async function detectDirect(): Promise<EnvironmentInfo> {
  const diagnostics: string[] = ["当前为 Linux 直接运行模式。"];
  try {
    const { stdout: executablePath } = await execFileAsync("sh", ["-lc", "command -v omp"]);
    const expanded = await probeBackend({ kind: "linux-direct", executablePath });
    return {
      platform: "linux",
      mode: "linux-direct",
      installations: deduplicatePhysicalInstallations(expanded.installations),
      diagnostics: [...diagnostics, ...expanded.diagnostics],
    };
  } catch (error) {
    diagnostics.push(`未找到 omp：${error instanceof Error ? error.message : String(error)}`);
    return { platform: "linux", mode: "linux-direct", installations: [], diagnostics };
  }
}

export async function detectEnvironment(platform: NodeJS.Platform = process.platform): Promise<EnvironmentInfo> {
  if (platform === "win32") return detectWindowsEnvironment();
  if (platform === "linux") return detectDirect();
  return {
    platform,
    mode: "unsupported",
    installations: [],
    diagnostics: ["当前版本支持 Windows 原生 OMP、Windows + WSL2，以及 Linux 直接运行模式。"],
  };
}
