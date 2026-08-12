import type { SessionSummary } from "../shared/contracts";
import { sessionMatchesIdentity } from "./session-collection";

export type ActiveTarget =
  | { kind: "new"; key: string; installationId?: string; cwd?: string; sessionPath?: string }
  | { kind: "saved"; key: string; session: SessionSummary };

export function newSessionTarget(key: string = crypto.randomUUID(), installationId?: string): ActiveTarget {
  return installationId === undefined
    ? { kind: "new", key }
    : { kind: "new", key, installationId };
}

export function savedSessionTarget(session: SessionSummary, key: string = crypto.randomUUID()): ActiveTarget {
  return { kind: "saved", key, session };
}

export function targetWorkspace(target: ActiveTarget): string | undefined {
  return target.kind === "saved" ? target.session.cwd : target.cwd;
}

export function targetSession(target: ActiveTarget): SessionSummary | undefined {
  return target.kind === "saved" ? target.session : undefined;
}

export function targetSessionPath(target: ActiveTarget): string | undefined {
  return target.kind === "saved" ? target.session.path : target.sessionPath;
}

export function targetInstallationId(target: ActiveTarget): string | undefined {
  return target.kind === "saved" ? target.session.installationId : target.installationId;
}

export function chooseTargetInstallation(
  target: ActiveTarget,
  installationId: string,
  key: string = crypto.randomUUID(),
): ActiveTarget {
  if (target.kind !== "new" || target.sessionPath || target.installationId === installationId) return target;
  return newSessionTarget(key, installationId);
}

export function chooseTargetWorkspace(target: ActiveTarget, cwd: string): ActiveTarget {
  if (target.kind !== "new" || target.sessionPath) return target;
  return { ...target, cwd };
}

export function attachTargetSessionPath(target: ActiveTarget, key: string, sessionPath: string): ActiveTarget {
  if (target.kind !== "new" || target.key !== key) return target;
  return { ...target, sessionPath };
}

export function reconcileTarget(target: ActiveTarget, sessions: SessionSummary[]): ActiveTarget {
  const sessionPath = targetSessionPath(target);
  const installationId = targetInstallationId(target);
  if (!installationId || !sessionPath) return target;
  const session = sessions.find(candidate => sessionMatchesIdentity(
    candidate.installationId,
    candidate.path,
    installationId,
    sessionPath,
  ));
  if (!session) return target;
  if (target.kind === "saved" && target.session === session) return target;
  return { kind: "saved", key: target.key, session };
}
