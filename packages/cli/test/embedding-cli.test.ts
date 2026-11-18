import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEARCH_PATH } from "@retrospecticus/shared";
import { issueToken } from "@retrospecticus/server/auth.ts";
import { loadConfig } from "@retrospecticus/server/config.ts";
import { insertChunk } from "@retrospecticus/server/db/chunks.ts";
import { countVectors, ensureModel, getActiveModel } from "@retrospecticus/server/db/vectors.ts";
import { startServer, type RunningServer } from "@retrospecticus/server/main.ts";
import { run } from "../src/main.ts";

const HANGAR = "User: why does the zeppelin hangar door jam?\n\nAssistant: Recalibrate the hydraulic actuator on the hangar door.";
const OTHERS = [
  "User: configure the marmalade pipeline\n\nAssistant: It buffers quince batches.",
  "User: rename the logging helper\n\nAssistant: Renamed it.",
  "User: bump the dependency versions\n\nAssistant: Bumped them.",
  "User: why is the build slow\n\nAssistant: The type checker runs twice.",
];

let dir: string;
let configPath: string;
let server: RunningServer | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "retrospecticus-embedding-"));
  configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ data_dir: join(dir, "data"), listen_host: "127.0.0.1", listen_port: 0, embedding: { provider: "fake", model: "first" } }),
  );
  server = null;
});
afterEach(async () => {
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function cli(...args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(["--config", configPath, ...args], { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

function seed(s: RunningServer): number[] {
  s.db.run(
    "INSERT INTO sessions (id, source, machine, kind, project_path, title, started_at) VALUES ('s1', 'claude-code', 'laptop', 'main', '/p', 'hangar', '2026-11-01T00:00:00.000Z')",
  );
  return [HANGAR, ...OTHERS].map((text, i) =>
    insertChunk(s.db, {
      sessionId: "s1",
      startMessageId: i * 2,
      endMessageId: i * 2 + 1,
      ordinal: i * 2,
      part: 0,
      text,
      textHash: createHash("sha256").update(text).digest("hex"),
      tokenEstimate: Math.ceil(text.length / 4),
      timestamp: "2026-11-01T00:00:00.000Z",
    }),
  );
}

async function until(condition: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

describe("embedding and reembed commands", () => {
  test("list, reembed to a second model, refuse an empty one, and switch while the server keeps answering", async () => {
    expect((await cli("embedding", "list")).out).toEqual(["No embedding models registered."]);

    server = startServer(loadConfig(configPath));
    const s = server;
    const [hangar] = seed(s);
    s.indexer!.wake();
    await until(() => countVectors(s.db, "fake-first") === 5);
    expect(getActiveModel(s.db)?.slug).toBe("fake-first");

    const { token } = issueToken(s.db, { scope: "search" });
    const searchFirst = async (query: string): Promise<number | undefined> => {
      const response = await fetch(`${s.url}${SEARCH_PATH}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { results: { chunkId: number }[] }).results[0]?.chunkId;
    };
    expect(await searchFirst("zeppelin hangar door")).toBe(hangar);

    const unknown = await cli("embedding", "activate", "fake-second");
    expect(unknown.code).toBe(1);
    expect(unknown.err.join("\n")).toContain("Unknown embedding model: fake-second");

    const reembed = await cli("reembed", "--model", "fake-second", "--dimensions", "32", "--batch-size", "2");
    expect(reembed.err).toEqual([]);
    expect(reembed.code).toBe(0);
    expect(reembed.out[0]).toBe("Embedding chunks with fake-second (32 dimensions)...");
    expect(reembed.out).toContain("  2 embedded, 3 remaining");
    expect(reembed.out).toContain("  5 embedded, 0 remaining");
    expect(reembed.out.join("\n")).toContain("Active model unchanged (fake-first)");
    expect(getActiveModel(s.db)?.slug).toBe("fake-first");
    expect(await searchFirst("zeppelin hangar door")).toBe(hangar);

    const again = await cli("reembed", "--model", "fake-second");
    expect(again.code).toBe(0);
    expect(again.out.join("\n")).toContain("Done: 0 chunks embedded with fake-second.");
    expect((await cli("reembed", "--model", "fake-second", "--dimensions", "16")).code).toBe(1);
    expect((await cli("reembed", "--model", "cohere-x")).code).toBe(1);
    expect((await cli("reembed")).code).toBe(2);

    ensureModel(s.db, { slug: "fake-empty", provider: "fake", model: "empty", dimensions: 8 });
    const list = await cli("embedding", "list");
    expect(list.code).toBe(0);
    expect(list.out[0]).toMatch(/^slug\s+dimensions\s+active\s+vectors\s+missing$/);
    expect(list.out.slice(1).map((line) => line.split(/\s+/))).toEqual([
      ["fake-first", "64", "yes", "5", "0"],
      ["fake-second", "32", "5", "0"],
      ["fake-empty", "8", "0", "5"],
    ]);

    const refused = await cli("embedding", "activate", "fake-empty");
    expect(refused.code).toBe(1);
    expect(refused.err.join("\n")).toContain("--force");
    expect(getActiveModel(s.db)?.slug).toBe("fake-first");

    const switched = await cli("embedding", "activate", "fake-second");
    expect(switched.code).toBe(0);
    expect(switched.out).toEqual(["Search now uses fake-second."]);
    expect(getActiveModel(s.db)?.slug).toBe("fake-second");
    expect(await searchFirst("zeppelin hangar door")).toBe(hangar);

    const forced = await cli("embedding", "activate", "fake-empty", "--force");
    expect(forced.code).toBe(0);
    expect(forced.out.join("\n")).toContain("5 chunks have no fake-empty vector yet");
    // With no vectors the vector list is empty, so keyword search alone still answers.
    expect(await searchFirst("zeppelin hangar door")).toBe(hangar);

    const dropped = await cli("embedding", "drop", "fake-empty");
    expect(dropped.code).toBe(0);
    expect(dropped.out).toEqual(["Dropped fake-empty and its vectors.", "It was active: search uses keywords alone until a model is active again."]);
    expect(getActiveModel(s.db)).toBeNull();
    expect((await cli("embedding", "drop", "fake-empty")).code).toBe(1);
  }, 20_000);

  test("usage errors", async () => {
    expect((await cli("embedding")).code).toBe(2);
    expect((await cli("embedding", "frob")).code).toBe(2);
    expect((await cli("embedding", "activate")).code).toBe(2);
    expect((await cli("embedding", "list", "extra")).code).toBe(2);
    expect((await cli("embedding", "drop")).code).toBe(2);
    expect((await cli("reembed", "--model", "fake-x", "--dimensions", "zero")).code).toBe(2);
  });
});
