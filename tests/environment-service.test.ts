import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileAsync } from "../src/main/exec";
import {
  detectMacosEnvironment,
  detectWindowsEnvironment,
  dataDirFromGcPlan,
  macosNativeCandidatePaths,
  POSIX_PROFILE_DISCOVERY_SCRIPT,
  WINDOWS_PROFILE_DISCOVERY_SCRIPT,
  windowsNativeCandidatePaths,
} from "../src/main/environment-service";

vi.mock("../src/main/exec", () => ({
  execFileAsync: vi.fn(),
}));

const mockedExecFile = vi.mocked(execFileAsync);

beforeEach(() => {
  mockedExecFile.mockReset();
});

function gcPlan(agentDir: string, dataDir = agentDir): string {
  const pathApi = agentDir.includes("\\") ? path.win32 : path.posix;
  return JSON.stringify({
    agentDir,
    apply: false,
    wal: {
      databases: [
        { dbPath: pathApi.join(dataDir, "history.db") },
        { dbPath: pathApi.join(dataDir, "models.db") },
      ],
    },
  });
}

describe("OMP environment discovery", () => {
  it.runIf(process.platform !== "win32")("enumerates canonical and XDG profile roots with POSIX sh", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-profile-discovery-"));
    const home = path.join(root, "home");
    const xdg = path.join(root, "xdg:with space");
    try {
      fs.mkdirSync(path.join(home, ".omp", "profiles", "work"), { recursive: true });
      fs.mkdirSync(path.join(xdg, "omp", "profiles", "research"), { recursive: true });
      const output = execFileSync("/bin/sh", ["-c", POSIX_PROFILE_DISCOVERY_SCRIPT, "omp-desktop-profiles"], {
        encoding: "utf8",
        env: { ...process.env, HOME: home, XDG_DATA_HOME: xdg, XDG_STATE_HOME: "", XDG_CACHE_HOME: "" },
      });
      expect(output.trim().split("\n").sort()).toEqual(["research", "work"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "resolves the same flattened XDG Profile data root that a real OMP process uses",
    async () => {
      const omp = process.env.OMP_EXECUTABLE ?? (() => {
        try {
          return execFileSync("sh", ["-lc", "command -v omp"], { encoding: "utf8" }).trim();
        } catch {
          return "";
        }
      })();
      if (!omp) return;

      const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "omp-profile-xdg-real-"));
      const home = path.join(root, "home");
      const data = path.join(root, "xdg data");
      const state = path.join(root, "xdg state");
      const cache = path.join(root, "xdg cache");
      const profile = "xdg-audit";
      const xdgProfileRoot = path.join(data, "omp", "profiles", profile);
      try {
        await Promise.all([
          fsPromises.mkdir(home, { recursive: true }),
          fsPromises.mkdir(xdgProfileRoot, { recursive: true }),
          fsPromises.mkdir(path.join(state, "omp", "profiles", profile), { recursive: true }),
          fsPromises.mkdir(path.join(cache, "omp", "profiles", profile), { recursive: true }),
        ]);
        const env = { ...process.env, HOME: home, XDG_DATA_HOME: data, XDG_STATE_HOME: state, XDG_CACHE_HOME: cache };
        const configAgentDir = execFileSync(omp, ["--profile", profile, "config", "path"], {
          encoding: "utf8",
          env,
        }).trim();
        execFileSync(omp, ["--profile", profile, "config", "list", "--json"], {
          encoding: "utf8",
          env,
          stdio: ["ignore", "ignore", "pipe"],
        });
        const gcPlan = execFileSync(omp, ["--profile", profile, "gc", "--json", "--wal"], {
          encoding: "utf8",
          env,
        });
        const resolvedDataDir = dataDirFromGcPlan({ kind: "linux-direct" }, gcPlan, configAgentDir);

        expect(configAgentDir).toBe(path.join(home, ".omp", "profiles", profile, "agent"));
        expect(resolvedDataDir).toBe(xdgProfileRoot);
        await expect(fsPromises.stat(path.join(xdgProfileRoot, "agent.db"))).resolves.toBeDefined();
      } finally {
        await fsPromises.rm(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it("accepts only a dry-run GC plan whose recognized data databases share one directory", () => {
    const valid = JSON.stringify({
      apply: false,
      agentDir: "/home/me/.omp/profiles/work/agent",
      wal: {
        databases: [
          { dbPath: "/xdg/omp/profiles/work/history.db" },
          { dbPath: "/xdg/omp/profiles/work/models.db" },
        ],
      },
    });
    const expectedAgentDir = "/home/me/.omp/profiles/work/agent";
    expect(dataDirFromGcPlan({ kind: "wsl" }, valid, expectedAgentDir)).toBe("/xdg/omp/profiles/work");
    expect(dataDirFromGcPlan(
      { kind: "wsl" },
      valid.replace('"apply":false', '"apply":true'),
      expectedAgentDir,
    )).toBeUndefined();
    expect(dataDirFromGcPlan(
      { kind: "wsl" },
      valid.replace(expectedAgentDir, "/other/agent"),
      expectedAgentDir,
    )).toBeUndefined();
    expect(dataDirFromGcPlan({ kind: "wsl" }, JSON.stringify({
      apply: false,
      agentDir: expectedAgentDir,
      wal: {
        databases: [
          { dbPath: "/xdg/omp/profiles/work/history.db" },
          { dbPath: "/other/models.db" },
        ],
      },
    }), expectedAgentDir)).toBeUndefined();
    expect(dataDirFromGcPlan({ kind: "wsl" }, JSON.stringify({
      apply: false,
      agentDir: expectedAgentDir,
      wal: { databases: [{ dbPath: "/xdg/omp/profiles/work/history.db" }] },
    }), expectedAgentDir)).toBeUndefined();
  });

  it("collects and case-insensitively deduplicates native well-known and PATH candidates", () => {
    expect(windowsNativeCandidatePaths(
      { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", USERPROFILE: "C:\\Users\\me" },
      [
        "C:\\Tools\\omp.exe",
        "c:\\tools\\OMP.EXE",
        "relative\\omp.exe",
        "\\\\?\\C:\\device\\omp.exe",
      ].join("\r\n"),
    )).toEqual([
      "C:\\Users\\me\\AppData\\Local\\omp\\omp.exe",
      "C:\\Users\\me\\.local\\bin\\omp.exe",
      "C:\\Tools\\omp.exe",
    ]);
  });

  it("keeps only the higher-priority native executable when both own the same data root", async () => {
    mockedExecFile.mockImplementation(async (executable, args) => {
      const command = String(executable);
      const argv = args.map(String);
      const trailing = argv.slice(argv.indexOf("--profile") + 2).join("|");
      if (command === "where.exe") {
        return { stdout: "C:\\Preferred\\omp.exe\r\nC:\\Fallback\\omp.exe", stderr: "" };
      }
      if (command === "wsl.exe" && argv.join("|") === "--list|--quiet") {
        throw new Error("WSL unavailable");
      }
      if (command === "powershell.exe") return { stdout: "", stderr: "" };
      if ((command === "C:\\Preferred\\omp.exe" || command === "C:\\Fallback\\omp.exe")
        && trailing === "--version") {
        return { stdout: "omp/17.2.15", stderr: "" };
      }
      if ((command === "C:\\Preferred\\omp.exe" || command === "C:\\Fallback\\omp.exe")
        && trailing === "config|path") {
        return { stdout: "C:\\Users\\me\\.omp\\agent", stderr: "" };
      }
      if (command === "C:\\Preferred\\omp.exe" && trailing === "gc|--json|--wal") {
        return {
          stdout: gcPlan("C:\\Users\\me\\.omp\\agent", "C:\\Shared\\OMP\\Data"),
          stderr: "",
        };
      }
      if (command === "C:\\Fallback\\omp.exe" && trailing === "gc|--json|--wal") {
        return {
          stdout: gcPlan("C:\\Users\\me\\.omp\\agent", "c:/shared/omp/data/"),
          stderr: "",
        };
      }
      throw new Error(`unexpected ${command} ${argv.join("|")}`);
    });

    const result = await detectWindowsEnvironment({});

    expect(result.installations).toHaveLength(1);
    expect(result.installations[0]).toMatchObject({
      executablePath: "C:\\Preferred\\omp.exe",
      dataDir: "C:\\Shared\\OMP\\Data",
    });
  });

  it("does not merge installations that have a different Profile or data root", async () => {
    mockedExecFile.mockImplementation(async (executable, args) => {
      const command = String(executable);
      const argv = args.map(String);
      const profileIndex = argv.indexOf("--profile");
      const profile = argv[profileIndex + 1];
      const trailing = argv.slice(profileIndex + 2).join("|");
      if (command === "where.exe") {
        return { stdout: "C:\\First\\omp.exe\r\nC:\\Second\\omp.exe", stderr: "" };
      }
      if (command === "wsl.exe" && argv.join("|") === "--list|--quiet") {
        throw new Error("WSL unavailable");
      }
      if (command === "powershell.exe") return { stdout: "work", stderr: "" };
      if ((command === "C:\\First\\omp.exe" || command === "C:\\Second\\omp.exe")
        && trailing === "--version") {
        return { stdout: "omp/17.2.15", stderr: "" };
      }
      const agentDir = profile === "default"
        ? "C:\\Users\\me\\.omp\\agent"
        : "C:\\Users\\me\\.omp\\profiles\\work\\agent";
      if ((command === "C:\\First\\omp.exe" || command === "C:\\Second\\omp.exe")
        && trailing === "config|path") {
        return { stdout: agentDir, stderr: "" };
      }
      if ((command === "C:\\First\\omp.exe" || command === "C:\\Second\\omp.exe")
        && trailing === "gc|--json|--wal") {
        const dataDir = command === "C:\\First\\omp.exe"
          ? "C:\\OMP Data\\shared"
          : "C:\\OMP Data\\other";
        return { stdout: gcPlan(agentDir, dataDir), stderr: "" };
      }
      throw new Error(`unexpected ${command} ${argv.join("|")}`);
    });

    const result = await detectWindowsEnvironment({});

    expect(result.installations.map(installation => [
      installation.executablePath,
      installation.profile,
      installation.dataDir,
    ])).toEqual([
      ["C:\\First\\omp.exe", undefined, "C:\\OMP Data\\shared"],
      ["C:\\First\\omp.exe", "work", "C:\\OMP Data\\shared"],
      ["C:\\Second\\omp.exe", undefined, "C:\\OMP Data\\other"],
      ["C:\\Second\\omp.exe", "work", "C:\\OMP Data\\other"],
    ]);
  });

  it("ignores Windows XDG variables and enumerates only the canonical native Profile root", async () => {
    const powershellCommands: string[] = [];
    mockedExecFile.mockImplementation(async (executable, args) => {
      const command = String(executable);
      const argv = args.map(String);
      const joined = argv.join("|");
      if (command === "where.exe") return { stdout: "C:\\Tools\\omp.exe", stderr: "" };
      if (command === "wsl.exe" && joined === "--list|--quiet") throw new Error("WSL unavailable");
      if (command === "powershell.exe") {
        powershellCommands.push(argv.at(-1) ?? "");
        return { stdout: "work", stderr: "" };
      }
      const profile = argv[argv.indexOf("--profile") + 1];
      const trailing = argv.slice(argv.indexOf("--profile") + 2).join("|");
      if (command === "C:\\Tools\\omp.exe" && trailing === "--version") {
        return { stdout: "omp/17.2.12", stderr: "" };
      }
      const agentDir = profile === "default"
        ? "C:\\Users\\me\\.omp\\agent"
        : `C:\\Users\\me\\.omp\\profiles\\${profile}\\agent`;
      if (command === "C:\\Tools\\omp.exe" && trailing === "config|path") {
        return { stdout: agentDir, stderr: "" };
      }
      if (command === "C:\\Tools\\omp.exe" && trailing === "gc|--json|--wal") {
        return { stdout: gcPlan(agentDir), stderr: "" };
      }
      throw new Error(`unexpected ${command} ${joined}`);
    });

    const result = await detectWindowsEnvironment({
      XDG_DATA_HOME: "C:\\phantom-data",
      XDG_STATE_HOME: "C:\\phantom-state",
      XDG_CACHE_HOME: "C:\\phantom-cache",
    });

    expect(result.installations.map(installation => installation.profile)).toEqual([undefined, "work"]);
    expect(powershellCommands).toEqual([WINDOWS_PROFILE_DISCOVERY_SCRIPT]);
    expect(WINDOWS_PROFILE_DISCOVERY_SCRIPT).not.toMatch(/XDG_(?:DATA|STATE|CACHE)_HOME/u);
  });

  it("quarantines strict data-root probe failures while other Profiles and backends continue", async () => {
    mockedExecFile.mockImplementation(async (executable, args) => {
      const command = String(executable);
      const argv = args.map(String);
      const joined = argv.join("|");
      if (command === "where.exe") return { stdout: "C:\\Tools\\omp.exe", stderr: "" };
      if (command === "powershell.exe") return { stdout: "good\nmissing\ntimeout", stderr: "" };
      if (command === "wsl.exe" && joined === "--list|--quiet") return { stdout: "Ubuntu", stderr: "" };
      if (command === "wsl.exe" && joined === "-d|Ubuntu|--exec|sh|-lc|command -v omp") {
        return { stdout: "/usr/bin/omp", stderr: "" };
      }
      if (command === "wsl.exe" && argv.includes("omp-desktop-profiles")) return { stdout: "", stderr: "" };

      const profile = argv[argv.indexOf("--profile") + 1];
      const trailing = argv.slice(argv.indexOf("--profile") + 2).join("|");
      const isNative = command === "C:\\Tools\\omp.exe";
      const isWslOmp = command === "wsl.exe" && argv.includes("/usr/bin/omp");
      if ((isNative || isWslOmp) && trailing === "--version") {
        return { stdout: "omp/17.2.12", stderr: "" };
      }
      if (isWslOmp && trailing === "config|path") return { stdout: "/home/me/.omp/agent", stderr: "" };
      if (isWslOmp && trailing === "gc|--json|--wal") {
        return { stdout: gcPlan("/home/me/.omp/agent"), stderr: "" };
      }
      const nativeAgentDir = profile === "default"
        ? "C:\\Users\\me\\.omp\\agent"
        : `C:\\Users\\me\\.omp\\profiles\\${profile}\\agent`;
      if (isNative && trailing === "config|path") return { stdout: nativeAgentDir, stderr: "" };
      if (isNative && trailing === "gc|--json|--wal") {
        if (profile === "default") return { stdout: "not-json", stderr: "" };
        if (profile === "timeout") throw new Error("OMP data-root probe timed out");
        if (profile === "missing") {
          return {
            stdout: JSON.stringify({
              agentDir: nativeAgentDir,
              apply: false,
              wal: { databases: [{ dbPath: path.win32.join(nativeAgentDir, "history.db") }] },
            }),
            stderr: "",
          };
        }
        return { stdout: gcPlan(nativeAgentDir), stderr: "" };
      }
      throw new Error(`unexpected ${command} ${joined}`);
    });

    const result = await detectWindowsEnvironment({});

    expect(result.installations.map(installation => [installation.kind, installation.profile])).toEqual([
      ["windows-native", "good"],
      ["wsl", undefined],
    ]);
    expect(result.diagnostics.some(value => value.includes("Default Profile") && value.includes("数据目录"))).toBe(true);
    expect(result.diagnostics.some(value => value.includes("Profile missing") && value.includes("history.db/models.db"))).toBe(true);
    expect(result.diagnostics.some(value => value.includes("Profile timeout") && value.includes("timed out"))).toBe(true);
  });

  it("uses the legacy agent root only when a pre-17.2.12 OMP explicitly lacks gc", async () => {
    mockedExecFile.mockImplementation(async (executable, args) => {
      const command = String(executable);
      const joined = args.map(String).join("|");
      if (command === "where.exe") return { stdout: "C:\\Tools\\omp.exe", stderr: "" };
      if (command === "wsl.exe" && joined === "--list|--quiet") throw new Error("WSL unavailable");
      if (command === "powershell.exe") return { stdout: "", stderr: "" };
      if (command === "C:\\Tools\\omp.exe" && joined === "--profile|default|--version") {
        return { stdout: "omp/17.2.11", stderr: "" };
      }
      if (command === "C:\\Tools\\omp.exe" && joined === "--profile|default|config|path") {
        return { stdout: "C:\\Users\\me\\.omp\\agent", stderr: "" };
      }
      if (command === "C:\\Tools\\omp.exe" && joined === "--profile|default|gc|--json|--wal") {
        throw new Error("Unknown command: gc");
      }
      throw new Error(`unexpected ${command} ${joined}`);
    });

    const result = await detectWindowsEnvironment({});
    expect(result.installations).toMatchObject([{
      kind: "windows-native",
      version: "17.2.11",
      agentDir: "C:\\Users\\me\\.omp\\agent",
    }]);
    expect(result.installations[0]?.dataDir).toBeUndefined();
  });

  it("detects native and WSL installations concurrently while isolating bad native candidates", async () => {
    mockedExecFile.mockImplementation(async (executable, args) => {
      const command = String(executable);
      const argv = args.map(String);
      if (command === "where.exe") return { stdout: "C:\\Tools\\omp.exe", stderr: "" };
      if (command === "wsl.exe" && argv.join("|") === "--list|--quiet") {
        return { stdout: "Ubuntu-24.04", stderr: "" };
      }
      if (command === "wsl.exe" && argv.join("|") === "-d|Ubuntu-24.04|--exec|sh|-lc|command -v omp") {
        return { stdout: "/usr/bin/omp", stderr: "" };
      }
      if (command === "wsl.exe" && argv.join("|") === "-d|Ubuntu-24.04|--exec|/usr/bin/omp|--profile|default|--version") {
        return { stdout: "omp/17.2.12", stderr: "" };
      }
      if (command === "wsl.exe" && argv.join("|") === "-d|Ubuntu-24.04|--exec|/usr/bin/omp|--profile|default|config|path") {
        return { stdout: "/home/me/.omp/agent", stderr: "" };
      }
      if (command === "wsl.exe" && argv.join("|") === "-d|Ubuntu-24.04|--exec|/usr/bin/omp|--profile|default|gc|--json|--wal") {
        return { stdout: gcPlan("/home/me/.omp/agent"), stderr: "" };
      }
      if (command.toLowerCase() === "c:\\tools\\omp.exe" && argv.join("|") === "--profile|default|--version") {
        return { stdout: "omp/17.2.12", stderr: "" };
      }
      if (command.toLowerCase() === "c:\\tools\\omp.exe" && argv.join("|") === "--profile|default|config|path") {
        return { stdout: "C:\\Users\\me\\.omp\\agent", stderr: "" };
      }
      if (command.toLowerCase() === "c:\\tools\\omp.exe" && argv.join("|") === "--profile|default|gc|--json|--wal") {
        return { stdout: gcPlan("C:\\Users\\me\\.omp\\agent"), stderr: "" };
      }
      if (command === "powershell.exe") return { stdout: "", stderr: "" };
      if (command === "wsl.exe" && argv.includes("omp-desktop-profiles")) return { stdout: "", stderr: "" };
      throw new Error("candidate unavailable");
    });

    const result = await detectWindowsEnvironment({
      LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
      USERPROFILE: "C:\\Users\\me",
    });

    expect(result.mode).toBe("windows-dual");
    expect(result.installations).toHaveLength(2);
    expect(result.installations[0]).toMatchObject({
      kind: "windows-native",
      label: "Windows (native)",
      executablePath: "C:\\Tools\\omp.exe",
      agentDir: "C:\\Users\\me\\.omp\\agent",
      version: "17.2.12",
    });
    expect(result.installations[0]?.id).toMatch(/^windows-native:[a-f0-9]{24}$/u);
    expect(result.installations[1]).toMatchObject({
      kind: "wsl",
      distro: "Ubuntu-24.04",
      label: "Ubuntu-24.04 (WSL)",
      executablePath: "/usr/bin/omp",
      agentDir: "/home/me/.omp/agent",
      version: "17.2.12",
    });
    expect(result.diagnostics).toEqual([]);
  });

  it("keeps a healthy native installation when WSL discovery fails", async () => {
    mockedExecFile.mockImplementation(async (executable, args) => {
      const command = String(executable);
      const argv = args.map(String).join("|");
      if (command === "where.exe") return { stdout: "C:\\Tools\\omp.exe", stderr: "" };
      if (command === "wsl.exe" && argv === "--list|--quiet") throw new Error("WSL is unavailable");
      if (command === "C:\\Tools\\omp.exe" && argv === "--profile|default|--version") {
        return { stdout: "omp/17.2.12", stderr: "" };
      }
      if (command === "C:\\Tools\\omp.exe" && argv === "--profile|default|config|path") {
        return { stdout: "D:\\OMP\\agent", stderr: "" };
      }
      if (command === "C:\\Tools\\omp.exe" && argv === "--profile|default|gc|--json|--wal") {
        return { stdout: gcPlan("D:\\OMP\\agent"), stderr: "" };
      }
      if (command === "powershell.exe") return { stdout: "", stderr: "" };
      throw new Error("unexpected command");
    });

    const result = await detectWindowsEnvironment({});

    expect(result.installations).toHaveLength(1);
    expect(result.installations[0]?.kind).toBe("windows-native");
    expect(result.diagnostics).toEqual(["无法连接 WSL：WSL is unavailable"]);
  });

  it("keeps a healthy WSL installation when native discovery fails", async () => {
    mockedExecFile.mockImplementation(async (executable, args) => {
      const command = String(executable);
      const argv = args.map(String).join("|");
      if (command === "where.exe") throw new Error("PATH lookup unavailable");
      if (command === "wsl.exe" && argv === "--list|--quiet") {
        return { stdout: "Debian", stderr: "" };
      }
      if (command === "wsl.exe" && argv === "-d|Debian|--exec|sh|-lc|command -v omp") {
        return { stdout: "/opt/omp/bin/omp", stderr: "" };
      }
      if (command === "wsl.exe" && argv === "-d|Debian|--exec|/opt/omp/bin/omp|--profile|default|--version") {
        return { stdout: "omp/17.2.15", stderr: "" };
      }
      if (command === "wsl.exe" && argv === "-d|Debian|--exec|/opt/omp/bin/omp|--profile|default|config|path") {
        return { stdout: "/home/me/.omp/agent", stderr: "" };
      }
      if (command === "wsl.exe" && argv === "-d|Debian|--exec|/opt/omp/bin/omp|--profile|default|gc|--json|--wal") {
        return { stdout: gcPlan("/home/me/.omp/agent"), stderr: "" };
      }
      if (command === "wsl.exe" && argv.includes("omp-desktop-profiles")) return { stdout: "", stderr: "" };
      throw new Error("native candidate unavailable");
    });

    const result = await detectWindowsEnvironment({
      LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
      USERPROFILE: "C:\\Users\\me",
    });

    expect(result.installations).toHaveLength(1);
    expect(result.installations[0]).toMatchObject({ kind: "wsl", distro: "Debian" });
    expect(result.diagnostics).toEqual([
      "未检测到可用的 Windows 原生 OMP。已检查常见安装位置和 Windows PATH。",
    ]);
  });

  it("keeps a healthy WSL distribution when another distribution has a broken OMP probe", async () => {
    mockedExecFile.mockImplementation(async (executable, args) => {
      const command = String(executable);
      const argv = args.map(String).join("|");
      if (command === "where.exe") return { stdout: "", stderr: "" };
      if (command === "wsl.exe" && argv === "--list|--quiet") {
        return { stdout: "Ubuntu\r\nDebian", stderr: "" };
      }
      if (command === "wsl.exe" && argv === "-d|Ubuntu|--exec|sh|-lc|command -v omp") {
        return { stdout: "/usr/bin/omp", stderr: "" };
      }
      if (command === "wsl.exe" && argv.startsWith("-d|Ubuntu|--exec|/usr/bin/omp|")) {
        throw new Error("Ubuntu OMP is corrupt");
      }
      if (command === "wsl.exe" && argv === "-d|Debian|--exec|sh|-lc|command -v omp") {
        return { stdout: "/opt/omp/bin/omp", stderr: "" };
      }
      if (command === "wsl.exe" && argv === "-d|Debian|--exec|/opt/omp/bin/omp|--profile|default|--version") {
        return { stdout: "omp/17.2.15", stderr: "" };
      }
      if (command === "wsl.exe" && argv === "-d|Debian|--exec|/opt/omp/bin/omp|--profile|default|config|path") {
        return { stdout: "/home/me/.omp/agent", stderr: "" };
      }
      if (command === "wsl.exe" && argv === "-d|Debian|--exec|/opt/omp/bin/omp|--profile|default|gc|--json|--wal") {
        return { stdout: gcPlan("/home/me/.omp/agent"), stderr: "" };
      }
      if (command === "wsl.exe" && argv.includes("omp-desktop-profiles")) {
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected ${command} ${argv}`);
    });

    const result = await detectWindowsEnvironment({});

    expect(result.installations).toHaveLength(1);
    expect(result.installations[0]).toMatchObject({ kind: "wsl", distro: "Debian" });
    expect(result.diagnostics).not.toContain(expect.stringContaining("无法连接 WSL"));
  });

  it("discovers native and WSL named profiles as isolated installations and quarantines one bad profile", async () => {
    const calls: Array<{ command: string; argv: string[] }> = [];
    mockedExecFile.mockImplementation(async (executable, args) => {
      const command = String(executable);
      const argv = args.map(String);
      calls.push({ command, argv });
      const joined = argv.join("|");
      if (command === "where.exe") return { stdout: "C:\\Tools\\omp.exe", stderr: "" };
      if (command === "powershell.exe") return { stdout: "bad/name\r\nwork\r\nbroken\r\nwork\r\n", stderr: "" };
      if (command === "wsl.exe" && joined === "--list|--quiet") return { stdout: "Ubuntu", stderr: "" };
      if (command === "wsl.exe" && joined === "-d|Ubuntu|--exec|sh|-lc|command -v omp") {
        return { stdout: "/usr/bin/omp", stderr: "" };
      }
      if (command === "wsl.exe" && argv.includes("omp-desktop-profiles")) {
        return { stdout: "team\ninvalid profile\n", stderr: "" };
      }
      const profile = argv[argv.indexOf("--profile") + 1];
      const trailing = argv.slice(argv.indexOf("--profile") + 2).join("|");
      if ((command === "C:\\Tools\\omp.exe" || (command === "wsl.exe" && argv.includes("/usr/bin/omp")))
        && trailing === "--version") {
        if (profile === "broken") throw new Error("profile is corrupt");
        return { stdout: "omp/17.2.15", stderr: "" };
      }
      if (command === "C:\\Tools\\omp.exe" && trailing === "config|path") {
        return {
          stdout: profile === "default"
            ? "C:\\Users\\me\\.omp\\agent"
            : `C:\\Users\\me\\.omp\\profiles\\${profile}\\agent`,
          stderr: "",
        };
      }
      if (command === "wsl.exe" && argv.includes("/usr/bin/omp") && trailing === "config|path") {
        return {
          stdout: profile === "default"
            ? "/home/me/.omp/agent"
            : `/home/me/.omp/profiles/${profile}/agent`,
          stderr: "",
        };
      }
      if (command === "C:\\Tools\\omp.exe" && trailing === "gc|--json|--wal") {
        const agentDir = profile === "default"
          ? "C:\\Users\\me\\.omp\\agent"
          : `C:\\Users\\me\\.omp\\profiles\\${profile}\\agent`;
        return { stdout: gcPlan(agentDir), stderr: "" };
      }
      if (command === "wsl.exe" && argv.includes("/usr/bin/omp") && trailing === "gc|--json|--wal") {
        const agentDir = profile === "default"
          ? "/home/me/.omp/agent"
          : `/home/me/.omp/profiles/${profile}/agent`;
        return { stdout: gcPlan(agentDir), stderr: "" };
      }
      throw new Error(`unexpected ${command} ${joined}`);
    });

    const result = await detectWindowsEnvironment({});
    expect(result.installations.map(installation => ({
      kind: installation.kind,
      profile: installation.profile,
      label: installation.label,
      agentDir: installation.agentDir,
    }))).toEqual([
      { kind: "windows-native", profile: undefined, label: "Windows (native)", agentDir: "C:\\Users\\me\\.omp\\agent" },
      { kind: "windows-native", profile: "work", label: "Windows (native) · Profile · work", agentDir: "C:\\Users\\me\\.omp\\profiles\\work\\agent" },
      { kind: "wsl", profile: undefined, label: "Ubuntu (WSL)", agentDir: "/home/me/.omp/agent" },
      { kind: "wsl", profile: "team", label: "Ubuntu (WSL) · Profile · team", agentDir: "/home/me/.omp/profiles/team/agent" },
    ]);
    expect(new Set(result.installations.map(installation => installation.id)).size).toBe(4);
    expect(result.diagnostics).toEqual([
      "无法加载 Windows (native) 的 Profile broken：profile is corrupt",
    ]);
    expect(calls.some(({ command, argv }) => command === "C:\\Tools\\omp.exe"
      && argv.join("|") === "--profile|work|config|path")).toBe(true);
    expect(calls.some(({ command, argv }) => command === "wsl.exe"
      && argv.join("|").includes("--exec|/usr/bin/omp|--profile|team|config|path"))).toBe(true);
    expect(calls.flatMap(call => call.argv)).not.toContain("bad/name");
    expect(calls.flatMap(call => call.argv)).not.toContain("invalid profile");
  });

  it("builds deterministic macOS candidates and treats an explicit executable as authoritative", () => {
    expect(macosNativeCandidatePaths(
      { HOME: "/Users/me" },
      "/Applications/OMP/omp\nrelative/omp\n/opt/homebrew/bin/omp\n",
    )).toEqual([
      "/opt/homebrew/bin/omp",
      "/usr/local/bin/omp",
      "/Users/me/.local/bin/omp",
      "/Applications/OMP/omp",
    ]);
    expect(macosNativeCandidatePaths(
      { HOME: "/Users/me", OMP_EXECUTABLE: "/private/tools/omp" },
      "/Applications/OMP/omp",
    )).toEqual(["/private/tools/omp"]);
  });

  it("discovers native macOS Default and named Profiles through the direct POSIX adapter", async () => {
    mockedExecFile.mockImplementation(async (executable, args) => {
      const command = String(executable);
      const argv = args.map(String);
      if (command === "/bin/sh" && argv.includes("omp-desktop-profiles")) {
        return { stdout: "work\nbad/name\n", stderr: "" };
      }
      if (command !== "/private/tools/omp") throw new Error(`unexpected executable ${command}`);
      const profile = argv[argv.indexOf("--profile") + 1];
      const trailing = argv.slice(argv.indexOf("--profile") + 2).join("|");
      const agentDir = profile === "default"
        ? "/Users/me/.omp/agent"
        : `/Users/me/.omp/profiles/${profile}/agent`;
      if (trailing === "--version") return { stdout: "omp/17.2.12", stderr: "" };
      if (trailing === "config|path") return { stdout: agentDir, stderr: "" };
      if (trailing === "gc|--json|--wal") return { stdout: gcPlan(agentDir), stderr: "" };
      throw new Error(`unexpected argv ${argv.join("|")}`);
    });

    const result = await detectMacosEnvironment({
      HOME: "/Users/me",
      OMP_EXECUTABLE: "/private/tools/omp",
    });

    expect(result).toMatchObject({ platform: "darwin", mode: "macos-native", diagnostics: [] });
    expect(result.installations.map(installation => ({
      kind: installation.kind,
      label: installation.label,
      profile: installation.profile,
      agentDir: installation.agentDir,
    }))).toEqual([
      {
        kind: "macos-native",
        label: "macOS (native)",
        profile: undefined,
        agentDir: "/Users/me/.omp/agent",
      },
      {
        kind: "macos-native",
        label: "macOS (native) · Profile · work",
        profile: "work",
        agentDir: "/Users/me/.omp/profiles/work/agent",
      },
    ]);
    expect(result.installations.every(installation => /^macos-native:[a-f0-9]{24}$/u.test(installation.id)))
      .toBe(true);
    expect(mockedExecFile).not.toHaveBeenCalledWith("/bin/zsh", expect.anything());
  });
});
