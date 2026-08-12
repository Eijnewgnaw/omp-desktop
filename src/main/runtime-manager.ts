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
import { assertLogicalPath, assertRuntimeId } from "./security";

interface RuntimeManagerEvents {
  frame: [RuntimeFrameEnvelope];
  status: [RuntimeStatusEnvelope];
}

export interface OwnedRuntime {
  descriptor: RuntimeDescriptor;
  installation: OmpInstallation;
}

export class RuntimeManager extends EventEmitter<RuntimeManagerEvents> {
  readonly #runtimes = new Map<string, OmpRpcClient>();
  #transition: Promise<void> = Promise.resolve();

  async start(installation: OmpInstallation, input: StartRuntimeInput): Promise<RuntimeDescriptor> {
    if (input.installationId !== installation.id) {
      throw new Error("Runtime installation does not match the selected OMP installation");
    }
    assertLogicalPath(installation, installation.executablePath, "OMP executable");
    assertLogicalPath(installation, input.path, "workspace path");
    if (input.sessionPath) assertLogicalPath(installation, input.sessionPath, "session path");
    return this.#exclusive(async () => {
      await this.#stopAllUnlocked();
      const runtimeId = crypto.randomUUID();
      const client = new OmpRpcClient(runtimeId, installation, input);
      this.#runtimes.set(runtimeId, client);
      client.on("frame", frame => this.emit("frame", { runtimeId, frame }));
      client.on("status", descriptor => this.emit("status", { runtimeId, descriptor }));
      client.on("exit", () => {
        if (!client.shutdownUnverified && this.#runtimes.get(runtimeId) === client) {
          this.#runtimes.delete(runtimeId);
        }
      });
      try {
        return await client.start();
      } catch (error) {
        try {
          await client.stop();
        } catch (stopError) {
          throw new AggregateError([error, stopError], "OMP failed to start and could not be stopped safely");
        }
        if (this.#runtimes.get(runtimeId) === client) this.#runtimes.delete(runtimeId);
        throw error;
      }
    });
  }

  send(runtimeId: string, frame: RpcFrame): void {
    const client = this.#runtimes.get(assertRuntimeId(runtimeId));
    if (!client) throw new Error("OMP runtime was not found");
    client.send(frame);
  }

  async stop(runtimeId: string): Promise<void> {
    await this.#exclusive(async () => {
      const safeId = assertRuntimeId(runtimeId);
      const client = this.#runtimes.get(safeId);
      if (!client) return;
      await client.stop();
      if (this.#runtimes.get(safeId) === client) this.#runtimes.delete(safeId);
    });
  }

  list(): RuntimeDescriptor[] {
    return [...this.#runtimes.values()].map(client => ({ ...client.descriptor }));
  }

  listOwned(): OwnedRuntime[] {
    return [...this.#runtimes.values()].map(client => ({
      descriptor: { ...client.descriptor },
      installation: client.installation,
    }));
  }

  async stopAll(): Promise<void> {
    await this.#exclusive(() => this.#stopAllUnlocked());
  }

  async #stopAllUnlocked(): Promise<void> {
    const clients = [...this.#runtimes.entries()];
    const results = await Promise.allSettled(clients.map(([, client]) => client.stop()));
    const errors: unknown[] = [];
    for (const [index, [runtimeId, client]] of clients.entries()) {
      const result = results[index];
      if (result?.status === "fulfilled") {
        if (this.#runtimes.get(runtimeId) === client) this.#runtimes.delete(runtimeId);
      } else if (result?.status === "rejected") {
        errors.push(result.reason);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "One or more OMP runtimes could not be stopped safely");
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#transition;
    let release!: () => void;
    this.#transition = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
