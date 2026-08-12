import type { OmpInstallation, OmpRuntimeKind } from "../shared/contracts";

export type RuntimeLocation = "macos-native" | "windows-native" | "wsl";

export const RUNTIME_LOCATIONS: readonly RuntimeLocation[] = ["macos-native", "windows-native", "wsl"];

export const RUNTIME_LOCATION_LABELS: Record<RuntimeLocation, string> = {
  "macos-native": "macOS",
  "windows-native": "Windows",
  wsl: "WSL",
};

/**
 * linux-direct is used only by the WSLg development shell. In the product UI
 * it represents the same user-facing WSL location, while retaining its real
 * adapter kind and installation ID for every main-process operation.
 */
export function runtimeLocation(kind: OmpRuntimeKind): RuntimeLocation {
  if (kind === "macos-native") return "macos-native";
  return kind === "windows-native" ? "windows-native" : "wsl";
}

export function installationsForLocation(
  installations: readonly OmpInstallation[],
  location: RuntimeLocation,
): OmpInstallation[] {
  return installations.filter(item => runtimeLocation(item.kind) === location);
}

export function visibleRuntimeInstallations(
  installations: readonly OmpInstallation[],
): OmpInstallation[] {
  const productInstallations = installations.filter(item =>
    item.kind === "macos-native" || item.kind === "windows-native" || item.kind === "wsl");
  return productInstallations.length > 0
    ? productInstallations
    : installations.filter(item => item.kind === "linux-direct");
}
