import fs from "node:fs/promises";
import path from "node:path";
import type { OmpInstallation, ThemeJson, ThemeSnapshot } from "../shared/contracts";
import themeBundleJson from "../shared/omp-themes.generated.json";
import { runOmp } from "./environment-service";
import { wslPathToHostPath } from "./security";

interface ThemeBundle {
  source: string;
  sourceVersion: string;
  themes: Record<string, ThemeJson>;
}

const themeBundle = themeBundleJson as ThemeBundle;

const ANSI_BASE = [
  "#000000",
  "#800000",
  "#008000",
  "#808000",
  "#000080",
  "#800080",
  "#008080",
  "#c0c0c0",
  "#808080",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#0000ff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
] as const;

export function ansi256ToHex(index: number): string {
  const value = Math.max(0, Math.min(255, Math.round(index)));
  if (value < 16) return ANSI_BASE[value] ?? "#808080";
  if (value < 232) {
    const offset = value - 16;
    const red = Math.floor(offset / 36);
    const green = Math.floor((offset % 36) / 6);
    const blue = offset % 6;
    const channel = (component: number): number => (component === 0 ? 0 : 55 + component * 40);
    return `#${[channel(red), channel(green), channel(blue)]
      .map(component => component.toString(16).padStart(2, "0"))
      .join("")}`;
  }
  const gray = 8 + (value - 232) * 10;
  return `#${gray.toString(16).padStart(2, "0").repeat(3)}`;
}

function resolveColor(
  value: string | number | undefined,
  vars: Record<string, string | number>,
  fallback: string,
  seen = new Set<string>(),
): string {
  if (typeof value === "number") return ansi256ToHex(value);
  if (value === undefined || value === "") return fallback;
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    return `#${value
      .slice(1)
      .split("")
      .map(character => character.repeat(2))
      .join("")}`.toLowerCase();
  }
  if (seen.has(value)) return fallback;
  const variable = vars[value];
  if (variable === undefined) return fallback;
  seen.add(value);
  return resolveColor(variable, vars, fallback, seen);
}

function hexToHsv(hex: string): [number, number, number] {
  const red = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const green = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta !== 0) {
    if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (maximum === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }
  if (hue < 0) hue += 360;
  return [hue, maximum === 0 ? 0 : delta / maximum, maximum];
}

function hsvToHex(hue: number, saturation: number, value: number): string {
  const chroma = value * saturation;
  const section = hue / 60;
  const intermediate = chroma * (1 - Math.abs((section % 2) - 1));
  const [red1, green1, blue1] =
    section < 1
      ? [chroma, intermediate, 0]
      : section < 2
        ? [intermediate, chroma, 0]
        : section < 3
          ? [0, chroma, intermediate]
          : section < 4
            ? [0, intermediate, chroma]
            : section < 5
              ? [intermediate, 0, chroma]
              : [chroma, 0, intermediate];
  const match = value - chroma;
  return `#${[red1, green1, blue1]
    .map(channel => Math.round((channel + match) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

export function colorBlindDiffColor(hex: string): string {
  const [hue, saturation, value] = hexToHsv(hex);
  return hsvToHex((hue + 60) % 360, Math.min(1, saturation * 0.71), value);
}

export function resolveTheme(
  theme: ThemeJson,
  options: { mode: "dark" | "light"; colorBlindMode: boolean },
): Pick<ThemeSnapshot, "colors" | "export"> {
  const textFallback = options.mode === "dark" ? "#e7e9ef" : "#191b20";
  const vars = theme.vars ?? {};
  const colors = Object.fromEntries(
    Object.entries(theme.colors).map(([key, value]) => [key, resolveColor(value, vars, textFallback)]),
  );
  if (options.colorBlindMode && colors.toolDiffAdded) {
    colors.toolDiffAdded = colorBlindDiffColor(colors.toolDiffAdded);
  }
  const pageFallback = options.mode === "dark" ? "#121419" : "#f8f8f8";
  const cardFallback = options.mode === "dark" ? "#1a1e25" : "#ffffff";
  return {
    colors,
    export: {
      pageBg: resolveColor(theme.export?.pageBg, vars, pageFallback),
      cardBg: resolveColor(theme.export?.cardBg, vars, cardFallback),
      infoBg: resolveColor(theme.export?.infoBg, vars, colors.toolPendingBg ?? cardFallback),
    },
  };
}

async function getConfigValue(installation: OmpInstallation, key: string, fallback: string): Promise<string> {
  try {
    return (await runOmp(installation, ["config", "get", key])).trim() || fallback;
  } catch {
    return fallback;
  }
}

async function loadCustomTheme(installation: OmpInstallation, name: string): Promise<ThemeJson | null> {
  try {
    const file = wslPathToHostPath(installation.distro, path.posix.join(installation.agentDir, "themes", `${name}.json`));
    return JSON.parse(await fs.readFile(file, "utf8")) as ThemeJson;
  } catch {
    return null;
  }
}

async function customThemeNames(installation: OmpInstallation): Promise<string[]> {
  try {
    const directory = wslPathToHostPath(installation.distro, path.posix.join(installation.agentDir, "themes"));
    return (await fs.readdir(directory))
      .filter(file => file.endsWith(".json"))
      .map(file => file.slice(0, -5));
  } catch {
    return [];
  }
}

export async function getThemeSnapshot(
  installation: OmpInstallation,
  mode: "dark" | "light",
): Promise<ThemeSnapshot> {
  const [darkTheme, lightTheme, symbolPresetRaw, colorBlindRaw, customNames] = await Promise.all([
    getConfigValue(installation, "theme.dark", "anthracite"),
    getConfigValue(installation, "theme.light", "light"),
    getConfigValue(installation, "symbolPreset", "unicode"),
    getConfigValue(installation, "colorBlindMode", "false"),
    customThemeNames(installation),
  ]);
  const requestedName = mode === "dark" ? darkTheme : lightTheme;
  const builtin = themeBundle.themes[requestedName];
  const custom = builtin ? null : await loadCustomTheme(installation, requestedName);
  const fallbackName = mode === "dark" ? "dark" : "light";
  const theme = builtin ?? custom ?? themeBundle.themes[fallbackName];
  if (!theme) throw new Error("OMP theme bundle is incomplete");
  const colorBlindMode = colorBlindRaw === "true";
  const resolved = resolveTheme(theme, { mode, colorBlindMode });
  const symbolPreset = ["unicode", "nerd", "ascii"].includes(symbolPresetRaw)
    ? (symbolPresetRaw as ThemeSnapshot["symbolPreset"])
    : theme.symbols?.preset ?? "unicode";
  return {
    name: theme.name,
    darkTheme,
    lightTheme,
    mode,
    symbolPreset,
    colorBlindMode,
    ...resolved,
    availableThemes: [...new Set([...Object.keys(themeBundle.themes), ...customNames])].sort(),
    source: builtin ? "builtin" : custom ? "custom" : "fallback",
  };
}

export const bundledThemeVersion = themeBundle.sourceVersion;
