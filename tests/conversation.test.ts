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
