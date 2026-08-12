import type { SessionSummary } from "../shared/contracts";

export function normalizedSessionPath(installationId: string, path: string): string {
  return installationId.startsWith("windows-native:") ? path.toLocaleLowerCase("en-US") : path;
}

export function sessionIdentity(installationId: string, path: string): string {
  return JSON.stringify([installationId, normalizedSessionPath(installationId, path)]);
}

export function sessionSummaryIdentity(
  session: Pick<SessionSummary, "installationId" | "path">,
): string {
  return sessionIdentity(session.installationId, session.path);
}

export function sessionMatchesIdentity(
  installationId: string | undefined,
  path: string | undefined,
  expectedInstallationId: string,
  expectedPath: string,
): boolean {
  return Boolean(installationId
    && path
    && sessionIdentity(installationId, path) === sessionIdentity(expectedInstallationId, expectedPath));
}

export function mergeSessions(groups: readonly (readonly SessionSummary[])[]): SessionSummary[] {
  return groups
    .flatMap(group => group)
    .map((session, index) => ({ session, index }))
    .sort((left, right) => {
      const pinnedOrder = Number(right.session.pinned) - Number(left.session.pinned);
      if (pinnedOrder !== 0) return pinnedOrder;

      const modifiedOrder = Date.parse(right.session.modifiedAt) - Date.parse(left.session.modifiedAt);
      if (Number.isFinite(modifiedOrder) && modifiedOrder !== 0) return modifiedOrder;

      return left.index - right.index;
    })
    .map(item => item.session);
}

export interface SessionGroupRequest {
  installationId: string;
  sessions: Promise<SessionSummary[]>;
}

export interface AvailableSessionGroups {
  groups: SessionSummary[][];
  failedInstallationIds: string[];
  errors: unknown[];
}

/**
 * Resolve each installation independently so one offline Profile or backend
 * cannot hide sessions from every healthy environment.
 */
export async function collectAvailableSessionGroups(
  requests: readonly SessionGroupRequest[],
): Promise<AvailableSessionGroups> {
  const settled = await Promise.allSettled(requests.map(request => request.sessions));
  const groups: SessionSummary[][] = [];
  const failedInstallationIds: string[] = [];
  const errors: unknown[] = [];

  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      groups.push(result.value);
      return;
    }
    const request = requests[index];
    if (!request) return;
    failedInstallationIds.push(request.installationId);
    errors.push(result.reason);
  });

  return { groups, failedInstallationIds, errors };
}

export function replaceSessionSummary(
  sessions: readonly SessionSummary[],
  updated: SessionSummary,
): SessionSummary[] {
  const identity = sessionSummaryIdentity(updated);
  let replaced = false;
  const next = sessions.map(session => {
    if (sessionSummaryIdentity(session) !== identity) return session;
    replaced = true;
    return updated;
  });
  if (!replaced) next.push(updated);
  return mergeSessions([next]);
}

export function removeSessionSummary(
  sessions: readonly SessionSummary[],
  removed: Pick<SessionSummary, "installationId" | "path">,
): SessionSummary[] {
  const identity = sessionSummaryIdentity(removed);
  return sessions.filter(session => sessionSummaryIdentity(session) !== identity);
}
