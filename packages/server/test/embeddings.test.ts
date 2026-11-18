import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { listAlerts } from "../src/db/alerts.ts";
import { deleteChunks, insertChunk } from "../src/db/chunks.ts";
import { openDb, vectorTableName, type Db } from "../src/db/index.ts";
import { statusReport } from "../src/db/status.ts";
import {
  activateModel,
  countMissing,
  countVectors,
  dropModel,
  ensureModel,
  getModel,
  getActiveModel,
  knn,
  listModels,
} from "../src/db/vectors.ts";
import { createFakeProvider, fakeEmbedding } from "../src/embeddings/fake.ts";
import { createOpenAIProvider } from "../src/embeddings/openai.ts";
import { createProvider, presetPrefixes, providerForSlug } from "../src/embeddings/registry.ts";
import type { EmbeddingProvider } from "../src/embeddings/types.ts";
import { backlogAlertKey, createEmbedStage, createVectorSearch } from "../src/indexer/embed.ts";
import { search } from "../src/search/index.ts";
import { buildWiring } from "../src/wiring.ts";

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

function seed(db: Db, texts: readonly string[]): number[] {
  db.run(
    "INSERT INTO sessions (id, source, machine, kind, project_path, title, started_at) VALUES ('s1', 'claude-code', 'laptop', 'main', '/p', 'seeded', '2026-11-01T00:00:00.000Z')",
  );
  return texts.map((text, i) =>
    insertChunk(db, {
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

describe("fake provider", () => {
  test("is deterministic, normalised and puts texts sharing words close", async () => {
    const provider = createFakeProvider({ model: "alpha" });
    expect(provider.slug).toBe("fake-alpha");
    expect(provider.dimensions).toBe(64);
    const [a, again, near, far] = await provider.embed([
      "the zeppelin hangar door",
      "the zeppelin hangar door",
      "Zeppelin hangar maintenance",
      "quince marmalade recipe",
    ]);
    expect([...a!]).toEqual([...again!]);
    expect([...fakeEmbedding("the zeppelin hangar door")]).toEqual([...a!]);
    expect(cosine(a!, a!)).toBeCloseTo(1, 5);
    expect(cosine(a!, near!)).toBeGreaterThan(cosine(a!, far!));
    expect(cosine(a!, near!)).toBeGreaterThan(0.5);
  });

  test("honours dimensions and aliases, and gives wordless text a direction", async () => {
    const provider = createFakeProvider({ model: "small", dimensions: 8, aliases: { Airship: "zeppelin" } });
    const [airship, zeppelin, empty] = await provider.embed(["airship", "zeppelin", "!!!"]);
    expect(airship!.length).toBe(8);
    expect(cosine(airship!, zeppelin!)).toBeCloseTo(1, 5);
    expect(cosine(empty!, empty!)).toBeCloseTo(1, 5);
  });
});

describe("openai provider", () => {
  let server: ReturnType<typeof Bun.serve>;
  let key: string | undefined;
  let requests: { auth: string | null; body: { model: string; input: string[] } }[];
  let failNext: number[];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const body = (await req.json()) as { model: string; input: string[] };
        requests.push({ auth: req.headers.get("authorization"), body });
        const status = failNext.shift();
        if (status !== undefined) return new Response(JSON.stringify({ error: { message: "slow down" } }), { status });
        // Reversed, so a client that ignores `index` gets the order wrong.
        const data = body.input
          .map((text, index) => ({ object: "embedding", index, embedding: [text.length, index, 1] }))
          .reverse();
        return Response.json({ object: "list", data, model: body.model });
      },
    });
  });
  afterAll(() => server.stop(true));
  beforeEach(() => {
    requests = [];
    failNext = [];
    key = "  sk-test-key\n";
  });

  const make = (extra: Partial<Parameters<typeof createOpenAIProvider>[0]> = {}): EmbeddingProvider =>
    createOpenAIProvider({
      model: "custom-model",
      dimensions: 3,
      apiKey: () => key,
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      retryDelaysMs: [0, 0],
      ...extra,
    });

  test("batches by 96, sends the trimmed key and maps results by index", async () => {
    const provider = make();
    expect(provider.slug).toBe("openai-custom-model");
    const texts = Array.from({ length: 200 }, (_, i) => "x".repeat(i + 1));
    const vectors = await provider.embed(texts);
    expect(requests.map((r) => r.body.input.length)).toEqual([96, 96, 8]);
    expect(requests.every((r) => r.auth === "Bearer sk-test-key" && r.body.model === "custom-model")).toBe(true);
    expect(vectors).toHaveLength(200);
    vectors.forEach((v, i) => {
      expect(v).toBeInstanceOf(Float32Array);
      expect(v[0]).toBe(i + 1);
      expect(v[1]).toBe(i % 96);
    });
  });

  test("retries a 429 and a 5xx, then gives up with the status", async () => {
    failNext = [429, 503];
    const [v] = await make().embed(["hello"]);
    expect(v![0]).toBe(5);
    expect(requests).toHaveLength(3);

    requests = [];
    failNext = [500, 500, 500];
    await expect(make().embed(["hello"])).rejects.toThrow(/500/);
    expect(requests).toHaveLength(3);

    requests = [];
    failNext = [400];
    await expect(make().embed(["hello"])).rejects.toThrow(/400/);
    expect(requests).toHaveLength(1);
  });

  test("a missing or empty key fails the call without a request, naming the secret", async () => {
    key = undefined;
    await expect(make().embed(["a"])).rejects.toThrow(/secrets set embedding_api_key/);
    key = "\n";
    await expect(make().embed(["a"])).rejects.toThrow(/embedding_api_key/);
    await expect(make({ apiKey: undefined }).embed(["a"])).rejects.toThrow(/embedding_api_key/);
    expect(requests).toHaveLength(0);
  });

  test("the key is asked for on every call, so a rotated one applies at once", async () => {
    const provider = make();
    await provider.embed(["a"]);
    key = "sk-rotated";
    await provider.embed(["a"]);
    expect(requests.map((r) => r.auth)).toEqual(["Bearer sk-test-key", "Bearer sk-rotated"]);
  });

  test("knows the dimensions of the text-embedding-3 models and requires them otherwise", () => {
    expect(createOpenAIProvider({ model: "text-embedding-3-small" }).dimensions).toBe(1536);
    expect(createOpenAIProvider({ model: "text-embedding-3-large" }).dimensions).toBe(3072);
    expect(() => createOpenAIProvider({ model: "mystery" })).toThrow(/dimensions/);
    expect(() => createOpenAIProvider({ model: "text-embedding-3-small", dimensions: 3 })).toThrow(/1536/);
  });

  test("rejects a response with the wrong vector size", async () => {
    await expect(make({ dimensions: 4 }).embed(["a"])).rejects.toThrow(/expected 4/);
  });

  test("an Ollama-style provider sends no key and names itself in the slug", async () => {
    const provider = make({ apiKey: undefined, keyOptional: true, provider: "ollama" });
    expect(provider.slug).toBe("ollama-custom-model");
    const [v] = await provider.embed(["abc"]);
    expect(v![0]).toBe(3);
    expect(requests[0]!.auth).toBeNull();
  });
});

