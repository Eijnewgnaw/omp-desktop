import { contextBridge, ipcRenderer } from "electron";
import type {
  AppSettings,
  DeleteSessionInput,
  DeleteSessionResult,
  EnvironmentInfo,
  HandoffSessionInput,
  OmpDesktopApi,
  ReclaimSessionInput,
  ReclaimSessionResult,
  RpcFrame,
  RuntimeDescriptor,
  RuntimeFrameEnvelope,
  RuntimeStatusEnvelope,
  SessionMetadataPatch,
  SessionSummary,
  StartRuntimeInput,
  ThemeSnapshot,
  TrashSessionInput,
  TrashSessionResult,
} from "../shared/contracts";

const api: OmpDesktopApi = {
  environment: {
    detect: () => ipcRenderer.invoke("environment:detect") as Promise<EnvironmentInfo>,
  },
  sessions: {
    list: input => ipcRenderer.invoke("sessions:list", input) as Promise<SessionSummary[]>,
    update: (input, patch: SessionMetadataPatch) =>
      ipcRenderer.invoke("sessions:update", input, patch) as Promise<SessionSummary>,
    trash: (input: TrashSessionInput) => ipcRenderer.invoke("sessions:trash", input) as Promise<TrashSessionResult>,
    delete: (input: DeleteSessionInput) => ipcRenderer.invoke("sessions:delete", input) as Promise<DeleteSessionResult>,
    reclaim: (input: ReclaimSessionInput) => ipcRenderer.invoke("sessions:reclaim", input) as Promise<ReclaimSessionResult>,
  },
  theme: {
    get: input => ipcRenderer.invoke("theme:get", input) as Promise<ThemeSnapshot>,
  },
  runtime: {
    start: (input: StartRuntimeInput) => ipcRenderer.invoke("runtime:start", input) as Promise<RuntimeDescriptor>,
    send: (runtimeId: string, frame: RpcFrame) => ipcRenderer.invoke("runtime:send", runtimeId, frame),
    stop: (runtimeId: string) => ipcRenderer.invoke("runtime:stop", runtimeId),
    list: () => ipcRenderer.invoke("runtime:list") as Promise<RuntimeDescriptor[]>,
    onFrame: callback => {
      const listener = (_event: Electron.IpcRendererEvent, payload: RuntimeFrameEnvelope): void => callback(payload);
      ipcRenderer.on("runtime:frame", listener);
      return () => ipcRenderer.removeListener("runtime:frame", listener);
    },
    onStatus: callback => {
      const listener = (_event: Electron.IpcRendererEvent, payload: RuntimeStatusEnvelope): void => callback(payload);
      ipcRenderer.on("runtime:status", listener);
      return () => ipcRenderer.removeListener("runtime:status", listener);
    },
  },
  system: {
    chooseWorkspace: (installationId: string) =>
      ipcRenderer.invoke("system:choose-workspace", installationId) as Promise<string | null>,
    handoffToTerminal: (input: HandoffSessionInput) =>
      ipcRenderer.invoke("system:handoff-terminal", input) as Promise<AppSettings>,
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get") as Promise<AppSettings>,
    update: (patch: Partial<AppSettings>) => ipcRenderer.invoke("settings:update", patch) as Promise<AppSettings>,
    migrateHandoffs: handoffs => ipcRenderer.invoke("settings:migrate-handoffs", handoffs) as Promise<AppSettings>,
  },
};

contextBridge.exposeInMainWorld("ompDesktop", api);
