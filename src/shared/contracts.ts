export type RuntimeState =
  | "starting"
  | "ready"
  | "idle"
  | "running"
  | "waiting_for_user"
  | "aborting"
  | "completed"
  | "failed"
  | "exited";

export interface OmpInstallation {
  distro: string;
  executablePath: string;
  version: string;
  agentDir: string;
  direct: boolean;
}

export interface EnvironmentInfo {
  platform: string;
  mode: "windows-wsl" | "linux-direct" | "unsupported";
  installations: OmpInstallation[];
  selectedDistro?: string;
  diagnostics: string[];
}

export interface SessionSummary {
  id: string;
  path: string;
  cwd: string;
  title: string;
  titleSource?: "auto" | "user";
  createdAt: string;
  modifiedAt: string;
  size: number;
  projectName: string;
  pinned: boolean;
  archived: boolean;
  tags: string[];
  runtimeState?: RuntimeState;
}

export interface SessionMetadataPatch {
  displayTitle?: string | null;
  pinned?: boolean;
  archived?: boolean;
  tags?: string[];
}

export interface TrashSessionInput {
  distro: string;
  installationPath: string;
  path: string;
}

export interface TrashSessionResult {
  originalPath: string;
  trashPath: string;
  artifactTrashPath?: string;
}

export interface OmpModelInfo {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
}

export interface ThemeJson {
  name: string;
  vars?: Record<string, string | number>;
  colors: Record<string, string | number>;
  export?: {
    pageBg?: string | number;
    cardBg?: string | number;
    infoBg?: string | number;
  };
  symbols?: {
    preset?: "unicode" | "nerd" | "ascii";
    overrides?: Record<string, string>;
    spinnerFrames?: string[] | { status?: string[]; activity?: string[] };
  };
}

export interface ThemeSnapshot {
  name: string;
  darkTheme: string;
  lightTheme: string;
  mode: "dark" | "light";
  symbolPreset: "unicode" | "nerd" | "ascii";
  colorBlindMode: boolean;
  colors: Record<string, string>;
  export: {
    pageBg: string;
    cardBg: string;
    infoBg: string;
  };
  availableThemes: string[];
  source: "builtin" | "custom" | "fallback";
}

export interface WorkspaceInput {
  distro: string;
  path: string;
}

export interface StartRuntimeInput extends WorkspaceInput {
  installationPath: string;
  sessionPath?: string;
  profile?: string;
  initialPrompt?: string;
}

export interface RuntimeDescriptor {
  runtimeId: string;
  state: RuntimeState;
  sessionPath?: string;
  cwd: string;
  distro: string;
  pid?: number;
  error?: string;
}

export interface RpcFrame {
  type: string;
  id?: string;
  [key: string]: unknown;
}

export interface RuntimeFrameEnvelope {
  runtimeId: string;
  frame: RpcFrame;
}

export interface RuntimeStatusEnvelope {
  runtimeId: string;
  descriptor: RuntimeDescriptor;
}

export interface AppSettings {
  selectedDistro?: string;
  selectedInstallationPath?: string;
  lastWorkspace?: string;
  themeMode: "system" | "dark" | "light";
  profile?: string;
}

export interface OpenTerminalInput extends WorkspaceInput {
  installationPath: string;
  sessionPath?: string;
  profile?: string;
}

export interface OmpDesktopApi {
  environment: {
    detect(): Promise<EnvironmentInfo>;
  };
  sessions: {
    list(input: { distro: string; installationPath: string; includeArchived?: boolean }): Promise<SessionSummary[]>;
    update(path: string, patch: SessionMetadataPatch): Promise<SessionSummary>;
    trash(input: TrashSessionInput): Promise<TrashSessionResult>;
  };
  theme: {
    get(input: { distro: string; installationPath: string; mode: "dark" | "light" }): Promise<ThemeSnapshot>;
  };
  runtime: {
    start(input: StartRuntimeInput): Promise<RuntimeDescriptor>;
    send(runtimeId: string, frame: RpcFrame): Promise<void>;
    stop(runtimeId: string): Promise<void>;
    list(): Promise<RuntimeDescriptor[]>;
    onFrame(callback: (event: RuntimeFrameEnvelope) => void): () => void;
    onStatus(callback: (event: RuntimeStatusEnvelope) => void): () => void;
  };
  system: {
    chooseWorkspace(distro: string): Promise<string | null>;
    openTerminal(input: OpenTerminalInput): Promise<void>;
    openPath(input: WorkspaceInput): Promise<void>;
  };
  settings: {
    get(): Promise<AppSettings>;
    update(patch: Partial<AppSettings>): Promise<AppSettings>;
  };
}
