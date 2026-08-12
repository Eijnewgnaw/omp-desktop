import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  AppSettings,
  EnvironmentInfo,
  OmpModelInfo,
  OmpInstallation,
  RpcFrame,
  RuntimeDescriptor,
  SessionMetadataPatch,
  SessionSummary,
  ThemeSnapshot,
} from "../shared/contracts";
import { initialConversationState, reduceRpcFrame } from "./conversation";
import { ConversationPane } from "./components/ConversationPane";
import { BrandMark } from "./components/BrandMark";
import { PermissionDialog } from "./components/PermissionDialog";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { SessionDeleteDialog } from "./components/SessionDeleteDialog";
import { SessionReclaimDialog } from "./components/SessionReclaimDialog";
import { SessionRenameDialog } from "./components/SessionRenameDialog";
import { SessionTrashDialog } from "./components/SessionTrashDialog";
import { Sidebar } from "./components/Sidebar";
import { hasSessionHandoff } from "./session-handoff";
import { migrateLegacySettings, selectedInstallation } from "./installation-selection";
import {
  collectAvailableSessionGroups,
  mergeSessions,
  removeSessionSummary,
  replaceSessionSummary,
  sessionIdentity,
  sessionMatchesIdentity,
  sessionSummaryIdentity,
} from "./session-collection";
import { validateSessionTitle } from "./session-rename";
import {
  attachTargetSessionPath,
  chooseTargetInstallation,
  chooseTargetWorkspace,
  newSessionTarget,
  reconcileTarget,
  savedSessionTarget,
  targetInstallationId,
  targetSession,
  targetSessionPath,
  targetWorkspace,
  type ActiveTarget,
} from "./session-target";
import { applyTheme } from "./theme";

