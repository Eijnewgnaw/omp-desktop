import { StringDecoder } from "node:string_decoder";
import type { RpcFrame } from "../shared/contracts";

interface ChunkFrame extends RpcFrame {
  type: "rpc_chunk";
  chunkId: string;
  index: number;
  count: number;
  byteLength: number;
  data: string;
}

interface PendingChunks {
  chunkId: string;
  count: number;
  byteLength: number;
  chunks: Buffer[];
}

export class RpcFrameDecoder {
  readonly #decoder = new StringDecoder("utf8");
  #lineBuffer = "";
  #pending?: PendingChunks;

  push(chunk: Buffer | string): RpcFrame[] {
    this.#lineBuffer += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    const frames: RpcFrame[] = [];
    while (true) {
      const newline = this.#lineBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.#lineBuffer.slice(0, newline).trim();
      this.#lineBuffer = this.#lineBuffer.slice(newline + 1);
      if (!line) continue;
      const parsed = JSON.parse(line) as RpcFrame;
      const frame = this.#consumeFrame(parsed);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  finish(): RpcFrame[] {
    this.#lineBuffer += this.#decoder.end();
    const tail = this.#lineBuffer.trim();
    this.#lineBuffer = "";
    if (!tail) return [];
    const frame = this.#consumeFrame(JSON.parse(tail) as RpcFrame);
    return frame ? [frame] : [];
  }

  #consumeFrame(frame: RpcFrame): RpcFrame | null {
    if (frame.type !== "rpc_chunk") {
      if (this.#pending) throw new Error("OMP interrupted an RPC chunk sequence");
      return frame;
    }
    const chunk = frame as ChunkFrame;
    if (
      typeof chunk.chunkId !== "string" ||
      !Number.isInteger(chunk.index) ||
      !Number.isInteger(chunk.count) ||
      !Number.isInteger(chunk.byteLength) ||
      typeof chunk.data !== "string" ||
      chunk.count < 1 ||
      chunk.index < 0 ||
      chunk.index >= chunk.count ||
      chunk.byteLength < 0 ||
      chunk.byteLength > 64 * 1024 * 1024
    ) {
      throw new Error("OMP sent an invalid RPC chunk frame");
    }
    if (!this.#pending) {
      if (chunk.index !== 0) throw new Error("OMP RPC chunk sequence did not start at index 0");
      this.#pending = { chunkId: chunk.chunkId, count: chunk.count, byteLength: chunk.byteLength, chunks: [] };
    }
    const pending = this.#pending;
    if (
      pending.chunkId !== chunk.chunkId ||
      pending.count !== chunk.count ||
      pending.byteLength !== chunk.byteLength ||
      chunk.index !== pending.chunks.length
    ) {
      this.#pending = undefined;
      throw new Error("OMP sent an interleaved or inconsistent RPC chunk sequence");
    }
    pending.chunks.push(Buffer.from(chunk.data, "base64"));
    if (pending.chunks.length !== pending.count) return null;
    const reassembled = Buffer.concat(pending.chunks);
    this.#pending = undefined;
    if (reassembled.byteLength !== pending.byteLength) throw new Error("OMP RPC chunk byte length did not match");
    return JSON.parse(reassembled.toString("utf8")) as RpcFrame;
  }
}
