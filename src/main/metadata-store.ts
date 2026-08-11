import Database from "better-sqlite3";
import type { AppSettings, SessionMetadataPatch, SessionSummary } from "../shared/contracts";

interface SessionMetadataRow {
  session_path: string;
  display_title: string | null;
  pinned: number;
  archived: number;
  tags_json: string;
}

const defaultSettings: AppSettings = {
  themeMode: "system",
};

export class MetadataStore {
  readonly #db: Database.Database;

  constructor(filePath: string) {
    this.#db = new Database(filePath);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("foreign_keys = ON");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_metadata (
        session_path TEXT PRIMARY KEY,
        display_title TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        tags_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );
    `);
  }

  getSettings(): AppSettings {
    const rows = this.#db.prepare("SELECT key, value_json FROM app_settings").all() as Array<{
      key: keyof AppSettings;
      value_json: string;
    }>;
    const settings: AppSettings = { ...defaultSettings };
    for (const row of rows) {
      try {
        Object.assign(settings, { [row.key]: JSON.parse(row.value_json) });
      } catch {
        // Ignore malformed local UI preferences and preserve safe defaults.
      }
    }
    return settings;
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const statement = this.#db.prepare(`
      INSERT INTO app_settings (key, value_json) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
    `);
    const transaction = this.#db.transaction(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        statement.run(key, JSON.stringify(value));
      }
    });
    transaction();
    return this.getSettings();
  }

  getSessionMetadata(paths: string[]): Map<string, SessionMetadataRow> {
    const result = new Map<string, SessionMetadataRow>();
    if (paths.length === 0) return result;
    const query = this.#db.prepare("SELECT * FROM session_metadata WHERE session_path = ?");
    for (const sessionPath of paths) {
      const row = query.get(sessionPath) as SessionMetadataRow | undefined;
      if (row) result.set(sessionPath, row);
    }
    return result;
  }

  applyMetadata(summary: SessionSummary, row?: SessionMetadataRow): SessionSummary {
    if (!row) return summary;
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(row.tags_json) as unknown;
      if (Array.isArray(parsed)) tags = parsed.filter(value => typeof value === "string");
    } catch {
      tags = [];
    }
    return {
      ...summary,
      title: row.display_title || summary.title,
      pinned: row.pinned === 1,
      archived: row.archived === 1,
      tags,
    };
  }

  updateSession(summary: SessionSummary, patch: SessionMetadataPatch): SessionSummary {
    const current = this.getSessionMetadata([summary.path]).get(summary.path);
    const displayTitle = patch.displayTitle === undefined ? current?.display_title ?? null : patch.displayTitle;
    const pinned = patch.pinned === undefined ? current?.pinned ?? 0 : Number(patch.pinned);
    const archived = patch.archived === undefined ? current?.archived ?? 0 : Number(patch.archived);
    const tags = patch.tags ?? (() => {
      try {
        return current ? (JSON.parse(current.tags_json) as string[]) : [];
      } catch {
        return [];
      }
    })();
    this.#db
      .prepare(`
        INSERT INTO session_metadata
          (session_path, display_title, pinned, archived, tags_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_path) DO UPDATE SET
          display_title = excluded.display_title,
          pinned = excluded.pinned,
          archived = excluded.archived,
          tags_json = excluded.tags_json,
          updated_at = excluded.updated_at
      `)
      .run(summary.path, displayTitle, pinned, archived, JSON.stringify(tags), new Date().toISOString());
    const row = this.getSessionMetadata([summary.path]).get(summary.path);
    return this.applyMetadata(summary, row);
  }

  close(): void {
    this.#db.close();
  }
}
