import { describe, expect, it, vi } from "vitest";
import { SessionOwnershipCoordinator } from "../src/main/session-ownership";
import type { AppSettings, OmpInstallation, RuntimeDescriptor, SessionHandoff } from "../src/shared/contracts";

const linuxInstallation: OmpInstallation = {
  id: "linux-direct:default",
  kind: "linux-direct",
  label: "Linux",
  executablePath: "/usr/bin/omp",
  version: "17.2.15",
  agentDir: "/home/me/.omp/agent",
};
const otherLinuxInstallation: OmpInstallation = {
  ...linuxInstallation,
  id: "linux-direct:work",
  profile: "work",
  agentDir: "/home/me/.omp/profiles/work/agent",
};
const windowsInstallation: OmpInstallation = {
  id: "windows-native:default",
  kind: "windows-native",
  label: "Windows",
  executablePath: "C:\\Tools\\omp.exe",
  version: "17.2.15",
  agentDir: "C:\\Users\\Me\\.omp\\agent",
};

function runtime(
  installation: OmpInstallation,
  sessionPath: string,
  runtimeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
): RuntimeDescriptor {
  return {
    runtimeId,
    state: "ready",
    sessionPath,
    cwd: installation.kind === "windows-native" ? "C:\\Work" : "/work",
    installationId: installation.id,
    runtimeKind: installation.kind,
    profile: installation.profile,
    distro: installation.distro,
  };
}

function handoff(installation: OmpInstallation, sessionPath: string): SessionHandoff {
  return {
    installationId: installation.id,
    sessionPath,
    cwd: installation.kind === "windows-native" ? "C:\\Work" : "/work",
    handedOffAt: "2026-08-12T00:00:00.000Z",
  };
}

function harness(initialSettings: AppSettings = { themeMode: "system" }) {
  const state = {
    runtimes: [] as RuntimeDescriptor[],
    runtimeInstallations: new Map<string, OmpInstallation>(),
    settings: initialSettings,
  };
  const start = vi.fn(async (installation: OmpInstallation, input: { sessionPath?: string; path: string }) => {
    const descriptor = runtime(installation, input.sessionPath ?? `${installation.agentDir}/sessions/new.jsonl`);
    state.runtimes = [descriptor];
    state.runtimeInstallations.set(descriptor.runtimeId, installation);
    return descriptor;
  });
  const stop = vi.fn(async (runtimeId: string) => {
    state.runtimes = state.runtimes.filter(item => item.runtimeId !== runtimeId);
    state.runtimeInstallations.delete(runtimeId);
  });
  const writeSettings = vi.fn((patch: Partial<AppSettings>) => {
    state.settings = { ...state.settings, ...patch };
  });
  const updateSettings = vi.fn((patch: Partial<AppSettings>) => {
    writeSettings(patch);
    return state.settings;
  });
  const coordinator = new SessionOwnershipCoordinator(
    {
      list: () => state.runtimes.map(item => ({ ...item })),
      listOwned: () => state.runtimes.map(descriptor => ({
        descriptor: { ...descriptor },
        installation: state.runtimeInstallations.get(descriptor.runtimeId)
          ?? [linuxInstallation, otherLinuxInstallation, windowsInstallation]
            .find(candidate => candidate.id === descriptor.installationId)
          ?? linuxInstallation,
      })),
      start,
      stop,
    },
    { getSettings: () => state.settings, updateSettings, writeSettings },
  );
  return { state, coordinator, start, stop, updateSettings, writeSettings };
}

