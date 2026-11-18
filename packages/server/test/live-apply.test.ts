import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEARCH_PATH, type MessageRole } from "@retrospecticus/shared";
import { createApp } from "../src/app.ts";
import { issueToken } from "../src/auth.ts";
import { openConfigStore, type ConfigStore } from "../src/config-store.ts";
import type { ServerConfigInput } from "../src/config.ts";
import { enqueueAlert, listAlerts } from "../src/db/alerts.ts";
import { insertChunk, listChunks } from "../src/db/chunks.ts";
import { upsertFileSize } from "../src/db/files.ts";
import { openDb, type Db } from "../src/db/index.ts";
import { insertMessage, insertRecord } from "../src/db/messages.ts";
import { applySessionPatch, markChunkDirty } from "../src/db/sessions.ts";
import { countVectors, getActiveModel, type ModelRow } from "../src/db/vectors.ts";
import { providerForSlug } from "../src/embeddings/registry.ts";
import type { EmbeddingProvider } from "../src/embeddings/types.ts";
import { createVectorSearch } from "../src/indexer/embed.ts";
import { runUntilIdle } from "../src/indexer/loop.ts";
import { buildWiring } from "../src/wiring.ts";

let dir: string;
let db: Db;
let store: ConfigStore;
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "retrospecticus-live-"));
  db = openDb(":memory:");
  store = openConfigStore({ configPath: join(dir, "config.json"), log: { warn() {}, error() {} } });
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function configure(next: ServerConfigInput): void {
  store.update(next, store.version());
}

function addChunk(text: string, ordinal: number): number {
  return insertChunk(db, {
    sessionId: "s1",
    startMessageId: ordinal,
    endMessageId: ordinal + 1,
    ordinal,
    part: 0,
    text,
    textHash: createHash("sha256").update(text).digest("hex"),
    tokenEstimate: Math.ceil(text.length / 4),
    timestamp: "2026-11-01T10:00:00.000Z",
  });
}

function seedSession(): void {
  db.run(
    "INSERT INTO sessions (id, source, machine, kind, project_path, title, started_at) VALUES ('s1', 'claude-code', 'laptop', 'main', '/p', 't', '2026-11-01T09:00:00.000Z')",
  );
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

describe("search weights", () => {
  test("a change applies to the next search request", async () => {
    seedSession();
    const both = addChunk("zeppelin hangar door", 0);
    const one = addChunk("zeppelin cargo", 2);
    // The vector ranking disagrees with the keyword one, so the weights decide the winner.
    const app = createApp({ db, config: store, configStore: store, vectorSearch: async () => [{ chunkId: one }, { chunkId: both }] });
    const { token } = issueToken(db, { scope: "search" });
    const top = async () => {
      const response = await app.request(SEARCH_PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "zeppelin hangar" }),
      });
      return ((await response.json()) as { results: { chunkId: number }[] }).results[0]?.chunkId;
    };

    expect(await top()).toBe(both);
    configure({ search: { keyword_weight: 0, vector_weight: 1 } });
    expect(await top()).toBe(one);
    configure({ search: { keyword_weight: 1, vector_weight: 0 } });
    expect(await top()).toBe(both);
  });
});

describe("chunk settings", () => {
  test("a change re-chunks every session on the next indexer pass", async () => {
    const file = upsertFileSize(db, { machine: "m1", source: "claude-code", path: "p/s.jsonl" }, 0, 100);
    applySessionPatch(db, { id: "s" }, { source: "claude-code", machine: "m1", fileId: file.id });
    const add = (ordinal: number, role: MessageRole, text: string) => {
      const recordId = insertRecord(db, { fileId: file.id, byteOffset: ordinal * 10, byteLength: 10, type: role });
      insertMessage(db, { sessionId: "s", ordinal, role, text, recordId, part: 0, timestamp: new Date(Date.UTC(2026, 10, 16, 10, 0, ordinal)).toISOString() });
    };
    add(0, "user", "explain");
    add(1, "assistant", Array.from({ length: 8 }, (_, i) => `Point ${i}. ${"detail ".repeat(40)}`).join("\n\n"));
    markChunkDirty(db, ["s"]);

    const [chunk] = buildWiring(db, store).stages;
    while (await chunk!.run(db)) {
      // until idle
    }
    const before = listChunks(db, "s").length;
    expect(await chunk!.run(db)).toBe(false);

    configure({ indexer: { chunk_tokens: 100, chunk_overlap_tokens: 10 } });
    expect(await chunk!.run(db)).toBe(true);
    expect(listChunks(db, "s").length).toBeGreaterThan(before);
    expect(listChunks(db, "s").every((c) => c.text.length <= 400)).toBe(true);
  });
});

