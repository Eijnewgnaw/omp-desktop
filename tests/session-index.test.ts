import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
    const updated = index.update(session.path, { displayTitle: "桌面别名", pinned: true });
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
});
