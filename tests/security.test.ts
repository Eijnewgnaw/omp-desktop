import { describe, expect, it } from "vitest";
import { assertDistro, assertWslPath, isSafeExternalUrl, wslPathToHostPath } from "../src/main/security";

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
