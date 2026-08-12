import { describe, expect, it } from "vitest";
import { initialConversationState, reduceRpcFrame } from "../src/renderer/conversation";

describe("conversation reducer", () => {
  it("upserts streamed assistant messages", () => {
    const first = reduceRpcFrame(initialConversationState, {
      type: "message_update",
      message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "你" }] },
    });
    const second = reduceRpcFrame(first, {
      type: "message_end",
      message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "你好" }] },
    });
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]?.text).toBe("你好");
    expect(second.messages[0]?.streaming).toBe(false);
  });

  it("keeps one streamed message when OMP omits message ids and timestamps", () => {
    const started = reduceRpcFrame(initialConversationState, {
      type: "message_start",
      message: { role: "assistant", content: [{ type: "text", text: "开" }] },
    });
    const updated = reduceRpcFrame(started, {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "开始" }] },
    });
    const ended = reduceRpcFrame(updated, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "开始完成" }] },
    });
    expect(ended.messages).toHaveLength(1);
    expect(ended.messages[0]).toMatchObject({ text: "开始完成", streaming: false });
  });

  it("tracks OMP streaming state and successful model changes", () => {
    const loaded = reduceRpcFrame(initialConversationState, {
      type: "response",
      command: "get_state",
      success: true,
      data: {
        sessionId: "session-id",
        isStreaming: false,
        model: { provider: "openai", id: "gpt-a", name: "GPT A" },
      },
    });
    const running = reduceRpcFrame(loaded, { type: "agent_start" });
    const changed = reduceRpcFrame(running, {
      type: "response",
      command: "set_model",
      success: true,
      data: { provider: "openai", id: "gpt-b", name: "GPT B" },
    });
    const finished = reduceRpcFrame(changed, { type: "agent_end" });
    expect(running.isStreaming).toBe(true);
    expect(changed.model).toMatchObject({ provider: "openai", id: "gpt-b" });
    expect(finished.isStreaming).toBe(false);
  });

  it("keeps streaming through a non-terminal agent end", () => {
    const running = reduceRpcFrame(initialConversationState, { type: "agent_start" });
    const continuing = reduceRpcFrame(running, { type: "agent_end", isTerminal: false });
    const finished = reduceRpcFrame(continuing, { type: "agent_end", isTerminal: true });

    expect(continuing.isStreaming).toBe(true);
    expect(finished.isStreaming).toBe(false);
  });

  it("tracks tool execution lifecycle", () => {
    const started = reduceRpcFrame(initialConversationState, {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "README.md" },
    });
    const ended = reduceRpcFrame(started, {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read",
      result: { content: "ok" },
    });
    expect(ended.tools[0]).toMatchObject({ name: "read", status: "success" });
  });

  it("loads paged history", () => {
    const state = reduceRpcFrame(initialConversationState, {
      id: "history-initial",
      type: "response",
      command: "get_messages_page",
      success: true,
      data: {
        messages: [
          { role: "user", timestamp: 1, content: "问题" },
          { role: "assistant", timestamp: 2, content: [{ type: "text", text: "回答" }] },
        ],
      },
    });
    expect(state.messages.map(message => message.text)).toEqual(["问题", "回答"]);

    const next = reduceRpcFrame(state, {
      id: "history-next-second-page",
      type: "response",
      command: "get_messages_page",
      success: true,
      data: {
        messages: [{ role: "assistant", content: "后续回答" }],
      },
    });
    expect(next.messages.map(message => message.text)).toEqual(["问题", "回答", "后续回答"]);
    expect(new Set(next.messages.map(message => message.id)).size).toBe(3);
  });
});
