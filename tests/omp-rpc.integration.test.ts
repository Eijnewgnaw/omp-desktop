import { execFileSync } from "node:child_process";
import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { dataDirFromGcPlan } from "../src/main/environment-service";
import { OmpRpcClient } from "../src/main/omp-rpc-client";
import type { RpcFrame } from "../src/shared/contracts";

const integrationEnabled = process.env.OMP_INTEGRATION === "1";
const ompPath = process.env.OMP_EXECUTABLE
  || (integrationEnabled ? execFileSync("sh", ["-lc", "command -v omp"], { encoding: "utf8" }).trim() : "omp");

describe.skipIf(!integrationEnabled)("real OMP RPC integration", () => {
  it("handshakes, reads state, and lists selectable models without invoking one", async () => {
    await access(ompPath);
    const agentDir = execFileSync(ompPath, ["--profile", "default", "config", "path"], {
      encoding: "utf8",
    }).trim();
    const gcPlan = execFileSync(ompPath, ["--profile", "default", "gc", "--json", "--wal"], {
      encoding: "utf8",
    });
    const dataDir = dataDirFromGcPlan({ kind: "linux-direct" }, gcPlan, agentDir);
    const client = new OmpRpcClient(
      "019ff18b-2e8c-70b2-8700-ec77ab0171aa",
      {
        id: `linux-direct:${ompPath}`,
        kind: "linux-direct",
        label: "Local Linux OMP",
        executablePath: ompPath,
        version: "17.2.12",
        agentDir,
        ...(dataDir && dataDir !== agentDir ? { dataDir } : {}),
      },
      { installationId: `linux-direct:${ompPath}`, path: "/tmp" },
    );
    await client.start();
    const stateResponse = new Promise<RpcFrame>(resolve => {
      const listener = (frame: RpcFrame): void => {
        if (frame.type === "response" && frame.command === "get_state") {
          client.off("frame", listener);
          resolve(frame);
        }
      };
      client.on("frame", listener);
    });
    client.send({ id: "state-test", type: "get_state" });
    await expect(stateResponse).resolves.toMatchObject({ type: "response", command: "get_state", success: true });

    const modelsResponse = new Promise<RpcFrame>(resolve => {
      const listener = (frame: RpcFrame): void => {
        if (frame.type === "response" && frame.command === "get_available_models") {
          client.off("frame", listener);
          resolve(frame);
        }
      };
      client.on("frame", listener);
    });
    client.send({ id: "models-test", type: "get_available_models" });
    const models = await modelsResponse;
    expect(models).toMatchObject({ type: "response", command: "get_available_models", success: true });
    expect(Array.isArray((models.data as { models?: unknown[] } | undefined)?.models)).toBe(true);
    await client.stop();
  }, 30_000);
});
