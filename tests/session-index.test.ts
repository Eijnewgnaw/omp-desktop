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
});
