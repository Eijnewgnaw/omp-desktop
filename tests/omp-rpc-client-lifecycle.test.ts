import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: childProcessMocks.spawn,
}));

import { OmpRpcClient } from "../src/main/omp-rpc-client";
import type { RpcFrame, RuntimeDescriptor } from "../src/shared/contracts";

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
  readonly kill = vi.fn((_signal: NodeJS.Signals = "SIGTERM") => true);

  finish(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

const runtimeId = "019ff18b-2e8c-70b2-8700-ec77ab0171aa";

const linuxInstallation = {
  id: "linux-direct:/usr/local/bin/omp",
  kind: "linux-direct" as const,
  label: "Local Linux OMP",
  executablePath: "/usr/local/bin/omp",
  version: "17.2.12",
  agentDir: "/tmp/.omp/agent",
};

const nativeInstallation = {
  id: "windows-native:C:\\Tools\\omp.exe",
  kind: "windows-native" as const,
  label: "Windows OMP",
  executablePath: "C:\\Tools\\omp.exe",
  version: "17.2.12",
  agentDir: "C:\\Users\\tester\\.omp\\agent",
};

const wslInstallation = {
  id: "wsl:Ubuntu-24.04:/usr/bin/omp",
  kind: "wsl" as const,
  label: "Ubuntu-24.04 · WSL",
  distro: "Ubuntu-24.04",
  executablePath: "/usr/bin/omp",
  version: "17.2.12",
  agentDir: "/home/test/.omp/agent",
};

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

  it("keeps Linux-direct launch and graceful shutdown behavior", async () => {
    const child = new FakeChild();
    child.stdin.end.mockImplementation(() => child.finish());
    childProcessMocks.spawn.mockReturnValue(child);
    ready(child);

    const client = new OmpRpcClient(
      runtimeId,
      linuxInstallation,
      { installationId: linuxInstallation.id, path: "/tmp/project" },
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
      ["--profile", "default", "--mode", "rpc-ui", "--cwd", "/tmp/project"],
      expect.objectContaining({ cwd: "/tmp/project", stdio: ["pipe", "pipe", "pipe"] }),
    );
    expect(child.stdin.write).toHaveBeenCalledWith(expect.stringContaining('"type":"abort"'));
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("spawns Windows-native OMP directly with Win32 paths and stops gracefully", async () => {
    const child = new FakeChild();
    child.stdin.end.mockImplementation(() => child.finish());
    childProcessMocks.spawn.mockReturnValue(child);
    ready(child);
    const input = {
      installationId: nativeInstallation.id,
      path: "C:\\Work\\native-project",
      sessionPath: "C:\\Users\\tester\\.omp\\agent\\sessions\\project\\session.jsonl",
    };

    const client = new OmpRpcClient(runtimeId, nativeInstallation, input);
    await expect(client.start()).resolves.toMatchObject({
      installationId: nativeInstallation.id,
      runtimeKind: "windows-native",
      cwd: input.path,
      pid: 1234,
    });
    await client.stop();

    expect(childProcessMocks.spawn).toHaveBeenCalledOnce();
    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      "C:\\Tools\\omp.exe",
      [
        "--profile",
        "default",
        "--mode",
        "rpc-ui",
        "--cwd",
        input.path,
        "--resume",
        input.sessionPath,
      ],
      expect.objectContaining({
        cwd: input.path,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    expect(child.stdin.write).toHaveBeenCalledWith(expect.stringContaining('"type":"abort"'));
    expect(childProcessMocks.spawn).not.toHaveBeenCalledWith("taskkill.exe", expect.anything(), expect.anything());
    expect(childProcessMocks.spawn.mock.calls[0]?.[2]).not.toHaveProperty("shell");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("binds a trusted named profile before every RPC launch option", async () => {
    const child = new FakeChild();
    child.stdin.end.mockImplementation(() => child.finish());
    childProcessMocks.spawn.mockReturnValue(child);
    ready(child);
    const installation = {
      ...nativeInstallation,
      id: "windows-native:work-profile",
      profile: "work",
      agentDir: "C:\\Users\\tester\\.omp\\profiles\\work\\agent",
    };
    const client = new OmpRpcClient(runtimeId, installation, {
      installationId: installation.id,
      path: "C:\\Work\\profile-project",
    });

    await expect(client.start()).resolves.toMatchObject({
      installationId: installation.id,
      profile: "work",
    });
    await client.stop();

    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      installation.executablePath,
      ["--profile", "work", "--mode", "rpc-ui", "--cwd", "C:\\Work\\profile-project"],
      expect.objectContaining({ cwd: "C:\\Work\\profile-project" }),
    );
  });

  it("normalizes XDG session paths before updating the descriptor or forwarding frames", async () => {
    const child = new FakeChild();
    child.stdin.end.mockImplementation(() => child.finish());
    childProcessMocks.spawn.mockReturnValue(child);
    ready(child);
    const installation = {
      ...linuxInstallation,
      id: "linux-direct:xdg-work",
      profile: "work",
      agentDir: "/tmp/config/.omp/profiles/work/agent",
      dataDir: "/tmp/xdg/omp/profiles/work",
    };
    const client = new OmpRpcClient(runtimeId, installation, {
      installationId: installation.id,
      path: "/tmp/project",
    });
    const frames: RpcFrame[] = [];
    client.on("frame", frame => frames.push(frame));
    await client.start();
    frames.length = 0;

    child.stdout.emit("data", Buffer.from(`${JSON.stringify({
      type: "session_info_update",
      sessionFile: "/tmp/xdg/omp/profiles/work/sessions/project/../project/session.jsonl",
    })}\n`));
    expect(client.descriptor.sessionPath).toBe(
      "/tmp/xdg/omp/profiles/work/sessions/project/session.jsonl",
    );
    expect(frames.at(-1)).toMatchObject({
      type: "session_info_update",
      sessionFile: "/tmp/xdg/omp/profiles/work/sessions/project/session.jsonl",
    });

    child.stdout.emit("data", Buffer.from(`${JSON.stringify({
      type: "response",
      command: "get_state",
      success: true,
      data: {
        sessionFile: "/tmp/xdg/omp/profiles/work/sessions/project/./next.jsonl",
      },
    })}\n`));
    expect(client.descriptor.sessionPath).toBe(
      "/tmp/xdg/omp/profiles/work/sessions/project/next.jsonl",
    );
    expect(frames.at(-1)).toMatchObject({
      type: "response",
      command: "get_state",
      data: { sessionFile: "/tmp/xdg/omp/profiles/work/sessions/project/next.jsonl" },
    });
    await client.stop();
  });

  it.each([
    ["session_info_update", {
      type: "session_info_update",
      sessionFile: "/tmp/config/.omp/profiles/work/agent/sessions/project/poisoned.jsonl",
    }],
    ["get_state response", {
      type: "response",
      command: "get_state",
      success: true,
      data: {
        sessionFile: "/tmp/config/.omp/profiles/work/agent/sessions/project/poisoned.jsonl",
      },
    }],
  ])("strictly stops on an out-of-root %s without forwarding or poisoning state", async (_label, invalidFrame) => {
    const child = new FakeChild();
    child.stdin.end.mockImplementation(() => child.finish());
    childProcessMocks.spawn.mockReturnValue(child);
    ready(child);
    const installation = {
      ...linuxInstallation,
      id: "linux-direct:xdg-work",
      profile: "work",
      agentDir: "/tmp/config/.omp/profiles/work/agent",
      dataDir: "/tmp/xdg/omp/profiles/work",
    };
    const client = new OmpRpcClient(runtimeId, installation, {
      installationId: installation.id,
      path: "/tmp/project",
    });
    const frames: RpcFrame[] = [];
    const statuses: RuntimeDescriptor[] = [];
    await client.start();
    client.on("frame", frame => frames.push(frame));
    client.on("status", status => statuses.push(status));

    child.stdout.emit("data", Buffer.from(`${JSON.stringify(invalidFrame)}\n`));
    child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "agent_start" })}\n`));
    await vi.waitFor(() => expect(client.descriptor.state).toBe("exited"));

    expect(client.descriptor.sessionPath).toBeUndefined();
    expect(client.descriptor.error).toContain("outside its trusted data directory");
    expect(frames).toEqual([]);
    expect(statuses).toContainEqual(expect.objectContaining({
      state: "failed",
      sessionPath: undefined,
      error: expect.stringContaining("outside its trusted data directory"),
    }));
    expect(statuses).not.toContainEqual(expect.objectContaining({ state: "running" }));
    expect(child.stdin.end).toHaveBeenCalledOnce();
  });

  it("retains POSIX SIGTERM then SIGKILL escalation for Linux-direct OMP", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.kill.mockImplementation(signal => {
      if (signal === "SIGKILL") queueMicrotask(() => child.finish(137, "SIGKILL"));
      return true;
    });
    childProcessMocks.spawn.mockReturnValue(child);
    ready(child);
    const client = new OmpRpcClient(runtimeId, linuxInstallation, {
      installationId: linuxInstallation.id,
      path: "/tmp/project",
    });
    await client.start();

    const stopping = client.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(1_500);
    await stopping;

    expect(child.kill.mock.calls.map(call => call[0])).toEqual(["SIGTERM", "SIGKILL"]);
    expect(childProcessMocks.spawn).toHaveBeenCalledOnce();
    expect(client.descriptor.state).toBe("exited");
  });

  it("escalates Windows-native shutdown from taskkill /T to the exact root PID with /T /F", async () => {
    vi.useFakeTimers();
    const runtime = new FakeChild();
    const helpers: FakeChild[] = [];
    childProcessMocks.spawn.mockImplementation((command: string, args: string[]) => {
      if (command === nativeInstallation.executablePath) {
        ready(runtime);
        return runtime;
      }
      const helper = new FakeChild();
      helpers.push(helper);
      queueMicrotask(() => {
        helper.finish();
        if (args.includes("/F")) runtime.finish(1);
      });
      return helper;
    });

    const client = new OmpRpcClient(runtimeId, nativeInstallation, {
      installationId: nativeInstallation.id,
      path: "C:\\Work\\native-project",
    });
    await client.start();
    const stopping = client.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(1_500);
    await stopping;

    const taskkillCalls = childProcessMocks.spawn.mock.calls
      .filter(call => call[0] === "taskkill.exe");
    expect(taskkillCalls.map(call => call[1])).toEqual([
      ["/PID", "1234", "/T"],
      ["/PID", "1234", "/T", "/F"],
    ]);
    for (const call of taskkillCalls) {
      expect(call[2]).toEqual(expect.objectContaining({ windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }));
      expect(call[2]).not.toHaveProperty("shell");
    }
    expect(runtime.kill).not.toHaveBeenCalled();
    expect(helpers).toHaveLength(2);
    expect(client.descriptor.state).toBe("exited");
    expect(client.shutdownUnverified).toBe(false);
  });

  it("bounds taskkill helpers and retains native runtime ownership when exit cannot be verified", async () => {
    vi.useFakeTimers();
    const runtime = new FakeChild();
    const helpers: FakeChild[] = [];
    childProcessMocks.spawn.mockImplementation((command: string) => {
      if (command === nativeInstallation.executablePath) {
        ready(runtime);
        return runtime;
      }
      const helper = new FakeChild();
      helpers.push(helper);
      return helper;
    });

    const client = new OmpRpcClient(runtimeId, nativeInstallation, {
      installationId: nativeInstallation.id,
      path: "C:\\Work\\native-project",
    });
    await client.start();
    const stopping = client.stop();
    const assertion = expect(stopping).rejects.toThrow("Could not verify that the native OMP process tree exited");
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(1_500);
    await assertion;

    expect(helpers).toHaveLength(2);
    for (const helper of helpers) expect(helper.kill).toHaveBeenCalledWith("SIGTERM");
    expect(runtime.kill).not.toHaveBeenCalled();
    expect(client.descriptor.state).toBe("failed");
    expect(client.descriptor.error).toContain("helper timed out");
    expect(client.shutdownUnverified).toBe(true);

    runtime.finish(1);
    expect(client.descriptor.state).toBe("exited");
    expect(client.shutdownUnverified).toBe(false);
  });

  it("actively stops a runtime after an RPC decoding failure", async () => {
    const child = new FakeChild();
    child.stdin.end.mockImplementation(() => child.finish());
    childProcessMocks.spawn.mockReturnValue(child);
    ready(child);
    const client = new OmpRpcClient(
      runtimeId,
      linuxInstallation,
      { installationId: linuxInstallation.id, path: "/tmp/project" },
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
      { ...wslInstallation, executablePath: executable },
      {
        installationId: wslInstallation.id,
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
      wslInstallation,
      { installationId: wslInstallation.id, path: "/tmp/project" },
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
      wslInstallation,
      { installationId: wslInstallation.id, path: "/tmp/project" },
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
