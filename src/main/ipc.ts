import { ipcMain, type BrowserWindow } from "electron";
import { z } from "zod";
import type {
  AppSettings,
  EnvironmentInfo,
  HandoffSessionInput,
  OmpInstallation,
  RuntimeFrameEnvelope,
  RuntimeStatusEnvelope,
  SessionHandoff,
  StartRuntimeInput,
} from "../shared/contracts";
import { detectEnvironment } from "./environment-service";
import { MetadataStore } from "./metadata-store";
import { RuntimeManager } from "./runtime-manager";
import {
  assertDistro,
  assertLogicalPath,
  assertWslPath,
  installationDataDir,
  joinLogicalPath,
  normalizeOmpProfileName,
} from "./security";
import { containedLogicalRelativePath, SessionIndex } from "./session-index";
import { SessionOwnershipCoordinator } from "./session-ownership";
import { chooseWorkspace, openOmpTerminal } from "./system-service";
import { getThemeSnapshot } from "./theme-service";

const installationIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9:_-]+$/u);
const logicalPathValueSchema = z.string().min(1).max(8192);
const installationRefSchema = z.object({ installationId: installationIdSchema }).strict();
const installationRefWithExtrasSchema = installationRefSchema.passthrough();
export const startRuntimeSchema = installationRefSchema.extend({
  path: logicalPathValueSchema,
  sessionPath: logicalPathValueSchema.optional(),
  initialPrompt: z.string().max(900_000).optional(),
});
export const metadataPatchSchema = z.object({
  displayTitle: z.string().trim().min(1).max(240).nullable().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  tags: z.array(z.string().min(1).max(48)).max(24).optional(),
}).strict();
const rpcFrameSchema = z.object({ type: z.string().min(1).max(128), id: z.string().max(128).optional() }).loose();
const modernHandoffSchema = z.object({
  installationId: installationIdSchema,
  sessionPath: logicalPathValueSchema,
  cwd: logicalPathValueSchema,
  handedOffAt: z.string().datetime(),
  // Accepted only so existing settings can be read and rewritten during migration.
  distro: z.string().max(96).optional(),
  installationPath: logicalPathValueSchema.optional(),
}).strict();
const legacyHandoffSchema = z.object({
  sessionPath: logicalPathValueSchema,
  cwd: logicalPathValueSchema,
  handedOffAt: z.string().datetime(),
  distro: z.string().min(1).max(96),
  installationPath: logicalPathValueSchema,
}).strict();
export const handoffSchema = z.union([modernHandoffSchema, legacyHandoffSchema]);
const settingsPatchSchema = z
  .object({
    selectedInstallationId: installationIdSchema.optional(),
    recentWorkspaces: z.record(installationIdSchema, logicalPathValueSchema).optional(),
    // Legacy migration fields. New renderer code never uses these as authority.
    selectedDistro: z.string().max(96).optional(),
    selectedInstallationPath: logicalPathValueSchema.optional(),
    lastWorkspace: logicalPathValueSchema.optional(),
    themeMode: z.enum(["system", "dark", "light"]).optional(),
    // Accepted only to clear the pre-v0.1.0 global profile after migrating it
    // to a profile-specific installationId. It is never runtime authority.
    profile: z.string().max(128).optional(),
  })
  .strict();
const handoffMigrationSchema = z.array(handoffSchema).max(256);

export function assertInstallationSessionPath(
  installation: OmpInstallation,
  rawSessionPath: string,
): string {
  const sessionPath = assertLogicalPath(installation, rawSessionPath, "session path");
  containedLogicalRelativePath(
    installation,
    joinLogicalPath(installation, installationDataDir(installation), "sessions"),
    sessionPath,
  );
  return sessionPath;
}

function sameHandoff(left: SessionHandoff, right: SessionHandoff): boolean {
  return left.installationId === right.installationId
    && left.sessionPath === right.sessionPath
    && left.cwd === right.cwd
    && left.handedOffAt === right.handedOffAt
    && left.distro === right.distro
    && left.installationPath === right.installationPath;
}

