import { describe, expect, it } from "vitest";
import type { SessionHandoff } from "../src/shared/contracts";
import { addSessionHandoff, hasSessionHandoff, removeSessionHandoff } from "../src/renderer/session-handoff";

function handoff(distro: string, sessionPath: string): SessionHandoff {
  return {
    distro,
    installationPath: "/usr/bin/omp",
    sessionPath,
    cwd: "/work",
    handedOffAt: "2026-08-12T00:00:00.000Z",
  };
}

describe("external terminal handoff leases", () => {
  it("matches and removes only the exact distro and session", () => {
    const leases = [handoff("Ubuntu", "/sessions/a.jsonl"), handoff("Debian", "/sessions/a.jsonl")];
    expect(hasSessionHandoff(leases, "Ubuntu", "/sessions/a.jsonl")).toBe(true);
    expect(hasSessionHandoff(leases, "Ubuntu", "/sessions/b.jsonl")).toBe(false);
    expect(removeSessionHandoff(leases, "Ubuntu", "/sessions/a.jsonl")).toEqual([leases[1]]);
  });

  it("replaces a duplicate and bounds persisted leases", () => {
    const leases = [handoff("Ubuntu", "/sessions/a.jsonl"), handoff("Ubuntu", "/sessions/b.jsonl")];
    const replacement = { ...handoff("Ubuntu", "/sessions/a.jsonl"), handedOffAt: "2026-08-12T01:00:00.000Z" };
    expect(addSessionHandoff(leases, replacement, 2)).toEqual([leases[1], replacement]);
  });
});