describe("registry", () => {
  test("creates providers from config and from slugs", () => {
    expect(createProvider(defaultConfig().embedding)).toBeNull();
    expect(createProvider(defaultConfig({ embedding: { provider: "fake", model: "m" } }).embedding)?.slug).toBe("fake-m");
    expect(createProvider(defaultConfig({ embedding: { provider: "openai" } }).embedding)?.slug).toBe(
      "openai-text-embedding-3-small",
    );
    expect(() => createProvider(defaultConfig({ embedding: { provider: "acme" } }).embedding)).toThrow(/"acme"/);
    const ollama = defaultConfig({ embedding: { provider: "ollama", model: "embeddinggemma-2", dimensions: 768 } });
    expect(createProvider(ollama.embedding)?.slug).toBe("ollama-embeddinggemma-2");
    expect(providerForSlug("ollama-embeddinggemma-2", ollama.embedding).dimensions).toBe(768);
    expect(() => createProvider(defaultConfig({ embedding: { provider: "ollama", model: "x" } }).embedding)).toThrow(/dimensions/);

    const config = defaultConfig({ embedding: { provider: "fake", model: "m", dimensions: 16 } }).embedding;
    expect(providerForSlug("fake-m", config).dimensions).toBe(16);
    expect(providerForSlug("fake-other", config).dimensions).toBe(64);
    expect(providerForSlug("fake-other", config, 32).dimensions).toBe(32);
    expect(providerForSlug("openai-text-embedding-3-large", config).dimensions).toBe(3072);
    expect(() => providerForSlug("cohere-x", config)).toThrow(/cohere-x/);
    expect(() => providerForSlug("fake-", config)).toThrow();
  });

  test("a model of another provider than the configured one is reached at that provider's own address", async () => {
    const ollama = defaultConfig({ embedding: { provider: "ollama", model: "embeddinggemma-2", base_url: "http://127.0.0.1:11434/v1", dimensions: 768 } });
    const urls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return Response.json({ data: [{ index: 0, embedding: new Array(1536).fill(0) }] });
    }) as typeof fetch;
    try {
      await providerForSlug("openai-text-embedding-3-small", ollama.embedding, undefined, () => "sk-test").embed(["x"]);
      await providerForSlug("ollama-embeddinggemma-2", ollama.embedding).embed(["x"]).catch(() => undefined);
    } finally {
      globalThis.fetch = real;
    }
    expect(urls).toEqual(["https://api.openai.com/v1/embeddings", "http://127.0.0.1:11434/v1/embeddings"]);
  });

  test("the wiring's embed stage idles while embedding is off and fills the configured model otherwise", async () => {
    const db = openDb(":memory:");
    seed(db, ["zeppelin hangar"]);
    const off = buildWiring(db, defaultConfig()).stages;
    expect(off.map((s) => s.name)).toEqual(["chunk", "embed"]);
    expect(await off[1]!.run(db)).toBe(false);
    expect(getActiveModel(db)).toBeNull();
    const on = buildWiring(db, defaultConfig({ embedding: { provider: "fake", model: "m" } })).stages;
    expect(await on[1]!.run(db)).toBe(true);
    expect(getActiveModel(db)?.slug).toBe("fake-m");
    db.close();
  });
});

