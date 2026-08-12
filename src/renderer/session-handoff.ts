import type { SessionHandoff } from "../shared/contracts";

export function hasSessionHandoff(
  handoffs: SessionHandoff[] | undefined,
  distro: string | undefined,
  sessionPath: string,
): boolean {
  return Boolean(distro && handoffs?.some(item => item.distro === distro && item.sessionPath === sessionPath));
}

export function addSessionHandoff(
  handoffs: SessionHandoff[] | undefined,
  handoff: SessionHandoff,
  limit = 256,
): SessionHandoff[] {
  const remaining = (handoffs ?? []).filter(item =>
    item.distro !== handoff.distro || item.sessionPath !== handoff.sessionPath,
  );
  return [...remaining.slice(-Math.max(0, limit - 1)), handoff];
}

export function removeSessionHandoff(
  handoffs: SessionHandoff[] | undefined,
  distro: string,
  sessionPath: string,
): SessionHandoff[] {
  return (handoffs ?? []).filter(item => item.distro !== distro || item.sessionPath !== sessionPath);
}
