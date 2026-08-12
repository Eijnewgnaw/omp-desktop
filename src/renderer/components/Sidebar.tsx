import {
  Archive,
  ArchiveRestore,
  Bot,
  CircleX,
  FolderOpen,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SessionSummary } from "../../shared/contracts";
import { BrandMark } from "./BrandMark";

interface SidebarProps {
  collapsed: boolean;
  sessions: SessionSummary[];
  activePath?: string;
  query: string;
  showArchived: boolean;
  workspace?: string;
  workspaceSelectable: boolean;
  terminalAvailable: boolean;
  handedOffPaths: string[];
  switching: boolean;
  onCollapse(): void;
  onQuery(value: string): void;
  onToggleArchived(): void;
  onNew(): void;
  onChooseWorkspace(): void;
  onOpen(session: SessionSummary): void;
  onPin(session: SessionSummary): void;
  onArchive(session: SessionSummary): void;
  onTrash(session: SessionSummary): void;
  onDelete(session: SessionSummary): void;
  onOpenTerminal(session?: SessionSummary): void;
  onSettings(): void;
}

interface SessionMenuState {
  session: SessionSummary;
  top: number;
  left: number;
}

function relativeTime(value: string): string {
  const delta = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.round(delta / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.round(hours / 24);
  return days < 14 ? `${days} 天` : new Date(value).toLocaleDateString();
}

export function Sidebar(props: SidebarProps): React.JSX.Element {
  const [menu, setMenu] = useState<SessionMenuState>();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if ((target as Element).closest?.("[data-session-menu-trigger]")) return;
      setMenu(undefined);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenu(undefined);
    };
    const onResize = (): void => setMenu(undefined);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [menu]);

  const openMenu = (session: SessionSummary, target: HTMLElement): void => {
    const bounds = target.getBoundingClientRect();
    const menuHeight = 286;
    setMenu({
      session,
      top: Math.min(bounds.bottom + 5, window.innerHeight - menuHeight - 8),
      left: Math.max(8, bounds.right - 194),
    });
  };

  const runMenuAction = (action: (session: SessionSummary) => void): void => {
    if (!menu) return;
    const session = menu.session;
    setMenu(undefined);
    action(session);
  };

  if (props.collapsed) {
    return (
      <aside className="sidebar sidebar--collapsed">
        <div className="window-drag-region" />
        <button className="icon-button" onClick={props.onCollapse} title="展开侧边栏">
          <Bot size={19} />
        </button>
        <button className="icon-button icon-button--accent" disabled={props.switching} onClick={props.onNew} title="新建会话">
          <Plus size={19} />
        </button>
        <button
          className="icon-button"
          disabled={props.switching || !props.workspaceSelectable}
          onClick={props.onChooseWorkspace}
          title={props.workspaceSelectable ? "为新会话选择工作区" : "已保存会话使用自己的工作区"}
        >
          <FolderOpen size={18} />
        </button>
        <div className="sidebar-spacer" />
        <button className="icon-button" onClick={props.onSettings} title="设置">
          <Settings size={18} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand window-drag-region">
        <div className="brand-mark"><BrandMark /></div>
        <div>
          <strong>OMP Desktop</strong>
          <span>Oh My Pi workspace</span>
        </div>
        <button className="icon-button no-drag" onClick={props.onCollapse} title="收起侧边栏">
          <PanelLeftClose size={17} />
        </button>
      </div>

      <button className="new-session-button" onClick={props.onNew} disabled={props.switching}>
        <Plus size={17} />
        新建会话
        <span>Ctrl N</span>
      </button>

      <button
        className={`workspace-picker${props.workspaceSelectable ? "" : " workspace-picker--readonly"}`}
        onClick={props.onChooseWorkspace}
        disabled={props.switching || !props.workspaceSelectable}
        title={props.workspaceSelectable ? "为当前新会话选择工作区" : "工作区已绑定到这个会话"}
      >
        <FolderOpen size={16} />
        <span>
          <small>{props.workspaceSelectable ? "新会话工作区" : "会话工作区"}</small>
          <strong>{props.workspace || "选择 WSL 目录后开始"}</strong>
        </span>
        <MoreHorizontal size={16} />
      </button>

      <label className="session-search">
        <Search size={15} />
        <input value={props.query} onChange={event => props.onQuery(event.target.value)} placeholder="搜索会话" />
      </label>

      <div className="sidebar-section-label">
        <span>会话</span>
        <span className="sidebar-section-actions">
          <button
            className={props.showArchived ? "is-active" : ""}
            onClick={props.onToggleArchived}
            title={props.showArchived ? "隐藏已归档会话" : "显示已归档会话"}
          >
            <Archive size={12} />
          </button>
          {props.sessions.length}
        </span>
      </div>

      <div className="session-list" onScroll={() => setMenu(undefined)}>
        {props.sessions.length === 0 ? (
          <div className="empty-session-list">暂无匹配会话</div>
        ) : (
          props.sessions.map(session => (
            <div
              className={`session-row${props.activePath === session.path ? " session-row--active" : ""}`}
              key={session.path}
            >
              <button className="session-row__main" disabled={props.switching} onClick={() => props.onOpen(session)}>
                <span className="session-row__icon">{session.runtimeState === "running" ? <span className="pulse-dot" /> : "›"}</span>
                <span className="session-row__body">
                  <strong>{session.title}</strong>
                  <small>
                    {session.projectName} · {relativeTime(session.modifiedAt)}
                    {props.handedOffPaths.includes(session.path) ? " · 原始终端中" : ""}
                  </small>
                  {session.tags.length > 0 && (
                    <span className="tag-line">{session.tags.slice(0, 3).map(tag => <em key={tag}>{tag}</em>)}</span>
                  )}
                </span>
              </button>
              <button
                className={`session-menu-trigger${menu?.session.path === session.path ? " is-active" : ""}`}
                data-session-menu-trigger
                aria-haspopup="menu"
                aria-expanded={menu?.session.path === session.path}
                disabled={props.switching}
                title="会话操作"
                onClick={event => {
                  event.stopPropagation();
                  if (menu?.session.path === session.path) setMenu(undefined);
                  else openMenu(session, event.currentTarget);
                }}
              >
                <MoreHorizontal size={15} />
              </button>
            </div>
          ))
        )}
      </div>

      {menu && (
        <div
          className="session-menu"
          ref={menuRef}
          role="menu"
          style={{ top: menu.top, left: menu.left }}
        >
          <button role="menuitem" disabled={props.switching} onClick={() => runMenuAction(props.onOpen)}>
            <MessageSquare size={14} />
            <span>{props.handedOffPaths.includes(menu.session.path) ? "重新接管会话…" : "继续会话"}</span>
          </button>
          <button role="menuitem" disabled={props.switching} onClick={() => runMenuAction(session => props.onOpenTerminal(session))}>
            <TerminalSquare size={14} /><span>在原始终端打开</span>
          </button>
          <div className="session-menu__separator" />
          <button role="menuitem" onClick={() => runMenuAction(props.onPin)}>
            {menu.session.pinned ? <PinOff size={14} /> : <Pin size={14} />}
            <span>{menu.session.pinned ? "取消置顶" : "置顶"}</span>
          </button>
          <button role="menuitem" onClick={() => runMenuAction(props.onArchive)}>
            {menu.session.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            <span>{menu.session.archived ? "恢复会话" : "归档会话"}</span>
          </button>
          <div className="session-menu__separator" />
          <button className="session-menu__danger" role="menuitem" disabled={props.switching} onClick={() => runMenuAction(props.onTrash)}>
            <Trash2 size={14} /><span>移到回收站…</span>
          </button>
          <button
            className="session-menu__danger session-menu__danger--permanent"
            role="menuitem"
            disabled={props.switching}
            onClick={() => runMenuAction(props.onDelete)}
          >
            <CircleX size={14} /><span>彻底删除…</span>
          </button>
        </div>
      )}

      <div className="sidebar-footer">
        <button
          disabled={props.switching || !props.terminalAvailable}
          onClick={() => props.onOpenTerminal()}
          title={props.terminalAvailable ? "在原始 OMP 终端中打开当前会话" : "先创建或选择一个会话"}
        >
          <TerminalSquare size={16} />
          原始 OMP 终端
        </button>
        <button className="icon-button" onClick={props.onSettings} title="设置">
          <Settings size={17} />
        </button>
      </div>
    </aside>
  );
}