describe("vector storage", () => {
  test("registers models, refuses a dimension change and activates exactly one", () => {
    const db = openDb(":memory:");
    const ids = seed(db, ["one thing", "another thing"]);
    ensureModel(db, { slug: "fake-a", provider: "fake", model: "a", dimensions: 4 });
    ensureModel(db, { slug: "fake-a", provider: "fake", model: "a", dimensions: 4 });
    expect(() => ensureModel(db, { slug: "fake-a", provider: "fake", model: "a", dimensions: 8 })).toThrow(/4 dimensions/);
    ensureModel(db, { slug: "fake-b", provider: "fake", model: "b", dimensions: 2 });
    expect(getActiveModel(db)).toBeNull();
    activateModel(db, "fake-a");
    activateModel(db, "fake-b");
    expect(() => activateModel(db, "fake-zzz")).toThrow(/Unknown embedding model/);
    expect(getActiveModel(db)?.slug).toBe("fake-b");
    expect(listModels(db).map((m) => [m.slug, m.active, m.vectors, m.missing])).toEqual([
      ["fake-a", false, 0, 2],
      ["fake-b", true, 0, 2],
    ]);
    expect(countMissing(db, "fake-unregistered")).toBe(ids.length);
    db.close();
  });

  test("deleting a chunk removes its vector from every model's table", async () => {
    const db = openDb(":memory:");
    const [keep, drop] = seed(db, ["zeppelin hangar", "quince marmalade"]);
    for (const dimensions of [8, 16]) {
      const provider = createFakeProvider({ model: `d${dimensions}`, dimensions });
      const stage = createEmbedStage({ provider, backlogThreshold: 100 });
      expect(await stage.run(db)).toBe(true);
      expect(countVectors(db, provider.slug)).toBe(2);
    }
    deleteChunks(db, [drop!]);
    for (const slug of ["fake-d8", "fake-d16"]) {
      expect(countVectors(db, slug)).toBe(1);
      const rows = db.query<{ chunk_id: number }, []>(`SELECT chunk_id FROM ${vectorTableName(slug)}`).all();
      expect(rows.map((r) => r.chunk_id)).toEqual([keep!]);
    }
    db.close();
  });
});

