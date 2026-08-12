import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OmpInstallation, ThemeJson } from "../src/shared/contracts";
import { runOmp } from "../src/main/environment-service";
import {
  ansi256ToHex,
  colorBlindDiffColor,
  customThemeLogicalPath,
  getThemeSnapshot,
  resolveTheme,
} from "../src/main/theme-service";

vi.mock("../src/main/environment-service", () => ({ runOmp: vi.fn() }));

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.mocked(runOmp).mockReset();
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("OMP theme resolver", () => {
  it("converts ANSI 256 colors", () => {
    expect(ansi256ToHex(0)).toBe("#000000");
    expect(ansi256ToHex(16)).toBe("#000000");
    expect(ansi256ToHex(196)).toBe("#ff0000");
    expect(ansi256ToHex(255)).toBe("#eeeeee");
  });

  it("resolves variables and terminal default colors", () => {
    const theme: ThemeJson = {
      name: "fixture",
      vars: { accentValue: "#FF8844" },
      colors: {
        accent: "accentValue",
        text: "",
        toolDiffAdded: 107,
        toolPendingBg: "#101010",
      },
      export: { pageBg: "#080808" },
    };
    const result = resolveTheme(theme, { mode: "dark", colorBlindMode: false });
    expect(result.colors.accent).toBe("#ff8844");
    expect(result.colors.text).toBe("#e7e9ef");
    expect(result.export.pageBg).toBe("#080808");
  });

  it("adjusts the added diff color in color-blind mode", () => {
    expect(colorBlindDiffColor("#00ff00")).not.toBe("#00ff00");
  });

  it("routes custom theme files through each installation's logical path style", () => {
    const native: OmpInstallation = {
      id: "windows-native:omp",
      kind: "windows-native",
      label: "Windows · Native",
      executablePath: "C:\\Tools\\omp.exe",
      version: "17.2.12",
      agentDir: "C:\\Users\\Alice\\.omp\\agent",
    };
    const wsl: OmpInstallation = {
      id: "wsl:Ubuntu",
      kind: "wsl",
      label: "WSL · Ubuntu",
      distro: "Ubuntu",
      executablePath: "/usr/bin/omp",
      version: "17.2.12",
      agentDir: "/home/alice/.omp/agent",
    };

    expect(customThemeLogicalPath(native, "my-theme")).toBe(
      "C:\\Users\\Alice\\.omp\\agent\\themes\\my-theme.json",
    );
    expect(customThemeLogicalPath(wsl, "my-theme")).toBe("/home/alice/.omp/agent/themes/my-theme.json");
    const nativeWork: OmpInstallation = {
      ...native,
      id: "windows-native:work",
      label: "Windows · Native · work",
      profile: "work",
      agentDir: "C:\\Users\\Alice\\.omp-work\\agent",
    };
    const wslWork: OmpInstallation = {
      ...wsl,
      id: "wsl:work",
      label: "WSL · Ubuntu · work",
      profile: "work",
      agentDir: "/home/alice/.omp-work/agent",
    };
    expect(customThemeLogicalPath(nativeWork, "my-theme")).toBe(
      "C:\\Users\\Alice\\.omp-work\\agent\\themes\\my-theme.json",
    );
    expect(customThemeLogicalPath(wslWork, "my-theme")).toBe(
      "/home/alice/.omp-work/agent/themes/my-theme.json",
    );
    expect(customThemeLogicalPath(nativeWork, "my-theme")).not.toBe(customThemeLogicalPath(native, "my-theme"));
    expect(customThemeLogicalPath(wslWork, "my-theme")).not.toBe(customThemeLogicalPath(wsl, "my-theme"));
    expect(() => customThemeLogicalPath(native, "..\\escape")).toThrow("Invalid custom OMP theme name");
    expect(() => customThemeLogicalPath(wsl, "../escape")).toThrow("Invalid custom OMP theme name");
  });

  it.runIf(process.platform !== "win32")(
    "loads theme config and custom files from the exact default or named WSL profile",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-profile-themes-"));
      temporaryDirectories.push(root);
      const defaultAgentDir = path.join(root, "default-agent");
      const workAgentDir = path.join(root, "work-agent");
      await fs.mkdir(path.join(defaultAgentDir, "themes"), { recursive: true });
      await fs.mkdir(path.join(workAgentDir, "themes"), { recursive: true });
      await fs.writeFile(path.join(defaultAgentDir, "themes", "default-custom.json"), JSON.stringify({
        name: "default-custom",
        colors: { accent: "#112233" },
      }));
      await fs.writeFile(path.join(workAgentDir, "themes", "work-custom.json"), JSON.stringify({
        name: "work-custom",
        colors: { accent: "#445566" },
      }));
      const base = {
        kind: "wsl" as const,
        distro: "Ubuntu",
        executablePath: "/usr/bin/omp",
        version: "17.2.12",
      };
      const defaultInstallation: OmpInstallation = {
        ...base,
        id: "wsl:default",
        label: "Ubuntu (WSL)",
        agentDir: defaultAgentDir,
      };
      const workInstallation: OmpInstallation = {
        ...base,
        id: "wsl:work",
        label: "Ubuntu (WSL) · work",
        profile: "work",
        agentDir: workAgentDir,
      };
      vi.mocked(runOmp).mockImplementation(async (installation, args) => {
        const key = args.at(-1);
        if (key === "theme.dark") return installation.profile === "work" ? "work-custom" : "default-custom";
        if (key === "theme.light") return "light";
        if (key === "symbolPreset") return "unicode";
        if (key === "colorBlindMode") return "false";
        throw new Error(`Unexpected config key: ${String(key)}`);
      });

      const [defaultTheme, workTheme] = await Promise.all([
        getThemeSnapshot(defaultInstallation, "dark"),
        getThemeSnapshot(workInstallation, "dark"),
      ]);

      expect(defaultTheme).toMatchObject({ name: "default-custom", source: "custom" });
      expect(defaultTheme.colors.accent).toBe("#112233");
      expect(workTheme).toMatchObject({ name: "work-custom", source: "custom" });
      expect(workTheme.colors.accent).toBe("#445566");
      expect(vi.mocked(runOmp).mock.calls.some(([installation]) => installation.profile === "work")).toBe(true);
      expect(vi.mocked(runOmp).mock.calls.some(([installation]) => installation.profile === undefined)).toBe(true);
    },
  );
});
