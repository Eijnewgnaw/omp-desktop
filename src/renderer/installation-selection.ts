import type {
  AppSettings,
  EnvironmentInfo,
  OmpInstallation,
  SessionHandoff,
  SessionSummary,
} from "../shared/contracts";

function legacyProfileName(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return !normalized || normalized.toLocaleLowerCase("en-US") === "default" ? undefined : normalized;
}

function comparablePath(installation: Pick<OmpInstallation, "kind">, value: string): string {
  return installation.kind === "windows-native" ? value.toLocaleLowerCase("en-US") : value;
}

export function sameBaseRuntime(left: OmpInstallation, right: OmpInstallation): boolean {
  return left.kind === right.kind
    && left.distro === right.distro
    && comparablePath(left, left.executablePath) === comparablePath(right, right.executablePath);
}

export function baseRuntimeLabel(installation: OmpInstallation): string {
  if (installation.kind === "windows-native") return "Windows 原生";
  if (installation.kind === "wsl") return `WSL · ${installation.distro ?? installation.label}`;
  return "Linux 本机";
}

export function installationDisplayLabel(installation: OmpInstallation): string {
  return `${baseRuntimeLabel(installation)} · ${installation.profile
    ? `Profile · ${installation.profile}`
    : "Default"}`;
}

export function sessionRuntimeDisplayLabel(
  session: Pick<SessionSummary, "runtimeLabel" | "profile">,
): string {
  if (!session.profile) return `${session.runtimeLabel} · Default`;
  return session.runtimeLabel.includes("Profile ·")
    ? session.runtimeLabel
    : `${session.runtimeLabel} · Profile · ${session.profile}`;
}

function legacyBaseInstallation(
  installations: readonly OmpInstallation[],
  settings: Pick<AppSettings, "selectedDistro" | "selectedInstallationPath">,
): OmpInstallation | undefined {
  return installations.find(item => item.kind === "wsl"
    && item.distro === settings.selectedDistro
    && item.executablePath === settings.selectedInstallationPath);
}

function matchingProfile(
  installations: readonly OmpInstallation[],
  base: OmpInstallation | undefined,
  profile: string | undefined,
  requireResolvedBase = false,
): OmpInstallation | undefined {
  if (!profile || (requireResolvedBase && !base)) return undefined;
  const candidates = installations.filter(item => item.profile === profile && (!base || sameBaseRuntime(item, base)));
  return candidates.length === 1 ? candidates[0] : undefined;
}

function canonicalLogicalPath(installation: Pick<OmpInstallation, "kind">, value: string): string | undefined {
  const windows = installation.kind === "windows-native";
  const separator = windows ? "\\" : "/";
  const normalized = windows ? value.replaceAll("/", "\\").toLocaleLowerCase("en-US") : value;
  const prefix = windows ? normalized.match(/^[a-z]:\\/u)?.[0] : normalized.startsWith("/") ? "/" : undefined;
  if (!prefix) return undefined;
  const parts: string[] = [];
  for (const part of normalized.slice(prefix.length).split(separator)) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `${prefix}${parts.join(separator)}`;
}

export function sessionBelongsToInstallation(
  installation: OmpInstallation,
  sessionPath: string,
): boolean {
  const separator = installation.kind === "windows-native" ? "\\" : "/";
  const session = canonicalLogicalPath(installation, sessionPath);
  const dataDir = canonicalLogicalPath(
    installation,
    installation.dataDir ?? installation.agentDir,
  );
  if (!session || !dataDir) return false;
  let root = dataDir;
  while (root.endsWith(separator)) root = root.slice(0, -1);
  const sessionsRoot = `${root}${separator}sessions`;
  return session.startsWith(`${sessionsRoot}${separator}`);
}

