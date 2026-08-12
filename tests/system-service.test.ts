import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { dialog } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { OmpInstallation } from "../src/shared/contracts";

vi.mock("electron", () => ({
  dialog: { showOpenDialog: vi.fn() },
}));

import {
  buildOmpTerminalLaunch,
  chooseWorkspace,
  MACOS_TERMINAL_SCRIPT,
  spawnDetachedTerminal,
  type TerminalLaunch,
} from "../src/main/system-service";

function fakeChild(emitLifecycle: (child: EventEmitter) => void): ChildProcess {
  const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
  child.unref = vi.fn();
  queueMicrotask(() => emitLifecycle(child));
  return child as unknown as ChildProcess;
}

const wslInstallation: OmpInstallation = {
  id: "wsl:Ubuntu-24.04",
  kind: "wsl",
  label: "WSL · Ubuntu 24.04",
  distro: "Ubuntu 24.04",
  executablePath: "/home/me/.local/bin/omp",
  version: "17.2.12",
  agentDir: "/home/me/.omp/agent",
};

const nativeInstallation: OmpInstallation = {
  id: "windows-native:omp",
  kind: "windows-native",
  label: "Windows · Native",
  executablePath: "C:\\Users\\Me;StillSafe\\bin\\omp.exe",
  version: "17.2.12",
  agentDir: "C:\\Users\\Me\\.omp\\agent",
};

const directInstallation: OmpInstallation = {
  id: "linux-direct:omp",
  kind: "linux-direct",
  label: "Linux · Direct",
  executablePath: "/home/me/.local/bin/omp",
  version: "17.2.12",
  agentDir: "/home/me/.omp/agent",
};

const macosInstallation: OmpInstallation = {
  id: "macos-native:omp",
  kind: "macos-native",
  label: "macOS (native)",
  executablePath: "/opt/homebrew/bin/omp",
  version: "17.2.12",
  agentDir: "/Users/me/.omp/agent",
};

const wslInput = {
  installationId: wslInstallation.id,
  path: "/home/me/My Project;still-one-argument",
  sessionPath: "/home/me/.omp/sessions/old session.jsonl",
};

