import { EventEmitter } from "node:events";
import type {
  OmpInstallation,
  RpcFrame,
  RuntimeDescriptor,
  RuntimeFrameEnvelope,
  RuntimeStatusEnvelope,
  StartRuntimeInput,
} from "../shared/contracts";
import { OmpRpcClient } from "./omp-rpc-client";
import { assertRuntimeId } from "./security";

interface RuntimeManagerEvents {
  frame: [RuntimeFrameEnvelope];
  status: [RuntimeStatusEnvelope];
}

export class RuntimeManager extends EventEmitter<RuntimeManagerEvents> {
  readonly #runtimes = new Map<string, OmpRpcClient>();

  async start(installation: OmpInstallation, input: StartRuntimeInput): Promise<RuntimeDescriptor> {
    const runtimeId = crypto.randomUUID();
    const client = new OmpRpcClient(runtimeId, installation, input);
    this.#runtimes.set(runtimeId, client);
    client.on("frame", frame => this.emit("frame", { runtimeId, frame }));
    client.on("status", descriptor => this.emit("status", { runtimeId, descriptor }));
    client.on("exit", () => {
      setTimeout(() => this.#runtimes.delete(runtimeId), 30_000).unref();
    });
    try {
      return await client.start();
    } catch (error) {
      await client.stop().catch(() => undefined);
      this.#runtimes.delete(runtimeId);
      throw error;
    }
  }

  send(runtimeId: string, frame: RpcFrame): void {
    const client = this.#runtimes.get(assertRuntimeId(runtimeId));
    if (!client) throw new Error("OMP runtime was not found");
    client.send(frame);
  }

  async stop(runtimeId: string): Promise<void> {
    const safeId = assertRuntimeId(runtimeId);
    const client = this.#runtimes.get(safeId);
    if (!client) return;
    await client.stop();
    this.#runtimes.delete(safeId);
  }

  list(): RuntimeDescriptor[] {
    return [...this.#runtimes.values()].map(client => ({ ...client.descriptor }));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#runtimes.keys()].map(runtimeId => this.stop(runtimeId)));
  }
}
