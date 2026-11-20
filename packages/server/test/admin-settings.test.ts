import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../src/app.ts";
import type { AppEnv } from "../src/auth.ts";
import { openConfigStore, type ConfigStore } from "../src/config-store.ts";
import { insertChunk } from "../src/db/chunks.ts";
import { activateModel, ensureModel, getActiveModel, insertVectors } from "../src/db/vectors.ts";
import { ADMIN_HEADERS, adminGet, adminPost, adminSession } from "./enroll-helpers.ts";
import { createHarness, type Harness } from "./harness.ts";

let h: Harness;
let dir: string;
let store: ConfigStore;
let app: Hono<AppEnv>;
let cookie: string;

const SECRET_VALUES = {
  embedding_api_key: "sk-test-SECRET-embedding-0001",
  discord_webhook_url: "https://discord.example/api/webhooks/SECRET-hook-0002",
  smtp_url: "smtps://user:SECRET-pass-0003@mail.example:465",
};

beforeEach(async () => {
  h = createHarness();
  dir = mkdtempSync(join(tmpdir(), "retrospecticus-admin-settings-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ data_dir: h.dataDir, listen_port: 0 }));
  store = openConfigStore({ configPath: join(dir, "config.json"), log: { warn: () => {}, error: () => {} } });
  app = createApp({ db: h.db, config: store, configStore: store, adminLoginFailureDelayMs: 0 });
  cookie = (await adminSession(app, h)).cookie;
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  h.cleanup();
});

async function getSettings() {
  const res = await adminGet(app, "/admin/api/settings", cookie);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    config: Record<string, any>;
    version: string;
    secrets: Record<string, { set: boolean; updated_at: string | null }>;
    pending_restart: string[];
    last_error: string | null;
    restart_required_keys: string[];
    paths: { config: string; secrets: string };
    secrets_permission_problem: string | null;
  };
}

describe("GET /admin/api/settings", () => {
  test("returns the config with defaults, version, secret status and paths, but never secret values", async () => {
    for (const [name, value] of Object.entries(SECRET_VALUES)) store.setSecret(name as keyof typeof SECRET_VALUES, value);
    const res = await adminGet(app, "/admin/api/settings", cookie);
    const text = await res.text();
    for (const value of Object.values(SECRET_VALUES)) {
      expect(text).not.toContain(value);
      expect(text).not.toContain(value.slice(8, 20));
    }
    const s = JSON.parse(text);
    expect(s.config.indexer.chunk_tokens).toBe(400);
    expect(s.config.data_dir).toBe(h.dataDir);
    expect(s.version).toBe(store.version());
    expect(s.secrets.smtp_url.set).toBe(true);
    expect(typeof s.secrets.smtp_url.updated_at).toBe("string");
    expect(Object.keys(s.secrets.embedding_api_key).sort()).toEqual(["set", "updated_at"]);
    expect(s.restart_required_keys).toEqual(["data_dir", "listen_host", "listen_port"]);
    expect(s.paths).toEqual({ config: join(dir, "config.json"), secrets: join(dir, "secrets.json") });
    expect(s.pending_restart).toEqual([]);
    expect(s.last_error).toBeNull();
    expect(s.secrets_permission_problem).toBeNull();
  });

  test("an app without a store refuses with a readable reason", async () => {
    const plain = createApp({ db: h.db, config: h.config, adminLoginFailureDelayMs: 0 });
    const { cookie: c } = await adminSession(plain, h);
    const res = await adminGet(plain, "/admin/api/settings", c);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain("config file");
  });
});

describe("POST /admin/api/settings", () => {
  test("saves to the file and applies live", async () => {
    const { config, version } = await getSettings();
    config.search.keyword_weight = 3.5;
    config.listen_port = 9999;
    const res = await adminPost(app, "/admin/api/settings", cookie, { config, version });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string; pending_restart: string[] };
    expect(body.version).toBe(store.version());
    expect(body.version).not.toBe(version);
    expect(body.pending_restart).toEqual(["listen_port"]);
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).search.keyword_weight).toBe(3.5);
    expect(store.current().search.keyword_weight).toBe(3.5);
    expect((await getSettings()).pending_restart).toEqual(["listen_port"]);
  });

  test("oMLX cannot be saved without its own key, even with an OpenAI key saved", async () => {
    const { config, version } = await getSettings();
    config.embedding = { provider: "omlx", model: "embeddinggemma-2-bf16", dimensions: 768 };
    const refused = await adminPost(app, "/admin/api/settings", cookie, { config, version });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toContain("oMLX needs its API key");
    expect(store.current().embedding.provider).toBe("none");
    expect((await adminPost(app, "/admin/api/secrets/embedding_api_key", cookie, { value: "sk-openai" })).status).toBe(200);
    expect((await adminPost(app, "/admin/api/settings", cookie, { config, version })).status).toBe(400);
    expect((await adminPost(app, "/admin/api/secrets/omlx_api_key", cookie, { value: "omlx-key" })).status).toBe(200);
    expect((await adminPost(app, "/admin/api/settings", cookie, { config, version })).status).toBe(200);
    expect(store.current().embedding.provider).toBe("omlx");
  });

  test("409 with both versions when the file changed meanwhile", async () => {
    const { config, version } = await getSettings();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ data_dir: h.dataDir, listen_port: 0, search: { vector_weight: 4 } }));
    config.search.keyword_weight = 7;
    const res = await adminPost(app, "/admin/api/settings", cookie, { config, version });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { expected_version: string; actual_version: string };
    expect(body.expected_version).toBe(version);
    expect(body.actual_version).toMatch(/^[0-9a-f]{64}$/);
    expect(body.actual_version).not.toBe(version);
    expect(store.current().search.keyword_weight).toBe(2);
  });

  test("400 maps schema issues to field paths and writes nothing", async () => {
    const before = readFileSync(join(dir, "config.json"), "utf8");
    const { config, version } = await getSettings();
    config.indexer.chunk_tokens = 10;
    config.indexer.chunk_overlap_tokens = 50;
    config.alerts.digest_hour = 30;
    config.listen_port = "x";
    config.bogus = 1;
    const res = await adminPost(app, "/admin/api/settings", cookie, { config, version });
    expect(res.status).toBe(400);
    const { issues } = (await res.json()) as { issues: { path: string; message: string }[] };
    const paths = issues.map((i) => i.path);
    expect(paths).toContain("indexer.chunk_tokens");
    expect(paths).toContain("alerts.digest_hour");
    expect(paths).toContain("listen_port");
    expect(paths).toContain("");
    expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(before);
  });

  test("400 maps notifier and embedding errors to their sections", async () => {
    const { config, version } = await getSettings();
    config.notifiers = { email: { from: "a@example.com" } };
    let res = await adminPost(app, "/admin/api/settings", cookie, { config, version });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { issues: { path: string }[] }).issues[0]!.path).toBe("notifiers.email");

    config.notifiers = {};
    config.embedding = { provider: "ollama", model: "mystery-model" };
    res = await adminPost(app, "/admin/api/settings", cookie, { config, version });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { issues: { path: string }[] }).issues[0]!.path).toBe("embedding");
  });

  test("400 for a malformed body", async () => {
    expect((await adminPost(app, "/admin/api/settings", cookie, { config: {} })).status).toBe(400);
  });
});

