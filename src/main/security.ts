import path from "node:path";

const distroPattern = /^[\p{L}\p{N}._ -]{1,96}$/u;

export function assertDistro(value: string): string {
  if (!distroPattern.test(value) || value.includes("..")) {
    throw new Error("Invalid WSL distribution name");
  }
  return value;
}

export function assertWslPath(value: string, label = "path"): string {
  if (!value.startsWith("/") || value.includes("\0") || value.includes("\r") || value.includes("\n")) {
    throw new Error(`Invalid WSL ${label}`);
  }
  return path.posix.normalize(value);
}

export function assertRuntimeId(value: string): string {
  if (!/^[a-f0-9-]{16,64}$/i.test(value)) throw new Error("Invalid runtime id");
  return value;
}

export function wslPathToHostPath(distro: string, wslPath: string): string {
  const safeDistro = assertDistro(distro);
  const safePath = assertWslPath(wslPath);
  if (process.platform !== "win32") return safePath;
  const suffix = safePath.slice(1).split("/").join("\\");
  return `\\\\wsl.localhost\\${safeDistro}\\${suffix}`;
}

export function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
