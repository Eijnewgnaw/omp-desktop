import { execFileSync } from "node:child_process";
import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { OmpRpcClient } from "../src/main/omp-rpc-client";
import type { RpcFrame } from "../src/shared/contracts";

const integrationEnabled = process.env.OMP_INTEGRATION === "1";
const ompPath = process.env.OMP_EXECUTABLE
  || (integrationEnabled ? execFileSync("sh", ["-lc", "command -v omp"], { encoding: "utf8" }).trim() : "omp");

describe.skipIf(!integrationEnabled)("real OMP RPC integration", () => {
  it("handshakes, negotiates v2, and reads state without invoking a model", async () => {
    await access(ompPath);
    const client = new OmpRpcClient(
      "019ff18b-2e8c-70b2-8700-ec77ab0171aa",
      { distro: "direct", executablePath: ompPath, version: "17.2.12", agentDir: "/tmp", direct: true },
      { distro: "direct", installationPath: ompPath, path: "/tmp" },
    );
    await client.start();
    const response = new Promise<RpcFrame>(resolve => {
      const listener = (frame: RpcFrame): void => {
        if (frame.type === "response" && frame.command === "get_state") {
          client.off("frame", listener);
          resolve(frame);
        }
      };
      client.on("frame", listener);
    });
    client.send({ id: "state-test", type: "get_state" });
    await expect(response).resolves.toMatchObject({ type: "response", command: "get_state", success: true });
    await client.stop();
  }, 20_000);
});
