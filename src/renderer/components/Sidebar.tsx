import {
  Archive,
  Bot,
  FolderOpen,
  MoreHorizontal,
  PanelLeftClose,
  Pin,
  Plus,
  Search,
  Settings,
  TerminalSquare,
} from "lucide-react";
import type { SessionSummary } from "../../shared/contracts";
import { BrandMark } from "./BrandMark";

interface SidebarProps {
  collapsed: boolean;
  sessions: SessionSummary[];
  activePath?: string;
  query: string;
  showArchived: boolean;
  workspace?: string;
  onCollapse(): void;
  onQuery(value: string): void;
  onToggleArchived(): void;
  onNew(): void;
  onChooseWorkspace(): void;
  onOpen(session: SessionSummary): void;
  onPin(session: SessionSummary): void;
  onArchive(session: SessionSummary): void;
  onOpenTerminal(session?: SessionSummary): void;
  onSettings(): void;
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
  if (props.collapsed) {
    return (
      <aside className="sidebar sidebar--collapsed">
        <div className="window-drag-region" />
        <button className="icon-button" onClick={props.onCollapse} title="展开侧边栏">
          <Bot size={19} />
        </button>
        <button className="icon-button icon-button--accent" onClick={props.onNew} title="新建会话">
          <Plus size={19} />
        </button>
        <button className="icon-button" onClick={props.onChooseWorkspace} title="选择工作区">
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

      <button className="new-session-button" onClick={props.onNew}>
        <Plus size={17} />
        新建会话
        <span>Ctrl N</span>
      </button>

      <button className="workspace-picker" onClick={props.onChooseWorkspace}>
        <FolderOpen size={16} />
        <span>
          <small>当前工作区</small>
          <strong>{props.workspace || "选择 WSL 目录"}</strong>
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

      <div className="session-list">
        {props.sessions.length === 0 ? (
          <div className="empty-session-list">暂无匹配会话</div>
        ) : (
          props.sessions.map(session => (
            <button
              className={`session-row${props.activePath === session.path ? " session-row--active" : ""}`}
              key={session.path}
              onClick={() => props.onOpen(session)}
            >
              <span className="session-row__icon">{session.runtimeState === "running" ? <span className="pulse-dot" /> : "›"}</span>
              <span className="session-row__body">
                <strong>{session.title}</strong>
                <small>
                  {session.projectName} · {relativeTime(session.modifiedAt)}
                </small>
                {session.tags.length > 0 && (
                  <span className="tag-line">{session.tags.slice(0, 3).map(tag => <em key={tag}>{tag}</em>)}</span>
                )}
              </span>
              <span className="session-row__actions">
                <span
                  className={`mini-action${session.pinned ? " mini-action--active" : ""}`}
                  onClick={event => {
                    event.stopPropagation();
                    props.onPin(session);
                  }}
                  title={session.pinned ? "取消置顶" : "置顶"}
                >
                  <Pin size={13} />
                </span>
                <span
                  className="mini-action"
                  onClick={event => {
                    event.stopPropagation();
                    props.onArchive(session);
                  }}
                  title={session.archived ? "恢复会话" : "归档"}
                >
                  <Archive size={13} />
                </span>
              </span>
            </button>
          ))
        )}
      </div>

      <div className="sidebar-footer">
        <button onClick={() => props.onOpenTerminal()}>
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
