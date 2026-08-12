import { describe, expect, it } from "vitest";
import type { OmpRuntimeKind, SessionSummary } from "../src/shared/contracts";
import {
  collectAvailableSessionGroups,
  mergeSessions,
  removeSessionSummary,
  replaceSessionSummary,
  sessionIdentity,
  sessionMatchesIdentity,
  sessionSummaryIdentity,
} from "../src/renderer/session-collection";

interface SessionOptions {
  installationId: string;
  runtimeKind?: OmpRuntimeKind;
  runtimeLabel?: string;
  modifiedAt?: string;
  pinned?: boolean;
  profile?: string;
}

function session(path: string, options: SessionOptions): SessionSummary {
  return {
    id: `${options.installationId}:${path}`,
    installationId: options.installationId,
    runtimeKind: options.runtimeKind ?? "linux-direct",
    runtimeLabel: options.runtimeLabel ?? options.installationId,
    profile: options.profile,
    path,
    cwd: "/work",
    title: path,
    createdAt: "2026-08-12T00:00:00.000Z",
    modifiedAt: options.modifiedAt ?? "2026-08-12T00:00:00.000Z",
    size: 1,
    projectName: "work",
    pinned: options.pinned ?? false,
    archived: false,
    tags: [],
  };
}

describe("session collection", () => {
  it("builds unambiguous compound identities", () => {
    const first = sessionIdentity("install:a", "part:b/session.jsonl");
    const second = sessionIdentity("install:a:part", "b/session.jsonl");

    expect(first).not.toBe(second);
    expect(sessionSummaryIdentity(session("part:b/session.jsonl", {
      installationId: "install:a",
    }))).toBe(first);
  });

  it("normalizes Win32 session paths without weakening POSIX identity", () => {
    expect(sessionIdentity("windows-native:omp", "C:\\Users\\Alice\\Session.JSONL")).toBe(
      sessionIdentity("windows-native:omp", "c:\\users\\alice\\session.jsonl"),
    );
    expect(sessionMatchesIdentity(
      "windows-native:omp",
      "C:\\Users\\Alice\\Session.JSONL",
      "windows-native:omp",
      "c:\\users\\alice\\session.jsonl",
    )).toBe(true);
    expect(sessionMatchesIdentity(
      "wsl:Ubuntu",
      "/home/Alice/Session.jsonl",
      "wsl:Ubuntu",
      "/home/alice/session.jsonl",
    )).toBe(false);
  });

  it("merges all installations into one global stable order without mutating groups", () => {
    const sharedPath = "/sessions/shared.jsonl";
    const native = session(sharedPath, {
      installationId: "windows-native:omp",
      runtimeKind: "windows-native",
      runtimeLabel: "Windows native",
      modifiedAt: "2026-08-12T03:00:00.000Z",
    });
    const wsl = session(sharedPath, {
      installationId: "wsl:Ubuntu",
      runtimeKind: "wsl",
      runtimeLabel: "WSL Ubuntu",
      modifiedAt: "2026-08-12T01:00:00.000Z",
      pinned: true,
    });
    const tiedFirst = session("/sessions/first.jsonl", {
      installationId: "linux-direct:first",
      modifiedAt: "2026-08-12T02:00:00.000Z",
    });
    const tiedSecond = session("/sessions/second.jsonl", {
      installationId: "linux-direct:second",
      modifiedAt: "2026-08-12T02:00:00.000Z",
    });
    const firstGroup = [native, tiedFirst];
    const secondGroup = [wsl, tiedSecond];

    const merged = mergeSessions([firstGroup, secondGroup]);

    expect(merged).toEqual([wsl, native, tiedFirst, tiedSecond]);
    expect(merged.filter(item => item.path === sharedPath)).toEqual([wsl, native]);
    expect(firstGroup).toEqual([native, tiedFirst]);
    expect(secondGroup).toEqual([wsl, tiedSecond]);
    expect(merged).not.toBe(firstGroup);
  });

  it("keeps healthy session groups when another Profile is unavailable", async () => {
    const healthy = session("/sessions/healthy.jsonl", { installationId: "wsl:healthy" });
    const offlineError = new Error("Profile is offline");

    const result = await collectAvailableSessionGroups([
      { installationId: "wsl:offline", sessions: Promise.reject(offlineError) },
      { installationId: "wsl:healthy", sessions: Promise.resolve([healthy]) },
    ]);

    expect(result.groups).toEqual([[healthy]]);
    expect(result.failedInstallationIds).toEqual(["wsl:offline"]);
    expect(result.errors).toEqual([offlineError]);
  });

  it("updates and removes a single installation-scoped session optimistically", () => {
    const original = session("/sessions/shared.jsonl", {
      installationId: "wsl:Ubuntu",
      modifiedAt: "2026-08-12T01:00:00.000Z",
    });
    const otherBackend = session("/sessions/shared.jsonl", {
      installationId: "windows-native:omp",
      runtimeKind: "windows-native",
      modifiedAt: "2026-08-12T03:00:00.000Z",
    });
    const updated = { ...original, title: "Renamed", pinned: true };

    const replaced = replaceSessionSummary([otherBackend, original], updated);
    expect(replaced).toEqual([updated, otherBackend]);
    expect(removeSessionSummary(replaced, original)).toEqual([otherBackend]);
  });
});
