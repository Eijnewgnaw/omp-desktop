import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  AppSettings,
  EnvironmentInfo,
  OmpModelInfo,
  OmpInstallation,
  RpcFrame,
  RuntimeDescriptor,
  SessionSummary,
  ThemeSnapshot,
} from "../shared/contracts";
import { initialConversationState, reduceRpcFrame } from "./conversation";
import { ConversationPane } from "./components/ConversationPane";
import { BrandMark } from "./components/BrandMark";
import { PermissionDialog } from "./components/PermissionDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { SessionDeleteDialog } from "./components/SessionDeleteDialog";
import { SessionReclaimDialog } from "./components/SessionReclaimDialog";
import { SessionTrashDialog } from "./components/SessionTrashDialog";
import { Sidebar } from "./components/Sidebar";
import { addSessionHandoff, hasSessionHandoff, removeSessionHandoff } from "./session-handoff";
import {
  attachTargetSessionPath,
  chooseTargetWorkspace,
  newSessionTarget,
  reconcileTarget,
  savedSessionTarget,
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

function findInstallation(environment: EnvironmentInfo | undefined, settings: AppSettings | undefined): OmpInstallation | undefined {
  if (!environment || !settings) return undefined;
  return (
    environment.installations.find(
      item => item.distro === settings.selectedDistro && item.executablePath === settings.selectedInstallationPath,
    ) ?? environment.installations[0]
  );
}

function installationIdentity(installation: OmpInstallation | undefined): string | undefined {
  if (!installation) return undefined;
  return JSON.stringify([
    installation.direct ? "direct" : "wsl",
    installation.distro,
    installation.executablePath,
    installation.agentDir,
  ]);
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
  const [pendingTrash, setPendingTrash] = useState<SessionSummary>();
  const [pendingDelete, setPendingDelete] = useState<SessionSummary>();
  const [pendingReclaim, setPendingReclaim] = useState<SessionSummary>();
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
  const installationRef = useRef<OmpInstallation | undefined>(undefined);
  const sessionsLoadGenerationRef = useRef(0);

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

  const installation = useMemo(() => findInstallation(environment, settings), [environment, settings]);
  installationRef.current = installation;

  const loadSessions = useCallback(async (): Promise<void> => {
    if (!installation) return;
    const requestedInstallation = installationIdentity(installation);
    const generation = sessionsLoadGenerationRef.current + 1;
    sessionsLoadGenerationRef.current = generation;
    const next = await window.ompDesktop.sessions.list({
      distro: installation.distro,
      installationPath: installation.executablePath,
      includeArchived: showArchived,
    });
    if (sessionsLoadGenerationRef.current !== generation
      || installationIdentity(installationRef.current) !== requestedInstallation) return;
    setSessions(next);
    setActiveTarget(current => reconcileTarget(current, next));
  }, [installation, setActiveTarget, showArchived]);

  const loadTheme = useCallback(async (): Promise<void> => {
    if (!installation || !settings) return;
    const next = await window.ompDesktop.theme.get({
      distro: installation.distro,
      installationPath: installation.executablePath,
      mode: desiredThemeMode(settings),
    });
    setTheme(current => {
      if (current && JSON.stringify(current) === JSON.stringify(next)) return current;
      applyTheme(next);
      return next;
    });
  }, [installation, settings]);

  useEffect(() => {
    let active = true;
    void Promise.all([window.ompDesktop.environment.detect(), window.ompDesktop.settings.get()])
      .then(async ([detected, savedSettings]) => {
        if (!active) return;
        setEnvironment(detected);
        const first = detected.installations[0];
        const resolved = first && !savedSettings.selectedDistro
          ? await window.ompDesktop.settings.update({
              selectedDistro: first.distro,
              selectedInstallationPath: first.executablePath,
            })
          : savedSettings;
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
    if (!installation) return;
    sessionsLoadGenerationRef.current += 1;
    setSessions([]);
    void loadSessions().catch(error => setFatalError(error instanceof Error ? error.message : String(error)));
    void loadTheme().catch(error => setFatalError(error instanceof Error ? error.message : String(error)));
  }, [installation, loadSessions, loadTheme]);

  useEffect(() => {
    if (!installation || !settings) return;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const refresh = (): void => void loadTheme().catch(() => undefined);
    media.addEventListener("change", refresh);
    const interval = window.setInterval(refresh, 4_000);
    return () => {
      media.removeEventListener("change", refresh);
      window.clearInterval(interval);
    };
  }, [installation, settings, loadTheme]);

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
      setRuntime(current => ({
        ...event.descriptor,
        sessionPath: event.descriptor.sessionPath ?? current?.sessionPath,
      }));
      if (event.descriptor.sessionPath) runtimeSessionPathRef.current = event.descriptor.sessionPath;
      if (event.descriptor.state === "failed" && event.descriptor.error) setFatalError(event.descriptor.error);
      const releaseOwnership = (): void => {
        runtimeIdRef.current = undefined;
        runtimeSessionPathRef.current = undefined;
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        void newSession();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

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
        setRuntime(remaining);
      }
      throw error;
    }
    runtimeIdRef.current = undefined;
    runtimeSessionPathRef.current = undefined;
    runtimeTargetKeyRef.current = undefined;
    setRuntime(undefined);
    setPendingRequest(undefined);
    setAvailableModels([]);
    const pendingPrompts = [...pendingPromptsRef.current.values()];
    if (pendingPrompts.length > 0) setEditorUpdate({ key: crypto.randomUUID(), messages: pendingPrompts });
    pendingPromptsRef.current.clear();
  }, []);

  const startRuntime = useCallback(
    async (requestedTarget: ActiveTarget = activeTargetRef.current): Promise<RuntimeDescriptor> => {
      if (!installation || !settings) throw new Error("OMP 尚未准备好");
      const cwd = targetWorkspace(requestedTarget);
      if (!cwd) throw new Error("请先选择工作区");
      if (runtimeIdRef.current || runtimeStartRef.current) await stopRuntime();
      const generation = runtimeGenerationRef.current + 1;
      runtimeGenerationRef.current = generation;
      runtimeIdRef.current = undefined;
      runtimeSessionPathRef.current = targetSessionPath(requestedTarget);
      runtimeTargetKeyRef.current = requestedTarget.key;
      if (runtimeGenerationRef.current !== generation) throw new Error("会话切换已被新的操作取代");
      setRuntime({ runtimeId: "starting", state: "starting", cwd, distro: installation.distro });
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
        const startPromise = window.ompDesktop.runtime.start({
          distro: installation.distro,
          installationPath: installation.executablePath,
          path: cwd,
          sessionPath: targetSessionPath(requestedTarget),
          profile: settings.profile,
        });
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
          if (!remaining) runtimeTargetKeyRef.current = undefined;
          setRuntime(remaining);
        }
        throw finalError;
      }
    },
    [installation, settings, stopRuntime],
  );

  const newSession = useCallback(async (): Promise<void> => {
    setSwitchingSession(true);
    try {
      await stopRuntime();
      setActiveTarget(newSessionTarget());
      dispatchConversation({ type: "__reset" });
      setNotice("新会话已建立，请为它选择工作区");
    } finally {
      setSwitchingSession(false);
    }
  }, [setActiveTarget, stopRuntime]);

  const resumeSession = async (session: SessionSummary): Promise<RuntimeDescriptor> => {
    if (switchingSession) throw new Error("另一项会话切换仍在进行");
    setSwitchingSession(true);
    try {
      const nextTarget = savedSessionTarget(session);
      const descriptor = await startRuntime(nextTarget);
      setActiveTarget(nextTarget);
      return descriptor;
    } finally {
      setSwitchingSession(false);
    }
  };

  const openSession = async (session: SessionSummary): Promise<void> => {
    const handedOff = hasSessionHandoff(settings?.handedOffSessions, installation?.distro, session.path);
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

  const chooseWorkspace = async (): Promise<void> => {
    if (!installation) return;
    const currentTarget = activeTargetRef.current;
    if (currentTarget.kind !== "new" || currentTarget.sessionPath || runtimeIdRef.current || runtimeStartRef.current) {
      setFatalError("已保存的会话使用自己的工作区；请先新建会话，再选择工作区");
      return;
    }
    const selected = await window.ompDesktop.system.chooseWorkspace(installation.distro);
    if (!selected) return;
    setActiveTarget(current => chooseTargetWorkspace(current, selected));
    const updated = await window.ompDesktop.settings.update({ lastWorkspace: selected });
    setSettings(updated);
    setNotice("工作区已绑定到当前新会话");
  };

  const updateSettings = async (patch: Partial<AppSettings>): Promise<void> => {
    let changingRuntimeEnvironment = false;
    try {
      changingRuntimeEnvironment = (patch.selectedDistro !== undefined && patch.selectedDistro !== settings?.selectedDistro)
        || (patch.selectedInstallationPath !== undefined
          && patch.selectedInstallationPath !== settings?.selectedInstallationPath);
      if (changingRuntimeEnvironment) {
        setSwitchingSession(true);
        await stopRuntime();
        setActiveTarget(newSessionTarget());
        dispatchConversation({ type: "__reset" });
      }
      const updated = await window.ompDesktop.settings.update(patch);
      setSettings(updated);
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error));
    } finally {
      if (changingRuntimeEnvironment) setSwitchingSession(false);
    }
  };

  const updateSession = async (session: SessionSummary, patch: { pinned?: boolean; archived?: boolean }): Promise<void> => {
    setFatalError(undefined);
    try {
      if (!installation) throw new Error("OMP 安装环境尚未准备好");
      await window.ompDesktop.sessions.update({
        distro: installation.distro,
        installationPath: installation.executablePath,
        path: session.path,
      }, patch);
      await loadSessions();
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error));
    }
  };

  const sessionIsHandedOff = (session: SessionSummary): boolean =>
    hasSessionHandoff(settings?.handedOffSessions, installation?.distro, session.path);

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
    if (!pendingTrash || !installation) return;
    const session = pendingTrash;
    const ownsSession = activeSessionPath === session.path || runtimeSessionPathRef.current === session.path;
    setDeletingSession(true);
    setFatalError(undefined);
    try {
      if (sessionIsHandedOff(session)) throw new Error("原始 OMP 终端仍可能正在使用该会话");
      if (ownsSession) await stopRuntime();
      await window.ompDesktop.sessions.trash({
        distro: installation.distro,
        installationPath: installation.executablePath,
        path: session.path,
      });
      if (ownsSession) {
        setActiveTarget(newSessionTarget());
        dispatchConversation({ type: "__reset" });
      }
      setPendingTrash(undefined);
      setNotice("会话已移到可恢复回收站");
      await loadSessions();
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletingSession(false);
    }
  };

  const deleteSessionPermanently = async (): Promise<void> => {
    if (!pendingDelete || !installation) return;
    const session = pendingDelete;
    const ownsSession = activeSessionPath === session.path || runtimeSessionPathRef.current === session.path;
    setDeletingSession(true);
    setFatalError(undefined);
    try {
      if (sessionIsHandedOff(session)) throw new Error("原始 OMP 终端仍可能正在使用该会话");
      if (ownsSession) await stopRuntime();
      await window.ompDesktop.sessions.delete({
        distro: installation.distro,
        installationPath: installation.executablePath,
        path: session.path,
      });
      if (ownsSession) {
        setActiveTarget(newSessionTarget());
        dispatchConversation({ type: "__reset" });
      }
      setPendingDelete(undefined);
      setNotice("会话及其附件已彻底删除");
      await loadSessions();
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletingSession(false);
    }
  };

  const reclaimSession = async (): Promise<void> => {
    if (!pendingReclaim || !settings || !installation) return;
    const session = pendingReclaim;
    setReclaimingSession(true);
    setFatalError(undefined);
    try {
      await resumeSession(session);
      const handedOffSessions = removeSessionHandoff(settings.handedOffSessions, installation.distro, session.path);
      const updated = await window.ompDesktop.settings.update({ handedOffSessions });
      setSettings(updated);
      setPendingReclaim(undefined);
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error));
    } finally {
      setReclaimingSession(false);
    }
  };

  const openTerminal = async (session?: SessionSummary): Promise<void> => {
    if (!installation || !settings) return;
    const selectedSession = session ?? activeSession;
    const isCurrentSession = !session
      || session.path === activeSessionPath
      || session.path === runtimeSessionPathRef.current;
    const cwd = selectedSession?.cwd ?? workspace;
    if (!cwd) return;
    const sessionPath = isCurrentSession
      ? (selectedSession?.path ?? runtimeSessionPathRef.current ?? runtime?.sessionPath)
      : selectedSession?.path;
    if (!sessionPath) {
      setFatalError("请先在桌面端发送消息并创建会话，再交给原始 OMP 终端");
      return;
    }
    if (sessionPath && hasSessionHandoff(settings.handedOffSessions, installation.distro, sessionPath)) {
      setFatalError("该会话已经交给原始 OMP 终端；请勿重复启动同一会话");
      return;
    }
    setFatalError(undefined);
    setTerminalBusy(true);
    try {
      if (isCurrentSession) await stopRuntime();
      const previousHandoffs = settings.handedOffSessions ?? [];
      const pendingHandoffs = addSessionHandoff(previousHandoffs, {
        distro: installation.distro,
        installationPath: installation.executablePath,
        sessionPath,
        cwd,
        handedOffAt: new Date().toISOString(),
      });
      const pendingSettings = await window.ompDesktop.settings.update({ handedOffSessions: pendingHandoffs });
      setSettings(pendingSettings);
      await window.ompDesktop.system.openTerminal({
        distro: installation.distro,
        installationPath: installation.executablePath,
        path: cwd,
        sessionPath,
        profile: settings.profile,
      });
      if (isCurrentSession) {
        setActiveTarget(newSessionTarget());
        dispatchConversation({ type: "__reset" });
      }
      setNotice(isCurrentSession
        ? "会话已交给原始 OMP 终端；桌面端已切换到新会话"
        : "会话已在新的原始 OMP 终端窗口中打开");
    } catch (error) {
      if (sessionPath) {
        // A stale lease is safer than allowing two writers. Only remove the
        // pending lease if the terminal definitely failed to start and the
        // rollback itself succeeds.
        const handedOffSessions = removeSessionHandoff(
          settings.handedOffSessions,
          installation.distro,
          sessionPath,
        );
        try {
          const rolledBack = await window.ompDesktop.settings.update({ handedOffSessions });
          setSettings(rolledBack);
        } catch {
          // Preserve the conservative in-memory lease written before launch.
        }
      }
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
      [session.title, session.cwd, session.projectName, ...session.tags].some(value => value.toLowerCase().includes(normalized)),
    );
  }, [query, sessions]);

  const workspaceSelectable = activeTarget.kind === "new"
    && !activeTarget.sessionPath
    && !runtime
    && !switchingSession;
  const transitionBusy = switchingSession
    || sending
    || terminalBusy
    || deletingSession
    || reclaimingSession
    || ["starting", "aborting"].includes(runtime?.state ?? "");
  const handedOffPaths = (settings?.handedOffSessions ?? [])
    .filter(item => item.distro === installation?.distro)
    .map(item => item.sessionPath);

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
        <span>检查 WSL、会话和主题…</span>
      </div>
    );
  }

  return (
    <div className={`app-shell${sidebarCollapsed ? " app-shell--collapsed" : ""}`}>
      <Sidebar
        collapsed={sidebarCollapsed}
        sessions={filteredSessions}
        activePath={activeSessionPath}
        query={query}
        showArchived={showArchived}
        workspace={workspace}
        workspaceSelectable={workspaceSelectable}
        terminalAvailable={Boolean(activeSessionPath)}
        handedOffPaths={handedOffPaths}
        switching={transitionBusy}
        onCollapse={() => setSidebarCollapsed(value => !value)}
        onQuery={setQuery}
        onToggleArchived={() => setShowArchived(value => !value)}
        onNew={() => void newSession().catch(error => setFatalError(error instanceof Error ? error.message : String(error)))}
        onChooseWorkspace={() => void chooseWorkspace().catch(error => setFatalError(error instanceof Error ? error.message : String(error)))}
        onOpen={session => void openSession(session)}
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
        onChooseWorkspace={() => void chooseWorkspace().catch(error => setFatalError(error instanceof Error ? error.message : String(error)))}
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
