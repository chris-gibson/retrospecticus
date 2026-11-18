import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Hono } from "hono";
import { createApp } from "../src/app.ts";
import type { AppEnv } from "../src/auth.ts";
import { openConfigStore, type ConfigStore } from "../src/config-store.ts";
import { listAlerts } from "../src/db/alerts.ts";
import { insertChunk } from "../src/db/chunks.ts";
import { openDb, type Db } from "../src/db/index.ts";
import { countVectors } from "../src/db/vectors.ts";
import { createFakeProvider } from "../src/embeddings/fake.ts";
import {
  OpenAIEmbeddingError,
  createOpenAIProvider,
  parseResetDuration,
  requestedWaitMs,
} from "../src/embeddings/openai.ts";
import type { EmbeddingProvider } from "../src/embeddings/types.ts";
import { createEmbedStage, embedBackoffMs, getEmbedError } from "../src/indexer/embed.ts";
import { adminGet, adminSession } from "./enroll-helpers.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("rate-limit headers", () => {
  test("parses OpenAI reset durations", () => {
    expect(parseResetDuration("1s")).toBe(1000);
    expect(parseResetDuration("6m0s")).toBe(360_000);
    expect(parseResetDuration("20ms")).toBe(20);
    expect(parseResetDuration("1m30.5s")).toBe(90_500);
    expect(parseResetDuration("soon")).toBeUndefined();
    expect(parseResetDuration(null)).toBeUndefined();
  });

  test("Retry-After in seconds or as a date wins over reset headers", () => {
    const now = Date.parse("2026-11-17T10:00:00Z");
    const reset = { "x-ratelimit-reset-requests": "5s" };
    expect(requestedWaitMs(new Headers({ "retry-after": "7", ...reset }), now)).toBe(7000);
    expect(requestedWaitMs(new Headers({ "retry-after": "Tue, 17 Nov 2026 10:00:12 GMT" }), now)).toBe(12_000);
    expect(requestedWaitMs(new Headers({ "retry-after": "Tue, 17 Nov 2026 09:00:00 GMT" }), now)).toBe(0);
  });

  test("the larger reset header is used, and nothing otherwise", () => {
    const headers = new Headers({ "x-ratelimit-reset-requests": "1s", "x-ratelimit-reset-tokens": "6m0s" });
    expect(requestedWaitMs(headers, 0)).toBe(360_000);
    expect(requestedWaitMs(new Headers(), 0)).toBeUndefined();
  });
});

