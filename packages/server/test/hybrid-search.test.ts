import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { SEARCH_PATH } from "@retrospecticus/shared";
import { createApp } from "../src/app.ts";
import { issueToken } from "../src/auth.ts";
import { defaultConfig } from "../src/config.ts";
import { insertChunk } from "../src/db/chunks.ts";
import { openDb, type Db } from "../src/db/index.ts";
import { activateModel, countMissing, countVectors, ensureModel, getActiveModel, type ModelRow } from "../src/db/vectors.ts";
import { createFakeProvider } from "../src/embeddings/fake.ts";
import { providerForSlug } from "../src/embeddings/registry.ts";
import type { EmbeddingProvider } from "../src/embeddings/types.ts";
import { createEmbedStage, createVectorSearch, embedAll } from "../src/indexer/embed.ts";
import { search, type VectorSearch } from "../src/search/index.ts";

const HANGAR =
  "User: why does the zeppelin hangar door jam every morning?\n\nAssistant: The hydraulic actuator on the zeppelin hangar door drifts out of calibration overnight.";
const MANIFEST =
  "User: what is in the zeppelin cargo manifest?\n\nAssistant: The manifest lists the ballast tanks and the spare gondola parts.";
const UNRELATED = [
  "User: configure the marmalade pipeline\n\nAssistant: The marmalade pipeline buffers quince batches before sterilisation.",
  "User: rename the logging helper\n\nAssistant: Renamed the helper and updated its callers.",
  "User: bump the dependency versions\n\nAssistant: Bumped them and the tests still pass.",
  "User: why is the build slow\n\nAssistant: The type checker runs twice; drop the duplicate step.",
  "User: tidy the readme\n\nAssistant: Rewrote the install section.",
];

/** Models a synonym the keyword index cannot know about: "airship" means "zeppelin". */
const ALIASES = { airship: "zeppelin", dirigible: "zeppelin" };

let db: Db;
let ids: { hangar: number; manifest: number; unrelated: number[] };

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

beforeEach(() => {
  db = openDb(":memory:");
  db.run(
    "INSERT INTO sessions (id, source, machine, kind, project_path, title, started_at) VALUES ('s1', 'claude-code', 'laptop', 'main', '/home/u/code/alpha', 'airships', '2026-11-01T09:00:00.000Z')",
  );
  ids = {
    hangar: addChunk(HANGAR, 0),
    manifest: addChunk(MANIFEST, 2),
    unrelated: UNRELATED.map((text, i) => addChunk(text, 4 + i * 2)),
  };
});
afterEach(() => db.close());

async function embedWith(provider: EmbeddingProvider): Promise<VectorSearch> {
  const stage = createEmbedStage({ provider, backlogThreshold: 1000 });
  while (await stage.run(db)) {
    // until every chunk has a vector
  }
  return createVectorSearch(db, () => provider);
}