describe("main-process session ownership", () => {
  it("rejects trash and permanent deletion while the exact session runtime is active", async () => {
    const sessionPath = "/home/me/.omp/agent/sessions/project/active.jsonl";
    const { state, coordinator } = harness();
    state.runtimes = [runtime(linuxInstallation, sessionPath)];
    const trash = vi.fn();
    const remove = vi.fn();
    await expect(coordinator.trashSession(linuxInstallation, sessionPath, trash))
      .rejects.toThrow("still active in OMP Desktop");
    await expect(coordinator.deleteSession(linuxInstallation, sessionPath, remove))
      .rejects.toThrow("still active in OMP Desktop");
    expect(trash).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("rejects destructive actions while the exact terminal handoff lease exists", async () => {
    const sessionPath = "/home/me/.omp/agent/sessions/project/terminal.jsonl";
    const { coordinator } = harness({ themeMode: "system", handedOffSessions: [handoff(linuxInstallation, sessionPath)] });
    await expect(coordinator.trashSession(linuxInstallation, sessionPath, () => undefined))
      .rejects.toThrow("handed off to an OMP terminal");
    await expect(coordinator.deleteSession(linuxInstallation, sessionPath, () => undefined))
      .rejects.toThrow("handed off to an OMP terminal");
  });

  it("does not confuse another installation or session path with the target", async () => {
    const sessionPath = "/home/me/.omp/agent/sessions/project/target.jsonl";
    const { state, coordinator } = harness({
      themeMode: "system",
      handedOffSessions: [handoff(linuxInstallation, "/home/me/.omp/agent/sessions/project/other.jsonl")],
    });
    state.runtimes = [runtime(otherLinuxInstallation, sessionPath)];
    await expect(coordinator.trashSession(linuxInstallation, sessionPath, () => "trashed")).resolves.toBe("trashed");
    await expect(coordinator.deleteSession(linuxInstallation, sessionPath, () => "deleted")).resolves.toBe("deleted");
  });

  it("allows destructive actions after the owning runtime stops", async () => {
    const sessionPath = "/home/me/.omp/agent/sessions/project/stopped.jsonl";
    const { state, coordinator } = harness();
    state.runtimes = [runtime(linuxInstallation, sessionPath)];
    await expect(coordinator.deleteSession(linuxInstallation, sessionPath, () => undefined)).rejects.toThrow();
    state.runtimes = [];
    await expect(coordinator.trashSession(linuxInstallation, sessionPath, () => "ok")).resolves.toBe("ok");
    await expect(coordinator.deleteSession(linuxInstallation, sessionPath, () => "ok")).resolves.toBe("ok");
  });

  it("normalizes Win32 case and slash direction before comparing ownership", async () => {
    const requested = "C:\\Users\\Me\\.omp\\agent\\sessions\\Project\\Owned.jsonl";
    const alternate = "c:/users/me/.omp/agent/sessions/project/owned.JSONL";
    const { state, coordinator } = harness();
    state.runtimes = [runtime(windowsInstallation, alternate)];
    await expect(coordinator.deleteSession(windowsInstallation, requested, () => undefined))
      .rejects.toThrow("still active in OMP Desktop");
    state.runtimes = [];
    state.settings = { themeMode: "system", handedOffSessions: [handoff(windowsInstallation, alternate)] };
    await expect(coordinator.trashSession(windowsInstallation, requested, () => undefined))
      .rejects.toThrow("handed off to an OMP terminal");
  });

  it("blocks a different installation ID that resolves to the same physical session root", async () => {
    const sessionPath = "/home/me/.omp/agent/sessions/project/shared.jsonl";
    const oldExecutable: OmpInstallation = {
      ...linuxInstallation,
      id: "linux-direct:old-executable",
      executablePath: "/opt/old/omp",
    };
    const { state, coordinator } = harness();
    const descriptor = runtime(oldExecutable, sessionPath);
    state.runtimes = [descriptor];
    state.runtimeInstallations.set(descriptor.runtimeId, oldExecutable);

    await expect(coordinator.deleteSession(linuxInstallation, sessionPath, () => undefined))
      .rejects.toThrow("still active in OMP Desktop");
    await expect(coordinator.handoffToTerminal(linuxInstallation, {
      installationId: linuxInstallation.id,
      path: "/work",
      sessionPath,
    }, () => undefined)).rejects.toThrow("still active in OMP Desktop");
  });

  it("blocks a native executable alias that shares the same physical Windows data root", async () => {
    const sessionPath = "C:\\Users\\Me\\.omp\\agent\\sessions\\Project\\Shared.jsonl";
    const oldExecutable: OmpInstallation = {
      ...windowsInstallation,
      id: "windows-native:old-executable",
      executablePath: "D:\\Old\\omp.exe",
    };
    const { state, coordinator } = harness();
    const descriptor = runtime(oldExecutable, sessionPath);
    state.runtimes = [descriptor];
    state.runtimeInstallations.set(descriptor.runtimeId, oldExecutable);
    await expect(coordinator.trashSession(windowsInstallation, sessionPath, () => undefined))
      .rejects.toThrow("still active in OMP Desktop");
    await expect(coordinator.deleteSession(windowsInstallation, sessionPath, () => undefined))
      .rejects.toThrow("still active in OMP Desktop");
    await expect(coordinator.handoffToTerminal(windowsInstallation, {
      installationId: windowsInstallation.id,
      path: "C:\\Work",
      sessionPath,
    }, () => undefined)).rejects.toThrow("still active in OMP Desktop");
  });

  it("keeps a stale WSL lease bound to its distro across installation ID changes", async () => {
    const sessionPath = "/home/me/.omp/agent/sessions/project/stale.jsonl";
    const ubuntu: OmpInstallation = {
      ...linuxInstallation,
      id: "wsl:ubuntu-new",
      kind: "wsl",
      distro: "Ubuntu",
    };
    const debian: OmpInstallation = { ...ubuntu, id: "wsl:debian", distro: "Debian" };
    const staleLease: SessionHandoff = {
      ...handoff(ubuntu, sessionPath),
      installationId: "wsl:ubuntu-old",
      distro: "Ubuntu",
    };
    const { coordinator, start } = harness({ themeMode: "system", handedOffSessions: [staleLease] });
    await expect(coordinator.startRuntime(ubuntu, {
      installationId: ubuntu.id,
      path: "/work",
      sessionPath,
    })).rejects.toThrow("reclaim it before resuming");
    await expect(coordinator.startRuntime(debian, {
      installationId: debian.id,
      path: "/work",
      sessionPath,
    })).resolves.toEqual(expect.objectContaining({ installationId: debian.id }));
    expect(start).toHaveBeenCalledOnce();
  });

  it("does not merge installations whose Profile data roots differ", async () => {
    const targetPath = "/home/me/.omp/agent/sessions/project/default.jsonl";
    const profilePath = "/home/me/.omp/profiles/work/agent/sessions/project/work.jsonl";
    const { state, coordinator } = harness();
    const descriptor = runtime(otherLinuxInstallation, profilePath);
    state.runtimes = [descriptor];
    state.runtimeInstallations.set(descriptor.runtimeId, otherLinuxInstallation);
    await expect(coordinator.deleteSession(linuxInstallation, targetPath, () => "deleted"))
      .resolves.toBe("deleted");
  });

  it("conservatively blocks destructive and terminal actions while a same-root runtime has no session path", async () => {
    const sessionPath = "/home/me/.omp/agent/sessions/project/unknown.jsonl";
    const { state, coordinator } = harness();
    const descriptor = runtime(linuxInstallation, sessionPath);
    delete descriptor.sessionPath;
    state.runtimes = [descriptor];
    state.runtimeInstallations.set(descriptor.runtimeId, linuxInstallation);

    await expect(coordinator.trashSession(linuxInstallation, sessionPath, () => undefined))
      .rejects.toThrow("still active in OMP Desktop");
    await expect(coordinator.handoffToTerminal(linuxInstallation, {
      installationId: linuxInstallation.id,
      path: "/work",
      sessionPath,
    }, () => undefined)).rejects.toThrow("still active in OMP Desktop");
  });

  it("refuses ordinary resume while a lease exists and allows an unrelated session", async () => {
    const leasedPath = "/home/me/.omp/agent/sessions/project/leased.jsonl";
    const { coordinator, start } = harness({
      themeMode: "system",
      handedOffSessions: [handoff(linuxInstallation, leasedPath)],
    });
    await expect(coordinator.startRuntime(linuxInstallation, {
      installationId: linuxInstallation.id,
      path: "/work",
      sessionPath: leasedPath,
    })).rejects.toThrow("reclaim it before resuming");
    expect(start).not.toHaveBeenCalled();
    await expect(coordinator.startRuntime(linuxInstallation, {
      installationId: linuxInstallation.id,
      path: "/work",
      sessionPath: "/home/me/.omp/agent/sessions/project/free.jsonl",
    })).resolves.toEqual(expect.objectContaining({ installationId: linuxInstallation.id }));
  });

  it("atomically starts reclaim before removing its lease", async () => {
    const sessionPath = "/home/me/.omp/agent/sessions/project/reclaim.jsonl";
    const lease = handoff(linuxInstallation, sessionPath);
    const { state, coordinator, start, writeSettings } = harness({ themeMode: "system", handedOffSessions: [lease] });
    start.mockImplementationOnce(async installation => {
      expect(state.settings.handedOffSessions).toEqual([lease]);
      const descriptor = runtime(installation, sessionPath);
      state.runtimes = [descriptor];
      return descriptor;
    });
    const result = await coordinator.reclaimSession(linuxInstallation, {
      installationId: linuxInstallation.id,
      path: "/work",
      sessionPath,
    });
    expect(result.descriptor.sessionPath).toBe(sessionPath);
    expect(result.settings.handedOffSessions).toEqual([]);
    expect(writeSettings).toHaveBeenCalledWith({ handedOffSessions: [] });
  });

  it("keeps the lease if reclaim startup fails", async () => {
    const sessionPath = "/home/me/.omp/agent/sessions/project/reclaim-fail.jsonl";
    const lease = handoff(linuxInstallation, sessionPath);
    const { state, coordinator, start, writeSettings } = harness({ themeMode: "system", handedOffSessions: [lease] });
    start.mockRejectedValueOnce(new Error("startup failed"));
    await expect(coordinator.reclaimSession(linuxInstallation, {
      installationId: linuxInstallation.id,
      path: "/work",
      sessionPath,
    })).rejects.toThrow("startup failed");
    expect(state.settings.handedOffSessions).toEqual([lease]);
    expect(writeSettings).not.toHaveBeenCalled();
  });

  it("stops a reclaimed runtime if persisting desktop ownership fails", async () => {
    const sessionPath = "/home/me/.omp/agent/sessions/project/reclaim-db-fail.jsonl";
    const lease = handoff(linuxInstallation, sessionPath);
    const { state, coordinator, stop, writeSettings } = harness({ themeMode: "system", handedOffSessions: [lease] });
    writeSettings.mockImplementationOnce(() => {
      throw new Error("database unavailable");
    });
    await expect(coordinator.reclaimSession(linuxInstallation, {
      installationId: linuxInstallation.id,
      path: "/work",
      sessionPath,
    })).rejects.toThrow("database unavailable");
    expect(stop).toHaveBeenCalledOnce();
    expect(state.settings.handedOffSessions).toEqual([lease]);
  });

  it("persists one lease before terminal launch and rejects a repeated launch", async () => {
    const sessionPath = "/home/me/.omp/agent/sessions/project/handoff.jsonl";
    const { state, coordinator } = harness();
    const launch = vi.fn(async () => {
      expect(state.settings.handedOffSessions).toEqual([
        expect.objectContaining({ installationId: linuxInstallation.id, sessionPath }),
      ]);
    });
    const input = { installationId: linuxInstallation.id, path: "/work", sessionPath };
    const settings = await coordinator.handoffToTerminal(linuxInstallation, input, launch);
    expect(settings.handedOffSessions).toHaveLength(1);
    await expect(coordinator.handoffToTerminal(linuxInstallation, input, launch))
      .rejects.toThrow("already handed off");
    expect(launch).toHaveBeenCalledOnce();
  });

  it("rejects terminal handoff while the exact desktop runtime remains active", async () => {
    const sessionPath = "/home/me/.omp/agent/sessions/project/active-handoff.jsonl";
    const { state, coordinator } = harness();
    state.runtimes = [runtime(linuxInstallation, sessionPath)];
    const launch = vi.fn();
    await expect(coordinator.handoffToTerminal(linuxInstallation, {
      installationId: linuxInstallation.id,
      path: "/work",
      sessionPath,
    }, launch)).rejects.toThrow("still active in OMP Desktop");
    expect(launch).not.toHaveBeenCalled();
  });

  it("rolls back only its new lease when terminal launch fails", async () => {
    const existing = handoff(linuxInstallation, "/home/me/.omp/agent/sessions/project/existing.jsonl");
    const sessionPath = "/home/me/.omp/agent/sessions/project/failing-terminal.jsonl";
    const { state, coordinator } = harness({ themeMode: "system", handedOffSessions: [existing] });
    await expect(coordinator.handoffToTerminal(linuxInstallation, {
      installationId: linuxInstallation.id,
      path: "/work",
      sessionPath,
    }, async () => { throw new Error("terminal failed"); })).rejects.toThrow("terminal failed");
    expect(state.settings.handedOffSessions).toEqual([existing]);
  });

  it("never evicts an existing ownership lease when the 256-lease capacity is reached", async () => {
    const leases = Array.from({ length: 256 }, (_, index) => handoff(
      linuxInstallation,
      `/home/me/.omp/agent/sessions/project/lease-${index}.jsonl`,
    ));
    const { state, coordinator } = harness({ themeMode: "system", handedOffSessions: leases });
    const launch = vi.fn();
    await expect(coordinator.handoffToTerminal(linuxInstallation, {
      installationId: linuxInstallation.id,
      path: "/work",
      sessionPath: "/home/me/.omp/agent/sessions/project/lease-257.jsonl",
    }, launch)).rejects.toThrow("Too many active terminal ownership leases");
    expect(state.settings.handedOffSessions).toEqual(leases);
    expect(launch).not.toHaveBeenCalled();
  });

  it("keeps checks and writer-changing operations in one serial region", async () => {
    const sessionPath = "/home/me/.omp/agent/sessions/project/race.jsonl";
    const { state, coordinator, start } = harness();
    let releaseStart!: () => void;
    const blocked = new Promise<void>(resolve => { releaseStart = resolve; });
    let entered = false;
    start.mockImplementationOnce(async installation => {
      entered = true;
      const descriptor = runtime(installation, sessionPath);
      state.runtimes = [descriptor];
      await blocked;
      return descriptor;
    });
    const starting = coordinator.startRuntime(linuxInstallation, {
      installationId: linuxInstallation.id,
      path: "/work",
      sessionPath,
    });
    const remove = vi.fn();
    const deletion = coordinator.deleteSession(linuxInstallation, sessionPath, remove);
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(remove).not.toHaveBeenCalled();
    releaseStart();
    await starting;
    await expect(deletion).rejects.toThrow("still active in OMP Desktop");
    expect(remove).not.toHaveBeenCalled();
  });
});
