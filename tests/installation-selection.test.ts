import { describe, expect, it } from "vitest";
import type { AppSettings, EnvironmentInfo, OmpInstallation } from "../src/shared/contracts";
import {
  installationDisplayLabel,
  migrateLegacySettings,
  sessionBelongsToInstallation,
  sessionRuntimeDisplayLabel,
  selectedInstallation,
} from "../src/renderer/installation-selection";

function installation(profile?: string): OmpInstallation {
  return {
    id: `wsl:${profile ?? "default"}`,
    kind: "wsl",
    label: profile ? `Ubuntu (WSL) · Profile · ${profile}` : "Ubuntu (WSL) · Default",
    profile,
    distro: "Ubuntu",
    executablePath: "/usr/bin/omp",
    version: "17.2.15",
    agentDir: profile ? `/home/me/.omp/profiles/${profile}/agent` : "/home/me/.omp/agent",
  };
}

function environment(): EnvironmentInfo {
  return {
    platform: "win32",
    mode: "windows-dual",
    installations: [installation(), installation("work")],
    diagnostics: [],
  };
}

function settings(patch: Partial<AppSettings> = {}): AppSettings {
  return { themeMode: "system", ...patch };
}

describe("profile installation selection", () => {
  it("labels the base runtime and default or named profile explicitly", () => {
    expect(installationDisplayLabel(installation())).toBe("WSL · Ubuntu · Default");
    expect(installationDisplayLabel(installation("work"))).toBe("WSL · Ubuntu · Profile · work");
    expect(sessionRuntimeDisplayLabel({ runtimeLabel: "Ubuntu (WSL)", profile: undefined })).toBe(
      "Ubuntu (WSL) · Default",
    );
    expect(sessionRuntimeDisplayLabel({ runtimeLabel: "Ubuntu (WSL) · Profile · work", profile: "work" })).toBe(
      "Ubuntu (WSL) · Profile · work",
    );
  });

  it("migrates an Alpha global profile to the matching installation and workspace namespace", () => {
    const env = environment();
    const legacy = settings({
      selectedInstallationId: "wsl:default",
      selectedDistro: "Ubuntu",
      selectedInstallationPath: "/usr/bin/omp",
      profile: "work",
      lastWorkspace: "/work/legacy",
    });

    expect(selectedInstallation(env, legacy)?.id).toBe("wsl:work");
    expect(migrateLegacySettings(env, legacy)).toMatchObject({
      selectedInstallationId: "wsl:work",
      profile: "",
      recentWorkspaces: { "wsl:work": "/work/legacy" },
    });
  });

  it("binds legacy terminal leases to the matching profile and preserves unresolved leases", () => {
    const env = environment();
    const matched = {
      distro: "Ubuntu",
      installationPath: "/usr/bin/omp",
      sessionPath: "/home/me/.omp/profiles/work/agent/sessions/a.jsonl",
      cwd: "/work/a",
      handedOffAt: "2026-08-12T00:00:00.000Z",
    };
    const unresolved = { ...matched, distro: "Missing" };
    const patch = migrateLegacySettings(env, settings({
      profile: "work",
      handedOffSessions: [matched, unresolved],
    }));

    expect(patch.handedOffSessions).toEqual([
      { ...matched, installationId: "wsl:work" },
      unresolved,
    ]);
  });

  it("upgrades an Alpha handoff already bound to the base installation when its path belongs to work", () => {
    const env = environment();
    const alphaLease = {
      installationId: "wsl:default",
      sessionPath: "/home/me/.omp/profiles/work/agent/sessions/a.jsonl",
      cwd: "/work/a",
      handedOffAt: "2026-08-12T00:00:00.000Z",
    };
    expect(migrateLegacySettings(env, settings({
      profile: "work",
      handedOffSessions: [alphaLease],
    }))).toMatchObject({
      handedOffSessions: [{ ...alphaLease, installationId: "wsl:work" }],
    });
  });

  it("uses normalized containment and isolates default and named profile agent directories", () => {
    const defaultInstallation = installation();
    const workInstallation = installation("work");
    const workSession = "/home/me/.omp/profiles/work/agent/sessions/a.jsonl";
    expect(sessionBelongsToInstallation(workInstallation, workSession)).toBe(true);
    expect(sessionBelongsToInstallation(defaultInstallation, workSession)).toBe(false);
    expect(sessionBelongsToInstallation(
      workInstallation,
      "/home/me/.omp/profiles/work/agent/sessions/../../outside.jsonl",
    )).toBe(false);
  });

  it("recognizes XDG Profile sessions through the flattened data root only", () => {
    const workInstallation: OmpInstallation = {
      ...installation("work"),
      dataDir: "/home/me/.local/share/omp/profiles/work",
    };
    expect(sessionBelongsToInstallation(
      workInstallation,
      "/home/me/.local/share/omp/profiles/work/sessions/a.jsonl",
    )).toBe(true);
    expect(sessionBelongsToInstallation(
      workInstallation,
      "/home/me/.omp/profiles/work/agent/sessions/a.jsonl",
    )).toBe(false);
  });

  it("keeps modern profile installation selection authoritative after legacy profile is cleared", () => {
    const env = environment();
    expect(selectedInstallation(env, settings({
      selectedInstallationId: "wsl:default",
      profile: "",
    }))?.id).toBe("wsl:default");
  });

  it("normalizes the explicit Alpha default profile to the implicit default installation", () => {
    const env = environment();
    const legacy = settings({
      selectedDistro: "Ubuntu",
      selectedInstallationPath: "/usr/bin/omp",
      profile: " DEFAULT ",
    });
    expect(selectedInstallation(env, legacy)?.id).toBe("wsl:default");
    expect(migrateLegacySettings(env, legacy)).toMatchObject({
      selectedInstallationId: "wsl:default",
      profile: "",
    });
  });

  it("does not migrate an unavailable WSL Profile to a same-named native Profile", () => {
    const nativeWork: OmpInstallation = {
      id: "windows-native:work",
      kind: "windows-native",
      label: "Windows (native) · Profile · work",
      profile: "work",
      executablePath: "C:\\Tools\\omp.exe",
      version: "17.2.15",
      agentDir: "C:\\Users\\me\\.omp\\profiles\\work\\agent",
    };
    const env: EnvironmentInfo = {
      platform: "win32",
      mode: "windows-dual",
      installations: [nativeWork],
      diagnostics: [],
    };
    const legacy = settings({
      selectedDistro: "Ubuntu",
      selectedInstallationPath: "/usr/bin/omp",
      profile: "work",
    });

    expect(selectedInstallation(env, legacy)).toBeUndefined();
    expect(migrateLegacySettings(env, legacy)).toEqual({});
  });

  it("does not silently fall back when a modern selected Profile is temporarily unavailable", () => {
    const env = environment();
    expect(selectedInstallation(env, settings({
      selectedInstallationId: "wsl:temporarily-offline",
    }))).toBeUndefined();
    expect(migrateLegacySettings(env, settings({
      selectedInstallationId: "wsl:temporarily-offline",
    }))).toEqual({});
  });

  it("does not let leftover Alpha WSL fields retarget an unavailable modern Profile to Default", () => {
    const env: EnvironmentInfo = {
      ...environment(),
      installations: [installation()],
    };
    const migrated = settings({
      selectedInstallationId: "wsl:work",
      selectedDistro: "Ubuntu",
      selectedInstallationPath: "/usr/bin/omp",
      profile: "",
    });
    expect(selectedInstallation(env, migrated)).toBeUndefined();
    expect(migrateLegacySettings(env, migrated)).toEqual({ profile: "" });
  });

  it("does not migrate an unavailable Alpha named Profile to the detected base Default", () => {
    const env: EnvironmentInfo = {
      ...environment(),
      installations: [installation()],
    };
    const legacy = settings({
      selectedDistro: "Ubuntu",
      selectedInstallationPath: "/usr/bin/omp",
      profile: "work",
    });

    expect(selectedInstallation(env, legacy)).toBeUndefined();
    expect(migrateLegacySettings(env, legacy)).toEqual({});
  });
});
