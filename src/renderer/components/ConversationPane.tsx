import {
  ArrowUp,
  Bot,
  CircleStop,
  Copy,
  FolderOpen,
  Gauge,
  GitBranch,
  RefreshCw,
  Sparkles,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { OmpModelInfo, RuntimeDescriptor, SessionSummary } from "../../shared/contracts";
import type { ConversationState } from "../conversation";
import { BrandMark } from "./BrandMark";
import { ToolCard } from "./ToolCard";

interface ConversationPaneProps {
  targetKey: string;
  session?: SessionSummary;
  workspace?: string;
  workspaceSelectable: boolean;
  terminalAvailable: boolean;
  runtime?: RuntimeDescriptor;
  conversation: ConversationState;
  editorUpdate?: { key: string; messages: string[]; force?: boolean };
  sending: boolean;
  refreshing: boolean;
  terminalBusy: boolean;
  transitioning: boolean;
  availableModels: OmpModelInfo[];
  onSubmit(message: string): Promise<void>;
  onStop(): void;
  onChooseWorkspace(): void;
  onOpenTerminal(): void;
  onSelectModel(model: OmpModelInfo): void;
  onRefresh(): void;
}

function modelKey(model: { provider?: string; id?: string }): string {
  return JSON.stringify([model.provider ?? "", model.id ?? ""]);
}

const stateLabels: Record<string, string> = {
  starting: "正在启动",
  ready: "已连接",
  idle: "空闲",
  running: "OMP 正在工作",
  waiting_for_user: "等待确认",
  aborting: "正在停止",
  completed: "已完成",
  failed: "运行失败",
  exited: "已退出",
};

function Message({ role, text, thinking, error }: ConversationState["messages"][number]): React.JSX.Element {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  return (
    <article className={`message message--${role}${error ? " message--error" : ""}`}>
      <div className="message__avatar">{role === "assistant" ? <Bot size={17} /> : role === "user" ? "你" : "i"}</div>
      <div className="message__content">
        <div className="message__label">{role === "assistant" ? "OMP" : role === "user" ? "你" : "系统"}</div>
        {thinking && (
          <button className="thinking-toggle" onClick={() => setThinkingOpen(value => !value)}>
            <Sparkles size={14} />
            {thinkingOpen ? "收起思考" : "查看思考"}
          </button>
        )}
        {thinkingOpen && <pre className="thinking-content">{thinking}</pre>}
        {text && (
          <div className="markdown-body">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) => (
                  <a href={href?.startsWith("http") ? href : undefined} target="_blank" rel="noreferrer">{children}</a>
                ),
                pre: ({ children }) => (
                  <div className="code-block-wrap">
                    <button
                      className="copy-code"
                      onClick={event => {
                        const code = event.currentTarget.nextElementSibling?.textContent ?? "";
                        void navigator.clipboard.writeText(code);
                      }}
                      title="复制代码"
                    >
                      <Copy size={13} />
                    </button>
                    <pre>{children}</pre>
                  </div>
                ),
              }}
            >
              {text}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </article>
  );
}

