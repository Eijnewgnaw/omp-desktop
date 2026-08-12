import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OmpInstallation, SessionSummary } from "../src/shared/contracts";
import { MetadataStore } from "../src/main/metadata-store";
import { containedLogicalRelativePath, parseSessionPrefix, SessionIndex } from "../src/main/session-index";
import { installationMetadataKey } from "../src/main/security";

const temporaryDirectories: string[] = [];

function directInstallation(root: string, id = `linux-direct:${root}`): OmpInstallation {
  return {
    id,
    kind: "linux-direct",
    label: "Linux · Direct",
    executablePath: "/usr/bin/omp",
    version: "17.2.12",
    agentDir: root,
  };
}

function nativeInstallation(agentDir = "C:\\Users\\Alice\\.omp\\agent", id = "windows-native:fixture"): OmpInstallation {
  return {
    id,
    kind: "windows-native",
    label: "Windows (native)",
    executablePath: "C:\\Users\\Alice\\.local\\bin\\omp.exe",
    version: "17.2.12",
    agentDir,
  };
}

function metadataSummary(
  sessionPath: string,
  installationId = "linux-direct:metadata",
): SessionSummary {
  return {
    id: path.basename(sessionPath, ".jsonl"),
    installationId,
    runtimeKind: "linux-direct",
    runtimeLabel: "Linux · Direct",
    path: sessionPath,
    cwd: "/work/metadata",
    title: "Original",
    createdAt: "2026-08-12T00:00:00.000Z",
    modifiedAt: "2026-08-12T00:00:00.000Z",
    size: 100,
    projectName: "metadata",
    pinned: false,
    archived: false,
    tags: [],
  };
}

function wslDefaultInstallation(distro: string): OmpInstallation {
  return {
    id: `wsl:${distro}`,
    kind: "wsl",
    label: `WSL · ${distro}`,
    distro,
    executablePath: "/usr/bin/omp",
    version: "17.2.12",
    agentDir: "/home/user/.omp/agent",
  };
}