export function selectedInstallation(
  environment: EnvironmentInfo | undefined,
  settings: AppSettings | undefined,
): OmpInstallation | undefined {
  if (!environment || !settings) return undefined;
  const installations = environment.installations;
  const exact = installations.find(item => item.id === settings.selectedInstallationId);
  // Once the modern opaque ID exists it is the only selection authority.
  // Deprecated WSL fields may remain in SQLite after an Alpha migration and
  // must never make an unavailable named Profile fall back to Default.
  const legacyBase = settings.selectedInstallationId
    ? undefined
    : legacyBaseInstallation(installations, settings);
  const base = exact ?? legacyBase;
  const legacyProfile = legacyProfileName(settings.profile);
  // A stored base identity is authoritative even while that runtime is
  // temporarily unavailable. Never migrate a same-named Profile to another
  // backend merely because it is the only currently detected candidate.
  const hasStoredBaseIdentity = Boolean(
    settings.selectedInstallationId
    || settings.selectedDistro
    || settings.selectedInstallationPath,
  );
  const profile = matchingProfile(installations, base, legacyProfile, hasStoredBaseIdentity);
  // In Alpha builds a named Profile was stored separately from the base
  // runtime. While that exact Profile is unavailable, falling back to the
  // base Default installation would silently move new sessions, credentials
  // and metadata into a different environment. Keep the selection unresolved
  // until the requested Profile is detected again or the user chooses another
  // one explicitly.
  if (legacyProfile && !profile) return undefined;
  const resolvedStoredSelection = profile ?? exact ?? legacyBase;
  if (resolvedStoredSelection) return resolvedStoredSelection;
  // When a persisted runtime is temporarily unavailable, require an explicit
  // new choice. Falling through to another backend (or a same-named Profile)
  // would silently change where a new session, its credentials and files live.
  if (hasStoredBaseIdentity) return undefined;
  return installations.find(item => !item.profile) ?? installations[0];
}

function migrateLegacyHandoff(
  installations: readonly OmpInstallation[],
  handoff: SessionHandoff,
  legacyProfile: string | undefined,
): SessionHandoff {
  const current = installations.find(item => item.id === handoff.installationId);
  const baseCandidates = current
    ? installations.filter(item => sameBaseRuntime(item, current))
    : installations.filter(item => item.kind === "wsl"
      && item.distro === handoff.distro
      && item.executablePath === handoff.installationPath);
  const pathOwners = baseCandidates.filter(item => sessionBelongsToInstallation(item, handoff.sessionPath));
  const profileOwners = legacyProfile ? pathOwners.filter(item => item.profile === legacyProfile) : pathOwners;
  const target = profileOwners.length === 1 ? profileOwners[0] : undefined;
  return target && target.id !== handoff.installationId
    ? { ...handoff, installationId: target.id }
    : handoff;
}

export function migrateLegacySettings(
  environment: EnvironmentInfo,
  settings: AppSettings,
): Partial<AppSettings> {
  const patch: Partial<AppSettings> = {};
  const selected = selectedInstallation(environment, settings);
  const legacyProfile = legacyProfileName(settings.profile);
  const hasStoredBaseIdentity = Boolean(
    settings.selectedInstallationId
    || settings.selectedDistro
    || settings.selectedInstallationPath,
  );
  const storedBaseResolved = Boolean(
    environment.installations.some(item => item.id === settings.selectedInstallationId)
    || legacyBaseInstallation(environment.installations, settings),
  );
  const canPersistSelectionMigration = !hasStoredBaseIdentity || storedBaseResolved;
  if (selected && canPersistSelectionMigration && settings.selectedInstallationId !== selected.id) {
    patch.selectedInstallationId = selected.id;
  }
  if (canPersistSelectionMigration && settings.profile !== undefined
    && (!legacyProfile || selected?.profile === legacyProfile)) patch.profile = "";

  const handoffs = settings.handedOffSessions ?? [];
  const migrated = handoffs.map(handoff => migrateLegacyHandoff(
    environment.installations,
    handoff,
    legacyProfile,
  ));
  if (migrated.some((item, index) => item !== handoffs[index])) patch.handedOffSessions = migrated;

  if (selected && canPersistSelectionMigration && settings.lastWorkspace && !settings.recentWorkspaces?.[selected.id]) {
    patch.recentWorkspaces = { ...settings.recentWorkspaces, [selected.id]: settings.lastWorkspace };
  }
  return patch;
}