export function ConversationPane(props: ConversationPaneProps): React.JSX.Element {
  const [editor, setEditor] = useState<{ draft: string; retryDrafts: string[] }>({ draft: "", retryDrafts: [] });
  const { draft, retryDrafts } = editor;
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const followOutputRef = useRef(true);
  const running = ["starting", "running", "aborting"].includes(props.runtime?.state ?? "");
  const currentModel = typeof props.conversation.model?.provider === "string" && typeof props.conversation.model.id === "string"
    ? props.conversation.model as OmpModelInfo
    : undefined;
  const visibleModels = currentModel
    && !props.availableModels.some(model => modelKey(model) === modelKey(currentModel))
    ? [currentModel, ...props.availableModels]
    : props.availableModels;

  useEffect(() => {
    if (!followOutputRef.current) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [props.conversation.messages, props.conversation.tools]);

  useEffect(() => {
    followOutputRef.current = true;
    setEditor({ draft: "", retryDrafts: [] });
  }, [props.targetKey]);

  useEffect(() => {
    if (!props.editorUpdate) return;
    const messages = [...new Set(props.editorUpdate.messages.filter(message => message.trim()))];
    if (messages.length === 0) return;
    setEditor(current => {
      if (props.editorUpdate?.force) {
        return {
          draft: messages[0] ?? "",
          retryDrafts: [...new Set([...current.retryDrafts, ...messages.slice(1)])],
        };
      }
      if (!current.draft.trim()) {
        return {
          draft: messages[0] ?? "",
          retryDrafts: [...new Set([...current.retryDrafts, ...messages.slice(1)])],
        };
      }
      return {
        ...current,
        retryDrafts: [...new Set([
          ...current.retryDrafts,
          ...messages.filter(message => message !== current.draft),
        ])],
      };
    });
    textareaRef.current?.focus();
  }, [props.editorUpdate]);

  const submit = async (): Promise<void> => {
    const message = draft.trim();
    if (!message || props.sending) return;
    setEditor(current => ({
      draft: "",
      retryDrafts: current.retryDrafts.filter(candidate => candidate !== message),
    }));
    await props.onSubmit(message).catch(() => setEditor(current => current.draft.trim()
      ? { ...current, retryDrafts: [...new Set([...current.retryDrafts, message])] }
      : { ...current, draft: message }));
    textareaRef.current?.focus();
  };

  return (
    <main className="conversation-pane">
      <header className="conversation-header window-drag-region">
        <div className="conversation-title no-drag">
          <span className="conversation-title__icon"><GitBranch size={16} /></span>
          <div>
            <strong>{props.session?.title || (props.workspace ? "新会话" : "OMP Desktop")}</strong>
            <small>{props.session?.cwd || props.workspace || "选择运行环境和工作区后开始"}</small>
          </div>
        </div>
        <div className="conversation-actions no-drag">
          {currentModel && visibleModels.length > 0 ? (
            <label className="header-chip model-select" title="选择 OMP 模型">
              <Gauge size={14} />
              <select
                aria-label="选择 OMP 模型"
                disabled={running}
                value={modelKey(currentModel)}
                onChange={event => {
                  const model = visibleModels.find(candidate => modelKey(candidate) === event.target.value);
                  if (model) props.onSelectModel(model);
                }}
              >
                {visibleModels.map(model => (
                  <option key={modelKey(model)} value={modelKey(model)}>
                    {model.name || model.id} · {model.provider}
                  </option>
                ))}
              </select>
            </label>
          ) : props.conversation.model ? (
            <span className="header-chip"><Gauge size={14} />{props.conversation.model.name || props.conversation.model.id}</span>
          ) : null}
          {props.conversation.thinkingLevel && <span className="header-chip">{props.conversation.thinkingLevel}</span>}
          <button
            className="icon-button"
            disabled={props.refreshing || props.transitioning}
            onClick={props.onRefresh}
            title={props.refreshing ? "正在重新载入当前会话" : "重新载入当前会话"}
          >
            <RefreshCw className={props.refreshing ? "spin" : undefined} size={16} />
          </button>
          <button
            className="icon-button"
            disabled={!props.terminalAvailable || props.terminalBusy || props.transitioning}
            onClick={props.onOpenTerminal}
            title={!props.terminalAvailable
              ? "先在桌面端发送消息并创建会话，再交给原始终端"
              : props.terminalBusy
                ? "正在打开原始 OMP 终端"
                : "在原始 OMP 终端中打开"}
          >
            {props.terminalBusy ? <RefreshCw className="spin" size={16} /> : <TerminalSquare size={17} />}
          </button>
        </div>
      </header>

      <div
        className="conversation-scroll"
        ref={scrollRef}
        onScroll={event => {
          const element = event.currentTarget;
          followOutputRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
        }}
      >
        {props.conversation.messages.length === 0 && props.conversation.tools.length === 0 ? (
          <section className="welcome-panel">
            <div className="welcome-mark"><BrandMark /></div>
            <p className="eyebrow">OMP · DESKTOP WORKSPACE</p>
            <h1>{props.session ? "准备恢复这个会话" : "把终端里的 OMP，放进一个更好管理的工作台。"}</h1>
            <p>
              {props.workspace
                ? `当前工作区是 ${props.workspace}。发送消息后，任务仍由你现有的 OMP 完整执行。`
                : "先为这个新会话选择 OMP 运行环境和项目目录，然后再启动 OMP。"}
            </p>
            {!props.workspace && props.workspaceSelectable && (
              <button className="primary-button welcome-action" onClick={props.onChooseWorkspace}>
                <FolderOpen size={16} />选择工作区
              </button>
            )}
            <div className="welcome-grid">
              <div><span>01</span><strong>忠实运行</strong><p>模型、工具、规则和权限全部交给 OMP。</p></div>
              <div><span>02</span><strong>会话可回退</strong><p>任何会话都能在原始终端中继续。</p></div>
              <div><span>03</span><strong>主题同步</strong><p>颜色和语义跟随 OMP 当前主题。</p></div>
            </div>
          </section>
        ) : (
          <div className="timeline">
            {props.conversation.messages.map(message => <Message key={message.id} {...message} />)}
            {props.conversation.tools.length > 0 && (
              <div className="tool-stack">
                {props.conversation.tools.map(tool => <ToolCard key={tool.id} tool={tool} />)}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="composer-area">
        {retryDrafts.length > 0 && (
          <div className="retry-drafts" role="status">
            <span>{retryDrafts.length} 条未发送消息已保留</span>
            <button
              onClick={() => setEditor(current => {
                const [next, ...remaining] = current.retryDrafts;
                if (!next) return current;
                const retryQueue = current.draft.trim() && current.draft !== next
                  ? [...remaining, current.draft]
                  : remaining;
                return { draft: next, retryDrafts: [...new Set(retryQueue)] };
              })}
            >
              恢复
            </button>
          </div>
        )}
        {props.runtime && (
          <div className={`runtime-banner runtime-banner--${props.runtime.state}`}>
            <span className={running ? "pulse-dot" : "status-dot"} />
            {stateLabels[props.runtime.state] || props.runtime.state}
            {props.runtime.error && <em>{props.runtime.error}</em>}
            {running && <button onClick={props.onStop}><CircleStop size={14} />停止</button>}
          </div>
        )}
        <div className="composer">
          <textarea
            ref={textareaRef}
            value={draft}
            disabled={!props.workspace || props.sending}
            placeholder={props.workspace ? "让 OMP 处理一个任务…" : "请先选择工作区"}
            rows={1}
            onChange={event => setEditor(current => ({ ...current, draft: event.target.value }))}
            onKeyDown={event => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <button className="send-button" disabled={!draft.trim() || !props.workspace || props.sending} onClick={() => void submit()}>
            {props.sending ? <RefreshCw className="spin" size={17} /> : <ArrowUp size={18} />}
          </button>
        </div>
        <div className="composer-hint">
          <span>Enter 发送 · Shift Enter 换行</span>
          <span>{props.conversation.tokensPerSecond ? `${props.conversation.tokensPerSecond.toFixed(1)} tok/s` : "由 OMP 运行"}</span>
        </div>
      </div>
    </main>
  );
}
