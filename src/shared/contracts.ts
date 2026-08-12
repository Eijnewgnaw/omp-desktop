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

export type OmpRuntimeKind = "windows-native" | "wsl" | "linux-direct";

export interface OmpInstallation {
  id: string;
  kind: OmpRuntimeKind;
  label: string;
  /** Undefined identifies OMP's implicit default profile. */
  profile?: string;
  executablePath: string;
  version: string;
  /** OMP's config-facing agent directory (`omp config path`). */
  agentDir: string;
  /**
   * Authoritative root for data-class files such as `agent.db` and `sessions/`.
   * Under OMP's XDG layout this is the flattened profile data root, so it does
   * not end in `agent/` and can differ from the config-facing `agentDir`.
   */
  dataDir?: string;
  distro?: string;
}

export interface EnvironmentInfo {
  platform: string;
  mode: "windows-dual" | "linux-direct" | "unsupported";
  installations: OmpInstallation[];
  diagnostics: string[];
}

export interface SessionSummary {
  id: string;
  installationId: string;
  runtimeKind: OmpRuntimeKind;
  runtimeLabel: string;
  /** Undefined identifies OMP's implicit default profile. */
  profile?: string;
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
  installationId: string;
  path: string;
}

export interface TrashSessionResult {
  originalPath: string;
  trashPath: string;
  artifactTrashPath?: string;
}

export interface DeleteSessionInput {
  installationId: string;
  path: string;
}

export interface DeleteSessionResult {
  deletedPath: string;
  deletedArtifactPath?: string;
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
  installationId: string;
  path: string;
}

export interface StartRuntimeInput extends WorkspaceInput {
  sessionPath?: string;
  initialPrompt?: string;
}

export interface RuntimeDescriptor {
  runtimeId: string;
  state: RuntimeState;
  sessionPath?: string;
  cwd: string;
  installationId: string;
  runtimeKind: OmpRuntimeKind;
  /** Undefined identifies OMP's implicit default profile. */
  profile?: string;
  distro?: string;
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
  selectedInstallationId?: string;
  recentWorkspaces?: Record<string, string>;
  /** @deprecated Retained only while migrating settings written before v0.1.0. */
  selectedDistro?: string;
  /** @deprecated Retained only while migrating settings written before v0.1.0. */
  selectedInstallationPath?: string;
  /** @deprecated Retained only while migrating settings written before v0.1.0. */
  lastWorkspace?: string;
  themeMode: "system" | "dark" | "light";
  /** @deprecated Profiles are represented by selectedInstallationId. */
  profile?: string;
  handedOffSessions?: SessionHandoff[];
}

export interface SessionHandoff {
  /** Missing only on legacy WSL leases that could not yet be migrated safely. */
  installationId?: string;
  sessionPath: string;
  cwd: string;
  handedOffAt: string;
  /** @deprecated Retained only while migrating settings written before v0.1.0. */
  distro?: string;
  /** @deprecated Retained only while migrating settings written before v0.1.0. */
  installationPath?: string;
}

export interface ReclaimSessionInput extends WorkspaceInput {
  sessionPath: string;
}

export interface ReclaimSessionResult {
  descriptor: RuntimeDescriptor;
  settings: AppSettings;
}

export interface HandoffSessionInput extends WorkspaceInput {
  sessionPath: string;
}

export interface OmpDesktopApi {
  environment: {
    detect(): Promise<EnvironmentInfo>;
  };
  sessions: {
    list(input: { installationId: string; includeArchived?: boolean }): Promise<SessionSummary[]>;
    update(
      input: { installationId: string; path: string },
      patch: SessionMetadataPatch,
    ): Promise<SessionSummary>;
    trash(input: TrashSessionInput): Promise<TrashSessionResult>;
    delete(input: DeleteSessionInput): Promise<DeleteSessionResult>;
    reclaim(input: ReclaimSessionInput): Promise<ReclaimSessionResult>;
  };
  theme: {
    get(input: { installationId: string; mode: "dark" | "light" }): Promise<ThemeSnapshot>;
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
    chooseWorkspace(installationId: string): Promise<string | null>;
    handoffToTerminal(input: HandoffSessionInput): Promise<AppSettings>;
  };
  settings: {
    get(): Promise<AppSettings>;
    update(patch: Partial<AppSettings>): Promise<AppSettings>;
    migrateHandoffs(handoffs: SessionHandoff[]): Promise<AppSettings>;
  };
}
