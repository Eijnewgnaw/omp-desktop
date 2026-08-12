import { describe, expect, it } from "vitest";
import { SESSION_TITLE_MAX_LENGTH, validateSessionTitle } from "../src/renderer/session-rename";

describe("session rename validation", () => {
  it("trims a non-empty title before saving", () => {
    expect(validateSessionTitle("  新的会话名称  ")).toEqual({ valid: true, title: "新的会话名称" });
  });

  it("rejects an empty or whitespace-only title", () => {
    expect(validateSessionTitle("  \n\t ")).toEqual({ valid: false, error: "会话名称不能为空" });
  });

  it("matches the metadata API title limit", () => {
    expect(validateSessionTitle("a".repeat(SESSION_TITLE_MAX_LENGTH))).toMatchObject({ valid: true });
    expect(validateSessionTitle("a".repeat(SESSION_TITLE_MAX_LENGTH + 1))).toEqual({
      valid: false,
      error: `会话名称不能超过 ${SESSION_TITLE_MAX_LENGTH} 个字符`,
    });
  });
});