describe("embed stage", () => {
  const TEXTS = [
    "User: why does the zeppelin hangar door jam?\n\nAssistant: Recalibrate the hydraulic actuator.",
    "User: configure the marmalade pipeline\n\nAssistant: It buffers quince batches.",
    "User: rename the logging helper\n\nAssistant: Done.",
    "User: bump the dependency versions\n\nAssistant: Bumped.",
    "User: why is the build slow\n\nAssistant: The type checker runs twice.",
  ];

  test("fills vectors in batches, activating the model when none is active", async () => {
    const db = openDb(":memory:");
    seed(db, TEXTS);
    const provider = createFakeProvider({ model: "stage" });
    const stage = createEmbedStage({ provider, batchSize: 2, backlogThreshold: 100 });
    expect(stage.name).toBe("embed");
    const ran: boolean[] = [];
    for (let i = 0; i < 4; i++) ran.push(await stage.run(db));
    expect(ran).toEqual([true, true, true, false]);
    expect(countVectors(db, "fake-stage")).toBe(5);
    expect(getActiveModel(db)?.slug).toBe("fake-stage");
    expect(statusReport(db).embedding).toEqual({ active_model: "fake-stage", backlog: 0 });

    const other = createEmbedStage({ provider: createFakeProvider({ model: "second" }), backlogThreshold: 100 });
    await other.run(db);
    expect(getActiveModel(db)?.slug).toBe("fake-stage");
    db.close();
  });

  test("survives a failing provider, keeps keyword search working, alerts once and clears when drained", async () => {
    const db = openDb(":memory:");
    const ids = seed(db, TEXTS);
    const fake = createFakeProvider({ model: "flaky" });
    let down = true;
    let calls = 0;
    const provider: EmbeddingProvider = {
      slug: fake.slug,
      dimensions: fake.dimensions,
      async embed(texts) {
        calls++;
        if (down) throw new Error("provider unreachable");
        return fake.embed(texts);
      },
    };
    const errors: unknown[] = [];
    let clock = 0;
    const stage = createEmbedStage({ provider, batchSize: 2, backlogThreshold: 3, onError: (e) => errors.push(e), now: () => clock });

    expect(await stage.run(db)).toBe(false);
    clock += 31_000;
    expect(await stage.run(db)).toBe(false);
    expect(calls).toBe(2);
    expect(errors).toHaveLength(2);
    expect((errors[0] as Error).message).toBe("provider unreachable");
    expect(countVectors(db, "fake-flaky")).toBe(0);

    const alerts = () => listAlerts(db).filter((a) => a.kind === "embedding-backlog");
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toMatchObject({ severity: "warning", dedupe_key: backlogAlertKey("fake-flaky") });
    expect(alerts()[0]!.dedupe_key).toBe("embedding-backlog:fake-flaky");

    const results = await search(db, { query: "zeppelin hangar" });
    expect(results.map((r) => r.chunkId)).toEqual([ids[0]!]);

    down = false;
    clock += 10 * 60_000;
    while (await stage.run(db)) {
      // drain the backlog
    }
    expect(countVectors(db, "fake-flaky")).toBe(5);
    expect(alerts()).toHaveLength(0);
    expect(statusReport(db).embedding.backlog).toBe(0);

    seed2(db, 4);
    down = true;
    expect(await stage.run(db)).toBe(false);
    expect(alerts()).toHaveLength(1);
    db.close();
  });

  function seed2(db: Db, n: number): void {
    for (let i = 0; i < n; i++) {
      const text = `User: later question ${i}\n\nAssistant: later answer ${i}`;
      insertChunk(db, {
        sessionId: "s1",
        startMessageId: 100 + i * 2,
        endMessageId: 101 + i * 2,
        ordinal: 100 + i * 2,
        part: 0,
        text,
        textHash: createHash("sha256").update(text).digest("hex"),
        tokenEstimate: 10,
        timestamp: "2026-11-02T00:00:00.000Z",
      });
    }
  }

  test("a vector for a chunk rewritten mid-embedding is dropped", async () => {
    const db = openDb(":memory:");
    const [id] = seed(db, ["zeppelin hangar"]);
    const fake = createFakeProvider({ model: "race" });
    const provider: EmbeddingProvider = {
      ...fake,
      async embed(texts) {
        db.run("UPDATE chunks SET text = 'quince marmalade', text_hash = 'changed' WHERE id = ?", [id!]);
        return fake.embed(texts);
      },
    };
    const stage = createEmbedStage({ provider, backlogThreshold: 100 });
    expect(await stage.run(db)).toBe(false);
    expect(countVectors(db, "fake-race")).toBe(0);
    expect(knn(db, "fake-race", fakeEmbedding("zeppelin"), 5)).toEqual([]);
    db.close();
  });
});

