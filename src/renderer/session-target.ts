import type { SessionSummary } from "../shared/contracts";

export type ActiveTarget =
  | { kind: "new"; key: string; cwd?: string; sessionPath?: string }
  | { kind: "saved"; key: string; session: SessionSummary };

export function newSessionTarget(key = crypto.randomUUID()): ActiveTarget {
  return { kind: "new", key };
}

export function savedSessionTarget(session: SessionSummary, key = crypto.randomUUID()): ActiveTarget {
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
  if (!sessionPath) return target;
  const session = sessions.find(candidate => candidate.path === sessionPath);
  if (!session) return target;
  if (target.kind === "saved" && target.session === session) return target;
  return { kind: "saved", key: target.key, session };
}