describe("OpenAI provider failures", () => {
  function provider(responses: (() => Response)[], extra: Partial<Parameters<typeof createOpenAIProvider>[0]> = {}) {
    const sleeps: number[] = [];
    let calls = 0;
    const p = createOpenAIProvider({
      model: "m",
      dimensions: 2,
      apiKey: () => "sk-secret-key",
      retryDelaysMs: [1000, 4000],
      sleep: async (ms) => void sleeps.push(ms),
      now: () => 0,
      fetch: (async () => responses[calls++]!()) as unknown as typeof fetch,
      ...extra,
    });
    return { p, sleeps, calls: () => calls };
  }
  const ok = () => Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
  const quota = (code: string) => () =>
    new Response(JSON.stringify({ error: { type: "insufficient_quota", code, message: "You have no credits remaining" } }), { status: 429 });

  test("waits as long as Retry-After asks, capped at a minute", async () => {
    const { p, sleeps } = provider([
      () => new Response("slow", { status: 429, headers: { "retry-after": "3" } }),
      () => new Response("slow", { status: 429, headers: { "retry-after": "600" } }),
      ok,
    ]);
    await p.embed(["a"]);
    expect(sleeps).toEqual([3000, 60_000]);
  });

  test("falls back to the fixed schedule without headers", async () => {
    const { p, sleeps } = provider([() => new Response("", { status: 503 }), ok]);
    await p.embed(["a"]);
    expect(sleeps).toEqual([1000]);
  });

  test.each(["credit_balance_exhausted", "insufficient_quota"])("quota (%s) is not retried", async (code) => {
    const { p, sleeps, calls } = provider([quota(code), ok]);
    const error = await p.embed(["a"]).catch((e) => e as OpenAIEmbeddingError);
    expect(error).toBeInstanceOf(OpenAIEmbeddingError);
    expect(error).toMatchObject({ kind: "quota", status: 429 });
    expect(calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("401 is auth and not retried; the key never appears in the message", async () => {
    const { p, calls } = provider([() => new Response('{"error":{"message":"bad key"}}', { status: 401 })]);
    const error = (await p.embed(["a"]).catch((e) => e)) as OpenAIEmbeddingError;
    expect(error.kind).toBe("auth");
    expect(error.message).not.toContain("sk-secret-key");
    expect(calls()).toBe(1);
  });

  test("429 without a quota body is rate_limit after the attempts run out; 5xx is server", async () => {
    const limited = provider([() => new Response("{}", { status: 429 }), () => new Response("{}", { status: 429 }), () => new Response("{}", { status: 429 })]);
    expect(((await limited.p.embed(["a"]).catch((e) => e)) as OpenAIEmbeddingError).kind).toBe("rate_limit");
    expect(limited.calls()).toBe(3);
    const down = provider([() => new Response("", { status: 500 }), () => new Response("", { status: 500 }), () => new Response("", { status: 502 })]);
    expect(((await down.p.embed(["a"]).catch((e) => e)) as OpenAIEmbeddingError).kind).toBe("server");
  });

  test("a network error is retried, then reported as server", async () => {
    let calls = 0;
    const p = createOpenAIProvider({
      model: "m",
      dimensions: 2,
      apiKey: () => "k",
      retryDelaysMs: [1],
      sleep: async () => {},
      fetch: (async () => {
        calls++;
        throw new Error("connection refused");
      }) as unknown as typeof fetch,
    });
    const error = (await p.embed(["a"]).catch((e) => e)) as OpenAIEmbeddingError;
    expect(error.kind).toBe("server");
    expect(calls).toBe(2);
  });
});

function seed(db: Db, n: number): void {
  db.run(
    "INSERT INTO sessions (id, source, machine, kind, project_path, title, started_at) VALUES ('s1', 'claude-code', 'laptop', 'main', '/p', 't', '2026-11-01T00:00:00.000Z')",
  );
  for (let i = 0; i < n; i++) {
    const text = `chunk ${i}`;
    insertChunk(db, {
      sessionId: "s1",
      startMessageId: i * 2,
      endMessageId: i * 2 + 1,
      ordinal: i * 2,
      part: 0,
      text,
      textHash: createHash("sha256").update(text).digest("hex"),
      tokenEstimate: 2,
      timestamp: "2026-11-01T00:00:00.000Z",
    });
  }
}

function flaky(slug: string, failure: () => Error | null): EmbeddingProvider & { calls: number } {
  const fake = createFakeProvider({ model: "any" });
  const out = {
    slug,
    dimensions: fake.dimensions,
    calls: 0,
    async embed(texts: string[]) {
      out.calls++;
      const error = failure();
      if (error) throw error;
      return fake.embed(texts);
    },
  };
  return out;
}

describe("embed stage backoff, status and alerts", () => {
  let db: Db;
  let clock: number;
  const T0 = Date.parse("2026-11-17T05:00:00Z");
  beforeEach(() => {
    db = openDb(":memory:");
    seed(db, 3);
    clock = T0;
  });
  afterEach(() => db.close());

  const embedAlerts = () => listAlerts(db).filter((a) => a.dedupe_key.startsWith("embedding-error:"));

  test("backoff schedule: 30s, 1m, 2m, 5m, 10m, 10m; quota and auth 15m", () => {
    const transient = [1, 2, 3, 4, 5, 6, 9].map((n) => embedBackoffMs("server", n) / 1000);
    expect(transient).toEqual([30, 60, 120, 300, 600, 600, 600]);
    expect(embedBackoffMs("quota", 1)).toBe(900_000);
    expect(embedBackoffMs("auth", 4)).toBe(900_000);
  });

  test("skips ticks until the next attempt, logs once per failure, and resets on success", async () => {
    let fail: Error | null = new OpenAIEmbeddingError("503", { kind: "server", status: 503 });
    const provider = flaky("fake-bo", () => fail);
    const warn = console.warn;
    const logged: string[] = [];
    console.warn = (m: string) => void logged.push(m);
    try {
      const stage = createEmbedStage({ provider, backlogThreshold: 1000, now: () => clock });
      await stage.run(db);
      await stage.run(db);
      await stage.run(db);
      expect(provider.calls).toBe(1);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain("Retrying in 30 s, at 05:00 UTC");

      clock += 30_000;
      await stage.run(db);
      expect(provider.calls).toBe(2);
      expect(getEmbedError(db, "fake-bo")).toMatchObject({ kind: "server", consecutive_failures: 2, status: 503 });
      clock += 59_000;
      await stage.run(db);
      expect(provider.calls).toBe(2);
      clock += 1000;
      await stage.run(db);
      expect(provider.calls).toBe(3);
      expect(getEmbedError(db, "fake-bo")?.next_attempt_at).toBe(new Date(clock + 120_000).toISOString());

      fail = null;
      clock += 120_000;
      expect(await stage.run(db)).toBe(true);
      expect(getEmbedError(db, "fake-bo")).toBeNull();
      expect(countVectors(db, "fake-bo")).toBe(3);
    } finally {
      console.warn = warn;
    }
  });

  test("resetBackoff retries at once", async () => {
    const provider = flaky("fake-rb", () => new OpenAIEmbeddingError("no key", { kind: "auth" }));
    const stage = createEmbedStage({ provider, backlogThreshold: 1000, now: () => clock, onError: () => {} });
    await stage.run(db);
    await stage.run(db);
    expect(provider.calls).toBe(1);
    stage.resetBackoff();
    await stage.run(db);
    expect(provider.calls).toBe(2);
  });

  test("quota alerts once at the first failure, clears on recovery and alerts again next incident", async () => {
    let fail: Error | null = new OpenAIEmbeddingError("429 quota", { kind: "quota", status: 429 });
    const provider = flaky("openai-qa", () => fail);
    const stage = createEmbedStage({ provider, backlogThreshold: 1000, now: () => clock, onError: () => {} });
    await stage.run(db);
    expect(embedAlerts()).toHaveLength(1);
    expect(embedAlerts()[0]).toMatchObject({ severity: "warning", dedupe_key: "embedding-error:openai-qa:quota" });
    expect(embedAlerts()[0]!.title).toBe("Embedding stopped: OpenAI has no credits remaining (quota)");
    expect(embedAlerts()[0]!.body).toContain("every 15 minutes");

    clock += 15 * 60_000;
    await stage.run(db);
    clock += 15 * 60_000;
    await stage.run(db);
    expect(embedAlerts()).toHaveLength(1);
    expect(getEmbedError(db, "openai-qa")?.next_attempt_at).toBe(new Date(clock + 900_000).toISOString());

    fail = null;
    clock += 15 * 60_000;
    await stage.run(db);
    expect(embedAlerts()).toHaveLength(0);
    const resumed = listAlerts(db).filter((a) => a.title === "Embedding resumed for openai-qa");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.severity).toBe("info");

    insertChunk(db, {
      sessionId: "s1", startMessageId: 99, endMessageId: 100, ordinal: 99, part: 0, text: "later",
      textHash: createHash("sha256").update("later").digest("hex"), tokenEstimate: 1, timestamp: "2026-11-01T00:00:00.000Z",
    });
    fail = new OpenAIEmbeddingError("429 quota", { kind: "quota", status: 429 });
    await stage.run(db);
    expect(embedAlerts()).toHaveLength(1);
  });

  test("transient failures alert only after 30 minutes", async () => {
    const provider = flaky("fake-tr", () => new OpenAIEmbeddingError("503", { kind: "server", status: 503 }));
    const stage = createEmbedStage({ provider, backlogThreshold: 1000, now: () => clock, onError: () => {} });
    await stage.run(db);
    for (let i = 0; i < 6; i++) {
      clock += 5 * 60_000;
      await stage.run(db);
    }
    expect(clock - T0).toBe(30 * 60_000);
    expect(embedAlerts()).toHaveLength(1);
    expect(embedAlerts()[0]!.dedupe_key).toBe("embedding-error:fake-tr:server");
  });

  test("transient failures under 30 minutes do not alert", async () => {
    const provider = flaky("fake-tq", () => new OpenAIEmbeddingError("503", { kind: "server", status: 503 }));
    const stage = createEmbedStage({ provider, backlogThreshold: 1000, now: () => clock, onError: () => {} });
    await stage.run(db);
    clock += 10 * 60_000;
    await stage.run(db);
    clock += 19 * 60_000;
    await stage.run(db);
    expect(embedAlerts()).toHaveLength(0);
  });
});

describe("GET /admin/api/embedding error", () => {
  let h: Harness;
  let dir: string;
  let store: ConfigStore;
  let app: Hono<AppEnv>;
  let cookie: string;
  beforeEach(async () => {
    h = createHarness();
    dir = mkdtempSync(join(tmpdir(), "retrospecticus-emb-err-"));
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ data_dir: h.dataDir, listen_port: 0, embedding: { provider: "ollama", model: "nomic", dimensions: 8 } }),
    );
    store = openConfigStore({ configPath: join(dir, "config.json"), log: { warn: () => {}, error: () => {} } });
    app = createApp({ db: h.db, config: store, configStore: store, adminLoginFailureDelayMs: 0 });
    cookie = (await adminSession(app, h)).cookie;
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    h.cleanup();
  });

  test("is null when healthy and carries the failure when not", async () => {
    let res = await adminGet(app, "/admin/api/embedding", cookie);
    expect(((await res.json()) as { error: unknown }).error).toBeNull();

    seed(h.db, 2);
    const provider: EmbeddingProvider = {
      slug: "ollama-nomic",
      dimensions: 8,
      embed: async () => {
        throw new OpenAIEmbeddingError("ollama embeddings returned 503", { kind: "server", status: 503 });
      },
    };
    await createEmbedStage({ provider, backlogThreshold: 1000, onError: () => {} }).run(h.db);
    res = await adminGet(app, "/admin/api/embedding", cookie);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({
      slug: "ollama-nomic",
      kind: "server",
      status: 503,
      consecutive_failures: 1,
      message: "ollama embeddings returned 503",
    });
    expect(typeof body.error.next_attempt_at).toBe("string");
  });
});