function createLegacyMetadataDatabase(databasePath: string, sessionPaths: string | readonly string[]): void {
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
  const insert = legacy.prepare(`
      INSERT INTO session_metadata
        (session_path, display_title, pinned, archived, tags_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
  for (const sessionPath of typeof sessionPaths === "string" ? [sessionPaths] : sessionPaths) {
    insert.run(sessionPath, "Legacy title", 1, 0, JSON.stringify(["legacy"]), "2026-08-12T00:00:00.000Z");
  }
  legacy.close();
}

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
    const installation = directInstallation(root);
    const [session] = await index.list(installation);
    expect(session?.title).toBe("原始标题");
    expect(session).toMatchObject({
      installationId: installation.id,
      runtimeKind: "linux-direct",
      runtimeLabel: installation.label,
    });
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
    const installation = directInstallation(root);
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
    const installation = directInstallation(root);

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
    const installation = directInstallation(root);
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
    const installation = directInstallation(root);
    const [indexed] = await index.list(installation);
    if (!indexed) throw new Error("Fixture session was not indexed");
    index.update(installation, indexed.path, { pinned: true });

    const result = await index.deletePermanently(installation, sessionPath);

    expect(result).toEqual({ deletedPath: sessionPath, deletedArtifactPath: artifactPath });
    await expect(fs.lstat(sessionPath)).rejects.toThrow();
    await expect(fs.lstat(artifactPath)).rejects.toThrow();
    expect(await fs.readFile(unrelated, "utf8")).toBe("safe");
    const installationKey = installationMetadataKey(installation);
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
    const installation = directInstallation(root);

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
    const installationA = directInstallation(rootA, "linux-direct:a");
    const installationB = directInstallation(rootB, "linux-direct:b");
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
      installationId: "wsl:Ubuntu",
      runtimeKind: "wsl" as const,
      runtimeLabel: "WSL · Ubuntu",
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

  it("migrates only a unique scoped path alias while current rows and other installations win", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-metadata-alias-"));
    temporaryDirectories.push(root);
    const store = new MetadataStore(path.join(root, "metadata.sqlite3"));
    const installationKey = "linux-direct:work";
    const otherInstallationKey = "linux-direct:other";
    const oldPath = "/home/me/.omp/profiles/work/agent/sessions/project/session.jsonl";
    const currentPath = "/home/me/.local/share/omp/profiles/work/sessions/project/session.jsonl";
    const aliases = new Map([[currentPath, oldPath]]);

    store.updateSession(installationKey, metadataSummary(oldPath), {
      displayTitle: "Old scoped title",
      pinned: true,
    });
    store.updateSession(installationKey, metadataSummary(currentPath), {
      displayTitle: "Current title",
      archived: true,
    });

    const current = store.getSessionMetadata(installationKey, [currentPath], undefined, aliases).get(currentPath);
    expect(store.applyMetadata(metadataSummary(currentPath), current)).toMatchObject({
      title: "Current title",
      pinned: false,
      archived: true,
    });
    expect(store.getSessionMetadata(installationKey, [oldPath]).get(oldPath)).toMatchObject({
      display_title: "Old scoped title",
    });

    const otherCurrent = "/other/data/sessions/project/session.jsonl";
    expect(store.getSessionMetadata(
      otherInstallationKey,
      [otherCurrent],
      undefined,
      new Map([[otherCurrent, oldPath]]),
    ).size).toBe(0);
    expect(store.getSessionMetadata(installationKey, [oldPath]).size).toBe(1);

    const ambiguousA = "/data/sessions/project/a.jsonl";
    const ambiguousB = "/data/sessions/project/b.jsonl";
    const ambiguousOld = "/config/agent/sessions/project/shared.jsonl";
    store.updateSession(installationKey, metadataSummary(ambiguousOld), { tags: ["do-not-guess"] });
    expect(store.getSessionMetadata(
      installationKey,
      [ambiguousA, ambiguousB],
      undefined,
      new Map([[ambiguousA, ambiguousOld], [ambiguousB, ambiguousOld]]),
    ).size).toBe(0);
    expect(store.getSessionMetadata(installationKey, [ambiguousOld]).size).toBe(1);
    store.close();
  });

  it("isolates metadata for the same native runtime and path across default and named profiles", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-profile-metadata-"));
    temporaryDirectories.push(root);
    const store = new MetadataStore(path.join(root, "metadata.sqlite3"));
    const defaultInstallation = nativeInstallation();
    const workInstallation: OmpInstallation = {
      ...defaultInstallation,
      id: "windows-native:work",
      label: "Windows (native) · work",
      profile: "work",
    };
    const summary = {
      id: "shared-id",
      path: "C:\\Users\\Alice\\.omp\\agent\\sessions\\shared\\session.jsonl",
      cwd: "C:\\Work\\shared",
      title: "Original",
      createdAt: "2026-08-12T00:00:00.000Z",
      modifiedAt: "2026-08-12T00:00:00.000Z",
      size: 100,
      projectName: "shared",
      pinned: false,
      archived: false,
      tags: [],
      installationId: defaultInstallation.id,
      runtimeKind: "windows-native" as const,
      runtimeLabel: defaultInstallation.label,
    };
    const defaultKey = installationMetadataKey(defaultInstallation);
    const workKey = installationMetadataKey(workInstallation);
    expect(defaultKey).not.toBe(workKey);

    store.updateSession(defaultKey, summary, { displayTitle: "Default title", pinned: true });
    store.updateSession(workKey, { ...summary, installationId: workInstallation.id }, {
      displayTitle: "Work title",
      archived: true,
    });

    expect(store.applyMetadata(summary, store.getSessionMetadata(defaultKey, [summary.path]).get(summary.path))).toMatchObject({
      title: "Default title",
      pinned: true,
      archived: false,
    });
    expect(store.applyMetadata(summary, store.getSessionMetadata(workKey, [summary.path]).get(summary.path))).toMatchObject({
      title: "Work title",
      pinned: false,
      archived: true,
    });
    store.close();
  });

  it("uses case-insensitive Win32 containment without accepting an adjacent directory", () => {
    const installation = { kind: "windows-native" } as const;
    const root = "C:\\Users\\Alice\\.omp\\agent\\sessions";

    expect(
      containedLogicalRelativePath(
        installation,
        root,
        "c:\\users\\ALICE\\.omp\\agent\\sessions\\project\\session.jsonl",
      ),
    ).toBe("project\\session.jsonl");
    expect(() =>
      containedLogicalRelativePath(
        installation,
        root,
        "C:\\Users\\Alice\\.omp\\agent\\sessions-adjacent\\session.jsonl",
      ),
    ).toThrow("outside the OMP sessions directory");
  });

  it("indexes native sessions with Win32 title, cwd, project name, and isolated rename metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-native-index-"));
    temporaryDirectories.push(root);
    const hostBucket = path.join(root, "sessions", "native-project");
    const workHostRoot = path.join(root, "work-profile");
    const workHostBucket = path.join(workHostRoot, "sessions", "native-project");
    await fs.mkdir(hostBucket, { recursive: true });
    await fs.mkdir(workHostBucket, { recursive: true });
    const hostSessionPath = path.join(hostBucket, "session.jsonl");
    const workHostSessionPath = path.join(workHostBucket, "session.jsonl");
    const original = `${JSON.stringify({ type: "title", title: "Native original" })}\n${JSON.stringify({
      type: "session",
      id: "native-session",
      timestamp: "2026-08-12T00:00:00.000Z",
      cwd: "C:\\Work\\Native Project",
      titleSource: "auto",
    })}\n`;
    await fs.writeFile(hostSessionPath, original);
    await fs.writeFile(workHostSessionPath, `${JSON.stringify({ type: "title", title: "Work original" })}\n${JSON.stringify({
      type: "session",
      id: "native-work-session",
      timestamp: "2026-08-12T00:00:00.000Z",
      cwd: "C:\\Work\\Profile Project",
    })}\n`);
    const store = new MetadataStore(path.join(root, "metadata.sqlite3"));
    const index = new SessionIndex(store);
    const installation = nativeInstallation("C:\\Users\\Alice\\.omp\\agent", "windows-native:a");
    const otherInstallation: OmpInstallation = {
      ...nativeInstallation("C:\\Users\\Alice\\.omp-work\\agent", "windows-native:work"),
      label: "Windows (native) · work",
      profile: "work",
    };
    const logicalPath = "C:\\Users\\Alice\\.omp\\agent\\sessions\\native-project\\session.jsonl";
    const workLogicalPath = "C:\\Users\\Alice\\.omp-work\\agent\\sessions\\native-project\\session.jsonl";

    try {
      const [session] = await index.list(installation, false, path.join(root, "sessions"));
      expect(session).toMatchObject({
        id: "native-session",
        path: logicalPath,
        cwd: "C:\\Work\\Native Project",
        title: "Native original",
        projectName: "Native Project",
        installationId: installation.id,
        runtimeKind: "windows-native",
        runtimeLabel: installation.label,
      });
      expect(session?.profile).toBeUndefined();
      if (!session) throw new Error("Native fixture was not indexed");
      const [workSession] = await index.list(otherInstallation, false, path.join(workHostRoot, "sessions"));
      expect(workSession).toMatchObject({
        path: workLogicalPath,
        title: "Work original",
        projectName: "Profile Project",
        installationId: otherInstallation.id,
        profile: "work",
      });
      expect(index.update(installation, logicalPath.toLowerCase(), { displayTitle: "Native renamed" }).title).toBe(
        "Native renamed",
      );
      expect(index.update(otherInstallation, workLogicalPath, { pinned: true })).toMatchObject({
        title: "Work original",
        pinned: true,
      });
      expect(() => index.update(otherInstallation, logicalPath, { displayTitle: "Must not leak" })).toThrow("indexed");
      expect(await fs.readFile(hostSessionPath, "utf8")).toBe(original);
      expect(installationMetadataKey(installation)).not.toBe(installationMetadataKey(otherInstallation));
      expect(store.getSessionMetadata(installationMetadataKey(otherInstallation), [logicalPath]).size).toBe(0);
      expect(store.getSessionMetadata(installationMetadataKey(installation), [workLogicalPath]).size).toBe(0);
    } finally {
      store.close();
    }
  });

  it("moves and permanently deletes native sessions with only their adjacent artifact directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-native-mutations-"));
    temporaryDirectories.push(root);
    const hostBucket = path.join(root, "sessions", "native-project");
    await fs.mkdir(hostBucket, { recursive: true });
    const installation: OmpInstallation = {
      ...nativeInstallation("C:\\Users\\Alice\\.omp-work\\agent", "windows-native:work"),
      label: "Windows (native) · work",
      profile: "work",
    };
    const store = new MetadataStore(path.join(root, "metadata.sqlite3"));
    const index = new SessionIndex(store);
    const firstHostPath = path.join(hostBucket, "trash.jsonl");
    const firstLogicalPath = `${installation.agentDir}\\sessions\\native-project\\trash.jsonl`;
    const secondHostPath = path.join(hostBucket, "delete.jsonl");
    const secondLogicalPath = `${installation.agentDir}\\sessions\\native-project\\delete.jsonl`;
    const unrelated = path.join(hostBucket, "keep.txt");
    await fs.writeFile(firstHostPath, `${JSON.stringify({ type: "session", id: "trash", cwd: "C:\\Work\\One" })}\n`);
    await fs.mkdir(firstHostPath.slice(0, -6));
    await fs.writeFile(path.join(firstHostPath.slice(0, -6), "artifact.txt"), "first artifact");
    await fs.writeFile(secondHostPath, `${JSON.stringify({ type: "session", id: "delete", cwd: "C:\\Work\\Two" })}\n`);
    await fs.mkdir(secondHostPath.slice(0, -6));
    await fs.writeFile(path.join(secondHostPath.slice(0, -6), "artifact.txt"), "second artifact");
    await fs.writeFile(unrelated, "safe");

    const originalStat = fs.stat.bind(fs);
    try {
      await index.list(installation, false, path.join(root, "sessions"));
      expect(await originalStat(hostBucket)).toBeDefined();
      const trashResult = await index.trash(installation, firstLogicalPath.toLowerCase(), root);
      expect(trashResult.originalPath).toBe(firstLogicalPath);
      expect(trashResult.trashPath).toMatch(/^C:\\Users\\Alice\\\.omp-work\\agent\\trash\\omp-desktop\\/u);
      await expect(originalStat(firstHostPath)).rejects.toThrow();
      expect(await originalStat(path.join(root, "trash"))).toBeDefined();

      await index.list(installation, false, path.join(root, "sessions"));
      const deleteResult = await index.deletePermanently(installation, secondLogicalPath.toLowerCase(), root);
      expect(deleteResult).toEqual({
        deletedPath: secondLogicalPath,
        deletedArtifactPath: secondLogicalPath.slice(0, -6),
      });
      await expect(originalStat(secondHostPath)).rejects.toThrow();
      await expect(originalStat(secondHostPath.slice(0, -6))).rejects.toThrow();
      expect(await fs.readFile(unrelated, "utf8")).toBe("safe");
    } finally {
      store.close();
    }
  });

  it.runIf(process.platform !== "win32")(
    "isolates WSL default and named-profile sessions, metadata, trash, and permanent deletion",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-wsl-profiles-"));
      temporaryDirectories.push(root);
      const defaultAgentDir = path.join(root, "default-agent");
      const workAgentDir = path.join(root, "work-agent");
      const defaultSessionPath = path.join(defaultAgentDir, "sessions", "same-project", "session.jsonl");
      const workSessionPath = path.join(workAgentDir, "sessions", "same-project", "session.jsonl");
      await fs.mkdir(path.dirname(defaultSessionPath), { recursive: true });
      await fs.mkdir(path.dirname(workSessionPath), { recursive: true });
      await fs.writeFile(defaultSessionPath, `${JSON.stringify({ type: "title", title: "Default session" })}\n${JSON.stringify({
        type: "session",
        id: "default-session",
        cwd: "/work/default",
      })}\n`);
      await fs.writeFile(workSessionPath, `${JSON.stringify({ type: "title", title: "Work session" })}\n${JSON.stringify({
        type: "session",
        id: "work-session",
        cwd: "/work/profile",
      })}\n`);
      await fs.mkdir(defaultSessionPath.slice(0, -6));
      await fs.mkdir(workSessionPath.slice(0, -6));
      await fs.writeFile(path.join(defaultSessionPath.slice(0, -6), "artifact.txt"), "default artifact");
      await fs.writeFile(path.join(workSessionPath.slice(0, -6), "artifact.txt"), "work artifact");

      const base = {
        kind: "wsl" as const,
        distro: "Ubuntu",
        executablePath: "/usr/bin/omp",
        version: "17.2.12",
      };
      const defaultInstallation: OmpInstallation = {
        ...base,
        id: "wsl:default",
        label: "Ubuntu (WSL)",
        agentDir: defaultAgentDir,
      };
      const workInstallation: OmpInstallation = {
        ...base,
        id: "wsl:work",
        label: "Ubuntu (WSL) · work",
        profile: "work",
        agentDir: workAgentDir,
      };
      const store = new MetadataStore(path.join(root, "metadata.sqlite3"));
      const index = new SessionIndex(store);
      try {
        const [defaultSession] = await index.list(defaultInstallation);
        const [workSession] = await index.list(workInstallation);
        expect(defaultSession).toMatchObject({ title: "Default session", installationId: "wsl:default" });
        expect(defaultSession?.profile).toBeUndefined();
        expect(workSession).toMatchObject({ title: "Work session", installationId: "wsl:work", profile: "work" });
        if (!defaultSession || !workSession) throw new Error("Profile fixtures were not indexed");

        expect(index.update(defaultInstallation, defaultSession.path, { displayTitle: "Renamed default" })).toMatchObject({
          title: "Renamed default",
        });
        expect(index.update(workInstallation, workSession.path, { pinned: true })).toMatchObject({
          title: "Work session",
          pinned: true,
        });
        expect(installationMetadataKey(defaultInstallation)).not.toBe(installationMetadataKey(workInstallation));
        expect(() => index.update(defaultInstallation, workSession.path, { archived: true })).toThrow("indexed");
        expect(() => index.update(workInstallation, defaultSession.path, { archived: true })).toThrow("indexed");

        const trashed = await index.trash(defaultInstallation, defaultSession.path);
        expect(trashed.trashPath).toContain(`${defaultAgentDir}/trash/omp-desktop/`);
        await expect(fs.stat(defaultSessionPath)).rejects.toThrow();
        expect(await fs.readFile(workSessionPath, "utf8")).toContain("Work session");

        const deleted = await index.deletePermanently(workInstallation, workSession.path);
        expect(deleted.deletedPath).toBe(workSessionPath);
        await expect(fs.stat(workSessionPath)).rejects.toThrow();
        await expect(fs.stat(workSessionPath.slice(0, -6))).rejects.toThrow();
        expect(await fs.stat(trashed.trashPath)).toBeDefined();
      } finally {
        store.close();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves scoped rename, pin, archive, and tags when sessions move to the XDG data root",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-xdg-metadata-rebase-"));
      temporaryDirectories.push(root);
      const databasePath = path.join(root, "metadata.sqlite3");
      const configAgentDir = path.join(root, "home", ".omp", "profiles", "work", "agent");
      const dataDir = path.join(root, "data", "omp", "profiles", "work");
      const relativeParts = ["project", "session.jsonl"];
      const oldPath = path.join(configAgentDir, "sessions", ...relativeParts);
      const currentPath = path.join(dataDir, "sessions", ...relativeParts);
      await fs.mkdir(path.dirname(currentPath), { recursive: true });
      await fs.writeFile(currentPath, `${JSON.stringify({
        type: "session",
        id: "xdg-metadata",
        timestamp: "2026-08-12T00:00:00.000Z",
        cwd: "/work/xdg-metadata",
      })}\n`);
      const installation: OmpInstallation = {
        id: "linux-direct:xdg-metadata",
        kind: "linux-direct",
        label: "Linux (direct) · Profile · work",
        profile: "work",
        executablePath: "/usr/bin/omp",
        version: "17.2.15",
        agentDir: configAgentDir,
        dataDir,
      };
      const installationKey = installationMetadataKey(installation);
      const store = new MetadataStore(databasePath);
      store.updateSession(installationKey, metadataSummary(oldPath, installation.id), {
        displayTitle: "Migrated desktop name",
        pinned: true,
        archived: true,
        tags: ["xdg", "kept"],
      });

      const firstIndex = new SessionIndex(store);
      const [migrated] = await firstIndex.list(installation, true);
      expect(migrated).toMatchObject({
        path: currentPath,
        title: "Migrated desktop name",
        pinned: true,
        archived: true,
        tags: ["xdg", "kept"],
      });
      expect(store.getSessionMetadata(installationKey, [oldPath]).size).toBe(0);
      expect(store.getSessionMetadata(installationKey, [currentPath]).size).toBe(1);
      store.close();

      const reopenedStore = new MetadataStore(databasePath);
      try {
        const [reopened] = await new SessionIndex(reopenedStore).list(installation, true);
        expect(reopened).toMatchObject({
          path: currentPath,
          title: "Migrated desktop name",
          pinned: true,
          archived: true,
          tags: ["xdg", "kept"],
        });
      } finally {
        reopenedStore.close();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "indexes, trashes, and permanently deletes a Profile through its flattened XDG data root",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-xdg-profile-sessions-"));
      temporaryDirectories.push(root);
      const configAgentDir = path.join(root, "home", ".omp", "profiles", "work", "agent");
      const dataDir = path.join(root, "data", "omp", "profiles", "work");
      const bucket = path.join(dataDir, "sessions", "project");
      await fs.mkdir(bucket, { recursive: true });
      await fs.mkdir(configAgentDir, { recursive: true });
      const trashPath = path.join(bucket, "trash.jsonl");
      const deletePath = path.join(bucket, "delete.jsonl");
      await fs.writeFile(trashPath, `${JSON.stringify({ type: "session", id: "xdg-trash", cwd: "/work/x" })}\n`);
      await fs.writeFile(deletePath, `${JSON.stringify({ type: "session", id: "xdg-delete", cwd: "/work/x" })}\n`);
      const installation: OmpInstallation = {
        id: "linux-direct:xdg-work",
        kind: "linux-direct",
        label: "Linux (direct) · Profile · work",
        profile: "work",
        executablePath: "/usr/bin/omp",
        version: "17.2.15",
        agentDir: configAgentDir,
        dataDir,
      };
      const store = new MetadataStore(path.join(root, "metadata.sqlite3"));
      const index = new SessionIndex(store);
      try {
        const indexed = await index.list(installation);
        expect(indexed.map(session => session.path).sort()).toEqual([deletePath, trashPath].sort());

        const trashed = await index.trash(installation, trashPath);
        expect(trashed.trashPath).toContain(`${dataDir}/trash/omp-desktop/`);
        await expect(fs.stat(trashPath)).rejects.toThrow();

        await index.list(installation);
        await expect(index.deletePermanently(installation, deletePath)).resolves.toMatchObject({
          deletedPath: deletePath,
        });
        await expect(fs.stat(deletePath)).rejects.toThrow();
        await expect(fs.readdir(configAgentDir)).resolves.toEqual([]);
      } finally {
        store.close();
      }
    },
  );

  it.runIf(process.platform !== "win32")("preserves WSL logical paths while indexing on the development host", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-wsl-regression-"));
    temporaryDirectories.push(root);
    const bucket = path.join(root, "sessions", "work-demo");
    await fs.mkdir(bucket, { recursive: true });
    const sessionPath = path.join(bucket, "session.jsonl");
    await fs.writeFile(sessionPath, `${JSON.stringify({
      type: "session",
      id: "wsl-session",
      timestamp: "2026-08-12T00:00:00.000Z",
      cwd: "/work/demo",
    })}\n`);
    const installation: OmpInstallation = {
      id: "wsl:Ubuntu",
      kind: "wsl",
      label: "WSL · Ubuntu",
      distro: "Ubuntu",
      executablePath: "/usr/bin/omp",
      version: "17.2.12",
      agentDir: root,
    };
    const store = new MetadataStore(path.join(root, "metadata.sqlite3"));
    const index = new SessionIndex(store);

    await expect(index.list(installation)).resolves.toMatchObject([
      {
        path: sessionPath,
        cwd: "/work/demo",
        installationId: installation.id,
        runtimeKind: "wsl",
      },
    ]);
    store.close();
  });

  it.runIf(process.platform !== "win32")(
    "keeps same-path legacy metadata unclaimed across WSL distros until Alpha settings identify one owner",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-legacy-owner-"));
      temporaryDirectories.push(root);
      const hostSessionsRoot = path.join(root, "sessions");
      const hostSessionPath = path.join(hostSessionsRoot, "shared", "legacy.jsonl");
      const logicalSessionPath = "/home/user/.omp/agent/sessions/shared/legacy.jsonl";
      await fs.mkdir(path.dirname(hostSessionPath), { recursive: true });
      await fs.writeFile(hostSessionPath, `${JSON.stringify({ type: "title", title: "OMP title" })}\n${JSON.stringify({
        type: "session",
        id: "legacy",
        cwd: "/work/shared",
      })}\n`);
      const databasePath = path.join(root, "metadata.sqlite3");
      createLegacyMetadataDatabase(databasePath, logicalSessionPath);

      const ubuntu = wslDefaultInstallation("Ubuntu");
      const debian = wslDefaultInstallation("Debian");
      const store = new MetadataStore(databasePath);
      const index = new SessionIndex(store);
      try {
        // A current UI selection is not provenance. With no complete Alpha
        // owner pair, concurrent lists must leave the V1 row untouched.
        store.writeSettings({ selectedInstallationId: debian.id });
        const [debianBefore, ubuntuBefore] = await Promise.all([
          index.list(debian, false, hostSessionsRoot),
          index.list(ubuntu, false, hostSessionsRoot),
        ]);
        expect(debianBefore[0]).toMatchObject({ title: "OMP title", pinned: false });
        expect(ubuntuBefore[0]).toMatchObject({ title: "OMP title", pinned: false });
        expect(store.getSessionMetadata(installationMetadataKey(debian), [logicalSessionPath]).size).toBe(0);
        expect(store.getSessionMetadata(installationMetadataKey(ubuntu), [logicalSessionPath]).size).toBe(0);

        // Once the exact Alpha owner pair is available, order no longer
        // matters: Debian cannot steal Ubuntu's unscoped metadata.
        store.writeSettings({ selectedDistro: "Ubuntu", selectedInstallationPath: "/usr/bin/omp" });
        const [debianAfter, ubuntuAfter] = await Promise.all([
          index.list(debian, false, hostSessionsRoot),
          index.list(ubuntu, false, hostSessionsRoot),
        ]);
        expect(debianAfter[0]).toMatchObject({ title: "OMP title", pinned: false });
        expect(ubuntuAfter[0]).toMatchObject({ title: "Legacy title", pinned: true, tags: ["legacy"] });
        expect(store.getSessionMetadata(installationMetadataKey(debian), [logicalSessionPath]).size).toBe(0);
        expect(store.getSessionMetadata(installationMetadataKey(ubuntu), [logicalSessionPath]).size).toBe(1);
      } finally {
        store.close();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "atomically claims a unique Alpha owner's legacy path alias when XDG moves the session root",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-legacy-xdg-owner-"));
      temporaryDirectories.push(root);
      const hostSessionsRoot = path.join(root, "xdg-sessions");
      const currentDataDir = "/home/user/.local/share/omp";
      const legacyAgentDir = "/home/user/.omp/agent";
      const relativeClaimed = "shared/claimed.jsonl";
      const relativeCurrent = "shared/current-wins.jsonl";
      const claimedCurrentPath = `${currentDataDir}/sessions/${relativeClaimed}`;
      const currentWinsPath = `${currentDataDir}/sessions/${relativeCurrent}`;
      const claimedLegacyPath = `${legacyAgentDir}/sessions/${relativeClaimed}`;
      const currentWinsLegacyPath = `${legacyAgentDir}/sessions/${relativeCurrent}`;
      await fs.mkdir(path.join(hostSessionsRoot, "shared"), { recursive: true });
      await fs.writeFile(path.join(hostSessionsRoot, relativeClaimed), `${JSON.stringify({
        type: "session",
        id: "claimed",
        cwd: "/work/shared",
        title: "OMP claimed",
      })}\n`);
      await fs.writeFile(path.join(hostSessionsRoot, relativeCurrent), `${JSON.stringify({
        type: "session",
        id: "current-wins",
        cwd: "/work/shared",
        title: "OMP current",
      })}\n`);
      const databasePath = path.join(root, "metadata.sqlite3");
      createLegacyMetadataDatabase(databasePath, [claimedLegacyPath, currentWinsLegacyPath]);

      const ubuntu: OmpInstallation = {
        ...wslDefaultInstallation("Ubuntu"),
        dataDir: currentDataDir,
      };
      const debian: OmpInstallation = {
        ...wslDefaultInstallation("Debian"),
        dataDir: currentDataDir,
      };
      const ubuntuKey = installationMetadataKey(ubuntu);
      const debianKey = installationMetadataKey(debian);
      const store = new MetadataStore(databasePath);
      const index = new SessionIndex(store);
      try {
        store.updateSession(ubuntuKey, metadataSummary(currentWinsPath, ubuntu.id), {
          displayTitle: "Scoped current title",
          archived: true,
        });

        // Incomplete provenance remains unclaimed even though the old path is
        // a unique alias of the new XDG location.
        store.writeSettings({ selectedInstallationId: debian.id });
        const [debianBefore, ubuntuBefore] = await Promise.all([
          index.list(debian, true, hostSessionsRoot),
          index.list(ubuntu, true, hostSessionsRoot),
        ]);
        expect(debianBefore.find(item => item.path === claimedCurrentPath)).toMatchObject({
          title: "OMP claimed",
          pinned: false,
        });
        expect(ubuntuBefore.find(item => item.path === claimedCurrentPath)).toMatchObject({
          title: "OMP claimed",
          pinned: false,
        });

        store.writeSettings({ selectedDistro: "Ubuntu", selectedInstallationPath: "/usr/bin/omp" });
        const [debianAfter, ubuntuAfter] = await Promise.all([
          index.list(debian, true, hostSessionsRoot),
          index.list(ubuntu, true, hostSessionsRoot),
        ]);
        expect(debianAfter.find(item => item.path === claimedCurrentPath)).toMatchObject({
          title: "OMP claimed",
          pinned: false,
        });
        expect(ubuntuAfter.find(item => item.path === claimedCurrentPath)).toMatchObject({
          title: "Legacy title",
          pinned: true,
          tags: ["legacy"],
        });
        expect(ubuntuAfter.find(item => item.path === currentWinsPath)).toMatchObject({
          title: "Scoped current title",
          archived: true,
        });
        expect(store.getSessionMetadata(ubuntuKey, [claimedLegacyPath]).size).toBe(0);
        expect(store.getSessionMetadata(ubuntuKey, [claimedCurrentPath]).size).toBe(1);
        expect(store.getSessionMetadata(debianKey, [claimedCurrentPath]).size).toBe(0);
      } finally {
        store.close();
      }
    },
  );

  it("migrates legacy metadata without losing it or sharing it across installations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-metadata-migration-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "metadata.sqlite3");
    const sessionPath = "/home/user/.omp/agent/sessions/shared/legacy.jsonl";
    createLegacyMetadataDatabase(databasePath, sessionPath);

    const store = new MetadataStore(databasePath);
    const namedProfileKey = "wsl-profile:Ubuntu:work";
    expect(store.getSessionMetadata("wsl:Debian", [sessionPath]).size).toBe(0);
    expect(store.getSessionMetadata(namedProfileKey, [sessionPath]).size).toBe(0);
    const ubuntu = wslDefaultInstallation("Ubuntu");
    const ubuntuKey = installationMetadataKey(ubuntu);
    store.writeSettings({ selectedDistro: "Ubuntu", selectedInstallationPath: "/usr/bin/omp" });
    const migrated = store.getSessionMetadata(ubuntuKey, [sessionPath], ubuntu).get(sessionPath);

    expect(migrated).toMatchObject({
      session_path: sessionPath,
      display_title: "Legacy title",
      pinned: 1,
      archived: 0,
      tags_json: JSON.stringify(["legacy"]),
    });
    expect(store.getSessionMetadata("wsl:Debian", [sessionPath]).size).toBe(0);
    expect(store.getSessionMetadata(namedProfileKey, [sessionPath]).size).toBe(0);
    store.close();

    const reopened = new MetadataStore(databasePath);
    expect(reopened.getSessionMetadata(ubuntuKey, [sessionPath]).get(sessionPath)).toMatchObject({
      display_title: "Legacy title",
      pinned: 1,
      tags_json: JSON.stringify(["legacy"]),
    });
    expect(reopened.getSessionMetadata("wsl:Debian", [sessionPath]).size).toBe(0);
    reopened.close();
  });
});
