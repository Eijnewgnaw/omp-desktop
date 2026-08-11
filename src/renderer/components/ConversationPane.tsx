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
import type { RuntimeDescriptor, SessionSummary } from "../../shared/contracts";
import type { ConversationState } from "../conversation";
import { BrandMark } from "./BrandMark";
import { ToolCard } from "./ToolCard";

interface ConversationPaneProps {
  session?: SessionSummary;
  workspace?: string;
  runtime?: RuntimeDescriptor;
  conversation: ConversationState;
  editorFill?: { key: string; text: string };
  sending: boolean;
  onSubmit(message: string): Promise<void>;
  onStop(): void;
  onChooseWorkspace(): void;
  onOpenTerminal(): void;
  onRefresh(): void;
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
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const running = ["starting", "running", "aborting"].includes(props.runtime?.state ?? "");

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [props.conversation.messages, props.conversation.tools]);

  useEffect(() => {
    if (!props.editorFill) return;
    setDraft(props.editorFill.text);
    textareaRef.current?.focus();
  }, [props.editorFill]);

  const submit = async (): Promise<void> => {
    const message = draft.trim();
    if (!message || props.sending) return;
    setDraft("");
    await props.onSubmit(message).catch(() => setDraft(message));
    textareaRef.current?.focus();
  };

  return (
    <main className="conversation-pane">
      <header className="conversation-header window-drag-region">
        <div className="conversation-title no-drag">
          <span className="conversation-title__icon"><GitBranch size={16} /></span>
          <div>
            <strong>{props.session?.title || (props.workspace ? "新会话" : "OMP Desktop")}</strong>
            <small>{props.session?.cwd || props.workspace || "选择一个 WSL 工作区开始"}</small>
          </div>
        </div>
        <div className="conversation-actions no-drag">
          {props.conversation.model && (
            <span className="header-chip"><Gauge size={14} />{props.conversation.model.name || props.conversation.model.id}</span>
          )}
          {props.conversation.thinkingLevel && <span className="header-chip">{props.conversation.thinkingLevel}</span>}
          <button className="icon-button" onClick={props.onRefresh} title="刷新会话"><RefreshCw size={16} /></button>
          <button className="icon-button" onClick={props.onOpenTerminal} title="在原始 OMP 终端中打开"><TerminalSquare size={17} /></button>
        </div>
      </header>

      <div className="conversation-scroll" ref={scrollRef}>
        {props.conversation.messages.length === 0 && props.conversation.tools.length === 0 ? (
          <section className="welcome-panel">
            <div className="welcome-mark"><BrandMark /></div>
            <p className="eyebrow">OMP · DESKTOP WORKSPACE</p>
            <h1>{props.session ? "准备恢复这个会话" : "把终端里的 OMP，放进一个更好管理的工作台。"}</h1>
            <p>
              {props.workspace
                ? `当前工作区是 ${props.workspace}。发送消息后，任务仍由你现有的 OMP 完整执行。`
                : "先选择 WSL 项目目录，然后从这里启动或恢复 OMP 会话。"}
            </p>
            {!props.workspace && (
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
            onChange={event => setDraft(event.target.value)}
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