describe("task prefixes", () => {
  test("EmbeddingGemma gets its task prompts unless the config overrides them", () => {
    expect(presetPrefixes("embeddinggemma-2")).toEqual({
      query: "task: search result | query: ",
      document: "title: none | text: ",
    });
    expect(presetPrefixes("text-embedding-3-small")).toEqual({ query: "", document: "" });

    const gemma = defaultConfig({ embedding: { provider: "ollama", model: "embeddinggemma-2", dimensions: 768 } });
    expect(createProvider(gemma.embedding)?.documentPrefix).toBe("title: none | text: ");
    const off = defaultConfig({
      embedding: { provider: "ollama", model: "embeddinggemma-2", dimensions: 768, query_prefix: "", document_prefix: "doc: " },
    });
    const provider = createProvider(off.embedding)!;
    expect([provider.queryPrefix, provider.documentPrefix]).toEqual(["", "doc: "]);
    // A model other than the configured one uses its preset, not the config's override.
    expect(providerForSlug("ollama-embeddinggemma-3", off.embedding, 768).documentPrefix).toBe("title: none | text: ");
  });

  test("a model keeps its document prefix; the query prefix may change", () => {
    const db = openDb(":memory:");
    const spec = { slug: "fake-p", provider: "fake", model: "p", dimensions: 4, query_prefix: "q: ", document_prefix: "d: " };
    ensureModel(db, spec);
    expect(() => ensureModel(db, { ...spec, document_prefix: "other: " })).toThrow(/document prefix "d: "/);
    ensureModel(db, { ...spec, query_prefix: "ask: " });
    expect(getModel(db, "fake-p")).toMatchObject({ query_prefix: "ask: ", document_prefix: "d: " });

    dropModel(db, "fake-p");
    expect(getModel(db, "fake-p")).toBeNull();
    expect(countVectors(db, "fake-p")).toBe(0);
    ensureModel(db, { ...spec, document_prefix: "other: " });
    expect(() => dropModel(db, "fake-zzz")).toThrow(/Unknown embedding model/);
    db.close();
  });

  test("chunks are embedded with the document prefix and queries with the stored query prefix", async () => {
    const db = openDb(":memory:");
    seed(db, ["zeppelin hangar"]);
    const seen: string[] = [];
    const base = createFakeProvider({ model: "rec", dimensions: 8 });
    const provider: EmbeddingProvider = {
      ...base,
      queryPrefix: "q: ",
      documentPrefix: "d: ",
      embed: (texts) => {
        seen.push(...texts);
        return base.embed(texts);
      },
    };
    await createEmbedStage({ provider, backlogThreshold: 100 }).run(db);
    expect(seen).toEqual(["d: zeppelin hangar"]);

    // The provider now claims a different query prefix; search must keep the one stored with the vectors.
    const vectorSearch = createVectorSearch(db, () => ({ ...provider, queryPrefix: "changed: " }));
    await vectorSearch("hangar", {}, 3);
    expect(seen.at(-1)).toBe("q: hangar");
    db.close();
  });

  test("the embed stage rebuilds a model dropped while it runs", async () => {
    const db = openDb(":memory:");
    seed(db, ["one", "two"]);
    const stage = createEmbedStage({ provider: createFakeProvider({ model: "r", dimensions: 8 }), backlogThreshold: 100 });
    await stage.run(db);
    expect(countVectors(db, "fake-r")).toBe(2);
    dropModel(db, "fake-r");
    expect(getActiveModel(db)).toBeNull();
    await stage.run(db);
    expect(countVectors(db, "fake-r")).toBe(2);
    expect(getActiveModel(db)?.slug).toBe("fake-r");
    db.close();
  });

  test("an older database gains the prefix columns", () => {
    const dir = mkdtempSync(join(tmpdir(), "retrospecticus-migrate-"));
    const path = join(dir, "old.sqlite");
    const old = new Database(path);
    old.run(
      "CREATE TABLE embedding_models (slug TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, dimensions INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)",
    );
    old.run("INSERT INTO embedding_models VALUES ('fake-old', 'fake', 'old', 4, 1, '2026-11-01T00:00:00.000Z')");
    old.close();
    const db = openDb(path);
    expect(getModel(db, "fake-old")).toMatchObject({ query_prefix: "", document_prefix: "" });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
