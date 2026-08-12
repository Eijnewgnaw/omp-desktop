import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MetadataStore } from "../src/main/metadata-store";
import { parseSessionPrefix, SessionIndex } from "../src/main/session-index";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("session indexing", () => {
  it("parses the fixed title slot and session header", () => {
    const parsed = parseSessionPrefix(
      `${JSON.stringify({ type: "title", title: "桌面客户端" })}\n${JSON.stringify({
        type: "session",
        version: 3,
        id: "session-id",
        timestamp: "2026-08-12T00:00:00.000Z",
        cwd: "/work/demo",
        title: "fallback",
      })}\n`,
    );
    expect(parsed?.title).toBe("桌面客户端");
    expect(parsed?.header.cwd).toBe("/work/demo");
  });

  it("indexes sessions and applies local metadata without editing JSONL", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-session-"));
    temporaryDirectories.push(root);
    const bucket = path.join(root, "sessions", "abs-demo-hash");
    await fs.mkdir(bucket, { recursive: true });
    const sessionPath = path.join(bucket, "2026-08-12_session-id.jsonl");
    const original = `${JSON.stringify({ type: "title", title: "原始标题" })}\n${JSON.stringify({
      type: "session",
      version: 3,
      id: "session-id",
      timestamp: "2026-08-12T00:00:00.000Z",
      cwd: "/work/demo",
      title: "原始标题",
      titleSource: "auto",
    })}\n`;
    await fs.writeFile(sessionPath, original);
    const store = new MetadataStore(path.join(root, "metadata.sqlite3"));
    const index = new SessionIndex(store);
    const installation = {
      distro: "direct",
      executablePath: "/usr/bin/omp",
      version: "17.2.12",
      agentDir: root,
      direct: true,
    };
    const [session] = await index.list(installation);
    expect(session?.title).toBe("原始标题");
    if (!session) throw new Error("Fixture session was not indexed");
    const updated = index.update(installation, session.path, { displayTitle: "桌面别名", pinned: true });
    expect(updated.title).toBe("桌面别名");
    expect(updated.pinned).toBe(true);
    expect(await fs.readFile(sessionPath, "utf8")).toBe(original);
    store.close();
  });

  it("moves a session and its artifact directory into the recoverable app trash", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-trash-"));
    temporaryDirectories.push(root);
    const bucket = path.join(root, "sessions", "abs-demo-hash");
    await fs.mkdir(bucket, { recursive: true });
    const sessionPath = path.join(bucket, "2026-08-12_session-id.jsonl");
    const artifactPath = sessionPath.slice(0, -".jsonl".length);
    const content = `${JSON.stringify({
      type: "session",
      id: "session-id",
      timestamp: "2026-08-12T00:00:00.000Z",
      cwd: "/work/demo",
    })}\n`;
    await fs.writeFile(sessionPath, content);
    await fs.mkdir(artifactPath);
    await fs.writeFile(path.join(artifactPath, "result.txt"), "kept");
    const unrelated = path.join(root, "do-not-touch.txt");
    await fs.writeFile(unrelated, "safe");

    const store = new MetadataStore(path.join(root, "metadata.sqlite3"));
    const index = new SessionIndex(store);
    const installation = {
      distro: "direct",
      executablePath: "/usr/bin/omp",
      version: "17.2.12",
      agentDir: root,
      direct: true,
    };
    await index.list(installation);
    const result = await index.trash(installation, sessionPath);

    await expect(fs.stat(sessionPath)).rejects.toThrow();
    await expect(fs.stat(artifactPath)).rejects.toThrow();
    expect(await fs.readFile(result.trashPath, "utf8")).toBe(content);
    expect(result.artifactTrashPath).toBeDefined();
    expect(await fs.readFile(path.join(result.artifactTrashPath!, "result.txt"), "utf8")).toBe("kept");
    expect(await fs.readFile(unrelated, "utf8")).toBe("safe");
    expect(await index.list(installation)).toEqual([]);
    store.close();
  });

  it("refuses to move files outside the installation session root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-trash-boundary-"));
    temporaryDirectories.push(root);
    await fs.mkdir(path.join(root, "sessions"), { recursive: true });
    const outside = path.join(root, "outside.jsonl");
    await fs.writeFile(outside, "{}\n");
    const store = new MetadataStore(path.join(root, "metadata.sqlite3"));
    const index = new SessionIndex(store);
    const installation = {
      distro: "direct",
      executablePath: "/usr/bin/omp",
      version: "17.2.12",
      agentDir: root,
      direct: true,
    };

    await expect(index.trash(installation, outside)).rejects.toThrow("outside the OMP sessions directory");
    expect(await fs.readFile(outside, "utf8")).toBe("{}\n");
    store.close();
  });

  it("refuses an adjacent artifact path that is not a directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-trash-artifact-"));
    temporaryDirectories.push(root);
    const bucket = path.join(root, "sessions", "abs-demo-hash");
    await fs.mkdir(bucket, { recursive: true });
    const sessionPath = path.join(bucket, "2026-08-12_session-id.jsonl");
    const artifactPath = sessionPath.slice(0, -".jsonl".length);
    const content = `${JSON.stringify({
      type: "session",
      id: "session-id",
      timestamp: "2026-08-12T00:00:00.000Z",
      cwd: "/work/demo",
    })}\n`;
    await fs.writeFile(sessionPath, content);
    await fs.writeFile(artifactPath, "unexpected sibling file");
    const store = new MetadataStore(path.join(root, "metadata.sqlite3"));
    const index = new SessionIndex(store);
    const installation = {
      distro: "direct",
      executablePath: "/usr/bin/omp",
      version: "17.2.12",
      agentDir: root,
      direct: true,
    };
    await index.list(installation);

    await expect(index.trash(installation, sessionPath)).rejects.toThrow("artifacts must be a directory");
    expect(await fs.readFile(sessionPath, "utf8")).toBe(content);
    expect(await fs.readFile(artifactPath, "utf8")).toBe("unexpected sibling file");
    store.close();
  });

  it("permanently deletes only the indexed JSONL and its artifact directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-delete-"));
    temporaryDirectories.push(root);
    const bucket = path.join(root, "sessions", "abs-demo-hash");
    await fs.mkdir(bucket, { recursive: true });
    const sessionPath = path.join(bucket, "2026-08-12_delete-me.jsonl");
    const artifactPath = sessionPath.slice(0, -".jsonl".length);
    await fs.writeFile(sessionPath, `${JSON.stringify({
      type: "session",
      id: "delete-me",
      timestamp: "2026-08-12T00:00:00.000Z",
      cwd: "/work/delete-me",
    })}\n`);
    await fs.mkdir(artifactPath);
    await fs.writeFile(path.join(artifactPath, "attachment.txt"), "delete me too");
    const unrelated = path.join(bucket, "keep.txt");
    await fs.writeFile(unrelated, "safe");
    const store = new MetadataStore(path.join(root, "metadata.sqlite3"));
    const index = new SessionIndex(store);
    const installation = {
      distro: "direct",
      executablePath: "/usr/bin/omp",
      version: "17.2.12",
      agentDir: root,
      direct: true,
    };
    const [indexed] = await index.list(installation);
    if (!indexed) throw new Error("Fixture session was not indexed");
    index.update(installation, indexed.path, { pinned: true });

    const result = await index.deletePermanently(installation, sessionPath);

    expect(result).toEqual({ deletedPath: sessionPath, deletedArtifactPath: artifactPath });
    await expect(fs.lstat(sessionPath)).rejects.toThrow();
    await expect(fs.lstat(artifactPath)).rejects.toThrow();
    expect(await fs.readFile(unrelated, "utf8")).toBe("safe");
    const installationKey = JSON.stringify([
      "direct",
      installation.distro,
      installation.executablePath,
      installation.agentDir,
    ]);
    expect(store.getSessionMetadata(installationKey, [sessionPath]).size).toBe(0);
    expect(await index.list(installation)).toEqual([]);
    store.close();
  });

  it("refuses to permanently delete outside the session root or through a symlink", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-delete-boundary-"));
    temporaryDirectories.push(root);
    const bucket = path.join(root, "sessions", "abs-demo-hash");
    await fs.mkdir(bucket, { recursive: true });
    const outside = path.join(root, "outside.jsonl");
    await fs.writeFile(outside, "outside\n");
    const sessionPath = path.join(bucket, "2026-08-12_link.jsonl");
    await fs.symlink(outside, sessionPath);
    const store = new MetadataStore(path.join(root, "metadata.sqlite3"));
    const index = new SessionIndex(store);
    const installation = {
      distro: "direct",
      executablePath: "/usr/bin/omp",
      version: "17.2.12",
      agentDir: root,
      direct: true,
    };

    await expect(index.deletePermanently(installation, outside)).rejects.toThrow("outside the OMP sessions directory");
    await expect(index.deletePermanently(installation, sessionPath)).rejects.toThrow("indexed");
    expect(await fs.readFile(outside, "utf8")).toBe("outside\n");
    store.close();
  });

  it("never authorizes a mutation from another OMP installation cache", async () => {
    const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-install-a-"));
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-install-b-"));
    temporaryDirectories.push(rootA, rootB);
    const bucket = path.join(rootA, "sessions", "same-project");
    await fs.mkdir(bucket, { recursive: true });
    const sessionPath = path.join(bucket, "same-session.jsonl");
    await fs.writeFile(sessionPath, `${JSON.stringify({
      type: "session",
      id: "same-session",
      timestamp: "2026-08-12T00:00:00.000Z",
      cwd: "/work/same",
    })}\n`);
    const store = new MetadataStore(path.join(rootA, "metadata.sqlite3"));
    const index = new SessionIndex(store);
    const installationA = {
      distro: "Ubuntu",
      executablePath: "/usr/bin/omp",
      version: "17.2.12",
      agentDir: rootA,
      direct: true,
    };
    const installationB = { ...installationA, distro: "Debian", agentDir: rootB };
    await index.list(installationA);

    expect(() => index.update(installationB, sessionPath, { pinned: true })).toThrow(
      "Session must be indexed before it can be updated",
    );
    expect(await fs.readFile(sessionPath, "utf8")).toContain("same-session");
    store.close();
  });

  it("isolates metadata for identical session paths across installations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-metadata-scope-"));
    temporaryDirectories.push(root);
    const store = new MetadataStore(path.join(root, "metadata.sqlite3"));
    const summary = {
      id: "shared-id",
      path: "/home/user/.omp/agent/sessions/shared/session.jsonl",
      cwd: "/work/shared",
      title: "Original",
      createdAt: "2026-08-12T00:00:00.000Z",
      modifiedAt: "2026-08-12T00:00:00.000Z",
      size: 100,
      projectName: "shared",
      pinned: false,
      archived: false,
      tags: [],
    };

    store.updateSession("wsl:Ubuntu", summary, { displayTitle: "Ubuntu title", pinned: true });
    expect(store.getSessionMetadata("wsl:Debian", [summary.path]).size).toBe(0);
    store.updateSession("wsl:Debian", summary, { displayTitle: "Debian title", archived: true });

    store.deleteSession("wsl:Ubuntu", summary.path);

    expect(store.getSessionMetadata("wsl:Ubuntu", [summary.path]).size).toBe(0);
    const debian = store.getSessionMetadata("wsl:Debian", [summary.path]).get(summary.path);
    expect(store.applyMetadata(summary, debian)).toMatchObject({
      title: "Debian title",
      pinned: false,
      archived: true,
    });
    store.close();
  });

  it("migrates legacy metadata without losing it or sharing it across installations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-metadata-migration-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "metadata.sqlite3");
    const sessionPath = "/home/user/.omp/agent/sessions/shared/legacy.jsonl";
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE session_metadata (
        session_path TEXT PRIMARY KEY,
        display_title TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        tags_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );
    `);
    legacy
      .prepare(`
        INSERT INTO session_metadata
          (session_path, display_title, pinned, archived, tags_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(sessionPath, "Legacy title", 1, 0, JSON.stringify(["legacy"]), "2026-08-12T00:00:00.000Z");
    legacy.close();

    const store = new MetadataStore(databasePath);
    const migrated = store.getSessionMetadata("wsl:Ubuntu", [sessionPath]).get(sessionPath);

    expect(migrated).toMatchObject({
      session_path: sessionPath,
      display_title: "Legacy title",
      pinned: 1,
      archived: 0,
      tags_json: JSON.stringify(["legacy"]),
    });
    expect(store.getSessionMetadata("wsl:Debian", [sessionPath]).size).toBe(0);
    store.close();

    const reopened = new MetadataStore(databasePath);
    expect(reopened.getSessionMetadata("wsl:Ubuntu", [sessionPath]).get(sessionPath)).toMatchObject({
      display_title: "Legacy title",
      pinned: 1,
      tags_json: JSON.stringify(["legacy"]),
    });
    expect(reopened.getSessionMetadata("wsl:Debian", [sessionPath]).size).toBe(0);
    reopened.close();
  });
});
