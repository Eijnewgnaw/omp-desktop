import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type {
  DeleteSessionResult,
  OmpInstallation,
  SessionMetadataPatch,
  SessionSummary,
  TrashSessionResult,
} from "../shared/contracts";
import { MetadataStore } from "./metadata-store";
import {
  assertLogicalPath,
  basenameLogicalPath,
  installationMetadataKey,
  installationDataDir,
  joinLogicalPath,
  toHostPath,
} from "./security";

interface SessionHeader {
  type: "session";
  id?: string;
  timestamp?: string;
  cwd?: string;
  title?: string;
  titleSource?: "auto" | "user";
}

interface TitleSlot {
  type: "title";
  title?: string;
}

function parseJsonLine<T>(line: string): T | null {
  try {
    return JSON.parse(line.trim()) as T;
  } catch {
    return null;
  }
}

export function parseSessionPrefix(content: string): {
  header: SessionHeader & Required<Pick<SessionHeader, "id" | "cwd">>;
  title?: string;
} | null {
  const entries = content
    .split(/\r?\n/)
    .slice(0, 12)
    .map(line => parseJsonLine<Record<string, unknown>>(line))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  const header = entries.find(entry => entry.type === "session") as SessionHeader | undefined;
  if (!header?.id || !header.cwd) return null;
  const titleSlot = entries.find(entry => entry.type === "title") as TitleSlot | undefined;
  return {
    header: header as SessionHeader & Required<Pick<SessionHeader, "id" | "cwd">>,
    title: titleSlot?.title || header.title,
  };
}

async function sessionFiles(directory: string, pathApi: typeof path.win32 | typeof path.posix = path): Promise<string[]> {
  const result: string[] = [];
  let buckets: Dirent[];
  try {
    buckets = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return result;
  }
  await Promise.all(
    buckets
      .filter(entry => entry.isDirectory())
      .map(async entry => {
        const bucket = pathApi.join(directory, entry.name);
        const files = await fs.readdir(bucket, { withFileTypes: true }).catch(() => []);
        for (const file of files) {
          if (file.isFile() && file.name.endsWith(".jsonl")) result.push(pathApi.join(bucket, file.name));
        }
      }),
  );
  return result;
}

function hostPathApi(
  installation: OmpInstallation,
  hostPathOverride = false,
): typeof path.win32 | typeof path.posix {
  if (hostPathOverride) return path;
  return process.platform === "win32" && installation.kind !== "linux-direct" ? path.win32 : path.posix;
}

function toLogicalPath(installation: OmpInstallation, hostRoot: string, logicalRoot: string, hostFile: string): string {
  const pathApi = hostPathApi(installation);
  const relative = pathApi.relative(hostRoot, hostFile);
  return joinLogicalPath(installation, logicalRoot, ...relative.split(/[\\/]+/u).filter(Boolean));
}

function relativeLogicalParts(installation: OmpInstallation, relative: string): string[] {
  return relative
    .split(installation.kind === "windows-native" ? /[\\/]+/u : /\/+/u)
    .filter(Boolean);
}

export function containedLogicalRelativePath(
  installation: Pick<OmpInstallation, "kind">,
  root: string,
  candidate: string,
): string {
  const pathApi = installation.kind === "windows-native" ? path.win32 : path.posix;
  const safeRoot = assertLogicalPath(installation, root, "OMP sessions directory");
  const safeCandidate = assertLogicalPath(installation, candidate, "session path");
  const relative = pathApi.relative(
    installation.kind === "windows-native" ? safeRoot.toLowerCase() : safeRoot,
    installation.kind === "windows-native" ? safeCandidate.toLowerCase() : safeCandidate,
  );
  const parentPrefix = `..${pathApi.sep}`;
  if (!relative || relative.startsWith(parentPrefix) || relative === ".." || pathApi.isAbsolute(relative)) {
    throw new Error("Session path is outside the OMP sessions directory");
  }
  return relative;
}

