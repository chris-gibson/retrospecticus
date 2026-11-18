import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Hono } from "hono";
import { createApp } from "../src/app.ts";
import type { AppEnv } from "../src/auth.ts";
import { defaultConfig, type ServerConfigInput } from "../src/config.ts";
import { staticConfig } from "../src/config-store.ts";
import { ollamaTagsUrl, toOllamaModels } from "../src/admin/probes.ts";
import type { SecretName } from "../src/secrets.ts";
import { adminPost, adminSession } from "./enroll-helpers.ts";
import { createHarness, type Harness } from "./harness.ts";

let h: Harness;
let server: ReturnType<typeof Bun.serve>;
let requests: { path: string; auth: string | null; body: any }[];
let logSpy: ReturnType<typeof spyOn>;

const OLLAMA_DIMS = 7;

beforeEach(() => {
  h = createHarness();
  requests = [];
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body: any = req.method === "POST" ? await req.json().catch(() => null) : null;
      requests.push({ path: url.pathname, auth: req.headers.get("Authorization"), body });
      if (url.pathname === "/api/tags") {
        return Response.json({
          models: [
            { name: "llama3:8b", model: "llama3:8b" },
            { name: "nomic-embed-text:latest", model: "nomic-embed-text:latest" },
            { name: "qwen3-embedding:0.6b", capabilities: ["embedding"] },
            { name: "gemma3", capabilities: ["completion", "vision"] },
          ],
        });
      }
      if (url.pathname.endsWith("/embeddings")) {
        if (body?.model === "broken") return new Response("model 'broken' not found, key sk-candidate-key-123", { status: 404 });
        const dims = body?.model?.startsWith("text-embedding-3-small") ? 1536 : OLLAMA_DIMS;
        return Response.json({
          data: (body.input as string[]).map((_, index) => ({ index, embedding: Array.from({ length: dims }, () => 0.1) })),
        });
      }
      if (url.pathname === "/hook") return new Response(null, { status: 204 });
      if (url.pathname === "/hook-fails") return new Response("nope", { status: 500 });
      if (url.pathname === "/slow") return new Promise(() => {});
      return new Response("not found", { status: 404 });
    },
  });
});
afterEach(() => {
  server.stop(true);
  logSpy.mockRestore();
  h.cleanup();
});

async function signedIn(config: ServerConfigInput = {}, secrets: Partial<Record<SecretName, string>> = {}) {
  const view = staticConfig(defaultConfig({ data_dir: h.dataDir, ...config }), secrets);
  const app = createApp({
    db: h.db,
    config: view,
    adminLoginFailureDelayMs: 0,
  });
  const { cookie } = await adminSession(app, h);
  return { app, cookie };
}

