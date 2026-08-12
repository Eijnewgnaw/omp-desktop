import Database from "better-sqlite3";
import type {
  AppSettings,
  OmpInstallation,
  SessionMetadataPatch,
  SessionSummary,
} from "../shared/contracts";
import { installationMetadataKey } from "./security";

interface SessionMetadataRow {
  session_path: string;
  display_title: string | null;
  pinned: number;
  archived: number;
  tags_json: string;
}

const legacyInstallationKey = "__omp_desktop_legacy_unscoped__";

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
    `);
    this.#ensureSessionMetadataSchema();
  }

  #createSessionMetadataTable(): void {
    this.#db.exec(`
      CREATE TABLE session_metadata (
        installation_key TEXT NOT NULL,
        session_path TEXT NOT NULL,
        display_title TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        tags_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (installation_key, session_path)
      );
    `);
  }

  #ensureSessionMetadataSchema(): void {
    const table = this.#db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_metadata'")
      .get();
    if (!table) {
      this.#createSessionMetadataTable();
      return;
    }

    const columns = this.#db.pragma("table_info(session_metadata)") as Array<{ name: string }>;
    if (columns.some(column => column.name === "installation_key")) return;

    // V1 metadata cannot identify its originating installation. Preserve each row
    // under a legacy key until the Alpha settings identify its unique owner, so
    // aliases/pins survive without leaking to whichever backend happens to list first.
    const migrate = this.#db.transaction(() => {
      this.#db.exec("ALTER TABLE session_metadata RENAME TO session_metadata_v1");
      this.#createSessionMetadataTable();
      this.#db
        .prepare(`
          INSERT INTO session_metadata
            (installation_key, session_path, display_title, pinned, archived, tags_json, updated_at)
          SELECT ?, session_path, display_title, pinned, archived, tags_json, updated_at
          FROM session_metadata_v1
        `)
        .run(legacyInstallationKey);
      this.#db.exec("DROP TABLE session_metadata_v1");
    });
    migrate();
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

  writeSettings(patch: Partial<AppSettings>): void {
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
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.writeSettings(patch);
    return this.getSettings();
  }

  #isLegacyMetadataOwner(
    installationKey: string,
    installation: OmpInstallation | undefined,
  ): boolean {
    if (!installation || installation.profile !== undefined) return false;
    if (installationMetadataKey(installation) !== installationKey) return false;
    const settings = this.getSettings();
    if (!settings.selectedDistro || !settings.selectedInstallationPath) return false;
    if (installation.executablePath !== settings.selectedInstallationPath) return false;

    // These deprecated fields are the provenance written by pre-v0.1.0 builds.
    // selectedInstallationId is deliberately ignored because it is a mutable
    // current UI selection and cannot prove who originally owned an unscoped row.
    if (installation.kind === "wsl") return installation.distro === settings.selectedDistro;
    return installation.kind === "linux-direct" && settings.selectedDistro === "direct";
  }

  getSessionMetadata(
    installationKey: string,
    paths: string[],
    legacyClaimant?: OmpInstallation,
    pathAliases: ReadonlyMap<string, string> = new Map(),
  ): Map<string, SessionMetadataRow> {
    const result = new Map<string, SessionMetadataRow>();
    if (paths.length === 0) return result;
    const query = this.#db.prepare(`
      SELECT session_path, display_title, pinned, archived, tags_json
      FROM session_metadata
      WHERE installation_key = ? AND session_path = ?
    `);
    const claimLegacyRow = this.#db.prepare(`
      UPDATE OR IGNORE session_metadata
      SET installation_key = ?, session_path = ?
      WHERE installation_key = ? AND session_path = ?
    `);
    const migrateScopedAlias = this.#db.prepare(`
      UPDATE OR IGNORE session_metadata
      SET session_path = ?
      WHERE installation_key = ? AND session_path = ?
    `);
    const currentPaths = new Set(paths);
    const aliasUseCount = new Map<string, number>();
    for (const currentPath of currentPaths) {
      const alias = pathAliases.get(currentPath);
      if (alias) aliasUseCount.set(alias, (aliasUseCount.get(alias) ?? 0) + 1);
    }
    const claimLegacy = this.#isLegacyMetadataOwner(installationKey, legacyClaimant);
    const read = this.#db.transaction(() => {
      for (const sessionPath of currentPaths) {
        let row = query.get(installationKey, sessionPath) as SessionMetadataRow | undefined;
        const alias = pathAliases.get(sessionPath);
        const aliasIsUnique = alias
          && alias !== sessionPath
          && !currentPaths.has(alias)
          && aliasUseCount.get(alias) === 1;
        if (!row) {
          if (aliasIsUnique) {
            // This is an in-scope path rebase, not an installation migration:
            // only a row under the exact same installation key is eligible.
            // UPDATE OR IGNORE makes an exact current row win even if one appears
            // before this transaction reaches the alias.
            migrateScopedAlias.run(sessionPath, installationKey, alias);
            row = query.get(installationKey, sessionPath) as SessionMetadataRow | undefined;
          }
        }
        if (!row && claimLegacy) {
          let legacyPath = sessionPath;
          let legacy = query.get(legacyInstallationKey, legacyPath) as SessionMetadataRow | undefined;
          if (!legacy && aliasIsUnique) {
            legacyPath = alias;
            legacy = query.get(legacyInstallationKey, legacyPath) as SessionMetadataRow | undefined;
          }
          if (legacy) {
            // Claim and rebase in one statement. UPDATE OR IGNORE preserves the
            // legacy row if an exact current row appears, and the re-read makes
            // that exact row authoritative.
            claimLegacyRow.run(installationKey, sessionPath, legacyInstallationKey, legacyPath);
            row = query.get(installationKey, sessionPath) as SessionMetadataRow | undefined;
          }
        }
        if (row) result.set(sessionPath, row);
      }
    });
    read();
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

  updateSession(
    installationKey: string,
    summary: SessionSummary,
    patch: SessionMetadataPatch,
    legacyClaimant?: OmpInstallation,
  ): SessionSummary {
    const current = this.getSessionMetadata(installationKey, [summary.path], legacyClaimant).get(summary.path);
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
          (installation_key, session_path, display_title, pinned, archived, tags_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(installation_key, session_path) DO UPDATE SET
          display_title = excluded.display_title,
          pinned = excluded.pinned,
          archived = excluded.archived,
          tags_json = excluded.tags_json,
          updated_at = excluded.updated_at
      `)
      .run(installationKey, summary.path, displayTitle, pinned, archived, JSON.stringify(tags), new Date().toISOString());
    const row = this.getSessionMetadata(installationKey, [summary.path], legacyClaimant).get(summary.path);
    return this.applyMetadata(summary, row);
  }

  deleteSession(installationKey: string, sessionPath: string): void {
    this.#db
      .prepare("DELETE FROM session_metadata WHERE installation_key = ? AND session_path = ?")
      .run(installationKey, sessionPath);
  }

  close(): void {
    this.#db.close();
  }
}
