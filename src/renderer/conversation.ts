import type { RpcFrame } from "../shared/contracts";

export interface UiMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  thinking?: string;
  timestamp?: number;
  streaming?: boolean;
  error?: boolean;
}

export interface UiToolCall {
  id: string;
  name: string;
  intent?: string;
  args: unknown;
  result?: unknown;
  status: "running" | "success" | "error";
}

export interface ConversationState {
  messages: UiMessage[];
  tools: UiToolCall[];
  model?: { provider?: string; id?: string; name?: string };
  thinkingLevel?: string;
  sessionPath?: string;
  sessionId?: string;
  sessionName?: string;
  tokensPerSecond?: number | null;
}

export const initialConversationState: ConversationState = {
  messages: [],
  tools: [],
};

function textParts(content: unknown): { text: string; thinking?: string } {
  if (typeof content === "string") return { text: content };
  if (!Array.isArray(content)) return { text: "" };
  const text: string[] = [];
  const thinking: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const item = part as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") text.push(item.text);
    if (["thinking", "reasoning"].includes(String(item.type)) && typeof item.thinking === "string") {
      thinking.push(item.thinking);
    } else if (["thinking", "reasoning"].includes(String(item.type)) && typeof item.text === "string") {
      thinking.push(item.text);
    }
  }
  return { text: text.join(""), thinking: thinking.join("") || undefined };
}

function messageId(message: Record<string, unknown>, fallback: string): string {
  if (typeof message.id === "string") return message.id;
  if (typeof message.timestamp === "number") return `${String(message.role)}-${message.timestamp}`;
  return fallback;
}

export function normalizeMessage(raw: unknown, fallbackId: string = crypto.randomUUID()): UiMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const message = raw as Record<string, unknown>;
  const rawRole = String(message.role ?? "system");
  const role: UiMessage["role"] = rawRole === "user" ? "user" : rawRole === "assistant" ? "assistant" : "system";
  const content = textParts(message.content ?? message.text ?? message.message);
  const fallbackText = typeof message.message === "string" ? message.message : "";
  const text = content.text || fallbackText;
  if (!text && !content.thinking) return null;
  return {
    id: messageId(message, fallbackId),
    role,
    text,
    thinking: content.thinking,
    timestamp: typeof message.timestamp === "number" ? message.timestamp : undefined,
    error: rawRole === "error",
  };
}

function upsertMessage(messages: UiMessage[], message: UiMessage): UiMessage[] {
  const index = messages.findIndex(candidate => candidate.id === message.id);
  if (index < 0) return [...messages, message];
  const result = [...messages];
  result[index] = { ...result[index], ...message };
  return result;
}

function responseData(frame: RpcFrame): Record<string, unknown> | undefined {
  return frame.data && typeof frame.data === "object" ? (frame.data as Record<string, unknown>) : undefined;
}

export function reduceRpcFrame(state: ConversationState, frame: RpcFrame): ConversationState {
  if (frame.type === "__reset") return initialConversationState;

  if (["message_start", "message_update", "message_end"].includes(frame.type)) {
    const message = normalizeMessage(frame.message, `${frame.type}-${state.messages.length}`);
    if (!message) return state;
    return {
      ...state,
      messages: upsertMessage(state.messages, { ...message, streaming: frame.type === "message_update" }),
    };
  }

  if (frame.type === "tool_execution_start") {
    const id = String(frame.toolCallId ?? crypto.randomUUID());
    return {
      ...state,
      tools: [
        ...state.tools.filter(tool => tool.id !== id),
        {
          id,
          name: String(frame.toolName ?? "tool"),
          intent: typeof frame.intent === "string" ? frame.intent : undefined,
          args: frame.args,
          status: "running",
        },
      ],
    };
  }

  if (frame.type === "tool_execution_update" || frame.type === "tool_execution_end") {
    const id = String(frame.toolCallId ?? "");
    return {
      ...state,
      tools: state.tools.map(tool =>
        tool.id === id
          ? {
              ...tool,
              result: frame.type === "tool_execution_update" ? frame.partialResult : frame.result,
              status: frame.type === "tool_execution_update" ? "running" : frame.isError ? "error" : "success",
            }
          : tool,
      ),
    };
  }

  if (frame.type === "notice" || frame.type === "command_output") {
    const rawText = frame.message ?? frame.output ?? frame.text;
    if (typeof rawText !== "string" || !rawText.trim()) return state;
    return {
      ...state,
      messages: [
        ...state.messages,
        {
          id: `${frame.type}-${crypto.randomUUID()}`,
          role: "system",
          text: rawText,
          error: frame.level === "error",
        },
      ],
    };
  }

  if (frame.type === "response") {
    const data = responseData(frame);
    if (frame.command === "get_messages_page" && data && Array.isArray(data.messages)) {
      const pageId = typeof frame.id === "string" ? frame.id : "history";
      const history = data.messages
        .map((message, index) => normalizeMessage(message, `${pageId}-${index}`))
        .filter((message): message is UiMessage => message !== null);
      return {
        ...state,
        messages: pageId.startsWith("history-next-") ? [...state.messages, ...history] : history,
      };
    }
    if (frame.command === "get_messages" && data && Array.isArray(data.messages)) {
      const history = data.messages
        .map((message, index) => normalizeMessage(message, `history-${index}`))
        .filter((message): message is UiMessage => message !== null);
      return { ...state, messages: history };
    }
    if (frame.command === "get_state" && data) {
      return {
        ...state,
        model: data.model && typeof data.model === "object" ? (data.model as ConversationState["model"]) : state.model,
        thinkingLevel: typeof data.thinkingLevel === "string" ? data.thinkingLevel : state.thinkingLevel,
        sessionPath: typeof data.sessionFile === "string" ? data.sessionFile : state.sessionPath,
        sessionId: typeof data.sessionId === "string" ? data.sessionId : state.sessionId,
        sessionName: typeof data.sessionName === "string" ? data.sessionName : state.sessionName,
        tokensPerSecond: typeof data.tokensPerSecond === "number" || data.tokensPerSecond === null
          ? data.tokensPerSecond
          : state.tokensPerSecond,
      };
    }
  }

  if (frame.type === "session_info_update") {
    return {
      ...state,
      sessionPath: typeof frame.sessionFile === "string" ? frame.sessionFile : state.sessionPath,
      sessionName: typeof frame.sessionName === "string" ? frame.sessionName : state.sessionName,
    };
  }

  if (frame.type === "model_changed" || frame.type === "thinking_level_changed") {
    return {
      ...state,
      thinkingLevel: typeof frame.thinkingLevel === "string" ? frame.thinkingLevel : state.thinkingLevel,
    };
  }

  return state;
}
