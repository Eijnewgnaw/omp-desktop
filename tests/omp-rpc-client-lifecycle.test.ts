import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: childProcessMocks.spawn,
}));

import { OmpRpcClient } from "../src/main/omp-rpc-client";

class FakeStream extends EventEmitter {}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly stdin = {
    writable: true,
    write: vi.fn(() => true),
    end: vi.fn(),
  };
  readonly pid = 1234;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    this.signalCode = signal;
    return true;
  });

  finish(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

const runtimeId = "019ff18b-2e8c-70b2-8700-ec77ab0171aa";

function ready(child: FakeChild, processGroup?: number): void {
  queueMicrotask(() => {
    if (processGroup) {
      child.stderr.emit("data", Buffer.from(`\u001eOMP_DESKTOP_PROCESS_GROUP=${processGroup}\u001f\n`));
    }
    child.stdout.emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "ready", supportedProtocolVersions: [1, 2] })}\n`),
    );
  });
}

describe("OmpRpcClient lifecycle", () => {
  beforeEach(() => {
    childProcessMocks.spawn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps direct-mode launch and graceful shutdown behavior", async () => {
    const child = new FakeChild();
    child.stdin.end.mockImplementation(() => child.finish());
    childProcessMocks.spawn.mockReturnValue(child);
    ready(child);

    const client = new OmpRpcClient(
      runtimeId,
      { distro: "direct", executablePath: "/usr/local/bin/omp", version: "17.2.12", agentDir: "/tmp", direct: true },
      { distro: "direct", installationPath: "/usr/local/bin/omp", path: "/tmp/project" },
    );
    await client.start();

    child.stdout.emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "response", command: "prompt", success: false, error: "temporary failure" })}\n`),
    );
    expect(client.descriptor.error).toBe("temporary failure");
    child.stdout.emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "response", command: "get_state", success: true, data: {} })}\n`),
    );
    expect(client.descriptor.error).toBeUndefined();
    child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "agent_start" })}\n`));
    child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "agent_end", isTerminal: false })}\n`));
    expect(client.descriptor.state).toBe("running");
    child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "agent_end", isTerminal: true })}\n`));
    expect(client.descriptor.state).toBe("completed");
    await client.stop();

    expect(childProcessMocks.spawn).toHaveBeenCalledOnce();
    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      "/usr/local/bin/omp",
      ["--mode", "rpc-ui", "--cwd", "/tmp/project"],
      expect.objectContaining({ cwd: "/tmp/project", stdio: ["pipe", "pipe", "pipe"] }),
    );
    expect(child.stdin.write).toHaveBeenCalledWith(expect.stringContaining('"type":"abort"'));
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("actively stops a runtime after an RPC decoding failure", async () => {
    const child = new FakeChild();
    child.stdin.end.mockImplementation(() => child.finish());
    childProcessMocks.spawn.mockReturnValue(child);
    ready(child);
    const client = new OmpRpcClient(
      runtimeId,
      { distro: "direct", executablePath: "/usr/local/bin/omp", version: "17.2.12", agentDir: "/tmp", direct: true },
      { distro: "direct", installationPath: "/usr/local/bin/omp", path: "/tmp/project" },
    );
    await client.start();

    child.stdout.emit("data", Buffer.from("{not-json}\n"));
    await vi.waitFor(() => expect(client.descriptor.state).toBe("exited"));

    expect(child.stdin.end).toHaveBeenCalledOnce();
  });

  it("passes WSL paths positionally and terminates the exact recorded process group", async () => {
    vi.useFakeTimers();
    const runtime = new FakeChild();
    const helpers: FakeChild[] = [];
    childProcessMocks.spawn.mockImplementation((_command: string, args: string[]) => {
      if (args.includes("--cd")) {
        ready(runtime, 4321);
        return runtime;
      }
      const helper = new FakeChild();
      helpers.push(helper);
      queueMicrotask(() => {
        helper.finish();
        if (args.includes("KILL")) runtime.finish(137);
      });
      return helper;
    });

    const workspace = "/tmp/work;echo NOT_EXECUTED";
    const executable = "/opt/omp;not-a-command";
    const sessionPath = "/tmp/session;still-an-argument.jsonl";
    const client = new OmpRpcClient(
      runtimeId,
      { distro: "Ubuntu-24.04", executablePath: executable, version: "17.2.12", agentDir: "/home/test/.omp/agent", direct: false },
      {
        distro: "Ubuntu-24.04",
        installationPath: executable,
        path: workspace,
        sessionPath,
      },
    );
    await client.start();
    runtime.stderr.emit("data", Buffer.from("\u001eOMP_DESKTOP_PROCESS_GROUP=9999\u001f\n"));

    const launchArgs = childProcessMocks.spawn.mock.calls[0]?.[1] as string[];
    const scriptIndex = launchArgs.indexOf("-c") + 1;
    const launchScript = launchArgs[scriptIndex] ?? "";
    expect(launchArgs).toEqual(expect.arrayContaining(["/bin/sh", executable, sessionPath]));
    expect(launchScript).toContain("/usr/bin/setsid --fork --wait");
    expect(launchScript).not.toContain(workspace);
    expect(launchScript).not.toContain(executable);
    expect(launchScript).not.toContain(sessionPath);

    const stopping = client.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(1_500);
    await stopping;

    const helperCalls = childProcessMocks.spawn.mock.calls.slice(1).map(call => call[1] as string[]);
    const term = helperCalls.find(args => args.includes("TERM"));
    const kill = helperCalls.find(args => args.includes("KILL"));
    const cleanup = helperCalls.find(args => args.includes("omp-desktop-cleanup"));
    expect(term).toEqual(expect.arrayContaining(["omp-desktop-signal", "TERM", "4321", `/tmp/omp-desktop-${runtimeId}.pid`]));
    expect(kill).toEqual(expect.arrayContaining(["omp-desktop-signal", "KILL", "4321", `/tmp/omp-desktop-${runtimeId}.pid`]));
    expect(helperCalls.flat()).not.toContain("9999");
    expect(cleanup).toEqual(expect.arrayContaining(["omp-desktop-cleanup", `/tmp/omp-desktop-${runtimeId}.pid`]));
    expect(helperCalls.flat().join(" ")).not.toMatch(/pkill|killall|--terminate/i);
    expect(runtime.kill).not.toHaveBeenCalled();
    expect(client.descriptor.state).toBe("exited");
    expect(client.descriptor.error).toBeUndefined();
    expect(helpers.length).toBeGreaterThanOrEqual(3);
  });

  it("reaps the WSL process group when RPC startup times out", async () => {
    vi.useFakeTimers();
    const runtime = new FakeChild();
    childProcessMocks.spawn.mockImplementation((_command: string, args: string[]) => {
      if (args.includes("--cd")) {
        queueMicrotask(() => {
          runtime.stderr.emit("data", Buffer.from("\u001eOMP_DESKTOP_PROCESS_GROUP=9876\u001f\n"));
        });
        return runtime;
      }
      const helper = new FakeChild();
      queueMicrotask(() => {
        helper.finish();
        if (args.includes("KILL")) runtime.finish(137);
      });
      return helper;
    });

    const client = new OmpRpcClient(
      runtimeId,
      { distro: "Ubuntu", executablePath: "/usr/bin/omp", version: "17.2.12", agentDir: "/home/test/.omp/agent", direct: false },
      { distro: "Ubuntu", installationPath: "/usr/bin/omp", path: "/tmp/project" },
    );
    const starting = client.start();
    const assertion = expect(starting).rejects.toThrow(/startup timed out/i);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(1_500);
    await assertion;

    const helperCalls = childProcessMocks.spawn.mock.calls.slice(1).map(call => call[1] as string[]);
    expect(helperCalls.some(args => args.includes("TERM") && args.includes("9876"))).toBe(true);
    expect(helperCalls.some(args => args.includes("KILL") && args.includes("9876"))).toBe(true);
    expect(helperCalls.some(args => args.includes("omp-desktop-cleanup"))).toBe(true);
  });

  it("rejects shutdown when the WSL process group never exits", async () => {
    vi.useFakeTimers();
    const runtime = new FakeChild();
    childProcessMocks.spawn.mockImplementation((_command: string, args: string[]) => {
      if (args.includes("--cd")) {
        ready(runtime, 2468);
        return runtime;
      }
      const helper = new FakeChild();
      queueMicrotask(() => helper.finish());
      return helper;
    });
    const client = new OmpRpcClient(
      runtimeId,
      { distro: "Ubuntu", executablePath: "/usr/bin/omp", version: "17.2.12", agentDir: "/home/test/.omp/agent", direct: false },
      { distro: "Ubuntu", installationPath: "/usr/bin/omp", path: "/tmp/project" },
    );
    await client.start();

    const stopping = client.stop();
    const assertion = expect(stopping).rejects.toThrow("Could not verify that the OMP WSL process group exited");
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(1_500);
    await assertion;

    expect(client.descriptor.state).toBe("failed");
    expect(runtime.kill).not.toHaveBeenCalled();
    const helperCalls = childProcessMocks.spawn.mock.calls.slice(1).map(call => call[1] as string[]);
    expect(helperCalls.some(args => args.includes("TERM"))).toBe(true);
    expect(helperCalls.some(args => args.includes("KILL"))).toBe(true);
    expect(helperCalls.some(args => args.includes("omp-desktop-cleanup"))).toBe(false);

    runtime.finish(137);
    expect(client.descriptor.state).toBe("exited");
    expect(client.shutdownUnverified).toBe(false);
  });
});
