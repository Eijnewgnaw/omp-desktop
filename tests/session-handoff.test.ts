import { describe, expect, it } from "vitest";
import type { OmpInstallation, SessionHandoff } from "../src/shared/contracts";
import { hasSessionHandoff } from "../src/renderer/session-handoff";

function handoff(installationId: string, sessionPath: string): SessionHandoff {
  return {
    installationId,
    sessionPath,
    cwd: "/work",
    handedOffAt: "2026-08-12T00:00:00.000Z",
  };
}

describe("external terminal handoff leases", () => {
  it("matches only the exact installation and session", () => {
    const leases = [handoff("wsl:ubuntu", "/sessions/a.jsonl"), handoff("wsl:debian", "/sessions/a.jsonl")];
    expect(hasSessionHandoff(leases, "wsl:ubuntu", "/sessions/a.jsonl")).toBe(true);
    expect(hasSessionHandoff(leases, "wsl:ubuntu", "/sessions/b.jsonl")).toBe(false);
  });

  it("conservatively locks an unmigrated legacy lease without assigning it to the wrong installation", () => {
    const legacy = {
      sessionPath: "/sessions/shared.jsonl",
      cwd: "/work/shared",
      handedOffAt: "2026-08-12T00:00:00.000Z",
      distro: "Ubuntu",
      installationPath: "/usr/bin/omp",
    } satisfies SessionHandoff;
    const leases = [legacy];
    const ubuntu: OmpInstallation = {
      id: "wsl:ubuntu",
      kind: "wsl",
      label: "Ubuntu",
      executablePath: "/usr/bin/omp",
      version: "1.0.0",
      agentDir: "/home/alice/.omp/agent",
      distro: "Ubuntu",
    };
    const debian: OmpInstallation = {
      ...ubuntu,
      id: "wsl:debian",
      label: "Debian",
      distro: "Debian",
    };

    expect(hasSessionHandoff(leases, ubuntu, legacy.sessionPath)).toBe(true);
    expect(hasSessionHandoff(leases, debian, legacy.sessionPath)).toBe(false);
  });

  it("matches native handoffs case-insensitively", () => {
    const leases = [handoff("windows-native:omp", "C:\\Users\\Alice\\SESSION.JSONL")];
    expect(hasSessionHandoff(
      leases,
      "windows-native:omp",
      "c:\\users\\alice\\session.jsonl",
    )).toBe(true);
  });
});