export async function validateInstallationBoundSettings(
  patch: Pick<Partial<AppSettings>, "recentWorkspaces" | "handedOffSessions">,
  resolveInstallation: (installationId: string) => Promise<OmpInstallation>,
  detectCurrentEnvironment: () => Promise<EnvironmentInfo>,
  currentSettings: AppSettings,
): Promise<Pick<Partial<AppSettings>, "recentWorkspaces" | "handedOffSessions">> {
  const validated: Pick<Partial<AppSettings>, "recentWorkspaces" | "handedOffSessions"> = {};
  if (patch.recentWorkspaces) {
    if (Object.keys(patch.recentWorkspaces).length > 256) throw new Error("Too many recent workspaces");
    const recentWorkspaces: Record<string, string> = {};
    for (const [installationId, workspace] of Object.entries(patch.recentWorkspaces)) {
      try {
        const installation = await resolveInstallation(installationId);
        recentWorkspaces[installationId] = assertLogicalPath(installation, workspace, "workspace path");
      } catch (error) {
        // A temporarily offline runtime must not block updates for healthy
        // runtimes. Preserve only the exact value that was already stored;
        // never accept a new or modified value without resolving its adapter.
        if (currentSettings.recentWorkspaces?.[installationId] !== workspace) throw error;
        recentWorkspaces[installationId] = workspace;
      }
    }
    validated.recentWorkspaces = recentWorkspaces;
  }

  if (patch.handedOffSessions) {
    const handedOffSessions: SessionHandoff[] = [];
    for (const handoff of patch.handedOffSessions) {
      if (handoff.installationId) {
        try {
          const installation = await resolveInstallation(handoff.installationId);
          handedOffSessions.push({
            ...handoff,
            sessionPath: assertInstallationSessionPath(installation, handoff.sessionPath),
            cwd: assertLogicalPath(installation, handoff.cwd, "workspace path"),
          });
        } catch (error) {
          const unchanged = currentSettings.handedOffSessions?.some(existing => sameHandoff(existing, handoff));
          if (!unchanged) throw error;
          handedOffSessions.push(handoff);
        }
        continue;
      }

      const distro = assertDistro(handoff.distro ?? "");
      const installationPath = assertWslPath(handoff.installationPath ?? "", "OMP executable");
      const sessionPath = assertWslPath(handoff.sessionPath, "session path");
      const cwd = assertWslPath(handoff.cwd, "workspace path");
      const detected = await detectCurrentEnvironment();
      const baseCandidates = detected.installations.filter(candidate =>
        candidate.kind === "wsl"
          && candidate.distro === distro
          && candidate.executablePath === installationPath,
      );
      const pathOwners = baseCandidates.filter(candidate => {
        try {
          assertInstallationSessionPath(candidate, sessionPath);
          return true;
        } catch {
          return false;
        }
      });
      const installation = pathOwners.length === 1 ? pathOwners[0] : undefined;
      handedOffSessions.push(installation
        ? { ...handoff, installationId: installation.id, distro, installationPath, sessionPath, cwd }
        : { ...handoff, distro, installationPath, sessionPath, cwd });
    }
    validated.handedOffSessions = handedOffSessions;
  }
  return validated;
}

function sameHandoffPayload(left: SessionHandoff, right: SessionHandoff): boolean {
  return left.sessionPath === right.sessionPath
    && left.cwd === right.cwd
    && left.handedOffAt === right.handedOffAt
    && left.distro === right.distro
    && left.installationPath === right.installationPath;
}

function sameBaseInstallation(left: OmpInstallation, right: OmpInstallation): boolean {
  if (left.kind !== right.kind || left.distro !== right.distro) return false;
  const executable = (installation: OmpInstallation): string => installation.kind === "windows-native"
    ? assertLogicalPath(installation, installation.executablePath, "OMP executable").toLocaleLowerCase("en-US")
    : installation.executablePath;
  return executable(left) === executable(right);
}

export function handoffMigrationOwners(
  installations: readonly OmpInstallation[],
  existing: SessionHandoff,
): OmpInstallation[] {
  const oldBase = existing.installationId
    ? installations.find(candidate => candidate.id === existing.installationId)
    : undefined;
  const baseCandidates = oldBase
    ? installations.filter(candidate => sameBaseInstallation(candidate, oldBase))
    : existing.installationId
      ? installations
      : installations.filter(candidate => candidate.kind === "wsl"
        && candidate.distro === existing.distro
        && candidate.executablePath === existing.installationPath);
  return baseCandidates.filter(candidate => {
    try {
      assertInstallationSessionPath(candidate, existing.sessionPath);
      return true;
    } catch {
      return false;
    }
  });
}

export interface IpcServices {
  store: MetadataStore;
  sessions: SessionIndex;
  runtimes: RuntimeManager;
}

export function createEnvironmentResolver(
  detect: () => Promise<EnvironmentInfo>,
  now: () => number = Date.now,
  cacheTtlMs = 10_000,
): (force?: boolean) => Promise<EnvironmentInfo> {
  let cache: { value: EnvironmentInfo; time: number } | undefined;
  let inFlight: Promise<EnvironmentInfo> | undefined;
  return async (force = false): Promise<EnvironmentInfo> => {
    if (!force && cache && now() - cache.time < cacheTtlMs) return cache.value;
    if (inFlight) return inFlight;
    const request = detect().then(value => {
      cache = { value, time: now() };
      return value;
    });
    inFlight = request;
    try {
      return await request;
    } finally {
      if (inFlight === request) inFlight = undefined;
    }
  };
}

