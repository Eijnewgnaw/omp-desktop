import { describe, expect, it } from "vitest";
import {
  assertDistro,
  assertLogicalPath,
  assertWindowsPath,
  assertWslPath,
  basenameLogicalPath,
  installationDataDir,
  installationMetadataKey,
  isSafeExternalUrl,
  joinLogicalPath,
  normalizeOmpProfileName,
  ompArgumentsForInstallation,
  toHostPath,
  wslPathToHostPath,
} from "../src/main/security";

describe("desktop security boundaries", () => {
  it("accepts normal WSL identifiers and POSIX paths", () => {
    expect(assertDistro("Ubuntu-24.04")).toBe("Ubuntu-24.04");
    expect(assertWslPath("/work/demo/../project")).toBe("/work/project");
  });

  it("rejects shell control characters and traversal-like distro names", () => {
    expect(() => assertDistro("Ubuntu; shutdown")).toThrow();
    expect(() => assertDistro("../Ubuntu")).toThrow();
    expect(() => assertWslPath("/work/demo\n--resume=/tmp/session")).toThrow();
  });

  it("normalizes drive-absolute native paths and rejects every other Windows path family", () => {
    expect(assertWindowsPath("C:/Users/me/project/../workspace")).toBe("C:\\Users\\me\\workspace");
    for (const value of [
      "project\\relative",
      "C:drive-relative",
      "\\root-relative",
      "\\\\server\\share",
      "\\\\?\\C:\\Windows",
      "\\\\.\\PhysicalDrive0",
      "C:\\workspace\n--resume=C:\\other",
    ]) {
      expect(() => assertWindowsPath(value)).toThrow();
    }
  });

  it("adapts logical path operations to each trusted installation kind", () => {
    const native = { kind: "windows-native" as const };
    const wsl = { kind: "wsl" as const, distro: "Ubuntu-24.04" };
    expect(assertLogicalPath(native, "D:/work/demo")).toBe("D:\\work\\demo");
    expect(joinLogicalPath(native, "D:\\work", "demo", "session.jsonl")).toBe(
      "D:\\work\\demo\\session.jsonl",
    );
    expect(basenameLogicalPath(native, "D:\\work\\session.jsonl", ".jsonl")).toBe("session");
    expect(assertLogicalPath(wsl, "/work/demo/../project")).toBe("/work/project");
    expect(joinLogicalPath(wsl, "/work", "demo", "session.jsonl")).toBe("/work/demo/session.jsonl");
    expect(toHostPath(native, "D:/work/demo")).toBe("D:\\work\\demo");
  });

  it("preserves the exact historical WSL metadata key serialization", () => {
    expect(installationMetadataKey({
      kind: "wsl",
      distro: "Ubuntu-24.04",
      executablePath: "/home/me/.local/bin/omp",
      agentDir: "/home/me/.omp/agent",
    })).toBe(JSON.stringify([
      "wsl",
      "Ubuntu-24.04",
      "/home/me/.local/bin/omp",
      "/home/me/.omp/agent",
    ]));
  });

  it("uses the XDG data root for sessions without changing the Profile identity", () => {
    const base = {
      kind: "wsl" as const,
      distro: "Ubuntu-24.04",
      executablePath: "/home/me/.local/bin/omp",
      profile: "work",
      agentDir: "/home/me/.omp/profiles/work/agent",
    };
    const xdg = { ...base, dataDir: "/home/me/.local/share/omp/profiles/work" };
    expect(installationDataDir(xdg)).toBe("/home/me/.local/share/omp/profiles/work");
    expect(installationMetadataKey(xdg)).toBe(installationMetadataKey(base));
  });

  it("keeps native and direct Profile identities stable across data-root changes", () => {
    const native = {
      kind: "windows-native" as const,
      executablePath: "C:\\Users\\me\\AppData\\Local\\omp\\omp.exe",
      profile: "work",
      agentDir: "C:\\Users\\me\\.omp\\profiles\\work\\agent",
    };
    expect(installationMetadataKey({
      ...native,
      dataDir: "D:\\omp-data\\profiles\\work",
    })).toBe(installationMetadataKey(native));

    const direct = {
      kind: "linux-direct" as const,
      executablePath: "/home/me/.local/bin/omp",
      profile: "work",
      agentDir: "/home/me/.omp/profiles/work/agent",
    };
    expect(installationMetadataKey({
      ...direct,
      dataDir: "/home/me/.local/share/omp/profiles/work",
    })).toBe(installationMetadataKey(direct));
  });

  it("matches OMP profile validation and keeps every profile identity isolated", () => {
    expect(normalizeOmpProfileName(undefined)).toBeUndefined();
    expect(normalizeOmpProfileName("  default ")).toBeUndefined();
    expect(normalizeOmpProfileName("work-2.0_a")).toBe("work-2.0_a");
    for (const value of ["Work", "../work", "work/team", "work.", "CON", "lpt1.txt", "a".repeat(65)]) {
      expect(() => normalizeOmpProfileName(value)).toThrow("Invalid OMP profile");
    }

    const base = {
      kind: "wsl" as const,
      distro: "Ubuntu-24.04",
      executablePath: "/home/me/.local/bin/omp",
      agentDir: "/home/me/.omp/agent",
    };
    expect(installationMetadataKey({ ...base, profile: "work", agentDir: "/home/me/.omp/profiles/work/agent" }))
      .toBe(JSON.stringify([
        "wsl-profile",
        "Ubuntu-24.04",
        "/home/me/.local/bin/omp",
        "work",
        "/home/me/.omp/profiles/work/agent",
      ]));
    expect(ompArgumentsForInstallation({}, ["config", "path"]))
      .toEqual(["--profile", "default", "config", "path"]);
    expect(ompArgumentsForInstallation({ profile: "work" }, ["config", "path"]))
      .toEqual(["--profile", "work", "config", "path"]);
  });

  it("allows only browser-safe external protocols", () => {
    expect(isSafeExternalUrl("https://example.com/login")).toBe(true);
    expect(isSafeExternalUrl("http://127.0.0.1/callback")).toBe(true);
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
  });

  it("keeps direct-mode paths unchanged outside Windows", () => {
    if (process.platform !== "win32") {
      expect(wslPathToHostPath("direct", "/work/project")).toBe("/work/project");
    }
  });
});