describe("secrets", () => {
  test("set and unset, written with mode 0600, value never echoed", async () => {
    const res = await adminPost(app, "/admin/api/secrets/discord_webhook_url", cookie, { value: SECRET_VALUES.discord_webhook_url });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET_VALUES.discord_webhook_url);
    expect(JSON.parse(text).status.set).toBe(true);
    expect(store.getSecret("discord_webhook_url")).toBe(SECRET_VALUES.discord_webhook_url);
    expect(statSync(join(dir, "secrets.json")).mode & 0o777).toBe(0o600);

    const unset = await adminPost(app, "/admin/api/secrets/discord_webhook_url/unset", cookie);
    expect(unset.status).toBe(200);
    expect(((await unset.json()) as { status: { set: boolean } }).status.set).toBe(false);
    expect(store.getSecret("discord_webhook_url")).toBeUndefined();
    expect(statSync(join(dir, "secrets.json")).mode & 0o777).toBe(0o600);
  });

  test("unknown names and empty values are refused", async () => {
    expect((await adminPost(app, "/admin/api/secrets/nope", cookie, { value: "x" })).status).toBe(404);
    expect((await adminPost(app, "/admin/api/secrets/nope/unset", cookie)).status).toBe(404);
    expect((await adminPost(app, "/admin/api/secrets/smtp_url", cookie, { value: "" })).status).toBe(400);
    expect((await adminPost(app, "/admin/api/secrets/smtp_url", cookie, {})).status).toBe(400);
  });
});

