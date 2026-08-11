import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { OmpInstallation, SessionSummary } from "../shared/contracts";
import { MetadataStore } from "./metadata-store";
import { wslPathToHostPath } from "./security";

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

export function parseSessionPrefix(content: string): { header: SessionHeader; title?: string } | null {
  const entries = content
    .split(/\r?\n/)
    .slice(0, 12)
    .map(line => parseJsonLine<Record<string, unknown>>(line))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  const header = entries.find(entry => entry.type === "session") as SessionHeader | undefined;
  if (!header?.id || !header.cwd) return null;
  const titleSlot = entries.find(entry => entry.type === "title") as TitleSlot | undefined;
  return { header, title: titleSlot?.title || header.title };
}

async function sessionFiles(directory: string): Promise<string[]> {
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
        const bucket = path.join(directory, entry.name);
        const files = await fs.readdir(bucket, { withFileTypes: true }).catch(() => []);
        for (const file of files) {
          if (file.isFile() && file.name.endsWith(".jsonl")) result.push(path.join(bucket, file.name));
        }
      }),
  );
  return result;
}

function toWslPath(hostRoot: string, wslRoot: string, hostFile: string): string {
  const relative = path.relative(hostRoot, hostFile).split(path.sep).join("/");
  return path.posix.join(wslRoot, relative);
}

export class SessionIndex {
  readonly #store: MetadataStore;
  readonly #cache = new Map<string, SessionSummary>();

  constructor(store: MetadataStore) {
    this.#store = store;
  }

  async list(installation: OmpInstallation, includeArchived = false): Promise<SessionSummary[]> {
    const wslRoot = path.posix.join(installation.agentDir, "sessions");
    const hostRoot = installation.direct
      ? path.resolve(installation.agentDir, "sessions")
      : wslPathToHostPath(installation.distro, wslRoot);
    const files = await sessionFiles(hostRoot);
    const sessionPathFor = (hostFile: string): string => installation.direct
      ? hostFile
      : toWslPath(hostRoot, wslRoot, hostFile);
    const metadata = this.#store.getSessionMetadata(files.map(sessionPathFor));
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
            const cwd = parsed.header.cwd ?? "/";
            const createdAt = parsed.header.timestamp ?? stat.birthtime.toISOString();
            const base: SessionSummary = {
              id: parsed.header.id ?? path.basename(hostFile, ".jsonl"),
              path: sessionPath,
              cwd,
              title: parsed.title?.trim() || `未命名会话 · ${new Date(createdAt).toLocaleString()}`,
              titleSource: parsed.header.titleSource,
              createdAt,
              modifiedAt: stat.mtime.toISOString(),
              size: stat.size,
              projectName: path.posix.basename(cwd) || cwd,
              pinned: false,
              archived: false,
              tags: [],
            };
            return this.#store.applyMetadata(base, metadata.get(sessionPath));
          } catch {
            return null;
          }
        }),
      )
    ).filter((summary): summary is SessionSummary => summary !== null);
    this.#cache.clear();
    for (const summary of summaries) this.#cache.set(summary.path, summary);
    return summaries
      .filter(summary => includeArchived || !summary.archived)
      .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.modifiedAt.localeCompare(left.modifiedAt));
  }

  update(pathValue: string, patch: Parameters<MetadataStore["updateSession"]>[1]): SessionSummary {
    const existing = this.#cache.get(pathValue);
    if (!existing) throw new Error("Session must be indexed before it can be updated");
    const updated = this.#store.updateSession(existing, patch);
    this.#cache.set(pathValue, updated);
    return updated;
  }
}