function desiredThemeMode(settings: AppSettings): "dark" | "light" {
  if (settings.themeMode === "dark" || settings.themeMode === "light") return settings.themeMode;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function installationForSession(
  environment: EnvironmentInfo | undefined,
  session: SessionSummary,
): OmpInstallation | undefined {
  return environment?.installations.find(item => item.id === session.installationId);
}

export default function App(): React.JSX.Element {
  const [environment, setEnvironment] = useState<EnvironmentInfo>();
  const [settings, setSettings] = useState<AppSettings>();
  const [theme, setTheme] = useState<ThemeSnapshot>();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeTarget, setActiveTargetState] = useState<ActiveTarget>(() => newSessionTarget());
  const [runtime, setRuntime] = useState<RuntimeDescriptor>();
  const [conversation, dispatchConversation] = useReducer(reduceRpcFrame, initialConversationState);
  const [pendingRequest, setPendingRequest] = useState<RpcFrame>();
  const [query, setQuery] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [sending, setSending] = useState(false);
  const [switchingSession, setSwitchingSession] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [fatalError, setFatalError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [availableModels, setAvailableModels] = useState<OmpModelInfo[]>([]);
  const [pendingRename, setPendingRename] = useState<SessionSummary>();
  const [pendingTrash, setPendingTrash] = useState<SessionSummary>();
  const [pendingDelete, setPendingDelete] = useState<SessionSummary>();
  const [pendingReclaim, setPendingReclaim] = useState<SessionSummary>();
  const [newSessionDraft, setNewSessionDraft] = useState<{
    installationId?: string;
    workspace?: string;
  }>();
  const [selectingNewSessionWorkspace, setSelectingNewSessionWorkspace] = useState(false);
  const selectingNewSessionWorkspaceRef = useRef(false);
  const [creatingNewSession, setCreatingNewSession] = useState(false);
  const [newSessionError, setNewSessionError] = useState<string>();
  const [newSessionReturnFocus, setNewSessionReturnFocus] = useState<HTMLElement>();
  const creatingNewSessionRef = useRef(false);
  const [renamingSession, setRenamingSession] = useState(false);
  const [renameError, setRenameError] = useState<string>();
  const [deletingSession, setDeletingSession] = useState(false);
  const [reclaimingSession, setReclaimingSession] = useState(false);
  const [editorUpdate, setEditorUpdate] = useState<{ key: string; messages: string[]; force?: boolean }>();
  const runtimeIdRef = useRef<string | undefined>(undefined);
  const runtimeSessionPathRef = useRef<string | undefined>(undefined);
  const runtimeTargetKeyRef = useRef<string | undefined>(undefined);
  const runtimeGenerationRef = useRef(0);
  const runtimeStartRef = useRef<Promise<RuntimeDescriptor> | undefined>(undefined);
  const pendingPromptsRef = useRef(new Map<string, string>());
  const activeTargetRef = useRef(activeTarget);
  const settingsRef = useRef<AppSettings | undefined>(undefined);
  const activeInstallationRef = useRef<OmpInstallation | undefined>(undefined);
  const installationsRef = useRef<OmpInstallation[]>([]);
  const sessionsLoadGenerationRef = useRef(0);
  const themeLoadGenerationRef = useRef(0);
  const workspaceRequestGenerationRef = useRef(0);
  const newSessionRequestGenerationRef = useRef(0);
  const runtimeInstallationIdRef = useRef<string | undefined>(undefined);

  const setActiveTarget = useCallback((update: ActiveTarget | ((current: ActiveTarget) => ActiveTarget)): void => {
    setActiveTargetState(current => {
      const next = typeof update === "function" ? update(current) : update;
      activeTargetRef.current = next;
      return next;
    });
  }, []);

  const activeSession = targetSession(activeTarget);
  const workspace = targetWorkspace(activeTarget);
  const activeSessionPath = targetSessionPath(activeTarget);

  const defaultInstallation = useMemo(() => selectedInstallation(environment, settings), [environment, settings]);
  const activeInstallation = useMemo(() => {
    const requestedId = targetInstallationId(activeTarget) ?? defaultInstallation?.id;
    return environment?.installations.find(item => item.id === requestedId);
  }, [activeTarget, defaultInstallation, environment]);
  settingsRef.current = settings;
  activeInstallationRef.current = activeInstallation;
  installationsRef.current = environment?.installations ?? [];

  const loadSessions = useCallback(async (): Promise<{ failedInstallationIds: string[] }> => {
    const requestedInstallations = [...installationsRef.current];
    const generation = sessionsLoadGenerationRef.current + 1;
    sessionsLoadGenerationRef.current = generation;
    if (requestedInstallations.length === 0) {
      setSessions([]);
      return { failedInstallationIds: [] };
    }
    const requestedIdentity = JSON.stringify(requestedInstallations.map(item => item.id).sort());
    const result = await collectAvailableSessionGroups(requestedInstallations.map(item => ({
      installationId: item.id,
      sessions: window.ompDesktop.sessions.list({
        installationId: item.id,
        includeArchived: showArchived,
      }),
    })));
    const currentIdentity = JSON.stringify(installationsRef.current.map(item => item.id).sort());
    if (sessionsLoadGenerationRef.current !== generation || currentIdentity !== requestedIdentity) {
      return { failedInstallationIds: result.failedInstallationIds };
    }
    if (result.groups.length === 0 && result.failedInstallationIds.length > 0) {
      const firstError = result.errors[0];
      throw new Error(firstError instanceof Error
        ? `无法刷新会话列表：${firstError.message}`
        : "当前所有 OMP 运行环境都暂时无法刷新");
    }
    const next = mergeSessions(result.groups);
    setSessions(next);
    setActiveTarget(current => reconcileTarget(current, next));
    return { failedInstallationIds: result.failedInstallationIds };
  }, [setActiveTarget, showArchived]);

  const applySessionUpdate = useCallback((updated: SessionSummary): void => {
    setSessions(current => !showArchived && updated.archived
      ? removeSessionSummary(current, updated)
      : replaceSessionSummary(current, updated));
    setActiveTarget(current => {
      if (!sessionMatchesIdentity(
        targetInstallationId(current),
        targetSessionPath(current),
        updated.installationId,
        updated.path,
      )) return current;
      return savedSessionTarget(updated, current.key);
    });
  }, [setActiveTarget, showArchived]);

  const applySessionRemoval = useCallback((removed: SessionSummary): void => {
    setSessions(current => removeSessionSummary(current, removed));
  }, []);

  const refreshSessionsAfterSuccess = useCallback(async (successMessage: string): Promise<void> => {
    try {
      const result = await loadSessions();
      setNotice(result.failedInstallationIds.length > 0
        ? `${successMessage}；部分离线运行环境将在恢复后刷新`
        : successMessage);
    } catch {
      setNotice(`${successMessage}；会话列表暂未刷新，可稍后重试`);
    }
  }, [loadSessions]);

  const loadTheme = useCallback(async (): Promise<void> => {
    const installation = activeInstallationRef.current;
    const currentSettings = settingsRef.current;
    if (!installation || !currentSettings) return;
    const generation = themeLoadGenerationRef.current + 1;
    themeLoadGenerationRef.current = generation;
    const requestedInstallationId = installation.id;
    const next = await window.ompDesktop.theme.get({
      installationId: installation.id,
      mode: desiredThemeMode(currentSettings),
    });
    if (themeLoadGenerationRef.current !== generation
      || activeInstallationRef.current?.id !== requestedInstallationId) return;
    setTheme(current => {
      if (current && JSON.stringify(current) === JSON.stringify(next)) return current;
      applyTheme(next);
      return next;
    });
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([window.ompDesktop.environment.detect(), window.ompDesktop.settings.get()])
      .then(async ([detected, savedSettings]) => {
        if (!active) return;
        setEnvironment(detected);
        const migration = migrateLegacySettings(detected, savedSettings);
        const { handedOffSessions, ...ordinaryMigration } = migration;
        let resolved = savedSettings;
        const migrationErrors: string[] = [];
        if (handedOffSessions) {
          try {
            resolved = await window.ompDesktop.settings.migrateHandoffs(handedOffSessions);
          } catch (migrationError) {
            migrationErrors.push(migrationError instanceof Error ? migrationError.message : String(migrationError));
          }
        }
        if (Object.keys(ordinaryMigration).length > 0) {
          try {
            resolved = await window.ompDesktop.settings.update(ordinaryMigration);
          } catch (migrationError) {
            migrationErrors.push(migrationError instanceof Error ? migrationError.message : String(migrationError));
          }
        }
        if (migrationErrors.length > 0) {
          // Migration is optional. Preserve each unresolved value (especially
          // conservative terminal leases) and still load the rest of the app.
          setFatalError(`部分旧版设置暂未迁移，已按安全状态启动：${migrationErrors.join("；")}`);
        }
        if (!active) return;
        setSettings(resolved);
        if (detected.installations.length === 0) setSettingsOpen(true);
      })
      .catch(error => setFatalError(error instanceof Error ? error.message : String(error)));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    void loadSessions().catch(error => setFatalError(error instanceof Error ? error.message : String(error)));
    return () => {
      sessionsLoadGenerationRef.current += 1;
    };
  }, [environment, loadSessions]);

  useEffect(() => {
    if (!activeInstallation || !settings) return;
    void loadTheme().catch(error => setFatalError(error instanceof Error ? error.message : String(error)));
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const refresh = (): void => void loadTheme().catch(() => undefined);
    media.addEventListener("change", refresh);
    const interval = window.setInterval(refresh, 4_000);
    return () => {
      media.removeEventListener("change", refresh);
      window.clearInterval(interval);
      themeLoadGenerationRef.current += 1;
    };
  }, [activeInstallation, loadTheme, settings?.themeMode]);

  useEffect(() => {
    if (!defaultInstallation) return;
    setActiveTarget(current => {
      if (current.kind !== "new" || current.installationId || current.sessionPath) return current;
      return chooseTargetInstallation(current, defaultInstallation.id, current.key);
    });
  }, [defaultInstallation, setActiveTarget]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(undefined), 5_000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    const stopFrame = window.ompDesktop.runtime.onFrame(event => {
      if (runtimeIdRef.current !== event.runtimeId) return;
      dispatchConversation(event.frame);
      if (event.frame.type === "response" && event.frame.success === false) {
        const isRetryableHistoryError = event.frame.command === "get_messages_page"
          && ["session_busy", "stale_cursor"].includes(String(event.frame.code));
        if (!isRetryableHistoryError) {
          const message = typeof event.frame.error === "string" ? event.frame.error : "OMP 命令执行失败";
          setFatalError(message);
          if (event.frame.command === "prompt" && typeof event.frame.id === "string") {
            const prompt = pendingPromptsRef.current.get(event.frame.id);
            if (prompt) setEditorUpdate({ key: crypto.randomUUID(), messages: [prompt] });
            pendingPromptsRef.current.delete(event.frame.id);
          }
        }
      }
      if (event.frame.type === "response" && event.frame.success === true && event.frame.command === "get_available_models") {
        const data = event.frame.data && typeof event.frame.data === "object"
          ? event.frame.data as Record<string, unknown>
          : undefined;
        const models = Array.isArray(data?.models) ? data.models : [];
        setAvailableModels(models.flatMap(raw => {
          if (!raw || typeof raw !== "object") return [];
          const model = raw as Record<string, unknown>;
          if (typeof model.provider !== "string" || typeof model.id !== "string") return [];
          return [{
            provider: model.provider,
            id: model.id,
            name: typeof model.name === "string" ? model.name : undefined,
            reasoning: typeof model.reasoning === "boolean" ? model.reasoning : undefined,
            contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : undefined,
          }];
        }));
      }
      if (event.frame.type === "response" && event.frame.success === true && event.frame.command === "get_state") {
        const data = event.frame.data && typeof event.frame.data === "object"
          ? event.frame.data as Record<string, unknown>
          : undefined;
        if (typeof data?.sessionFile === "string") {
          runtimeSessionPathRef.current = data.sessionFile;
          const targetKey = runtimeTargetKeyRef.current;
          if (targetKey) {
            setActiveTarget(current => attachTargetSessionPath(current, targetKey, data.sessionFile as string));
          }
          setRuntime(current => current ? { ...current, sessionPath: data.sessionFile as string } : current);
        }
      }
      if (event.frame.type === "session_info_update" && typeof event.frame.sessionFile === "string") {
        runtimeSessionPathRef.current = event.frame.sessionFile;
        const targetKey = runtimeTargetKeyRef.current;
        if (targetKey) {
          setActiveTarget(current => attachTargetSessionPath(current, targetKey, event.frame.sessionFile as string));
        }
      }
      if (event.frame.type === "response" && event.frame.success === true && event.frame.command === "prompt") {
        const data = event.frame.data && typeof event.frame.data === "object"
          ? event.frame.data as Record<string, unknown>
          : undefined;
        if (data?.agentInvoked === false && typeof event.frame.id === "string") {
          pendingPromptsRef.current.delete(event.frame.id);
        }
      }
      if (event.frame.type === "prompt_result" && event.frame.agentInvoked === false && typeof event.frame.id === "string") {
        pendingPromptsRef.current.delete(event.frame.id);
      }
      if (event.frame.type === "response" && event.frame.command === "get_messages_page") {
        const runtimeId = runtimeIdRef.current;
        const data = event.frame.data && typeof event.frame.data === "object"
          ? event.frame.data as Record<string, unknown>
          : undefined;
        if (event.frame.success === false && ["session_busy", "stale_cursor"].includes(String(event.frame.code))) {
          if (runtimeId) {
            void window.ompDesktop.runtime.send(runtimeId, {
              id: `history-fallback-${crypto.randomUUID()}`,
              type: "get_messages",
            }).catch(() => undefined);
          }
        } else if (runtimeId && typeof data?.nextCursor === "string") {
          void window.ompDesktop.runtime.send(runtimeId, {
            id: `history-next-${crypto.randomUUID()}`,
            type: "get_messages_page",
            cursor: data.nextCursor,
            limit: 256,
          }).catch(() => undefined);
        }
      }
      if (event.frame.type === "extension_ui_request") {
        const method = String(event.frame.method ?? "");
        if (["select", "confirm", "input", "editor"].includes(method)) setPendingRequest(event.frame);
        if (method === "cancel") {
          setPendingRequest(current => String(current?.id) === String(event.frame.targetId) ? undefined : current);
        }
        if (method === "set_editor_text" && typeof event.frame.text === "string") {
          setEditorUpdate({ key: crypto.randomUUID(), messages: [event.frame.text], force: true });
        }
        if (method === "notify" && typeof event.frame.message === "string") {
          setFatalError(event.frame.notifyType === "error" ? event.frame.message : undefined);
        }
        if (method === "open_url" && typeof event.frame.url === "string" && /^https?:\/\//.test(event.frame.url)) {
          window.open(event.frame.url, "_blank", "noopener,noreferrer");
        }
      }
      if (event.frame.type === "model_changed") {
        const runtimeId = runtimeIdRef.current;
        if (runtimeId) {
          void window.ompDesktop.runtime.send(runtimeId, {
            id: `state-model-${crypto.randomUUID()}`,
            type: "get_state",
          }).catch(() => undefined);
        }
      }
      if (event.frame.type === "agent_end" && event.frame.isTerminal !== false) {
        const oldestPromptId = pendingPromptsRef.current.keys().next().value as string | undefined;
        if (oldestPromptId) pendingPromptsRef.current.delete(oldestPromptId);
      }
    });
    const stopStatus = window.ompDesktop.runtime.onStatus(event => {
      if (runtimeIdRef.current !== event.runtimeId) return;
      runtimeInstallationIdRef.current = event.descriptor.installationId;
      setRuntime(current => ({
        ...event.descriptor,
        sessionPath: event.descriptor.sessionPath ?? current?.sessionPath,
      }));
      if (event.descriptor.sessionPath) runtimeSessionPathRef.current = event.descriptor.sessionPath;
      if (event.descriptor.state === "failed" && event.descriptor.error) setFatalError(event.descriptor.error);
      const releaseOwnership = (): void => {
        runtimeIdRef.current = undefined;
        runtimeSessionPathRef.current = undefined;
        runtimeInstallationIdRef.current = undefined;
        runtimeTargetKeyRef.current = undefined;
        const pendingPrompts = [...pendingPromptsRef.current.values()];
        if (pendingPrompts.length > 0) setEditorUpdate({ key: crypto.randomUUID(), messages: pendingPrompts });
        pendingPromptsRef.current.clear();
      };
      if (event.descriptor.state === "exited") {
        releaseOwnership();
      } else if (event.descriptor.state === "failed") {
        void window.ompDesktop.runtime.list().then(descriptors => {
          if (runtimeIdRef.current !== event.runtimeId) return;
          const managed = descriptors.find(descriptor => descriptor.runtimeId === event.runtimeId);
          if (!managed) {
            releaseOwnership();
            return;
          }
          runtimeSessionPathRef.current = managed.sessionPath ?? runtimeSessionPathRef.current;
          runtimeInstallationIdRef.current = managed.installationId;
          setRuntime(managed);
        }).catch(() => {
          // Retaining ownership is the safe choice when the main process cannot confirm exit.
        });
      }
      if (["completed", "failed", "exited"].includes(event.descriptor.state)) void loadSessions().catch(() => undefined);
    });
    return () => {
      stopFrame();
      stopStatus();
    };
  }, [loadSessions, setActiveTarget]);

  const stopRuntime = useCallback(async (): Promise<void> => {
    runtimeGenerationRef.current += 1;
    const runtimeId = runtimeIdRef.current;
    const inFlightStart = runtimeStartRef.current;
    try {
      if (runtimeId) await window.ompDesktop.runtime.stop(runtimeId);
      if (inFlightStart) {
        const startingDescriptor = await inFlightStart.catch(() => undefined);
        if (startingDescriptor && startingDescriptor.runtimeId !== runtimeId) {
          await window.ompDesktop.runtime.stop(startingDescriptor.runtimeId);
        }
      }
    } catch (error) {
      const [remaining] = await window.ompDesktop.runtime.list().catch(() => []);
      if (remaining) {
        runtimeIdRef.current = remaining.runtimeId;
        runtimeSessionPathRef.current = remaining.sessionPath;
        runtimeInstallationIdRef.current = remaining.installationId;
        setRuntime(remaining);
      }
      throw error;
    }
    runtimeIdRef.current = undefined;
    runtimeSessionPathRef.current = undefined;
    runtimeInstallationIdRef.current = undefined;
    runtimeTargetKeyRef.current = undefined;
    setRuntime(undefined);
    setPendingRequest(undefined);
    setAvailableModels([]);
    const pendingPrompts = [...pendingPromptsRef.current.values()];
    if (pendingPrompts.length > 0) setEditorUpdate({ key: crypto.randomUUID(), messages: pendingPrompts });
    pendingPromptsRef.current.clear();
  }, []);

  const startRuntime = useCallback(
    async (
      requestedTarget: ActiveTarget = activeTargetRef.current,
      reclaimHandoff = false,
    ): Promise<RuntimeDescriptor> => {
      if (!settings) throw new Error("OMP 尚未准备好");
      const requestedSession = targetSession(requestedTarget);
      const requestedInstallationId = targetInstallationId(requestedTarget)
        ?? (requestedTarget.kind === "new" ? defaultInstallation?.id : undefined);
      const requestedInstallation = requestedSession
        ? installationForSession(environment, requestedSession)
        : environment?.installations.find(item => item.id === requestedInstallationId);
      if (!requestedInstallation) throw new Error("这个会话绑定的 OMP 运行环境当前不可用");
      const cwd = targetWorkspace(requestedTarget);
      if (!cwd) throw new Error("请先选择工作区");
      if (runtimeIdRef.current || runtimeStartRef.current) await stopRuntime();
      const generation = runtimeGenerationRef.current + 1;
      runtimeGenerationRef.current = generation;
      runtimeIdRef.current = undefined;
      runtimeSessionPathRef.current = targetSessionPath(requestedTarget);
      runtimeInstallationIdRef.current = requestedInstallation.id;
      runtimeTargetKeyRef.current = requestedTarget.key;
      if (runtimeGenerationRef.current !== generation) throw new Error("会话切换已被新的操作取代");
      setRuntime({
        runtimeId: "starting",
        state: "starting",
        cwd,
        installationId: requestedInstallation.id,
        runtimeKind: requestedInstallation.kind,
        profile: requestedInstallation.profile,
        distro: requestedInstallation.distro,
      });
      setPendingRequest(undefined);
      setAvailableModels([]);
      const interruptedPrompts = [...pendingPromptsRef.current.values()];
      if (interruptedPrompts.length > 0) {
        setEditorUpdate({ key: crypto.randomUUID(), messages: interruptedPrompts });
      }
      pendingPromptsRef.current.clear();
      dispatchConversation({ type: "__reset" });
      let descriptor: RuntimeDescriptor | undefined;
      try {
        const input = {
          installationId: requestedInstallation.id,
          path: cwd,
          sessionPath: targetSessionPath(requestedTarget),
        };
        const startPromise = reclaimHandoff && input.sessionPath
          ? window.ompDesktop.sessions.reclaim({ ...input, sessionPath: input.sessionPath }).then(result => {
            setSettings(result.settings);
            return result.descriptor;
          })
          : window.ompDesktop.runtime.start(input);
        runtimeStartRef.current = startPromise;
        try {
          descriptor = await startPromise;
        } finally {
          if (runtimeStartRef.current === startPromise) runtimeStartRef.current = undefined;
        }
        if (runtimeGenerationRef.current !== generation) {
          await window.ompDesktop.runtime.stop(descriptor.runtimeId);
          throw new Error("会话切换已被新的操作取代");
        }
        runtimeIdRef.current = descriptor.runtimeId;
        runtimeSessionPathRef.current = descriptor.sessionPath;
        runtimeInstallationIdRef.current = descriptor.installationId;
        setRuntime(descriptor);
        await window.ompDesktop.runtime.send(descriptor.runtimeId, {
          id: `state-${crypto.randomUUID()}`,
          type: "get_state",
        });
        if (targetSessionPath(requestedTarget)) {
          await window.ompDesktop.runtime.send(descriptor.runtimeId, {
            id: `history-${crypto.randomUUID()}`,
            type: "get_messages_page",
            limit: 256,
          });
        }
        await window.ompDesktop.runtime.send(descriptor.runtimeId, {
          id: `models-${crypto.randomUUID()}`,
          type: "get_available_models",
        });
        return descriptor;
      } catch (error) {
        let finalError: unknown = error;
        if (descriptor) {
          try {
            await window.ompDesktop.runtime.stop(descriptor.runtimeId);
          } catch (stopError) {
            finalError = new AggregateError([error, stopError], "OMP 启动失败，且无法安全停止后台进程");
          }
        }
        if (runtimeGenerationRef.current === generation) {
          const [remaining] = await window.ompDesktop.runtime.list().catch(() => []);
          runtimeIdRef.current = remaining?.runtimeId;
          runtimeSessionPathRef.current = remaining?.sessionPath;
          runtimeInstallationIdRef.current = remaining?.installationId;
          if (!remaining) runtimeTargetKeyRef.current = undefined;
          setRuntime(remaining);
        }
        throw finalError;
      }
    },
    [defaultInstallation, environment, settings, stopRuntime],
  );

  const openNewSessionDialog = useCallback((): void => {
    if (switchingSession
      || sending
      || terminalBusy
      || deletingSession
      || reclaimingSession
      || creatingNewSession
      || ["starting", "aborting"].includes(runtime?.state ?? "")
      || document.querySelector('[role="dialog"]')
      || pendingRequest
      || pendingRename
      || pendingTrash
      || pendingDelete
      || pendingReclaim
      || settingsOpen
      || newSessionDraft) return;
    const preferredInstallation = defaultInstallation
      ?? environment?.installations.find(item => item.profile === undefined)
      ?? environment?.installations[0];
    newSessionRequestGenerationRef.current += 1;
    setNewSessionError(undefined);
    setNewSessionReturnFocus(document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
    setNewSessionDraft({ installationId: preferredInstallation?.id });
  }, [
    creatingNewSession,
    defaultInstallation,
    deletingSession,
    environment,
    newSessionDraft,
    pendingDelete,
    pendingReclaim,
    pendingRename,
    pendingRequest,
    pendingTrash,
    reclaimingSession,
    runtime?.state,
    sending,
    settingsOpen,
    switchingSession,
    terminalBusy,
  ]);

  const cancelNewSessionDialog = useCallback((): void => {
    if (creatingNewSession) return;
    newSessionRequestGenerationRef.current += 1;
    setNewSessionError(undefined);
    setNewSessionDraft(undefined);
    selectingNewSessionWorkspaceRef.current = false;
    setSelectingNewSessionWorkspace(false);
  }, [creatingNewSession]);

  useEffect(() => {
    if (newSessionDraft || creatingNewSession || !newSessionReturnFocus) return;
    const target = newSessionReturnFocus;
    setNewSessionReturnFocus(undefined);
    window.requestAnimationFrame(() => {
      if (target.isConnected && !(target instanceof HTMLButtonElement && target.disabled)) target.focus();
      else document.querySelector<HTMLTextAreaElement>(".composer textarea:not(:disabled)")?.focus();
    });
  }, [creatingNewSession, newSessionDraft, newSessionReturnFocus]);

  const selectNewSessionInstallation = (installationId: string): void => {
    if (!environment?.installations.some(item => item.id === installationId)) {
      setNewSessionError("所选 OMP 运行位置当前不可用");
      return;
    }
    newSessionRequestGenerationRef.current += 1;
    setNewSessionError(undefined);
    setNewSessionDraft(current => current
      ? {
          installationId,
          ...(current.installationId === installationId && current.workspace
            ? { workspace: current.workspace }
            : {}),
        }
      : current);
  };

  const chooseNewSessionWorkspace = async (): Promise<void> => {
    const draft = newSessionDraft;
    if (selectingNewSessionWorkspaceRef.current || creatingNewSessionRef.current) return;
    if (!draft?.installationId) {
      setNewSessionError("请先选择 OMP 运行环境及对应的 Profile");
      return;
    }
    const requestGeneration = newSessionRequestGenerationRef.current + 1;
    newSessionRequestGenerationRef.current = requestGeneration;
    selectingNewSessionWorkspaceRef.current = true;
    setSelectingNewSessionWorkspace(true);
    setNewSessionError(undefined);
    try {
      const selected = await window.ompDesktop.system.chooseWorkspace(draft.installationId);
      if (!selected || newSessionRequestGenerationRef.current !== requestGeneration) return;
      setNewSessionDraft(current => current?.installationId === draft.installationId
        ? { ...current, workspace: selected }
        : current);
    } catch (error) {
      setNewSessionError(error instanceof Error ? error.message : String(error));
    } finally {
      selectingNewSessionWorkspaceRef.current = false;
      setSelectingNewSessionWorkspace(false);
    }
  };

  const confirmNewSession = async (): Promise<void> => {
    const draft = newSessionDraft;
    if (creatingNewSessionRef.current || selectingNewSessionWorkspace) return;
    if (!draft?.installationId || !draft.workspace) {
      setNewSessionError("请选择运行位置、OMP Profile 和项目目录");
      return;
    }
    if (switchingSession
      || sending
      || terminalBusy
      || deletingSession
      || reclaimingSession
      || ["starting", "aborting"].includes(runtime?.state ?? "")
      || pendingRequest
      || pendingRename
      || pendingTrash
      || pendingDelete
      || pendingReclaim
      || settingsOpen) {
      setNewSessionError("另一项操作仍在进行，请完成后再创建新会话");
      return;
    }
    const installation = environment?.installations.find(item => item.id === draft.installationId);
    if (!installation) {
      setNewSessionError("所选 OMP 运行位置当前不可用，请重新选择");
      return;
    }
    creatingNewSessionRef.current = true;
    setCreatingNewSession(true);
    setSwitchingSession(true);
    setNewSessionError(undefined);
    try {
      await stopRuntime();
      workspaceRequestGenerationRef.current += 1;
      newSessionRequestGenerationRef.current += 1;
      const target = chooseTargetWorkspace(
        newSessionTarget(crypto.randomUUID(), installation.id),
        draft.workspace,
      );
      setEditorUpdate(undefined);
      setActiveTarget(target);
      dispatchConversation({ type: "__reset" });
      setNewSessionDraft(undefined);
      setNotice("新会话已建立，可以开始与 OMP 对话");
      const latestSettings = settingsRef.current;
      try {
        const updated = await window.ompDesktop.settings.update({
          recentWorkspaces: {
            ...latestSettings?.recentWorkspaces,
            [installation.id]: draft.workspace,
          },
        });
        setSettings(updated);
      } catch (settingsError) {
        setFatalError(`新会话已建立，但最近项目记录保存失败：${settingsError instanceof Error ? settingsError.message : String(settingsError)}`);
      }
    } catch (error) {
      setNewSessionError(error instanceof Error ? error.message : String(error));
    } finally {
      creatingNewSessionRef.current = false;
      setCreatingNewSession(false);
      setSwitchingSession(false);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        openNewSessionDialog();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openNewSessionDialog]);

  const resumeSession = async (session: SessionSummary, reclaimHandoff = false): Promise<RuntimeDescriptor> => {
    if (switchingSession) throw new Error("另一项会话切换仍在进行");
    setSwitchingSession(true);
    workspaceRequestGenerationRef.current += 1;
    try {
      const nextTarget = savedSessionTarget(session);
      const descriptor = await startRuntime(nextTarget, reclaimHandoff);
      setActiveTarget(nextTarget);
      return descriptor;
    } finally {
      setSwitchingSession(false);
    }
  };

  const openSession = async (session: SessionSummary): Promise<void> => {
    const handedOff = hasSessionHandoff(
      settings?.handedOffSessions,
      installationForSession(environment, session),
      session.path,
    );
    if (handedOff) {
      setPendingReclaim(session);
      return;
    }
    setFatalError(undefined);
    try {
      await resumeSession(session);
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error));
    }
  };

  const submit = async (message: string): Promise<void> => {
    setSending(true);
    setFatalError(undefined);
    let promptId: string | undefined;
    try {
      let runtimeId = runtimeIdRef.current;
      if (runtimeId && runtimeTargetKeyRef.current !== activeTargetRef.current.key) {
        runtimeId = undefined;
      }
      if (!runtimeId) runtimeId = (await startRuntime(activeTargetRef.current)).runtimeId;
      promptId = `prompt-${crypto.randomUUID()}`;
      pendingPromptsRef.current.set(promptId, message);
      await window.ompDesktop.runtime.send(runtimeId, {
        id: promptId,
        type: "prompt",
        message,
        streamingBehavior: "followUp",
      });
    } catch (error) {
      if (promptId) pendingPromptsRef.current.delete(promptId);
      setFatalError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setSending(false);
    }
  };

  const updateSettings = async (patch: Partial<AppSettings>): Promise<void> => {
    try {
      const updated = await window.ompDesktop.settings.update(patch);
      setSettings(updated);
      const selectedInstallationId = patch.selectedInstallationId;
      const currentTarget = activeTargetRef.current;
      if (selectedInstallationId
        && environment?.installations.some(item => item.id === selectedInstallationId)
        && currentTarget.kind === "new"
        && !currentTarget.sessionPath
        && !runtimeIdRef.current
        && !runtimeStartRef.current) {
        const nextTarget = chooseTargetInstallation(currentTarget, selectedInstallationId);
        if (nextTarget !== currentTarget) {
          workspaceRequestGenerationRef.current += 1;
          setActiveTarget(nextTarget);
          dispatchConversation({ type: "__reset" });
        }
      }
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error));
    }
  };

  const updateSession = async (session: SessionSummary, patch: SessionMetadataPatch): Promise<void> => {
    setFatalError(undefined);
    try {
      if (!installationForSession(environment, session)) throw new Error("这个会话绑定的 OMP 运行环境当前不可用");
      const updated = await window.ompDesktop.sessions.update({
        installationId: session.installationId,
        path: session.path,
      }, patch);
      applySessionUpdate(updated);
      await refreshSessionsAfterSuccess("会话设置已保存");
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error));
    }
  };

  const sessionIsHandedOff = (session: SessionSummary): boolean => hasSessionHandoff(
    settings?.handedOffSessions,
    installationForSession(environment, session),
    session.path,
  );

  const requestRename = (session: SessionSummary): void => {
    setFatalError(undefined);
    setRenameError(undefined);
    setPendingRename(session);
  };

  const renameSession = async (value: string): Promise<void> => {
    if (!pendingRename) return;
    const validation = validateSessionTitle(value);
    if (!validation.valid) {
      setRenameError(validation.error);
      return;
    }
    if (!installationForSession(environment, pendingRename)) {
      setRenameError("OMP 安装环境尚未准备好");
      return;
    }
    setRenamingSession(true);
    setRenameError(undefined);
    try {
      const updated = await window.ompDesktop.sessions.update({
        installationId: pendingRename.installationId,
        path: pendingRename.path,
      }, { displayTitle: validation.title });
      applySessionUpdate(updated);
      setPendingRename(undefined);
      await refreshSessionsAfterSuccess("会话名称已更新");
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : String(error));
    } finally {
      setRenamingSession(false);
    }
  };

  const requestTrash = (session: SessionSummary): void => {
    if (sessionIsHandedOff(session)) {
      setFatalError("该会话仍标记为由原始 OMP 终端使用。请先继续会话并确认重新接管，再执行移动操作");
      return;
    }
    setPendingTrash(session);
  };

  const requestPermanentDelete = (session: SessionSummary): void => {
    if (sessionIsHandedOff(session)) {
      setFatalError("该会话仍标记为由原始 OMP 终端使用。请先继续会话并确认重新接管，再执行永久删除");
      return;
    }
    setPendingDelete(session);
  };

  const trashSession = async (): Promise<void> => {
    if (!pendingTrash) return;
    const session = pendingTrash;
    const sessionInstallation = installationForSession(environment, session);
    if (!sessionInstallation) {
      setFatalError("这个会话绑定的 OMP 运行环境当前不可用");
      return;
    }
    const ownsSession = sessionMatchesIdentity(
      targetInstallationId(activeTargetRef.current),
      targetSessionPath(activeTargetRef.current),
      session.installationId,
      session.path,
    ) || sessionMatchesIdentity(
      runtimeInstallationIdRef.current,
      runtimeSessionPathRef.current,
      session.installationId,
      session.path,
    );
    setDeletingSession(true);
    setFatalError(undefined);
    try {
      if (sessionIsHandedOff(session)) throw new Error("原始 OMP 终端仍可能正在使用该会话");
      if (ownsSession) await stopRuntime();
      await window.ompDesktop.sessions.trash({
        installationId: sessionInstallation.id,
        path: session.path,
      });
      applySessionRemoval(session);
      if (ownsSession) {
        setActiveTarget(newSessionTarget(crypto.randomUUID(), defaultInstallation?.id));
        dispatchConversation({ type: "__reset" });
      }
      setPendingTrash(undefined);
      await refreshSessionsAfterSuccess("会话已移到可恢复回收站");
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletingSession(false);
    }
  };

  const deleteSessionPermanently = async (): Promise<void> => {
    if (!pendingDelete) return;
    const session = pendingDelete;
    const sessionInstallation = installationForSession(environment, session);
    if (!sessionInstallation) {
      setFatalError("这个会话绑定的 OMP 运行环境当前不可用");
      return;
    }
    const ownsSession = sessionMatchesIdentity(
      targetInstallationId(activeTargetRef.current),
      targetSessionPath(activeTargetRef.current),
      session.installationId,
      session.path,
    ) || sessionMatchesIdentity(
      runtimeInstallationIdRef.current,
      runtimeSessionPathRef.current,
      session.installationId,
      session.path,
    );
    setDeletingSession(true);
    setFatalError(undefined);
    try {
      if (sessionIsHandedOff(session)) throw new Error("原始 OMP 终端仍可能正在使用该会话");
      if (ownsSession) await stopRuntime();
      await window.ompDesktop.sessions.delete({
        installationId: sessionInstallation.id,
        path: session.path,
      });
      applySessionRemoval(session);
      if (ownsSession) {
        setActiveTarget(newSessionTarget(crypto.randomUUID(), defaultInstallation?.id));
        dispatchConversation({ type: "__reset" });
      }
      setPendingDelete(undefined);
      await refreshSessionsAfterSuccess("会话及其附件已彻底删除");
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletingSession(false);
    }
  };

  const reclaimSession = async (): Promise<void> => {
    if (!pendingReclaim || !settings) return;
    const session = pendingReclaim;
    const sessionInstallation = installationForSession(environment, session);
    if (!sessionInstallation) {
      setFatalError("这个会话绑定的 OMP 运行环境当前不可用");
      return;
    }
    setReclaimingSession(true);
    setFatalError(undefined);
    try {
      await resumeSession(session, true);
      setPendingReclaim(undefined);
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error));
    } finally {
      setReclaimingSession(false);
    }
  };

  const openTerminal = async (session?: SessionSummary): Promise<void> => {
    if (!settings) return;
    const selectedSession = session ?? activeSession;
    const terminalInstallation = selectedSession
      ? installationForSession(environment, selectedSession)
      : activeInstallation;
    if (!terminalInstallation) {
      setFatalError("这个会话绑定的 OMP 运行环境当前不可用");
      return;
    }
    const isCurrentSession = !session || sessionMatchesIdentity(
      targetInstallationId(activeTargetRef.current),
      targetSessionPath(activeTargetRef.current),
      session.installationId,
      session.path,
    ) || sessionMatchesIdentity(
      runtimeInstallationIdRef.current,
      runtimeSessionPathRef.current,
      session.installationId,
      session.path,
    );
    const cwd = selectedSession?.cwd ?? workspace;
    if (!cwd) return;
    const sessionPath = isCurrentSession
      ? (selectedSession?.path ?? runtimeSessionPathRef.current ?? runtime?.sessionPath)
      : selectedSession?.path;
    if (!sessionPath) {
      setFatalError("请先在桌面端发送消息并创建会话，再交给原始 OMP 终端");
      return;
    }
    if (sessionPath && hasSessionHandoff(settings.handedOffSessions, terminalInstallation, sessionPath)) {
      setFatalError("该会话已经交给原始 OMP 终端；请勿重复启动同一会话");
      return;
    }
    setFatalError(undefined);
    setTerminalBusy(true);
    try {
      if (isCurrentSession) await stopRuntime();
      const updated = await window.ompDesktop.system.handoffToTerminal({
        installationId: terminalInstallation.id,
        path: cwd,
        sessionPath,
      });
      setSettings(updated);
      if (isCurrentSession) {
        setActiveTarget(newSessionTarget(crypto.randomUUID(), defaultInstallation?.id));
        dispatchConversation({ type: "__reset" });
      }
      setNotice(isCurrentSession
        ? "会话已交给原始 OMP 终端；桌面端已切换到新会话"
        : "会话已在新的原始 OMP 终端窗口中打开");
    } catch (error) {
      const latestSettings = await window.ompDesktop.settings.get().catch(() => undefined);
      if (latestSettings) setSettings(latestSettings);
      setFatalError(error instanceof Error ? error.message : String(error));
    } finally {
      setTerminalBusy(false);
    }
  };

  const refreshSession = async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    setFatalError(undefined);
    try {
      let runtimeId = runtimeIdRef.current;
      const currentTarget = activeTargetRef.current;
      if (!runtimeId && targetSessionPath(currentTarget)) {
        runtimeId = (await startRuntime(currentTarget)).runtimeId;
      } else if (runtimeId) {
        await window.ompDesktop.runtime.send(runtimeId, {
          id: `refresh-state-${crypto.randomUUID()}`,
          type: "get_state",
        });
        if (targetSessionPath(currentTarget) || runtimeSessionPathRef.current) {
          await window.ompDesktop.runtime.send(runtimeId, {
            id: `refresh-history-${crypto.randomUUID()}`,
            type: "get_messages_page",
            limit: 256,
          });
        }
        await window.ompDesktop.runtime.send(runtimeId, {
          id: `refresh-models-${crypto.randomUUID()}`,
          type: "get_available_models",
        });
      }
      await Promise.all([loadSessions(), loadTheme()]);
      setNotice(runtimeId ? "当前会话已请求重新载入" : "会话列表和主题已刷新");
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshing(false);
    }
  };

  const selectModel = async (model: OmpModelInfo): Promise<void> => {
    const runtimeId = runtimeIdRef.current;
    if (!runtimeId) return;
    setFatalError(undefined);
    try {
      await window.ompDesktop.runtime.send(runtimeId, {
        id: `set-model-${crypto.randomUUID()}`,
        type: "set_model",
        provider: model.provider,
        modelId: model.id,
      });
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error));
    }
  };

  const filteredSessions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return sessions;
    return sessions.filter(session =>
      [session.title, session.cwd, session.projectName, session.runtimeLabel, ...session.tags]
        .some(value => value.toLowerCase().includes(normalized)),
    );
  }, [query, sessions]);

  const workspaceSelectable = activeTarget.kind === "new"
    && !activeTarget.sessionPath
    && !runtime
    && Boolean(activeInstallation)
    && !switchingSession;
  const transitionBusy = switchingSession
    || sending
    || terminalBusy
    || deletingSession
    || reclaimingSession
    || ["starting", "aborting"].includes(runtime?.state ?? "");
  const activeTargetInstallationId = targetInstallationId(activeTarget) ?? activeInstallation?.id;
  const activeSessionKey = activeTargetInstallationId && activeSessionPath
    ? sessionIdentity(activeTargetInstallationId, activeSessionPath)
    : undefined;
  const handedOffSessionKeys = sessions
    .filter(session => sessionIsHandedOff(session))
    .map(sessionSummaryIdentity);

  const respondToPermission = (frame: RpcFrame): void => {
    const runtimeId = runtimeIdRef.current;
    if (!runtimeId) return;
    setPendingRequest(undefined);
    void window.ompDesktop.runtime.send(runtimeId, frame).catch(error =>
      setFatalError(error instanceof Error ? error.message : String(error)),
    );
  };

  if (!environment || !settings) {
    return (
      <div className="boot-screen">
        <div className="boot-mark"><BrandMark /></div>
        <strong>正在连接 OMP</strong>
        <span>检查 OMP 运行环境、会话和主题…</span>
      </div>
    );
  }

  return (
    <div className={`app-shell${sidebarCollapsed ? " app-shell--collapsed" : ""}`}>
      <Sidebar
        collapsed={sidebarCollapsed}
        sessions={filteredSessions}
        installations={environment.installations}
        activeInstallationId={activeTargetInstallationId}
        activeSessionKey={activeSessionKey}
        query={query}
        showArchived={showArchived}
        workspace={workspace}
        workspaceSelectable={workspaceSelectable}
        terminalAvailable={Boolean(activeSessionPath)}
        handedOffSessionKeys={handedOffSessionKeys}
        switching={transitionBusy}
        onCollapse={() => setSidebarCollapsed(value => !value)}
        onQuery={setQuery}
        onToggleArchived={() => setShowArchived(value => !value)}
        onNew={openNewSessionDialog}
        onChooseWorkspace={openNewSessionDialog}
        onOpen={session => void openSession(session)}
        onRename={requestRename}
        onPin={session => void updateSession(session, { pinned: !session.pinned })}
        onArchive={session => void updateSession(session, { archived: !session.archived })}
        onTrash={requestTrash}
        onDelete={requestPermanentDelete}
        onOpenTerminal={session => void openTerminal(session)}
        onSettings={() => setSettingsOpen(true)}
      />

      <ConversationPane
        targetKey={activeTarget.key}
        session={activeSession}
        workspace={workspace}
        workspaceSelectable={workspaceSelectable}
        terminalAvailable={Boolean(activeSessionPath)}
        runtime={runtime}
        conversation={conversation}
        editorUpdate={editorUpdate}
        sending={sending || switchingSession}
        refreshing={refreshing}
        terminalBusy={terminalBusy}
        transitioning={switchingSession || deletingSession || reclaimingSession || ["starting", "aborting"].includes(runtime?.state ?? "")}
        availableModels={availableModels}
        onSubmit={submit}
        onStop={() => void stopRuntime().catch(error => setFatalError(error instanceof Error ? error.message : String(error)))}
        onChooseWorkspace={openNewSessionDialog}
        onOpenTerminal={() => void openTerminal()}
        onSelectModel={model => void selectModel(model)}
        onRefresh={() => void refreshSession()}
      />

      {fatalError && (
        <div className="error-toast" role="alert">
          <strong>操作未完成</strong>
          <span>{fatalError}</span>
          <button onClick={() => setFatalError(undefined)}>×</button>
        </div>
      )}

      {notice && (
        <div className="error-toast error-toast--notice" role="status">
          <strong>操作完成</strong>
          <span>{notice}</span>
          <button onClick={() => setNotice(undefined)}>×</button>
        </div>
      )}

      {pendingRequest && <PermissionDialog request={pendingRequest} onRespond={respondToPermission} />}
      {newSessionDraft && (
        <NewSessionDialog
          installations={environment.installations}
          selectedInstallationId={newSessionDraft.installationId}
          workspace={newSessionDraft.workspace}
          selectingWorkspace={selectingNewSessionWorkspace}
          creating={creatingNewSession}
          error={newSessionError}
          onSelectInstallation={selectNewSessionInstallation}
          onChooseWorkspace={() => void chooseNewSessionWorkspace()}
          onCancel={cancelNewSessionDialog}
          onConfirm={() => void confirmNewSession()}
        />
      )}
      {pendingRename && (
        <SessionRenameDialog
          session={pendingRename}
          saving={renamingSession}
          error={renameError}
          onCancel={() => {
            setPendingRename(undefined);
            setRenameError(undefined);
          }}
          onConfirm={title => void renameSession(title)}
        />
      )}
      {pendingTrash && (
        <SessionTrashDialog
          session={pendingTrash}
          deleting={deletingSession}
          onCancel={() => setPendingTrash(undefined)}
          onConfirm={() => void trashSession()}
        />
      )}
      {pendingDelete && (
        <SessionDeleteDialog
          session={pendingDelete}
          deleting={deletingSession}
          onCancel={() => setPendingDelete(undefined)}
          onConfirm={() => void deleteSessionPermanently()}
        />
      )}
      {pendingReclaim && (
        <SessionReclaimDialog
          session={pendingReclaim}
          reclaiming={reclaimingSession}
          onCancel={() => setPendingReclaim(undefined)}
          onConfirm={() => void reclaimSession()}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          environment={environment}
          settings={settings}
          theme={theme}
          onClose={() => setSettingsOpen(false)}
          onUpdate={patch => void updateSettings(patch)}
        />
      )}
    </div>
  );
}
