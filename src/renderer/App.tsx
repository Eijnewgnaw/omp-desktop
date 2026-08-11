import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  AppSettings,
  EnvironmentInfo,
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
  const [fatalError, setFatalError] = useState<string>();
  const [editorFill, setEditorFill] = useState<{ key: string; text: string }>();
  const runtimeIdRef = useRef<string | undefined>(undefined);
  const startingRef = useRef(false);

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
    const stopFrame = window.ompDesktop.runtime.onFrame(event => {
      if (!runtimeIdRef.current && startingRef.current) runtimeIdRef.current = event.runtimeId;
      if (runtimeIdRef.current !== event.runtimeId) return;
      dispatchConversation(event.frame);
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
          setEditorFill({ key: crypto.randomUUID(), text: event.frame.text });
        }
        if (method === "notify" && typeof event.frame.message === "string") {
          setFatalError(event.frame.notifyType === "error" ? event.frame.message : undefined);
        }
        if (method === "open_url" && typeof event.frame.url === "string" && /^https?:\/\//.test(event.frame.url)) {
          window.open(event.frame.url, "_blank", "noopener,noreferrer");
        }
      }
    });
    const stopStatus = window.ompDesktop.runtime.onStatus(event => {
      if (!runtimeIdRef.current && startingRef.current) runtimeIdRef.current = event.runtimeId;
      if (runtimeIdRef.current !== event.runtimeId) return;
      setRuntime(event.descriptor);
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
    const runtimeId = runtimeIdRef.current;
    if (!runtimeId) return;
    await window.ompDesktop.runtime.stop(runtimeId).catch(() => undefined);
    runtimeIdRef.current = undefined;
    setRuntime(undefined);
    setPendingRequest(undefined);
  }, []);

  const startRuntime = useCallback(
    async (session: SessionSummary | undefined, initialPrompt?: string): Promise<void> => {
      if (!installation || !settings) throw new Error("OMP 尚未准备好");
      const cwd = session?.cwd ?? workspace;
      if (!cwd) throw new Error("请先选择工作区");
      await stopRuntime();
      startingRef.current = true;
      runtimeIdRef.current = undefined;
      setRuntime({ runtimeId: "starting", state: "starting", cwd, distro: installation.distro });
      setPendingRequest(undefined);
      dispatchConversation({ type: "__reset" });
      try {
        const descriptor = await window.ompDesktop.runtime.start({
          distro: installation.distro,
          installationPath: installation.executablePath,
          path: cwd,
          sessionPath: session?.path,
          profile: settings.profile,
          initialPrompt,
        });
        runtimeIdRef.current = descriptor.runtimeId;
        setRuntime(descriptor);
        if (session) {
          await window.ompDesktop.runtime.send(descriptor.runtimeId, {
            id: `state-${crypto.randomUUID()}`,
            type: "get_state",
          });
          await window.ompDesktop.runtime.send(descriptor.runtimeId, {
            id: `history-${crypto.randomUUID()}`,
            type: "get_messages_page",
            limit: 256,
          });
        }
      } finally {
        startingRef.current = false;
      }
    },
    [installation, settings, stopRuntime, workspace],
  );

  const newSession = useCallback(async (): Promise<void> => {
    await stopRuntime();
    setActiveSession(undefined);
    dispatchConversation({ type: "__reset" });
  }, [stopRuntime]);

  const openSession = async (session: SessionSummary): Promise<void> => {
    setActiveSession(session);
    setWorkspace(session.cwd);
    if (settings?.lastWorkspace !== session.cwd) {
      const updated = await window.ompDesktop.settings.update({ lastWorkspace: session.cwd });
      setSettings(updated);
    }
    setSending(true);
    try {
      await startRuntime(session);
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  const submit = async (message: string): Promise<void> => {
    setSending(true);
    setFatalError(undefined);
    try {
      if (!runtimeIdRef.current) {
        await startRuntime(activeSession, message);
      } else {
        await window.ompDesktop.runtime.send(runtimeIdRef.current, {
          id: `prompt-${crypto.randomUUID()}`,
          type: "prompt",
          message,
        });
      }
    } catch (error) {
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
    const updated = await window.ompDesktop.settings.update(patch);
    setSettings(updated);
  };

  const updateSession = async (session: SessionSummary, patch: { pinned?: boolean; archived?: boolean }): Promise<void> => {
    await window.ompDesktop.sessions.update(session.path, patch);
    await loadSessions();
  };

  const openTerminal = (session = activeSession): void => {
    if (!installation || !settings) return;
    const cwd = session?.cwd ?? workspace;
    if (!cwd) return;
    void window.ompDesktop.system.openTerminal({
      distro: installation.distro,
      installationPath: installation.executablePath,
      path: cwd,
      sessionPath: session?.path,
      profile: settings.profile,
    }).catch(error => setFatalError(error instanceof Error ? error.message : String(error)));
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
        onCollapse={() => setSidebarCollapsed(value => !value)}
        onQuery={setQuery}
        onToggleArchived={() => setShowArchived(value => !value)}
        onNew={() => void newSession()}
        onChooseWorkspace={() => void chooseWorkspace()}
        onOpen={session => void openSession(session)}
        onPin={session => void updateSession(session, { pinned: !session.pinned })}
        onArchive={session => void updateSession(session, { archived: !session.archived })}
        onOpenTerminal={openTerminal}
        onSettings={() => setSettingsOpen(true)}
      />

      <ConversationPane
        session={activeSession}
        workspace={workspace}
        runtime={runtime}
        conversation={conversation}
        editorFill={editorFill}
        sending={sending}
        onSubmit={submit}
        onStop={() => void stopRuntime()}
        onChooseWorkspace={() => void chooseWorkspace()}
        onOpenTerminal={() => openTerminal()}
        onRefresh={() => {
          void loadSessions();
          void loadTheme();
        }}
      />

      {fatalError && (
        <div className="error-toast" role="alert">
          <strong>操作未完成</strong>
          <span>{fatalError}</span>
          <button onClick={() => setFatalError(undefined)}>×</button>
        </div>
      )}

      {pendingRequest && <PermissionDialog request={pendingRequest} onRespond={respondToPermission} />}
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
