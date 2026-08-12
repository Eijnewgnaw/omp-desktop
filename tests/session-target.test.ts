import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../src/shared/contracts";
import {
  attachTargetSessionPath,
  chooseTargetWorkspace,
  newSessionTarget,
  reconcileTarget,
  savedSessionTarget,
  targetSessionPath,
  targetWorkspace,
} from "../src/renderer/session-target";

function session(path: string, cwd: string): SessionSummary {
  return {
    id: path,
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
    const draft = newSessionTarget("new-1");
    expect(targetWorkspace(draft)).toBeUndefined();
    expect(targetWorkspace(chooseTargetWorkspace(draft, "/work/b"))).toBe("/work/b");

    const saved = savedSessionTarget(session("/sessions/a.jsonl", "/work/a"), "saved-1");
    expect(chooseTargetWorkspace(saved, "/work/b")).toBe(saved);
    expect(targetWorkspace(saved)).toBe("/work/a");
  });

  it("ignores stale runtime session paths and promotes the matching new session", () => {
    const current = chooseTargetWorkspace(newSessionTarget("new-2"), "/work/b");
    expect(attachTargetSessionPath(current, "stale-key", "/sessions/stale.jsonl")).toBe(current);
    const attached = attachTargetSessionPath(current, "new-2", "/sessions/b.jsonl");
    expect(targetSessionPath(attached)).toBe("/sessions/b.jsonl");
    const promoted = reconcileTarget(attached, [session("/sessions/b.jsonl", "/work/b")]);
    expect(promoted.kind).toBe("saved");
    expect(targetWorkspace(promoted)).toBe("/work/b");
  });

  it("keeps each saved session bound to its own workspace", () => {
    const a = savedSessionTarget(session("/sessions/a.jsonl", "/work/a"), "a");
    const b = savedSessionTarget(session("/sessions/b.jsonl", "/work/b"), "b");
    expect(targetWorkspace(a)).toBe("/work/a");
    expect(targetWorkspace(b)).toBe("/work/b");
  });
});
