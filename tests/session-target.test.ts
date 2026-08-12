import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../src/shared/contracts";
import {
  attachTargetSessionPath,
  chooseTargetInstallation,
  chooseTargetWorkspace,
  newSessionTarget,
  reconcileTarget,
  savedSessionTarget,
  targetInstallationId,
  targetSessionPath,
  targetWorkspace,
} from "../src/renderer/session-target";

function session(path: string, cwd: string, installationId = "linux-direct:default"): SessionSummary {
  return {
    id: path,
    installationId,
    runtimeKind: "linux-direct",
    runtimeLabel: installationId,
    path,
    cwd,
    title: path,
    createdAt: "2026-08-12T00:00:00.000Z",
    modifiedAt: "2026-08-12T00:00:00.000Z",
    size: 1,
    projectName: cwd,
    pinned: false,
    archived: false,
    tags: [],
  };
}

describe("session target state", () => {
  it("starts blank and only assigns a workspace to a new draft", () => {
    const draft = newSessionTarget("new-1", "linux-direct:a");
    expect(targetWorkspace(draft)).toBeUndefined();
    expect(targetWorkspace(chooseTargetWorkspace(draft, "/work/b"))).toBe("/work/b");
    expect(targetInstallationId(draft)).toBe("linux-direct:a");

    const saved = savedSessionTarget(session("/sessions/a.jsonl", "/work/a"), "saved-1");
    expect(chooseTargetWorkspace(saved, "/work/b")).toBe(saved);
    expect(targetWorkspace(saved)).toBe("/work/a");
    expect(targetInstallationId(saved)).toBe("linux-direct:default");
  });

  it("resets only an unattached new draft when its installation changes", () => {
    const draft = chooseTargetWorkspace(newSessionTarget("old-key", "linux-direct:a"), "/work/a");
    const changed = chooseTargetInstallation(draft, "wsl:Ubuntu", "new-key");

    expect(changed).toEqual({ kind: "new", key: "new-key", installationId: "wsl:Ubuntu" });
    expect(draft).toEqual({
      kind: "new",
      key: "old-key",
      installationId: "linux-direct:a",
      cwd: "/work/a",
    });
    expect(chooseTargetInstallation(draft, "linux-direct:a", "unused-key")).toBe(draft);

    const attached = attachTargetSessionPath(draft, "old-key", "/sessions/a.jsonl");
    expect(targetInstallationId(attached)).toBe("linux-direct:a");
    expect(chooseTargetInstallation(attached, "wsl:Ubuntu", "unused-key")).toBe(attached);

    const saved = savedSessionTarget(session("/sessions/a.jsonl", "/work/a"), "saved-key");
    expect(chooseTargetInstallation(saved, "wsl:Ubuntu", "unused-key")).toBe(saved);
  });

  it("ignores stale runtime session paths and promotes the matching new session", () => {
    const current = chooseTargetWorkspace(newSessionTarget("new-2", "linux-direct:a"), "/work/b");
    expect(attachTargetSessionPath(current, "stale-key", "/sessions/stale.jsonl")).toBe(current);
    const attached = attachTargetSessionPath(current, "new-2", "/sessions/b.jsonl");
    expect(targetSessionPath(attached)).toBe("/sessions/b.jsonl");
    expect(targetInstallationId(attached)).toBe("linux-direct:a");
    const promoted = reconcileTarget(attached, [session("/sessions/b.jsonl", "/work/b", "linux-direct:a")]);
    expect(promoted.kind).toBe("saved");
    expect(targetWorkspace(promoted)).toBe("/work/b");
  });

  it("reconciles identical paths only within the target installation", () => {
    const path = "/sessions/shared.jsonl";
    const draft = attachTargetSessionPath(
      newSessionTarget("draft", "wsl:Ubuntu"),
      "draft",
      path,
    );
    const native = session(path, "C:\\work\\native", "windows-native:omp");
    const wsl = session(path, "/work/wsl", "wsl:Ubuntu");

    expect(reconcileTarget(draft, [native, wsl])).toEqual({ kind: "saved", key: "draft", session: wsl });
    expect(reconcileTarget(draft, [native])).toBe(draft);
  });

  it("reconciles native paths case-insensitively", () => {
    const draft = attachTargetSessionPath(
      newSessionTarget("draft", "windows-native:omp"),
      "draft",
      "C:\\Users\\Alice\\SESSION.JSONL",
    );
    const indexed = session(
      "c:\\users\\alice\\session.jsonl",
      "C:\\work",
      "windows-native:omp",
    );
    expect(reconcileTarget(draft, [indexed])).toEqual({ kind: "saved", key: "draft", session: indexed });
  });

  it("keeps each saved session bound to its own workspace", () => {
    const a = savedSessionTarget(session("/sessions/a.jsonl", "/work/a"), "a");
    const b = savedSessionTarget(session("/sessions/b.jsonl", "/work/b"), "b");
    expect(targetWorkspace(a)).toBe("/work/a");
    expect(targetWorkspace(b)).toBe("/work/b");
  });
});