async function post(ctx: { app: Hono<AppEnv>; cookie: string }, path: string, body: unknown) {
  const res = await adminPost(ctx.app, path, ctx.cookie, body);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const base = () => `${server.url.origin}/v1`;

describe("Ollama model discovery", () => {
  test("the tags URL sits beside /v1, and only http(s) is allowed", () => {
    expect(ollamaTagsUrl("http://h:11434/v1")?.href).toBe("http://h:11434/api/tags");
    expect(ollamaTagsUrl("http://h:11434/v1/")?.href).toBe("http://h:11434/api/tags");
    expect(ollamaTagsUrl("http://h:11434")?.href).toBe("http://h:11434/api/tags");
    expect(ollamaTagsUrl("https://h/ollama/v1?x=1")?.href).toBe("https://h/ollama/api/tags");
    for (const bad of ["file:///etc/passwd", "ftp://h/", "javascript:alert(1)", "not a url"]) expect(ollamaTagsUrl(bad)).toBeNull();
  });

  test("embedding models come first, by capability when listed, else by name", () => {
    const models = toOllamaModels({
      models: [{ name: "zeta" }, { name: "bge-m3" }, { name: "x", capabilities: ["embedding"] }, { name: "all-minilm", capabilities: ["completion"] }],
    });
    expect(models.map((m) => [m.name, m.embedding])).toEqual([
      ["bge-m3", true],
      ["x", true],
      ["all-minilm", false],
      ["zeta", false],
    ]);
  });

  test("lists models from a fake Ollama", async () => {
    const ctx = await signedIn();
    const res = await post(ctx, "/admin/api/ollama/models", { base_url: base() });
    expect(res.status).toBe(200);
    expect(res.body.models.map((m: any) => m.name)).toEqual([
      "nomic-embed-text:latest",
      "qwen3-embedding:0.6b",
      "gemma3",
      "llama3:8b",
    ]);
    expect(res.body.models[1].capabilities).toEqual(["embedding"]);
    expect(requests.map((r) => r.path)).toEqual(["/api/tags"]);
  });

  test("refuses non-http addresses and reports an unreachable one", async () => {
    const ctx = await signedIn();
    expect((await post(ctx, "/admin/api/ollama/models", { base_url: "file:///etc/passwd" })).status).toBe(400);
    expect((await post(ctx, "/admin/api/ollama/models", {})).status).toBe(400);
    const down = await post(ctx, "/admin/api/ollama/models", { base_url: "http://127.0.0.1:1/v1" });
    expect(down.status).toBe(502);
    expect(down.body.error).toContain("cannot reach Ollama");
  });
});

describe("POST /admin/api/test/embedding", () => {
  test("the fake provider embeds with the preset prefixes logic", async () => {
    const ctx = await signedIn();
    const res = await post(ctx, "/admin/api/test/embedding", { embedding: { provider: "fake", model: "embeddinggemma", dimensions: 16 } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, slug: "fake-embeddinggemma", dimensions: 16, document_prefix: "title: none | text: " });
    expect(typeof res.body.latency_ms).toBe("number");
  });

  test("Ollama with an unknown model probes its dimensions, then embeds through the provider", async () => {
    const ctx = await signedIn();
    const res = await post(ctx, "/admin/api/test/embedding", { embedding: { provider: "ollama", model: "nomic-embed-text", base_url: base() } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ slug: "ollama-nomic-embed-text", dimensions: OLLAMA_DIMS, probed_dimensions: true });
    expect(requests.map((r) => r.path)).toEqual(["/v1/embeddings", "/v1/embeddings"]);
    expect(requests.every((r) => r.auth === null)).toBe(true);
  });

  test("OpenAI uses a candidate key without storing it, or the saved key", async () => {
    const ctx = await signedIn({}, { embedding_api_key: "sk-saved" });
    const candidate = await post(ctx, "/admin/api/test/embedding", {
      embedding: { provider: "openai", model: "text-embedding-3-small", base_url: base() },
      api_key: "sk-candidate",
    });
    expect(candidate.status).toBe(200);
    expect(candidate.body).toMatchObject({ slug: "openai-text-embedding-3-small", dimensions: 1536, probed_dimensions: false });
    expect(requests.at(-1)!.auth).toBe("Bearer sk-candidate");

    const saved = await post(ctx, "/admin/api/test/embedding", { embedding: { provider: "openai", base_url: base() } });
    expect(saved.status).toBe(200);
    expect(requests.at(-1)!.auth).toBe("Bearer sk-saved");
  });

  test("errors are short and do not echo the key", async () => {
    const ctx = await signedIn();
    const res = await post(ctx, "/admin/api/test/embedding", {
      embedding: { provider: "openai", model: "broken", dimensions: 3, base_url: base() },
      api_key: "sk-candidate-key-123",
    });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("404");
    expect(res.body.error).not.toContain("sk-candidate-key-123");
    expect(res.body.error.length).toBeLessThanOrEqual(240);

    const nokey = await post(ctx, "/admin/api/test/embedding", { embedding: { provider: "openai", base_url: base() } });
    expect(nokey.status).toBe(502);
    expect(nokey.body.error).toContain("embedding_api_key");
  });

  test("refuses none, bad settings and non-http addresses", async () => {
    const ctx = await signedIn();
    expect((await post(ctx, "/admin/api/test/embedding", { embedding: { provider: "none" } })).status).toBe(400);
    expect((await post(ctx, "/admin/api/test/embedding", { embedding: { provider: "fake", dimensions: -1 } })).status).toBe(400);
    expect((await post(ctx, "/admin/api/test/embedding", { embedding: { provider: "ollama", base_url: "ftp://h/v1" } })).status).toBe(400);
    expect((await post(ctx, "/admin/api/test/embedding", {})).status).toBe(400);
  });
});

describe("POST /admin/api/test/notifier", () => {
  test("sends a sample through the saved Discord config and secret", async () => {
    const ctx = await signedIn({ notifiers: { discord: {} } }, { discord_webhook_url: `${server.url.origin}/hook` });
    const res = await post(ctx, "/admin/api/test/notifier", { name: "discord" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, name: "discord" });
    const hook = requests.find((r) => r.path === "/hook")!;
    expect(hook.body.content).toContain("Retrospecticus test alert");
  });

  test("reports a failing webhook without echoing its URL", async () => {
    const url = `${server.url.origin}/hook-fails`;
    const ctx = await signedIn({ notifiers: { discord: {} } }, { discord_webhook_url: url });
    const res = await post(ctx, "/admin/api/test/notifier", { name: "discord" });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("500");
    expect(res.body.error).not.toContain(url);
  });

  test("a missing secret, an unconfigured notifier and a bad body are reported", async () => {
    const missing = await signedIn({ notifiers: { discord: {} } });
    const res = await post(missing, "/admin/api/test/notifier", { name: "discord" });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("discord_webhook_url");

    const none = await signedIn();
    expect((await post(none, "/admin/api/test/notifier", { name: "discord" })).status).toBe(400);
    expect((await post(none, "/admin/api/test/notifier", {})).status).toBe(400);
    expect((await post(none, "/admin/api/test/notifier", { name: "log" })).status).toBe(200);
  });

  test("a webhook that never answers times out", async () => {
    const view = staticConfig(defaultConfig({ data_dir: h.dataDir, notifiers: { discord: {} } }), {
      discord_webhook_url: `${server.url.origin}/slow`,
    });
    const { registerAdminRoutes } = await import("../src/admin/routes.ts");
    const { Hono } = await import("hono");
    const app = new Hono<AppEnv>();
    app.use(async (c, next) => {
      c.set("db", h.db);
      await next();
    });
    registerAdminRoutes(app, { db: h.db, now: () => new Date(), loginFailureDelayMs: 0, config: view, probeTimeoutsMs: { notify: 100 } });
    const { cookie } = await adminSession(app, h);
    const res = await post({ app, cookie }, "/admin/api/test/notifier", { name: "discord" });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("did not answer");
  });
});
