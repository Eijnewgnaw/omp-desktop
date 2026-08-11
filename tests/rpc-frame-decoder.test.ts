import { describe, expect, it } from "vitest";
import { RpcFrameDecoder } from "../src/main/rpc-frame-decoder";

describe("RpcFrameDecoder", () => {
  it("decodes split NDJSON frames", () => {
    const decoder = new RpcFrameDecoder();
    expect(decoder.push(Buffer.from('{"type":"rea'))).toEqual([]);
    expect(decoder.push(Buffer.from('dy"}\n{"type":"agent_start"}\n'))).toEqual([
      { type: "ready" },
      { type: "agent_start" },
    ]);
  });

  it("reassembles protocol v2 chunks", () => {
    const decoder = new RpcFrameDecoder();
    const payload = Buffer.from(JSON.stringify({ type: "response", command: "get_messages", data: { text: "你好" } }));
    const middle = Math.floor(payload.length / 2);
    const frames = [payload.subarray(0, middle), payload.subarray(middle)].map((chunk, index) => ({
      type: "rpc_chunk",
      chunkId: "chunk-1",
      index,
      count: 2,
      byteLength: payload.length,
      data: chunk.toString("base64"),
    }));
    expect(decoder.push(`${JSON.stringify(frames[0])}\n`)).toEqual([]);
    expect(decoder.push(`${JSON.stringify(frames[1])}\n`)).toEqual([
      { type: "response", command: "get_messages", data: { text: "你好" } },
    ]);
  });

  it("rejects interleaved chunk sequences", () => {
    const decoder = new RpcFrameDecoder();
    decoder.push(`${JSON.stringify({ type: "rpc_chunk", chunkId: "a", index: 0, count: 2, byteLength: 2, data: "eA==" })}\n`);
    expect(() => decoder.push('{"type":"ready"}\n')).toThrow(/interrupted/i);
  });
});