function logicalPathCacheKey(installation: OmpInstallation, value: string): string {
  const normalized = assertLogicalPath(installation, value, "session path");
  return installation.kind === "windows-native" ? normalized.toLowerCase() : normalized;
}

export class SessionIndex {
  readonly #store: MetadataStore;
  readonly #caches = new Map<string, Map<string, SessionSummary>>();

  constructor(store: MetadataStore) {
    this.#store = store;
  }

  #installationKey(installation: OmpInstallation): string {
    return installationMetadataKey(installation);
  }

  #cacheFor(installation: OmpInstallation): Map<string, SessionSummary> {
    const key = this.#installationKey(installation);
    let cache = this.#caches.get(key);
    if (!cache) {
      cache = new Map<string, SessionSummary>();
      this.#caches.set(key, cache);
    }
    return cache;
  }

  async list(
    installation: OmpInstallation,
    includeArchived = false,
    /** Test seam for exercising Win32 logical paths on a non-Windows CI host. */
    hostRootOverride?: string,
  ): Promise<SessionSummary[]> {
    const dataDir = installationDataDir(installation);
    const logicalRoot = joinLogicalPath(installation, dataDir, "sessions");
    const hostRoot = hostRootOverride ?? toHostPath(installation, logicalRoot);
    const files = await sessionFiles(hostRoot, hostPathApi(installation, hostRootOverride !== undefined));
    const sessionPathFor = (hostFile: string): string => hostRootOverride
      ? joinLogicalPath(
          installation,
          logicalRoot,
          ...path.relative(hostRoot, hostFile).split(path.sep).filter(Boolean),
        )
      : toLogicalPath(installation, hostRoot, logicalRoot, hostFile);
    const sessionPaths = files.map(sessionPathFor);
    const pathAliases = new Map<string, string>();
    if (logicalPathCacheKey(installation, dataDir) !== logicalPathCacheKey(installation, installation.agentDir)) {
      const legacyRoot = joinLogicalPath(installation, installation.agentDir, "sessions");
      for (const sessionPath of sessionPaths) {
        const relative = containedLogicalRelativePath(installation, logicalRoot, sessionPath);
        pathAliases.set(
          sessionPath,
          joinLogicalPath(installation, legacyRoot, ...relativeLogicalParts(installation, relative)),
        );
      }
    }
    const metadata = this.#store.getSessionMetadata(
      this.#installationKey(installation),
      sessionPaths,
      installation.profile === undefined ? installation : undefined,
      pathAliases,
    );
    const summaries = (
      await Promise.all(
        files.map(async hostFile => {
          try {
            const [handle, stat] = await Promise.all([fs.open(hostFile, "r"), fs.stat(hostFile)]);
            const buffer = Buffer.alloc(Math.min(8192, Math.max(512, stat.size)));
            await handle.read(buffer, 0, buffer.length, 0);
            await handle.close();
            const parsed = parseSessionPrefix(buffer.toString("utf8"));
            if (!parsed) return null;
            const sessionPath = sessionPathFor(hostFile);
            const cwd = assertLogicalPath(installation, parsed.header.cwd, "session workspace");
            const createdAt = parsed.header.timestamp ?? stat.birthtime.toISOString();
            const metadataRow = metadata.get(sessionPath);
            const base: SessionSummary = {
              id: parsed.header.id ?? basenameLogicalPath(installation, sessionPath, ".jsonl"),
              path: sessionPath,
              cwd,
              title: parsed.title?.trim() || `未命名会话 · ${new Date(createdAt).toLocaleString()}`,
              titleSource: parsed.header.titleSource,
              createdAt,
              modifiedAt: stat.mtime.toISOString(),
              size: stat.size,
              projectName: basenameLogicalPath(installation, cwd) || cwd,
              pinned: false,
              archived: false,
              tags: [],
              installationId: installation.id,
              runtimeKind: installation.kind,
              runtimeLabel: installation.label,
              profile: installation.profile,
            };
            return this.#store.applyMetadata(base, metadataRow);
          } catch {
            return null;
          }
        }),
      )
    ).filter((summary): summary is SessionSummary => summary !== null);
    const cache = this.#cacheFor(installation);
    cache.clear();
    for (const summary of summaries) cache.set(logicalPathCacheKey(installation, summary.path), summary);
    return summaries
      .filter(summary => includeArchived || !summary.archived)
      .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.modifiedAt.localeCompare(left.modifiedAt));
  }

  update(
    installation: OmpInstallation,
    pathValue: string,
    patch: SessionMetadataPatch,
  ): SessionSummary {
    const cache = this.#cacheFor(installation);
    const existing = cache.get(logicalPathCacheKey(installation, pathValue));
    if (!existing) throw new Error("Session must be indexed before it can be updated");
    const updated = this.#store.updateSession(
      this.#installationKey(installation),
      existing,
      patch,
      installation.profile === undefined ? installation : undefined,
    );
    cache.set(logicalPathCacheKey(installation, existing.path), updated);
    return updated;
  }

  async trash(
    installation: OmpInstallation,
    sessionPath: string,
    /** Test seam for exercising Win32 logical paths on a non-Windows CI host. */
    hostDataDirOverride?: string,
  ): Promise<TrashSessionResult> {
    const dataDir = installationDataDir(installation);
    const sessionsLogicalRoot = joinLogicalPath(installation, dataDir, "sessions");
    const requestedPath = assertLogicalPath(installation, sessionPath, "session path");
    const relative = containedLogicalRelativePath(installation, sessionsLogicalRoot, requestedPath);
    if (!basenameLogicalPath(installation, requestedPath).toLowerCase().endsWith(".jsonl")) {
      throw new Error("Only indexed OMP JSONL sessions can be moved to Trash");
    }
    const cache = this.#cacheFor(installation);
    const existing = cache.get(logicalPathCacheKey(installation, requestedPath));
    if (!existing) throw new Error("Session must be indexed before it can be moved to Trash");
    const sourceLogicalPath = existing.path;
    const sourceHostPath = hostDataDirOverride
      ? path.resolve(hostDataDirOverride, "sessions", ...relativeLogicalParts(installation, relative))
      : toHostPath(installation, sourceLogicalPath);
    const sourceStat = await fs.lstat(sourceHostPath).catch(() => undefined);
    if (!sourceStat?.isFile()) throw new Error("OMP session file no longer exists");

    const trashLogicalRoot = joinLogicalPath(installation, dataDir, "trash", "omp-desktop");
    const batch = `${new Date().toISOString().replace(/[:.]/g, "-")}_${crypto.randomUUID()}`;
    const destinationLogicalPath = joinLogicalPath(
      installation,
      trashLogicalRoot,
      batch,
      ...relativeLogicalParts(installation, relative),
    );
    const destinationHostPath = hostDataDirOverride
      ? path.resolve(
          hostDataDirOverride,
          "trash",
          "omp-desktop",
          batch,
          ...relativeLogicalParts(installation, relative),
        )
      : toHostPath(installation, destinationLogicalPath);
    const sourceArtifactPath = sourceHostPath.slice(0, -".jsonl".length);
    const destinationArtifactPath = destinationHostPath.slice(0, -".jsonl".length);
    const artifactStat = await fs.lstat(sourceArtifactPath).catch(() => undefined);
    const hasArtifacts = artifactStat?.isDirectory() ?? false;
    if (artifactStat && !hasArtifacts) {
      throw new Error("OMP session artifacts must be a directory before they can be moved to Trash");
    }

    const destinationPathApi = hostPathApi(installation, hostDataDirOverride !== undefined);
    await fs.mkdir(destinationPathApi.dirname(destinationHostPath), { recursive: true });
    await fs.rename(sourceHostPath, destinationHostPath);
    try {
      if (hasArtifacts) await fs.rename(sourceArtifactPath, destinationArtifactPath);
    } catch (error) {
      try {
        await fs.rename(destinationHostPath, sourceHostPath);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Failed to move OMP artifacts and restore the session file");
      }
      throw error;
    }
    cache.delete(logicalPathCacheKey(installation, sourceLogicalPath));

    return {
      originalPath: sourceLogicalPath,
      trashPath: destinationLogicalPath,
      artifactTrashPath: hasArtifacts ? destinationLogicalPath.slice(0, -".jsonl".length) : undefined,
    };
  }

  async deletePermanently(
    installation: OmpInstallation,
    sessionPath: string,
    /** Test seam for exercising Win32 logical paths on a non-Windows CI host. */
    hostDataDirOverride?: string,
  ): Promise<DeleteSessionResult> {
    const dataDir = installationDataDir(installation);
    const sessionsLogicalRoot = joinLogicalPath(installation, dataDir, "sessions");
    const requestedPath = assertLogicalPath(installation, sessionPath, "session path");
    const relative = containedLogicalRelativePath(installation, sessionsLogicalRoot, requestedPath);
    if (!basenameLogicalPath(installation, requestedPath).toLowerCase().endsWith(".jsonl")) {
      throw new Error("Only indexed OMP JSONL sessions can be permanently deleted");
    }
    const cache = this.#cacheFor(installation);
    const existing = cache.get(logicalPathCacheKey(installation, requestedPath));
    if (!existing) {
      throw new Error("Session must be indexed before it can be permanently deleted");
    }
    const sourceLogicalPath = existing.path;
    const sourceHostPath = hostDataDirOverride
      ? path.resolve(hostDataDirOverride, "sessions", ...relativeLogicalParts(installation, relative))
      : toHostPath(installation, sourceLogicalPath);
    const sourceStat = await fs.lstat(sourceHostPath).catch(() => undefined);
    if (!sourceStat?.isFile()) throw new Error("OMP session file no longer exists");

    const sourceArtifactPath = sourceHostPath.slice(0, -".jsonl".length);
    const artifactStat = await fs.lstat(sourceArtifactPath).catch(() => undefined);
    const hasArtifacts = artifactStat?.isDirectory() ?? false;
    if (artifactStat && !hasArtifacts) {
      throw new Error("OMP session artifacts must be a directory before they can be permanently deleted");
    }

    const stagingLogicalRoot = joinLogicalPath(
      installation,
      dataDir,
      ".omp-desktop-delete-staging",
      crypto.randomUUID(),
    );
    const stagingRoot = hostDataDirOverride
      ? path.resolve(hostDataDirOverride, ".omp-desktop-delete-staging", path.win32.basename(stagingLogicalRoot))
      : toHostPath(installation, stagingLogicalRoot);
    const stagedLogicalPath = joinLogicalPath(
      installation,
      stagingLogicalRoot,
      ...relativeLogicalParts(installation, relative),
    );
    const stagedSessionPath = hostDataDirOverride
      ? path.resolve(stagingRoot, ...relativeLogicalParts(installation, relative))
      : toHostPath(installation, stagedLogicalPath);
    const stagedArtifactPath = stagedSessionPath.slice(0, -".jsonl".length);
    await fs.mkdir(hostPathApi(installation, hostDataDirOverride !== undefined).dirname(stagedSessionPath), { recursive: true });
    await fs.rename(sourceHostPath, stagedSessionPath);
    try {
      if (hasArtifacts) await fs.rename(sourceArtifactPath, stagedArtifactPath);
    } catch (error) {
      try {
        await fs.rename(stagedSessionPath, sourceHostPath);
        await fs.rm(stagingRoot, { recursive: true, force: true });
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Failed to stage OMP artifacts and restore the session file");
      }
      throw error;
    }

    await fs.rm(stagingRoot, { recursive: true, force: false });
    cache.delete(logicalPathCacheKey(installation, sourceLogicalPath));
    this.#store.deleteSession(this.#installationKey(installation), sourceLogicalPath);
    return {
      deletedPath: sourceLogicalPath,
      deletedArtifactPath: hasArtifacts ? sourceLogicalPath.slice(0, -".jsonl".length) : undefined,
    };
  }
}
