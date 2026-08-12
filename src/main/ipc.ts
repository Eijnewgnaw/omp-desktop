import { ipcMain, type BrowserWindow } from "electron";
import { z } from "zod";
import type {
  EnvironmentInfo,
  OmpInstallation,
  RuntimeFrameEnvelope,
  RuntimeStatusEnvelope,
  StartRuntimeInput,
} from "../shared/contracts";
import { detectEnvironment } from "./environment-service";
import { MetadataStore } from "./metadata-store";
import { RuntimeManager } from "./runtime-manager";
import { SessionIndex } from "./session-index";
import { chooseWorkspace, openOmpTerminal, openWorkspacePath } from "./system-service";
import { getThemeSnapshot } from "./theme-service";

const distroSchema = z.string().min(1).max(96);
const pathSchema = z.string().startsWith("/").max(8192);
const installationInputSchema = z.object({
  distro: distroSchema,
  installationPath: pathSchema,
});
const startSchema = installationInputSchema.extend({
  path: pathSchema,
  sessionPath: pathSchema.optional(),
  profile: z.string().max(128).optional(),
  initialPrompt: z.string().max(900_000).optional(),
});
const metadataPatchSchema = z.object({
  displayTitle: z.string().max(240).nullable().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  tags: z.array(z.string().min(1).max(48)).max(24).optional(),
});
const rpcFrameSchema = z.object({ type: z.string().min(1).max(128), id: z.string().max(128).optional() }).loose();
const settingsPatchSchema = z
  .object({
    selectedDistro: z.string().max(96).optional(),
    selectedInstallationPath: pathSchema.optional(),
    lastWorkspace: pathSchema.optional(),
    themeMode: z.enum(["system", "dark", "light"]).optional(),
    profile: z.string().max(128).optional(),
    handedOffSessions: z.array(z.object({
      distro: distroSchema,
      installationPath: pathSchema,
      sessionPath: pathSchema,
      cwd: pathSchema,
      handedOffAt: z.string().datetime(),
    })).max(256).optional(),
  })
  .strict();

export interface IpcServices {
  store: MetadataStore;
  sessions: SessionIndex;
  runtimes: RuntimeManager;
}

export function registerIpc(window: BrowserWindow, services: IpcServices): () => void {
  let environmentCache: { value: EnvironmentInfo; time: number } | undefined;

  const environment = async (force = false): Promise<EnvironmentInfo> => {
    if (!force && environmentCache && Date.now() - environmentCache.time < 10_000) return environmentCache.value;
    const value = await detectEnvironment();
    environmentCache = { value, time: Date.now() };
    return value;
  };

  const installationFor = async (distro: string, executablePath: string): Promise<OmpInstallation> => {
    const detected = await environment();
    const installation = detected.installations.find(
      candidate => candidate.distro === distro && candidate.executablePath === executablePath,
    );
    if (!installation) throw new Error("OMP installation is no longer available; refresh the environment first");
    return installation;
  };

  ipcMain.handle("environment:detect", () => environment(true));
  ipcMain.handle("settings:get", () => services.store.getSettings());
  ipcMain.handle("settings:update", (_event, patch: unknown) => services.store.updateSettings(settingsPatchSchema.parse(patch)));

  ipcMain.handle("sessions:list", async (_event, raw: unknown) => {
    const input = installationInputSchema.extend({ includeArchived: z.boolean().optional() }).parse(raw);
    const installation = await installationFor(input.distro, input.installationPath);
    return services.sessions.list(installation, input.includeArchived);
  });
  ipcMain.handle("sessions:update", async (_event, raw: unknown, rawPatch: unknown) => {
    const input = installationInputSchema.extend({ path: pathSchema }).parse(raw);
    const installation = await installationFor(input.distro, input.installationPath);
    return services.sessions.update(installation, input.path, metadataPatchSchema.parse(rawPatch));
  });
  ipcMain.handle("sessions:trash", async (_event, raw: unknown) => {
    const input = installationInputSchema.extend({ path: pathSchema }).parse(raw);
    const installation = await installationFor(input.distro, input.installationPath);
    return services.sessions.trash(installation, input.path);
  });
  ipcMain.handle("sessions:delete", async (_event, raw: unknown) => {
    const input = installationInputSchema.extend({ path: pathSchema }).parse(raw);
    const installation = await installationFor(input.distro, input.installationPath);
    return services.sessions.deletePermanently(installation, input.path);
  });

  ipcMain.handle("theme:get", async (_event, raw: unknown) => {
    const input = installationInputSchema.extend({ mode: z.enum(["dark", "light"]) }).parse(raw);
    return getThemeSnapshot(await installationFor(input.distro, input.installationPath), input.mode);
  });

  ipcMain.handle("runtime:start", async (_event, raw: unknown) => {
    const input = startSchema.parse(raw) as StartRuntimeInput;
    const installation = await installationFor(input.distro, input.installationPath);
    return services.runtimes.start(installation, input);
  });
  ipcMain.handle("runtime:send", (_event, runtimeId: unknown, rawFrame: unknown) => {
    services.runtimes.send(z.string().uuid().parse(runtimeId), rpcFrameSchema.parse(rawFrame));
  });
  ipcMain.handle("runtime:stop", (_event, runtimeId: unknown) => services.runtimes.stop(z.string().uuid().parse(runtimeId)));
  ipcMain.handle("runtime:list", () => services.runtimes.list());

  ipcMain.handle("system:choose-workspace", (_event, distro: unknown) => chooseWorkspace(distroSchema.parse(distro)));
  ipcMain.handle("system:open-path", (_event, raw: unknown) => {
    const input = z.object({ distro: distroSchema, path: pathSchema }).parse(raw);
    return openWorkspacePath(input);
  });
  ipcMain.handle("system:open-terminal", async (_event, raw: unknown) => {
    const input = startSchema.omit({ initialPrompt: true }).parse(raw);
    await installationFor(input.distro, input.installationPath);
    await openOmpTerminal(input);
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
      "sessions:list",
      "sessions:update",
      "sessions:trash",
      "sessions:delete",
      "theme:get",
      "runtime:start",
      "runtime:send",
      "runtime:stop",
      "runtime:list",
      "system:choose-workspace",
      "system:open-path",
      "system:open-terminal",
    ]) {
      ipcMain.removeHandler(channel);
    }
  };
}