describe("notifiers", () => {
  test("are rebuilt when their section changes, and read their secret at send time", async () => {
    const hits: string[] = [];
    const hook = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        hits.push(new URL(req.url).pathname);
        return new Response(null, { status: 204 });
      },
    });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const stop = buildWiring(db, store, { dispatcherIntervalMs: 10 }).startBackground();
    try {
      enqueueAlert(db, { kind: "drift", severity: "breaking", title: "one", body: "b", dedupeKey: "one" });
      await until(() => listAlerts(db).every((a) => a.sent_at !== null), "the log notifier");
      expect(hits).toEqual([]);

      store.setSecret("discord_webhook_url", `${hook.url}first`);
      configure({ notifiers: { discord: {} } });
      enqueueAlert(db, { kind: "drift", severity: "breaking", title: "two", body: "b", dedupeKey: "two" });
      await until(() => hits.length === 1, "discord");
      expect(hits).toEqual(["/first"]);

      store.setSecret("discord_webhook_url", `${hook.url}rotated`);
      enqueueAlert(db, { kind: "drift", severity: "breaking", title: "three", body: "b", dedupeKey: "three" });
      await until(() => hits.length === 2, "the rotated webhook");
      expect(hits[1]).toBe("/rotated");
    } finally {
      await stop();
      errSpy.mockRestore();
      await hook.stop(true);
    }
  });
});

describe("embedding", () => {
  test("a changed model starts filling its vectors while the active model stays put", async () => {
    seedSession();
    addChunk("zeppelin hangar door", 0);
    addChunk("marmalade pipeline", 2);
    const wiring = buildWiring(db, store);
    const embed = wiring.stages.find((s) => s.name === "embed")!;
    expect(await embed.run(db)).toBe(false);

    configure({ embedding: { provider: "fake", model: "first" } });
    await runUntilIdle({ db, rawDir: join(dir, "raw"), stages: wiring.stages });
    expect(getActiveModel(db)?.slug).toBe("fake-first");
    expect(countVectors(db, "fake-first")).toBe(2);

    configure({ embedding: { provider: "fake", model: "second", dimensions: 16 } });
    await runUntilIdle({ db, rawDir: join(dir, "raw"), stages: wiring.stages });
    expect(countVectors(db, "fake-second")).toBe(2);
    expect(getActiveModel(db)?.slug).toBe("fake-first");
  });

  test("settings that contradict stored vectors pause embedding until they change", async () => {
    seedSession();
    addChunk("zeppelin hangar door", 0);
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const embed = buildWiring(db, store).stages.find((s) => s.name === "embed")!;
      configure({ embedding: { provider: "fake", model: "p", document_prefix: "d: " } });
      expect(await embed.run(db)).toBe(true);
      addChunk("marmalade pipeline", 2);
      configure({ embedding: { provider: "fake", model: "p", document_prefix: "other: " } });
      expect(await embed.run(db)).toBe(false);
      expect(await embed.run(db)).toBe(false);
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(countVectors(db, "fake-p")).toBe(1);
      configure({ embedding: { provider: "fake", model: "p", document_prefix: "d: " } });
      expect(await embed.run(db)).toBe(true);
      expect(countVectors(db, "fake-p")).toBe(2);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("vector search rebuilds its providers when the provider settings change, and stops while embedding is off", async () => {
    seedSession();
    addChunk("zeppelin hangar door", 0);
    configure({ embedding: { provider: "fake", model: "m" } });
    await runUntilIdle({ db, rawDir: join(dir, "raw"), stages: buildWiring(db, store).stages });

    const built: string[] = [];
    const vectorSearch = createVectorSearch(
      db,
      (model: ModelRow): EmbeddingProvider => {
        built.push(store.current().embedding.base_url ?? "default");
        return providerForSlug(model.slug, store.current().embedding, model.dimensions);
      },
      {
        enabled: () => store.current().embedding.provider !== "none",
        cacheKey: () => JSON.stringify(store.current().embedding),
      },
    );
    expect(await vectorSearch("hangar", {}, 3)).toHaveLength(1);
    expect(await vectorSearch("hangar", {}, 3)).toHaveLength(1);
    expect(built).toEqual(["default"]);

    configure({ embedding: { provider: "fake", model: "m", base_url: "http://127.0.0.1:1/v1" } });
    await vectorSearch("hangar", {}, 3);
    expect(built).toEqual(["default", "http://127.0.0.1:1/v1"]);

    configure({ embedding: { provider: "none" } });
    expect(await vectorSearch("hangar", {}, 3)).toBeNull();
  });
});
