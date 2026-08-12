import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn() },
}));

import {
  buildOmpTerminalLaunch,
  spawnDetachedTerminal,
  type TerminalLaunch,
} from "../src/main/system-service";

function fakeChild(emitLifecycle: (child: EventEmitter) => void): ChildProcess {
  const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
  child.unref = vi.fn();
  queueMicrotask(() => emitLifecycle(child));
  return child as unknown as ChildProcess;
}

const input = {
  distro: "Ubuntu 24.04",
  path: "/home/me/My Project;still-one-argument",
  installationPath: "/home/me/.local/bin/omp",
  profile: "work profile;not-a-command",
  sessionPath: "/home/me/.omp/sessions/old session.jsonl",
};

describe("OMP terminal launcher", () => {
  it("builds a visible new Windows Terminal window without a standalone separator", () => {
    const launch = buildOmpTerminalLaunch(input, "win32");

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
        "--cwd",
        "/home/me/My Project\\;still-one-argument",
        "--profile",
        "work profile\\;not-a-command",
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

  it("escapes a semicolon-only OMP profile for the Windows Terminal parser", () => {
    const launch = buildOmpTerminalLaunch({ ...input, profile: ";" }, "win32");
    const profileIndex = launch.args.indexOf("--profile");

    expect(launch.args[profileIndex + 1]).toBe("\\;");
    expect(launch.args.filter(argument => argument === ";")).toEqual([]);
  });

  it("builds a Linux terminal command with argv boundaries and the normalized working directory", () => {
    const launch = buildOmpTerminalLaunch(
      {
        ...input,
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
      "--cwd",
      "/work/Project folder",
      "--profile",
      "work profile;not-a-command",
    ]);
    expect(launch.options).toEqual({
      cwd: "/work/Project folder",
      detached: true,
      stdio: "ignore",
    });
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

    await expect(spawnDetachedTerminal(buildOmpTerminalLaunch(input, "win32"), () => child, 0)).rejects.toThrow(
      "Failed to start Windows Terminal: not found",
    );
  });

  it("reports a launcher that exits unsuccessfully during startup", async () => {
    const child = fakeChild(process => {
      process.emit("spawn");
      process.emit("exit", 7, null);
    });

    await expect(spawnDetachedTerminal(buildOmpTerminalLaunch(input, "win32"), () => child, 50)).rejects.toThrow(
      "Failed to start Windows Terminal: exited with code 7",
    );
  });

  it("reports a synchronous launcher failure", async () => {
    const launch = buildOmpTerminalLaunch(input, "win32");

    await expect(
      spawnDetachedTerminal(launch, () => {
        throw new Error("spawn refused");
      }),
    ).rejects.toThrow("Failed to start Windows Terminal: spawn refused");
  });
});
