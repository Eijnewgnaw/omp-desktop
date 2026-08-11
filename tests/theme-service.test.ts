import { describe, expect, it } from "vitest";
import type { ThemeJson } from "../src/shared/contracts";
import { ansi256ToHex, colorBlindDiffColor, resolveTheme } from "../src/main/theme-service";

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
});