describe("hybrid search", () => {
  test("ranks a related chunk that shares no keyword with the query above unrelated ones", async () => {
    const vectorSearch = await embedWith(createFakeProvider({ model: "aliased", aliases: ALIASES }));
    const query = "airship cargo";

    const keywordOnly = await search(db, { query, limit: 10 });
    expect(keywordOnly.map((r) => r.chunkId)).toEqual([ids.manifest]);

    const hybrid = (await search(db, { query, limit: 10 }, { vectorSearch })).map((r) => r.chunkId);
    expect(hybrid[0]).toBe(ids.manifest);
    expect(hybrid[1]).toBe(ids.hangar);
    expect(hybrid.slice(2).sort()).toEqual([...ids.unrelated].sort());
  });

  test("finds a chunk by meaning alone when no keyword matches", async () => {
    const vectorSearch = await embedWith(createFakeProvider({ model: "aliased", aliases: ALIASES }));
    expect(await search(db, { query: "dirigible", limit: 3 })).toEqual([]);
    const results = await search(db, { query: "dirigible", limit: 3 }, { vectorSearch });
    expect(results.map((r) => r.chunkId).slice(0, 2).sort()).toEqual([ids.hangar, ids.manifest].sort());
  });

  test("falls back to keywords with no active model or a failing query embedding", async () => {
    const noModel = createVectorSearch(db, () => {
      throw new Error("must not be asked for a provider");
    });
    expect(await noModel("zeppelin", {}, 5)).toBeNull();

    ensureModel(db, { slug: "fake-broken", provider: "fake", model: "broken", dimensions: 8 });
    activateModel(db, "fake-broken");
    const broken = createVectorSearch(db, () => ({
      slug: "fake-broken",
      dimensions: 8,
      embed: async () => {
        throw new Error("provider unreachable");
      },
    }));
    const results = await search(db, { query: "zeppelin hangar" }, { vectorSearch: broken });
    expect(results[0]?.chunkId).toBe(ids.hangar);
  });

  test("a mode limits ranking to keywords or to vectors", async () => {
    const vectorSearch = await embedWith(createFakeProvider({ model: "aliased", aliases: ALIASES }));
    expect(await search(db, { query: "dirigible", mode: "keyword" }, { vectorSearch })).toEqual([]);
    const byVector = await search(db, { query: "dirigible", limit: 2, mode: "vector" }, { vectorSearch });
    expect(byVector.map((r) => r.chunkId).sort()).toEqual([ids.hangar, ids.manifest].sort());
    expect(await search(db, { query: "marmalade", mode: "vector" })).toEqual([]);
    const byKeyword = await search(db, { query: "marmalade", mode: "keyword" }, { vectorSearch });
    expect(byKeyword.map((r) => r.chunkId)).toEqual([ids.unrelated[0]!]);
  });

  test("POST /v1/search uses the vector search it was given", async () => {
    const vectorSearch = await embedWith(createFakeProvider({ model: "aliased", aliases: ALIASES }));
    const app = createApp({ db, config: defaultConfig(), vectorSearch });
    const { token } = issueToken(db, { scope: "search" });
    const response = await app.request(SEARCH_PATH, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "dirigible", limit: 2 }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: { chunkId: number }[] };
    expect(body.results.map((r) => r.chunkId).sort()).toEqual([ids.hangar, ids.manifest].sort());

    const post = (payload: object) =>
      app.request(SEARCH_PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    const keyword = (await (await post({ query: "dirigible", mode: "keyword" })).json()) as { results: unknown[] };
    expect(keyword.results).toEqual([]);
    expect((await post({ query: "dirigible", mode: "semantic" })).status).toBe(400);
  });
});

describe("re-embed and switch", () => {
  test("search keeps working before, during and after moving to a second model", async () => {
    const config = defaultConfig({ embedding: { provider: "fake", model: "first" } }).embedding;
    const asked: string[] = [];
    const vectorSearch = createVectorSearch(db, (model: ModelRow) => {
      asked.push(model.slug);
      return providerForSlug(model.slug, config, model.dimensions);
    });
    const expectHangarFirst = async (): Promise<void> => {
      const results = await search(db, { query: "zeppelin hangar door" }, { vectorSearch });
      expect(results[0]?.chunkId).toBe(ids.hangar);
      expect(results.length).toBeGreaterThan(1);
    };

    const first = providerForSlug("fake-first", config);
    await embedWith(first);
    expect(getActiveModel(db)?.slug).toBe("fake-first");
    await expectHangarFirst();
    expect(asked).toEqual(["fake-first"]);

    const second = providerForSlug("fake-second", config, 32);
    expect(second.dimensions).toBe(32);
    let checkpoints = 0;
    const embedded = await embedAll(db, second, {
      batchSize: 2,
      onProgress: async ({ missing }) => {
        if (missing === 0) return;
        checkpoints++;
        expect(getActiveModel(db)?.slug).toBe("fake-first");
        await expectHangarFirst();
      },
    });
    expect(embedded).toBe(7);
    expect(checkpoints).toBeGreaterThan(1);
    expect(countVectors(db, "fake-second")).toBe(7);
    expect(countMissing(db, "fake-second")).toBe(0);
    expect(getActiveModel(db)?.slug).toBe("fake-first");
    expect(new Set(asked)).toEqual(new Set(["fake-first"]));

    activateModel(db, "fake-second");
    await expectHangarFirst();
    expect(asked).toEqual(["fake-first", "fake-second"]);

    expect(() => activateModel(db, "fake-nonexistent")).toThrow(/Unknown embedding model: fake-nonexistent/);
    expect(getActiveModel(db)?.slug).toBe("fake-second");
    await expectHangarFirst();
  });
});
