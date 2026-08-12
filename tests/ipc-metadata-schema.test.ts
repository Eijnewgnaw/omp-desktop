import { describe, expect, it } from "vitest";
import {
  assertInstallationSessionPath,
  createEnvironmentResolver,
  handoffMigrationOwners,
  handoffSchema,
  metadataPatchSchema,
  startRuntimeSchema,
  validateInstallationBoundSettings,
} from "../src/main/ipc";
import type { AppSettings, EnvironmentInfo, OmpInstallation } from "../src/shared/contracts";

describe("environment IPC coalescing", () => {
  it("shares one detection across concurrent forced and cache-miss requests", async () => {
    const environment: EnvironmentInfo = {
      platform: "win32",
      mode: "windows-dual",
      installations: [],
      diagnostics: [],
    };
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const resolveEnvironment = createEnvironmentResolver(async () => {
      calls += 1;
      await blocked;
      return environment;
    });

    const requests = Array.from({ length: 10 }, (_, index) => resolveEnvironment(index % 2 === 0));
    await Promise.resolve();
    expect(calls).toBe(1);
    release();
    await expect(Promise.all(requests)).resolves.toEqual(Array(10).fill(environment));
    expect(calls).toBe(1);
  });

  it("serves a fresh cache, refreshes when forced, and retries after a failed detection", async () => {
    const environment: EnvironmentInfo = {
      platform: "linux",
      mode: "linux-direct",
      installations: [],
      diagnostics: [],
    };
    let calls = 0;
    let fail = true;
    const resolveEnvironment = createEnvironmentResolver(async () => {
      calls += 1;
      if (fail) throw new Error("temporary detection failure");
      return environment;
    });
    await expect(resolveEnvironment()).rejects.toThrow("temporary detection failure");
    fail = false;
    await expect(resolveEnvironment()).resolves.toBe(environment);
    await expect(resolveEnvironment()).resolves.toBe(environment);
    expect(calls).toBe(2);
    await expect(resolveEnvironment(true)).resolves.toBe(environment);
    expect(calls).toBe(3);
  });
});

describe("session metadata IPC validation", () => {
  it("trims a user display title before it reaches metadata storage", () => {
    expect(metadataPatchSchema.parse({ displayTitle: "  Renamed session  " })).toEqual({
      displayTitle: "Renamed session",
    });
  });

  it("rejects a blank display title", () => {
    expect(() => metadataPatchSchema.parse({ displayTitle: " \n\t " })).toThrow();
  });

  it("retains null as the explicit request to clear a display title", () => {
    expect(metadataPatchSchema.parse({ displayTitle: null })).toEqual({ displayTitle: null });
  });
});

describe("runtime IPC validation", () => {
  it("accepts the default-profile runtime input used by the desktop", () => {
    expect(startRuntimeSchema.parse({
      installationId: "windows-native:fixture",
      path: "C:\\Work\\project",
    })).toEqual({
      installationId: "windows-native:fixture",
      path: "C:\\Work\\project",
    });
  });

  it("rejects renderer-supplied profiles because the trusted installation owns profile selection", () => {
    expect(() => startRuntimeSchema.parse({
      installationId: "windows-native:fixture",
      path: "C:\\Work\\project",
      profile: "work",
    })).toThrow();
  });

  it("binds resume paths to the selected Profile sessions directory", () => {
    const defaultInstallation: OmpInstallation = {
      id: "wsl:default",
      kind: "wsl",
      label: "Ubuntu (WSL)",
      distro: "Ubuntu",
      executablePath: "/usr/bin/omp",
      version: "17.2.15",
      agentDir: "/home/me/.omp/agent",
    };
    expect(assertInstallationSessionPath(
      defaultInstallation,
      "/home/me/.omp/agent/sessions/project/a.jsonl",
    )).toBe("/home/me/.omp/agent/sessions/project/a.jsonl");
    expect(() => assertInstallationSessionPath(
      defaultInstallation,
      "/home/me/.omp/profiles/work/agent/sessions/project/a.jsonl",
    )).toThrow("outside the OMP sessions directory");
  });

  it("binds XDG Profile resume paths to the flattened data root, not config path", () => {
    const xdgProfile: OmpInstallation = {
      id: "wsl:xdg-work",
      kind: "wsl",
      label: "Ubuntu (WSL) · Profile · work",
      distro: "Ubuntu",
      profile: "work",
      executablePath: "/usr/bin/omp",
      version: "17.2.15",
      agentDir: "/home/me/.omp/profiles/work/agent",
      dataDir: "/home/me/.local/share/omp/profiles/work",
    };
    expect(assertInstallationSessionPath(
      xdgProfile,
      "/home/me/.local/share/omp/profiles/work/sessions/project/a.jsonl",
    )).toBe("/home/me/.local/share/omp/profiles/work/sessions/project/a.jsonl");
    expect(() => assertInstallationSessionPath(
      xdgProfile,
      "/home/me/.omp/profiles/work/agent/sessions/project/a.jsonl",
    )).toThrow("outside the OMP sessions directory");
  });
});

