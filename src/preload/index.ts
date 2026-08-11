import { contextBridge, ipcRenderer } from "electron";
import type {
  AppSettings,
  EnvironmentInfo,
  OmpDesktopApi,
  OpenTerminalInput,
  RpcFrame,
  RuntimeDescriptor,
  RuntimeFrameEnvelope,
  RuntimeStatusEnvelope,
  SessionMetadataPatch,
  SessionSummary,
  StartRuntimeInput,
  ThemeSnapshot,
  WorkspaceInput,
} from "../shared/contracts";

const api: OmpDesktopApi = {
  environment: {
    detect: () => ipcRenderer.invoke("environment:detect") as Promise<EnvironmentInfo>,
  },
  sessions: {
    list: input => ipcRenderer.invoke("sessions:list", input) as Promise<SessionSummary[]>,
    update: (path: string, patch: SessionMetadataPatch) =>
      ipcRenderer.invoke("sessions:update", path, patch) as Promise<SessionSummary>,
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
    chooseWorkspace: (distro: string) => ipcRenderer.invoke("system:choose-workspace", distro) as Promise<string | null>,
    openTerminal: (input: OpenTerminalInput) => ipcRenderer.invoke("system:open-terminal", input),
    openPath: (input: WorkspaceInput) => ipcRenderer.invoke("system:open-path", input),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get") as Promise<AppSettings>,
    update: (patch: Partial<AppSettings>) => ipcRenderer.invoke("settings:update", patch) as Promise<AppSettings>,
  },
};

contextBridge.exposeInMainWorld("ompDesktop", api);
