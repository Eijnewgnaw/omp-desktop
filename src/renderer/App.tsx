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
import { SessionTrashDialog } from "./components/SessionTrashDialog";
import { Sidebar } from "./components/Sidebar";
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

export default function App(): React.JSX.Element {
  const [environment, setEnvironment] = useState<EnvironmentInfo>();
  const [settings, setSettings] = useState<AppSettings>();
  const [theme, setTheme] = useState<ThemeSnapshot>();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<SessionSummary>();
  const [workspace, setWorkspace] = useState<string>();
  const [runtime, setRuntime] = useState<RuntimeDescriptor>();
  const [conversation, dispatchConversation] = useReducer(reduceRpcFrame, initialConversationState);
  const [pendingRequest, setPendingRequest] = useState<RpcFrame>();
  const [query, setQuery] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [sending, setSending] = useState(false);
  const [switchingSession, setSwitchingSession] = useState(false);
  const [fatalError, setFatalError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [availableModels, setAvailableModels] = useState<OmpModelInfo[]>([]);
  const [pendingTrash, setPendingTrash] = useState<SessionSummary>();
  const [deletingSession, setDeletingSession] = useState(false);
  const [editorUpdate, setEditorUpdate] = useState<{ key: string; messages: string[]; force?: boolean }>();
  const runtimeIdRef = useRef<string | undefined>(undefined);
  const runtimeSessionPathRef = useRef<string | undefined>(undefined);
  const runtimeGenerationRef = useRef(0);
  const runtimeStartRef = useRef<Promise<RuntimeDescriptor> | undefined>(undefined);
  const pendingPromptsRef = useRef(new Map<string, string>());

  const installation = useMemo(() => findInstallation(environment, settings), [environment, settings]);

  const loadSessions = useCallback(async (): Promise<void> => {
    if (!installation) return;
    const next = await window.ompDesktop.sessions.list({
      distro: installation.distro,
      installationPath: installation.executablePath,
      includeArchived: showArchived,
    });
    setSessions(next);
    setActiveSession(current => current ? next.find(session => session.path === current.path) ?? current : current);
  }, [installation, showArchived]);

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
        setWorkspace(resolved.lastWorkspace);
        if (detected.installations.length === 0) setSettingsOpen(true);
      })
      .catch(error => setFatalError(error instanceof Error ? error.message : String(error)));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!installation) return;
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
          setRuntime(current => current ? { ...current, sessionPath: data.sessionFile as string } : current);
        }
      }
      if (event.frame.type === "session_info_update" && typeof event.frame.sessionFile === "string") {
        runtimeSessionPathRef.current = event.frame.sessionFile;
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
  }, [loadSessions]);

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
    setRuntime(undefined);
    setPendingRequest(undefined);
    setAvailableModels([]);
    const pendingPrompts = [...pendingPromptsRef.current.values()];
    if (pendingPrompts.length > 0) setEditorUpdate({ key: crypto.randomUUID(), messages: pendingPrompts });
    pendingPromptsRef.current.clear();
  }, []);

  const startRuntime = useCallback(
    async (session: SessionSummary | undefined): Promise<RuntimeDescriptor> => {
      if (!installation || !settings) throw new Error("OMP 尚未准备好");
      const cwd = session?.cwd ?? workspace;
      if (!cwd) throw new Error("请先选择工作区");
      if (runtimeIdRef.current || runtimeStartRef.current) await stopRuntime();
      const generation = runtimeGenerationRef.current + 1;
      runtimeGenerationRef.current = generation;
      runtimeIdRef.current = undefined;
      runtimeSessionPathRef.current = session?.path;
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
          sessionPath: session?.path,
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
        if (session) {
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
          setRuntime(remaining);
        }
        throw finalError;
      }
    },
    [installation, settings, stopRuntime, workspace],
  );

  const newSession = useCallback(async (): Promise<void> => {
    setSwitchingSession(true);
    try {
      await stopRuntime();
      setActiveSession(undefined);
      dispatchConversation({ type: "__reset" });
    } finally {
      setSwitchingSession(false);
    }
  }, [stopRuntime]);

  const openSession = async (session: SessionSummary): Promise<void> => {
    if (switchingSession) return;
    setSwitchingSession(true);
    setFatalError(undefined);
    try {
      setActiveSession(session);
      setWorkspace(session.cwd);
      if (settings?.lastWorkspace !== session.cwd) {
        const updated = await window.ompDesktop.settings.update({ lastWorkspace: session.cwd });
        setSettings(updated);
      }
      await startRuntime(session);
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error));
    } finally {
      setSwitchingSession(false);
    }
  };

  const submit = async (message: string): Promise<void> => {
    setSending(true);
    setFatalError(undefined);
    let promptId: string | undefined;
    try {
      let runtimeId = runtimeIdRef.current;
      if (!runtimeId) runtimeId = (await startRuntime(activeSession)).runtimeId;
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
    const selected = await window.ompDesktop.system.chooseWorkspace(installation.distro);
    if (!selected) return;
    await stopRuntime();
    setWorkspace(selected);
    setActiveSession(undefined);
    dispatchConversation({ type: "__reset" });
    const updated = await window.ompDesktop.settings.update({ lastWorkspace: selected });
    setSettings(updated);
  };

  const updateSettings = async (patch: Partial<AppSettings>): Promise<void> => {
    try {
      const updated = await window.ompDesktop.settings.update(patch);
      setSettings(updated);
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error));
    }
  };

  const updateSession = async (session: SessionSummary, patch: { pinned?: boolean; archived?: boolean }): Promise<void> => {
    setFatalError(undefined);
    try {
      await window.ompDesktop.sessions.update(session.path, patch);
      await loadSessions();
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error));
    }
  };

  const trashSession = async (): Promise<void> => {
    if (!pendingTrash || !installation) return;
    const session = pendingTrash;
    setDeletingSession(true);
    setFatalError(undefined);
    try {
      if (activeSession?.path === session.path || runtimeSessionPathRef.current === session.path) {
        await stopRuntime();
        setActiveSession(undefined);
        dispatchConversation({ type: "__reset" });
      }
      await window.ompDesktop.sessions.trash({
        distro: installation.distro,
        installationPath: installation.executablePath,
        path: session.path,
      });
      setPendingTrash(undefined);
      setNotice("会话已移到可恢复回收站");
      await loadSessions();
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletingSession(false);
    }
  };

  const openTerminal = async (session?: SessionSummary): Promise<void> => {
    if (!installation || !settings) return;
    const selectedSession = session ?? activeSession;
    const isCurrentSession = !session
      || session.path === activeSession?.path
      || session.path === runtimeSessionPathRef.current;
    const cwd = selectedSession?.cwd ?? workspace;
    if (!cwd) return;
    const sessionPath = isCurrentSession
      ? (selectedSession?.path ?? runtimeSessionPathRef.current ?? runtime?.sessionPath)
      : selectedSession?.path;
    setFatalError(undefined);
    try {
      if (isCurrentSession) await stopRuntime();
      await window.ompDesktop.system.openTerminal({
        distro: installation.distro,
        installationPath: installation.executablePath,
        path: cwd,
        sessionPath,
        profile: settings.profile,
      });
      if (isCurrentSession) {
        setActiveSession(undefined);
        dispatchConversation({ type: "__reset" });
        setNotice("会话已交给原始 OMP 终端；桌面端已切换到新会话");
      }
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error));
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
        activePath={activeSession?.path}
        query={query}
        showArchived={showArchived}
        workspace={workspace}
        switching={switchingSession || sending || ["starting", "running", "aborting"].includes(runtime?.state ?? "")}
        onCollapse={() => setSidebarCollapsed(value => !value)}
        onQuery={setQuery}
        onToggleArchived={() => setShowArchived(value => !value)}
        onNew={() => void newSession().catch(error => setFatalError(error instanceof Error ? error.message : String(error)))}
        onChooseWorkspace={() => void chooseWorkspace().catch(error => setFatalError(error instanceof Error ? error.message : String(error)))}
        onOpen={session => void openSession(session)}
        onPin={session => void updateSession(session, { pinned: !session.pinned })}
        onArchive={session => void updateSession(session, { archived: !session.archived })}
        onTrash={setPendingTrash}
        onOpenTerminal={session => void openTerminal(session)}
        onSettings={() => setSettingsOpen(true)}
      />

      <ConversationPane
        session={activeSession}
        workspace={workspace}
        runtime={runtime}
        conversation={conversation}
        editorUpdate={editorUpdate}
        sending={sending || switchingSession}
        availableModels={availableModels}
        onSubmit={submit}
        onStop={() => void stopRuntime().catch(error => setFatalError(error instanceof Error ? error.message : String(error)))}
        onChooseWorkspace={() => void chooseWorkspace().catch(error => setFatalError(error instanceof Error ? error.message : String(error)))}
        onOpenTerminal={() => void openTerminal()}
        onSelectModel={model => void selectModel(model)}
        onRefresh={() => {
          void Promise.all([loadSessions(), loadTheme()]).catch(error =>
            setFatalError(error instanceof Error ? error.message : String(error)),
          );
        }}
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
