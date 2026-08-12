import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeClients = vi.hoisted(() => ({
  instances: [] as Array<{
    runtimeId: string;
    descriptor: {
      runtimeId: string;
      state: "starting";
      cwd: string;
      installationId: string;
      runtimeKind: "linux-direct" | "windows-native" | "wsl";
      distro?: string;
    };
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }>,
  events: [] as string[],
  failNextStart: false,
  failNextStop: false,
}));

vi.mock("../src/main/omp-rpc-client", () => ({
  OmpRpcClient: class FakeOmpRpcClient extends EventEmitter {
    readonly descriptor;
    readonly runtimeId: string;
    readonly start = vi.fn(async () => {
      fakeClients.events.push(`start:${this.runtimeId}`);
      if (fakeClients.failNextStart) {
        fakeClients.failNextStart = false;
        throw new Error("startup failed");
      }
      return { ...this.descriptor };
    });
    readonly stop = vi.fn(async () => {
      fakeClients.events.push(`stop:${this.runtimeId}`);
      if (fakeClients.failNextStop) {
        fakeClients.failNextStop = false;
        throw new Error("stop could not be verified");
      }
    });

    constructor(
      runtimeId: string,
      installation: { id: string; kind: "linux-direct" | "windows-native" | "wsl"; distro?: string },
      input: { path: string; installationId: string },
    ) {
      super();
      this.runtimeId = runtimeId;
      this.descriptor = {
        runtimeId,
        state: "starting" as const,
        cwd: input.path,
        installationId: installation.id,
        runtimeKind: installation.kind,
        distro: installation.distro,
      };
      fakeClients.instances.push(this);
    }

    send(): void {}
  },
}));

import { RuntimeManager } from "../src/main/runtime-manager";

const installation = {
  id: "linux-direct:/usr/bin/omp",
  kind: "linux-direct" as const,
  label: "Local Linux OMP",
  executablePath: "/usr/bin/omp",
  version: "17.2.12",
  agentDir: "/tmp/.omp/agent",
};

describe("RuntimeManager lifecycle", () => {
  beforeEach(() => {
    fakeClients.instances.length = 0;
    fakeClients.events.length = 0;
    fakeClients.failNextStart = false;
    fakeClients.failNextStop = false;
  });

  it("stops the previous runtime before starting its replacement", async () => {
    const manager = new RuntimeManager();
    const first = await manager.start(installation, {
      installationId: installation.id,
      path: "/tmp/first",
    });
    const second = await manager.start(installation, {
      installationId: installation.id,
      path: "/tmp/second",
    });

    expect(fakeClients.events).toEqual([
      `start:${first.runtimeId}`,
      `stop:${first.runtimeId}`,
      `start:${second.runtimeId}`,
    ]);
    expect(manager.list()).toEqual([expect.objectContaining({ runtimeId: second.runtimeId, cwd: "/tmp/second" })]);
  });

  it("serializes concurrent starts and retains only the newest runtime", async () => {
    const manager = new RuntimeManager();
    const starts = ["one", "two", "three"].map(name =>
      manager.start(installation, {
        installationId: installation.id,
        path: `/tmp/${name}`,
      }),
    );
    const descriptors = await Promise.all(starts);

    expect(manager.list()).toEqual([
      expect.objectContaining({ runtimeId: descriptors[2]?.runtimeId, cwd: "/tmp/three" }),
    ]);
    expect(fakeClients.events).toEqual([
      `start:${descriptors[0]?.runtimeId}`,
      `stop:${descriptors[0]?.runtimeId}`,
      `start:${descriptors[1]?.runtimeId}`,
      `stop:${descriptors[1]?.runtimeId}`,
      `start:${descriptors[2]?.runtimeId}`,
    ]);
  });

  it("stops and removes a runtime whose startup fails", async () => {
    const manager = new RuntimeManager();
    fakeClients.failNextStart = true;

    await expect(
      manager.start(installation, {
        installationId: installation.id,
        path: "/tmp/failing",
      }),
    ).rejects.toThrow("startup failed");

    expect(fakeClients.instances).toHaveLength(1);
    expect(fakeClients.instances[0]?.stop).toHaveBeenCalledOnce();
    expect(manager.list()).toEqual([]);
  });

  it("blocks replacement and retains ownership when the previous runtime cannot stop", async () => {
    const manager = new RuntimeManager();
    const first = await manager.start(installation, {
      installationId: installation.id,
      path: "/tmp/first",
    });
    fakeClients.failNextStop = true;

    await expect(manager.start(installation, {
      installationId: installation.id,
      path: "/tmp/second",
    })).rejects.toThrow("could not be stopped safely");

    expect(fakeClients.instances).toHaveLength(1);
    expect(manager.list()).toEqual([expect.objectContaining({ runtimeId: first.runtimeId })]);
  });

  it("rejects a mismatched installation before disrupting the owned runtime", async () => {
    const manager = new RuntimeManager();
    const first = await manager.start(installation, {
      installationId: installation.id,
      path: "/tmp/first",
    });

    await expect(manager.start(installation, {
      installationId: "windows-native:C:\\Tools\\omp.exe",
      path: "/tmp/second",
    })).rejects.toThrow("does not match");

    expect(fakeClients.events).toEqual([`start:${first.runtimeId}`]);
    expect(fakeClients.instances).toHaveLength(1);
    expect(manager.list()).toEqual([expect.objectContaining({ runtimeId: first.runtimeId })]);
  });

  it("adapter-validates a replacement path before disrupting the owned runtime", async () => {
    const manager = new RuntimeManager();
    const first = await manager.start(installation, {
      installationId: installation.id,
      path: "/tmp/first",
    });

    await expect(manager.start(installation, {
      installationId: installation.id,
      path: "C:\\wrong-backend\\project",
    })).rejects.toThrow("Invalid WSL workspace path");

    expect(fakeClients.events).toEqual([`start:${first.runtimeId}`]);
    expect(manager.list()).toEqual([expect.objectContaining({ runtimeId: first.runtimeId })]);
  });
});
