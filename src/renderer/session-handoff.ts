import type { OmpInstallation, SessionHandoff } from "../shared/contracts";
import { sessionMatchesIdentity } from "./session-collection";

type InstallationIdentity = string | Pick<OmpInstallation, "id" | "kind" | "distro" | "executablePath">;

function installationId(installation: InstallationIdentity | undefined): string | undefined {
  return typeof installation === "string" ? installation : installation?.id;
}

function legacyInstallationMatches(
  handoff: SessionHandoff,
  installation: InstallationIdentity | undefined,
): boolean {
  if (!installation || typeof installation === "string" || installation.kind !== "wsl") return false;
  if (handoff.distro && handoff.distro !== installation.distro) return false;
  if (handoff.installationPath && handoff.installationPath !== installation.executablePath) return false;
  return Boolean(handoff.distro || handoff.installationPath);
}

export function hasSessionHandoff(
  handoffs: SessionHandoff[] | undefined,
  installation: InstallationIdentity | undefined,
  sessionPath: string,
): boolean {
  const id = installationId(installation);
  if (!id) return false;
  return Boolean(handoffs?.some(handoff => {
    if (!sessionMatchesIdentity(id, handoff.sessionPath, id, sessionPath)) return false;
    if (handoff.installationId === id) return true;
    if (legacyInstallationMatches(handoff, installation)) return true;
    if (!installation || typeof installation === "string") return false;
    // OMP executable upgrades can change the opaque installation ID without
    // changing the physical session root. WSL paths additionally require the
    // same distro; old modern leases without distro lock conservatively.
    return installation.kind !== "wsl" || !handoff.distro || handoff.distro === installation.distro;
  }));
}