describe("terminal handoff IPC validation", () => {
  it("limits a legacy lease to its WSL base when two distros expose the same POSIX path", () => {
    const ubuntu: OmpInstallation = {
      id: "wsl:ubuntu",
      kind: "wsl",
      label: "Ubuntu",
      distro: "Ubuntu",
      executablePath: "/usr/bin/omp",
      version: "17.2.15",
      agentDir: "/home/me/.omp/agent",
    };
    const debian: OmpInstallation = { ...ubuntu, id: "wsl:debian", label: "Debian", distro: "Debian" };
    const legacy = {
      distro: "Ubuntu",
      installationPath: "/usr/bin/omp",
      sessionPath: "/home/me/.omp/agent/sessions/project/a.jsonl",
      cwd: "/work/a",
      handedOffAt: "2026-08-12T00:00:00.000Z",
    };
    expect(handoffMigrationOwners([ubuntu, debian], legacy).map(item => item.id)).toEqual([ubuntu.id]);
  });

  it("migrates an Alpha base ID to the named Profile that physically owns its session", () => {
    const base: OmpInstallation = {
      id: "wsl:ubuntu-default",
      kind: "wsl",
      label: "Ubuntu",
      distro: "Ubuntu",
      executablePath: "/usr/bin/omp",
      version: "17.2.15",
      agentDir: "/home/me/.omp/agent",
    };
    const work: OmpInstallation = {
      ...base,
      id: "wsl:ubuntu-work",
      profile: "work",
      agentDir: "/home/me/.omp/profiles/work/agent",
    };
    const alphaLease = {
      installationId: base.id,
      sessionPath: "/home/me/.omp/profiles/work/agent/sessions/project/a.jsonl",
      cwd: "/work/a",
      handedOffAt: "2026-08-12T00:00:00.000Z",
    };
    expect(handoffMigrationOwners([base, work], alphaLease).map(item => item.id)).toEqual([work.id]);
  });

  it("keeps a stale opaque ID conservative when multiple physical owners remain plausible", () => {
    const ubuntu: OmpInstallation = {
      id: "wsl:ubuntu-new",
      kind: "wsl",
      label: "Ubuntu",
      distro: "Ubuntu",
      executablePath: "/usr/bin/omp",
      version: "17.2.15",
      agentDir: "/home/me/.omp/agent",
    };
    const debian: OmpInstallation = { ...ubuntu, id: "wsl:debian", label: "Debian", distro: "Debian" };
    const stale = {
      installationId: "wsl:missing-old-id",
      sessionPath: "/home/me/.omp/agent/sessions/project/a.jsonl",
      cwd: "/work/a",
      handedOffAt: "2026-08-12T00:00:00.000Z",
    };
    expect(handoffMigrationOwners([ubuntu, debian], stale).map(item => item.id).sort())
      .toEqual([debian.id, ubuntu.id].sort());
  });

  it("accepts a complete unresolved legacy WSL lease for conservative migration", () => {
    const lease = {
      distro: "Ubuntu-24.04",
      installationPath: "/usr/bin/omp",
      sessionPath: "/home/alice/.omp/agent/sessions/a.jsonl",
      cwd: "/work/a",
      handedOffAt: "2026-08-12T00:00:00.000Z",
    };
    expect(handoffSchema.parse(lease)).toEqual(lease);
  });

  it("rejects an ambiguous legacy lease without installation metadata", () => {
    expect(() => handoffSchema.parse({
      sessionPath: "/home/alice/.omp/agent/sessions/a.jsonl",
      cwd: "/work/a",
      handedOffAt: "2026-08-12T00:00:00.000Z",
    })).toThrow();
  });

  it("preserves unchanged offline records while validating healthy runtime updates", async () => {
    const online: OmpInstallation = {
      id: "wsl:online",
      kind: "wsl",
      label: "Ubuntu (WSL)",
      distro: "Ubuntu",
      executablePath: "/usr/bin/omp",
      version: "17.2.15",
      agentDir: "/home/me/.omp/agent",
    };
    const offlineLease = {
      installationId: "wsl:offline-profile",
      sessionPath: "/home/me/.omp/profiles/work/agent/sessions/p/a.jsonl",
      cwd: "/work/offline",
      handedOffAt: "2026-08-12T00:00:00.000Z",
    };
    const current: AppSettings = {
      themeMode: "system",
      recentWorkspaces: {
        "wsl:online": "/work/old",
        "wsl:offline-profile": "/work/offline",
      },
      handedOffSessions: [offlineLease],
    };
    const environment: EnvironmentInfo = {
      platform: "win32",
      mode: "windows-dual",
      installations: [online],
      diagnostics: [],
    };
    const resolve = async (installationId: string): Promise<OmpInstallation> => {
      if (installationId === online.id) return online;
      throw new Error("installation unavailable");
    };

    await expect(validateInstallationBoundSettings({
      recentWorkspaces: {
        "wsl:online": "/work/new",
        "wsl:offline-profile": "/work/offline",
      },
      handedOffSessions: [
        offlineLease,
        {
          installationId: online.id,
          sessionPath: "/home/me/.omp/agent/sessions/p/b.jsonl",
          cwd: "/work/new",
          handedOffAt: "2026-08-12T01:00:00.000Z",
        },
      ],
    }, resolve, async () => environment, current)).resolves.toEqual({
      recentWorkspaces: {
        "wsl:online": "/work/new",
        "wsl:offline-profile": "/work/offline",
      },
      handedOffSessions: [
        offlineLease,
        {
          installationId: online.id,
          sessionPath: "/home/me/.omp/agent/sessions/p/b.jsonl",
          cwd: "/work/new",
          handedOffAt: "2026-08-12T01:00:00.000Z",
        },
      ],
    });

    await expect(validateInstallationBoundSettings({
      recentWorkspaces: { "wsl:offline-profile": "/work/tampered" },
    }, resolve, async () => environment, current)).rejects.toThrow("installation unavailable");
    await expect(validateInstallationBoundSettings({
      handedOffSessions: [{ ...offlineLease, cwd: "/work/tampered" }],
    }, resolve, async () => environment, current)).rejects.toThrow("installation unavailable");
  });
});