describe("embedding models", () => {
  function seedChunks(n: number): number[] {
    h.db.run(
      "INSERT INTO sessions (id, source, machine, kind, project_path, title, started_at) VALUES ('s1', 'claude-code', 'laptop', 'main', '/p', 't', '2026-11-01T09:00:00.000Z')",
    );
    return Array.from({ length: n }, (_, i) =>
      insertChunk(h.db, {
        sessionId: "s1",
        startMessageId: i,
        endMessageId: i,
        ordinal: i,
        part: 0,
        text: `chunk ${i}`,
        textHash: `hash${i}`,
        tokenEstimate: 2,
        timestamp: "2026-11-01T10:00:00.000Z",
      }),
    );
  }

  test("lists models with counts and the configured slug; activation refuses missing vectors unless forced", async () => {
    const ids = seedChunks(2);
    ensureModel(h.db, { slug: "fake-a", provider: "fake", model: "a", dimensions: 4 });
    ensureModel(h.db, { slug: "fake-b", provider: "fake", model: "b", dimensions: 4 });
    activateModel(h.db, "fake-a");
    insertVectors(h.db, "fake-b", [{ chunkId: ids[0]!, embedding: new Float32Array([1, 0, 0, 0]) }]);
    const { config, version } = await getSettings();
    config.embedding = { provider: "fake", model: "b", dimensions: 4 };
    expect((await adminPost(app, "/admin/api/settings", cookie, { config, version })).status).toBe(200);

    const res = await adminGet(app, "/admin/api/embedding", cookie);
    const e = (await res.json()) as { models: any[]; configured: string; active: string };
    expect(e.configured).toBe("fake-b");
    expect(e.active).toBe("fake-a");
    expect(e.models.find((m) => m.slug === "fake-b")).toMatchObject({ vectors: 1, missing: 1, active: false });

    const refused = await adminPost(app, "/admin/api/embedding/activate", cookie, { slug: "fake-b" });
    expect(refused.status).toBe(409);
    expect(getActiveModel(h.db)?.slug).toBe("fake-a");

    expect((await adminPost(app, "/admin/api/embedding/activate", cookie, { slug: "fake-b", force: true })).status).toBe(200);
    expect(getActiveModel(h.db)?.slug).toBe("fake-b");

    insertVectors(h.db, "fake-a", ids.map((chunkId) => ({ chunkId, embedding: new Float32Array([0, 1, 0, 0]) })));
    expect((await adminPost(app, "/admin/api/embedding/activate", cookie, { slug: "fake-a" })).status).toBe(200);
    expect(getActiveModel(h.db)?.slug).toBe("fake-a");

    expect((await adminPost(app, "/admin/api/embedding/activate", cookie, { slug: "fake-zzz" })).status).toBe(404);
    expect((await adminPost(app, "/admin/api/embedding/activate", cookie, {})).status).toBe(400);
  });
});

describe("every new endpoint needs a session and passes the CSRF guard", () => {
  const posts: [string, unknown][] = [
    ["/admin/api/settings", { config: {}, version: "" }],
    ["/admin/api/secrets/smtp_url", { value: "smtp://x" }],
    ["/admin/api/secrets/smtp_url/unset", {}],
    ["/admin/api/embedding/activate", { slug: "fake-a", force: true }],
    ["/admin/api/ollama/models", { base_url: "http://127.0.0.1:1/v1" }],
    ["/admin/api/omlx/models", { base_url: "http://127.0.0.1:1/v1" }],
    ["/admin/api/test/embedding", { embedding: { provider: "fake" } }],
    ["/admin/api/test/notifier", { name: "log" }],
  ];
  const gets = ["/admin/api/settings", "/admin/api/embedding"];

  test.each(gets)("GET %s without a session is 401", async (path) => {
    expect((await app.request(path)).status).toBe(401);
    expect((await adminGet(app, path, "retrospecticus_admin=forged")).status).toBe(401);
  });

  test.each(posts)("POST %s needs a session", async (path, body) => {
    const res = await app.request(path, { method: "POST", headers: ADMIN_HEADERS, body: JSON.stringify(body) });
    expect(res.status).toBe(401);
  });

  test.each(posts)("POST %s needs JSON and the admin header", async (path, body) => {
    const text = JSON.stringify(body);
    const attempts: RequestInit[] = [
      { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: text },
      { method: "POST", headers: { Cookie: cookie, "Content-Type": "text/plain", "X-Retrospecticus-Admin": "1" }, body: text },
      { method: "POST", headers: { Cookie: cookie, "X-Retrospecticus-Admin": "1" }, body: text },
      { method: "PUT", headers: { Cookie: cookie, ...ADMIN_HEADERS }, body: text },
    ];
    for (const init of attempts) expect((await app.request(path, init)).status).toBe(403);
    expect(store.secretStatus().smtp_url.set).toBe(false);
  });
});