export function registerIpc(window: BrowserWindow, services: IpcServices): () => void {
  const sessionOwnership = new SessionOwnershipCoordinator(services.runtimes, services.store);
  const environment = createEnvironmentResolver(detectEnvironment);

  const installationFor = async (rawInstallationId: unknown): Promise<OmpInstallation> => {
    const installationId = installationIdSchema.parse(rawInstallationId);
    const detected = await environment();
    const installation = detected.installations.find(candidate => candidate.id === installationId);
    if (!installation) throw new Error("OMP installation is no longer available; refresh the environment first");
    return installation;
  };

  const resolveInputInstallation = async (raw: unknown): Promise<OmpInstallation> => {
    // Resolve the opaque ID before looking at any path-shaped field. Paths are
    // meaningful only after the trusted runtime kind has been recovered here.
    const { installationId } = installationRefWithExtrasSchema.parse(raw);
    return installationFor(installationId);
  };

  const validateSettingsPatch = async (raw: unknown): Promise<Partial<AppSettings>> => {
    const patch = settingsPatchSchema.parse(raw);
    const validated: Partial<AppSettings> = { ...patch };
    if (patch.profile !== undefined) {
      // Legacy-only, never runtime authority. Still reject malformed values
      // before they can be persisted again during migration.
      normalizeOmpProfileName(patch.profile);
    }
    if (patch.selectedInstallationId) await installationFor(patch.selectedInstallationId);
    Object.assign(validated, await validateInstallationBoundSettings(
      patch,
      installationId => installationFor(installationId),
      () => environment(),
      services.store.getSettings(),
    ));
    return validated;
  };

  const validateHandoffMigration = async (raw: unknown): Promise<SessionHandoff[]> => {
    const proposed = handoffMigrationSchema.parse(raw) as SessionHandoff[];
    const current = services.store.getSettings().handedOffSessions ?? [];
    if (proposed.length !== current.length) {
      throw new Error("Terminal ownership leases cannot be added or removed through settings migration");
    }
    const matched = new Set<number>();
    for (const existing of current) {
      const index = proposed.findIndex((candidate, candidateIndex) =>
        !matched.has(candidateIndex) && sameHandoffPayload(existing, candidate));
      if (index < 0) throw new Error("Settings migration cannot change terminal ownership lease contents");
      matched.add(index);
      const replacement = proposed[index];
      if (!replacement || replacement.installationId === existing.installationId) continue;

      if (existing.installationId) {
        try {
          const existingBase = await installationFor(existing.installationId);
          assertInstallationSessionPath(existingBase, existing.sessionPath);
          throw new Error("A resolved terminal ownership lease cannot move to another OMP installation");
        } catch (error) {
          if (error instanceof Error && error.message.includes("cannot move")) throw error;
          // An unavailable or path-incompatible Alpha identity may be migrated
          // only when the current environment has one unambiguous owner.
        }
      }
      const detected = await environment();
      const owners = handoffMigrationOwners(detected.installations, existing);
      if (owners.length !== 1 || owners[0]?.id !== replacement.installationId) {
        throw new Error("Terminal ownership lease migration is ambiguous");
      }
    }
    return (await validateInstallationBoundSettings(
      { handedOffSessions: proposed },
      installationId => installationFor(installationId),
      () => environment(),
      services.store.getSettings(),
    )).handedOffSessions ?? [];
  };

  ipcMain.handle("environment:detect", () => environment(true));
  ipcMain.handle("settings:get", () => services.store.getSettings());
  ipcMain.handle("settings:update", (_event, patch: unknown) => sessionOwnership.updateSettings(async () => (
    services.store.updateSettings(await validateSettingsPatch(patch))
  )));
  ipcMain.handle("settings:migrate-handoffs", (_event, raw: unknown) => sessionOwnership.updateSettings(async () => (
    services.store.updateSettings({ handedOffSessions: await validateHandoffMigration(raw) })
  )));

  ipcMain.handle("sessions:list", async (_event, raw: unknown) => {
    const installation = await resolveInputInstallation(raw);
    const input = installationRefSchema.extend({ includeArchived: z.boolean().optional() }).parse(raw);
    return services.sessions.list(installation, input.includeArchived);
  });
  ipcMain.handle("sessions:update", async (_event, raw: unknown, rawPatch: unknown) => {
    const installation = await resolveInputInstallation(raw);
    const input = installationRefSchema.extend({ path: logicalPathValueSchema }).parse(raw);
    const sessionPath = assertLogicalPath(installation, input.path, "session path");
    return services.sessions.update(installation, sessionPath, metadataPatchSchema.parse(rawPatch));
  });
  ipcMain.handle("sessions:trash", async (_event, raw: unknown) => {
    const installation = await resolveInputInstallation(raw);
    const input = installationRefSchema.extend({ path: logicalPathValueSchema }).parse(raw);
    const sessionPath = assertInstallationSessionPath(installation, input.path);
    return sessionOwnership.trashSession(
      installation,
      sessionPath,
      () => services.sessions.trash(installation, sessionPath),
    );
  });
  ipcMain.handle("sessions:delete", async (_event, raw: unknown) => {
    const installation = await resolveInputInstallation(raw);
    const input = installationRefSchema.extend({ path: logicalPathValueSchema }).parse(raw);
    const sessionPath = assertInstallationSessionPath(installation, input.path);
    return sessionOwnership.deleteSession(
      installation,
      sessionPath,
      () => services.sessions.deletePermanently(installation, sessionPath),
    );
  });
  ipcMain.handle("sessions:reclaim", async (_event, raw: unknown) => {
    const installation = await resolveInputInstallation(raw);
    const parsed = installationRefSchema.extend({
      path: logicalPathValueSchema,
      sessionPath: logicalPathValueSchema,
    }).parse(raw);
    return sessionOwnership.reclaimSession(installation, {
      ...parsed,
      path: assertLogicalPath(installation, parsed.path, "workspace path"),
      sessionPath: assertInstallationSessionPath(installation, parsed.sessionPath),
    });
  });

  ipcMain.handle("theme:get", async (_event, raw: unknown) => {
    const installation = await resolveInputInstallation(raw);
    const input = installationRefSchema.extend({ mode: z.enum(["dark", "light"]) }).parse(raw);
    return getThemeSnapshot(installation, input.mode);
  });

  ipcMain.handle("runtime:start", async (_event, raw: unknown) => {
    const installation = await resolveInputInstallation(raw);
    const parsed = startRuntimeSchema.parse(raw);
    const input: StartRuntimeInput = {
      ...parsed,
      path: assertLogicalPath(installation, parsed.path, "workspace path"),
      ...(parsed.sessionPath
        ? { sessionPath: assertInstallationSessionPath(installation, parsed.sessionPath) }
        : {}),
    };
    return sessionOwnership.startRuntime(installation, input);
  });
  ipcMain.handle("runtime:send", (_event, runtimeId: unknown, rawFrame: unknown) => {
    services.runtimes.send(z.string().uuid().parse(runtimeId), rpcFrameSchema.parse(rawFrame));
  });
  ipcMain.handle("runtime:stop", (_event, runtimeId: unknown) => services.runtimes.stop(z.string().uuid().parse(runtimeId)));
  ipcMain.handle("runtime:list", () => services.runtimes.list());

  ipcMain.handle("system:choose-workspace", async (_event, rawInstallationId: unknown) => (
    chooseWorkspace(await installationFor(rawInstallationId))
  ));
  ipcMain.handle("system:handoff-terminal", async (_event, raw: unknown) => {
    const installation = await resolveInputInstallation(raw);
    const parsed = installationRefSchema.extend({
      path: logicalPathValueSchema,
      sessionPath: logicalPathValueSchema,
    }).parse(raw);
    const input: HandoffSessionInput = {
      ...parsed,
      path: assertLogicalPath(installation, parsed.path, "workspace path"),
      sessionPath: assertInstallationSessionPath(installation, parsed.sessionPath),
    };
    return sessionOwnership.handoffToTerminal(
      installation,
      input,
      () => openOmpTerminal(installation, input),
    );
  });

  const frameListener = (payload: RuntimeFrameEnvelope): void => {
    if (!window.isDestroyed()) window.webContents.send("runtime:frame", payload);
  };
  const statusListener = (payload: RuntimeStatusEnvelope): void => {
    if (!window.isDestroyed()) window.webContents.send("runtime:status", payload);
  };
  services.runtimes.on("frame", frameListener);
  services.runtimes.on("status", statusListener);

  return () => {
    services.runtimes.off("frame", frameListener);
    services.runtimes.off("status", statusListener);
    for (const channel of [
      "environment:detect",
      "settings:get",
      "settings:update",
      "settings:migrate-handoffs",
      "sessions:list",
      "sessions:update",
      "sessions:trash",
      "sessions:delete",
      "sessions:reclaim",
      "theme:get",
      "runtime:start",
      "runtime:send",
      "runtime:stop",
      "runtime:list",
      "system:choose-workspace",
      "system:handoff-terminal",
    ]) {
      ipcMain.removeHandler(channel);
    }
  };
}