describe("OMP terminal launcher", () => {
  it("opens the macOS workspace chooser in the user home directory", async () => {
    const showOpenDialog = vi.mocked(dialog.showOpenDialog);
    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });

    await expect(chooseWorkspace(macosInstallation)).resolves.toBeNull();
    expect(showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: "选择 OMP 工作区",
      defaultPath: process.env.HOME,
      properties: ["openDirectory", "createDirectory"],
    }));
  });

  it("builds a visible new Windows Terminal window without a standalone separator", () => {
    const launch = buildOmpTerminalLaunch(wslInstallation, wslInput, "win32");

    expect(launch).toEqual({
      command: "wt.exe",
      args: [
        "-w",
        "new",
        "new-tab",
        "wsl.exe",
        "-d",
        "Ubuntu 24.04",
        "--cd",
        "/home/me/My Project\\;still-one-argument",
        "--exec",
        "/home/me/.local/bin/omp",
        "--profile",
        "default",
        "--cwd",
        "/home/me/My Project\\;still-one-argument",
        "--resume",
        "/home/me/.omp/sessions/old session.jsonl",
      ],
      options: {
        detached: true,
        stdio: "ignore",
      },
      displayName: "Windows Terminal",
    });
    expect(launch.args).not.toContain("--");
    expect(launch.options.windowsHide).not.toBe(true);
  });

  it("builds the fixed native Windows Terminal argv with literal values kept in one action", () => {
    const launch = buildOmpTerminalLaunch(
      nativeInstallation,
      {
        installationId: nativeInstallation.id,
        path: "C:\\Work Folder;still-one-argument",
        sessionPath: "C:\\Users\\Me\\.omp\\agent\\sessions\\old session.jsonl",
      },
      "win32",
    );

    expect(launch).toEqual({
      command: "wt.exe",
      args: [
        "-w",
        "new",
        "new-tab",
        "--startingDirectory",
        "C:\\Work Folder\\;still-one-argument",
        "C:\\Users\\Me\\;StillSafe\\bin\\omp.exe",
        "--profile",
        "default",
        "--cwd",
        "C:\\Work Folder\\;still-one-argument",
        "--resume",
        "C:\\Users\\Me\\.omp\\agent\\sessions\\old session.jsonl",
      ],
      options: { detached: true, stdio: "ignore" },
      displayName: "Windows Terminal",
    });
    expect(launch.args).not.toContain("wsl.exe");
    expect(launch.args.filter(argument => argument === ";")).toEqual([]);
  });

  it("launches a named native profile before cwd and resume without accepting a renderer profile", () => {
    const installation: OmpInstallation = {
      ...nativeInstallation,
      id: "windows-native:work",
      label: "Windows · Native · work",
      profile: "work",
      agentDir: "C:\\Users\\Me\\.omp-work\\agent",
    };
    const launch = buildOmpTerminalLaunch(
      installation,
      {
        installationId: installation.id,
        path: "C:\\Work Folder",
        sessionPath: "C:\\Users\\Me\\.omp-work\\agent\\sessions\\old.jsonl",
      },
      "win32",
    );

    expect(launch.args).toEqual([
      "-w",
      "new",
      "new-tab",
      "--startingDirectory",
      "C:\\Work Folder",
      "C:\\Users\\Me\\;StillSafe\\bin\\omp.exe",
      "--profile",
      "work",
      "--cwd",
      "C:\\Work Folder",
      "--resume",
      "C:\\Users\\Me\\.omp-work\\agent\\sessions\\old.jsonl",
    ]);
  });

  it("launches a named WSL profile inside the selected distribution", () => {
    const installation: OmpInstallation = {
      ...wslInstallation,
      id: "wsl:work",
      label: "Ubuntu 24.04 (WSL) · work",
      profile: "work",
      agentDir: "/home/me/.omp-work/agent",
    };
    const launch = buildOmpTerminalLaunch(
      installation,
      {
        installationId: installation.id,
        path: "/work/profile-project",
        sessionPath: "/home/me/.omp-work/agent/sessions/project/old.jsonl",
      },
      "win32",
    );

    expect(launch.args.slice(3)).toEqual([
      "wsl.exe",
      "-d",
      "Ubuntu 24.04",
      "--cd",
      "/work/profile-project",
      "--exec",
      "/home/me/.local/bin/omp",
      "--profile",
      "work",
      "--cwd",
      "/work/profile-project",
      "--resume",
      "/home/me/.omp-work/agent/sessions/project/old.jsonl",
    ]);
  });

  it("passes macOS Terminal values as separate argv to a fixed AppleScript", () => {
    const workspace = "/Users/me/Project; say hacked";
    const sessionPath = "/Users/me/.omp/agent/sessions/old session.jsonl";
    const launch = buildOmpTerminalLaunch(
      macosInstallation,
      { installationId: macosInstallation.id, path: workspace, sessionPath },
      "darwin",
    );

    expect(launch).toEqual({
      command: "/usr/bin/osascript",
      args: [
        "-e",
        MACOS_TERMINAL_SCRIPT,
        "--",
        workspace,
        "/opt/homebrew/bin/omp",
        "--profile",
        "default",
        "--cwd",
        workspace,
        "--resume",
        sessionPath,
      ],
      options: { detached: true, stdio: "ignore" },
      displayName: "macOS Terminal",
    });
    expect(MACOS_TERMINAL_SCRIPT).not.toContain(workspace);
    expect(MACOS_TERMINAL_SCRIPT).not.toContain(sessionPath);
    expect(MACOS_TERMINAL_SCRIPT).toContain("quoted form");
  });

  it("builds a Linux terminal command with argv boundaries and the normalized working directory", () => {
    const launch = buildOmpTerminalLaunch(
      directInstallation,
      {
        ...wslInput,
        installationId: directInstallation.id,
        path: "/work/demo/../Project folder",
        sessionPath: undefined,
      },
      "linux",
      "/usr/bin/example-terminal",
    );

    expect(launch.command).toBe("/usr/bin/example-terminal");
    expect(launch.args).toEqual([
      "-e",
      "/home/me/.local/bin/omp",
      "--profile",
      "default",
      "--cwd",
      "/work/Project folder",
    ]);
    expect(launch.options).toEqual({
      cwd: "/work/Project folder",
      detached: true,
      stdio: "ignore",
    });
  });

  it("keeps the selected Linux profile in the terminal argv", () => {
    const installation: OmpInstallation = {
      ...directInstallation,
      id: "linux-direct:work",
      label: "Linux · Direct · work",
      profile: "work",
      agentDir: "/home/me/.omp-work/agent",
    };
    const launch = buildOmpTerminalLaunch(
      installation,
      { installationId: installation.id, path: "/work/profile-project" },
      "linux",
      "/usr/bin/example-terminal",
    );

    expect(launch.args).toEqual([
      "-e",
      "/home/me/.local/bin/omp",
      "--profile",
      "work",
      "--cwd",
      "/work/profile-project",
    ]);
  });

  it("resolves after the detached process survives the startup window", async () => {
    const child = fakeChild(process => process.emit("spawn"));
    const spawn = vi.fn(() => child);
    const launch: TerminalLaunch = {
      command: "terminal",
      args: ["-e", "omp"],
      options: { detached: true, stdio: "ignore" },
      displayName: "terminal",
    };

    await expect(spawnDetachedTerminal(launch, spawn, 0)).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledWith(launch.command, launch.args, launch.options);
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("reports an asynchronous spawn error", async () => {
    const child = fakeChild(process => process.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" })));

    await expect(
      spawnDetachedTerminal(buildOmpTerminalLaunch(wslInstallation, wslInput, "win32"), () => child, 0),
    ).rejects.toThrow(
      "Failed to start Windows Terminal: not found",
    );
  });

  it("reports a launcher that exits unsuccessfully during startup", async () => {
    const child = fakeChild(process => {
      process.emit("spawn");
      process.emit("exit", 7, null);
    });

    await expect(
      spawnDetachedTerminal(buildOmpTerminalLaunch(wslInstallation, wslInput, "win32"), () => child, 50),
    ).rejects.toThrow(
      "Failed to start Windows Terminal: exited with code 7",
    );
  });

  it("reports a synchronous launcher failure", async () => {
    const launch = buildOmpTerminalLaunch(wslInstallation, wslInput, "win32");

    await expect(
      spawnDetachedTerminal(launch, () => {
        throw new Error("spawn refused");
      }),
    ).rejects.toThrow("Failed to start Windows Terminal: spawn refused");
  });
});
