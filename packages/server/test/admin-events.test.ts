import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../src/app.ts";
import { issueToken, type AppEnv } from "../src/auth.ts";
import { defaultConfig } from "../src/config.ts";
import { ackDriftEvent, upsertDriftEvent } from "../src/db/drift.ts";
import { openDb } from "../src/db/index.ts";
import { events } from "../src/events.ts";
import { ADMIN_HEADERS, adminPost, adminSession, startEnroll } from "./enroll-helpers.ts";
import { createHarness, type Harness } from "./harness.ts";

const PATH = "/admin/api/events";
const FAST = { coalesceMs: 40, keepaliveMs: 60_000, dataVersionPollMs: 60_000 };

let h: Harness;
let app: Hono<AppEnv>;
let cookie: string;
let baseline: number;
const open: Array<() => Promise<void>> = [];

beforeEach(async () => {
  h = createHarness();
  app = createApp({ db: h.db, config: h.config, adminLoginFailureDelayMs: 0, eventStream: FAST });
  cookie = (await adminSession(app, h)).cookie;
  baseline = events.listenerCount();
});
afterEach(async () => {
  for (const close of open.splice(0)) await close();
  h.cleanup();
});

interface Stream {
  status: number;
  /** Resolves with the next `change` event's topics. */
  nextChange(timeoutMs?: number): Promise<string[]>;
  close(): Promise<void>;
}

async function connect(target: Hono<AppEnv> = app, headers: Record<string, string> = { Cookie: cookie }): Promise<Stream> {
  const controller = new AbortController();
  const res = await target.request(PATH, { headers, signal: controller.signal });
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const stream: Stream = {
    status: res.status,
    async nextChange(timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (block.startsWith("event: change")) {
            return (JSON.parse(block.split("data: ")[1]!) as { topics: string[] }).topics;
          }
          continue;
        }
        const left = deadline - Date.now();
        if (left <= 0 || !reader) throw new Error("no change event arrived");
        const next = await Promise.race([
          reader.read(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), left)),
        ]);
        if (next === null) throw new Error("no change event arrived");
        if (next.done) throw new Error("stream ended");
        buffer += decoder.decode(next.value);
      }
    },
    async close() {
      controller.abort();
      await reader?.cancel().catch(() => {});
    },
  };
  open.push(() => stream.close());
  return stream;
}

describe("GET /admin/api/events", () => {
  test("refuses a request that is not signed in", async () => {
    const res = await app.request(PATH);
    expect(res.status).toBe(401);
    expect((await app.request(PATH, { headers: { Cookie: "retrospecticus_admin=nope" } })).status).toBe(401);
  });

  test("answers with an event stream that must not be cached or buffered", async () => {
    const res = await app.request(PATH, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    await res.body!.cancel();
  });

  test("announces machines after a heartbeat", async () => {
    const stream = await connect();
    const token = h.token("ingest", "laptop");
    const res = await app.request("/v1/heartbeat", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ collector_version: "0.0.1", sources: [] }),
    });
    expect(res.status).toBe(200);
    expect(await stream.nextChange()).toContain("machines");
  });

  test("announces enrollments after an enroll start and after an approval", async () => {
    const stream = await connect();
    const started = await startEnroll(app, "desk");
    expect(await stream.nextChange()).toContain("enrollments");
    const pending = (await (await app.request("/admin/api/enrollments", { headers: { Cookie: cookie } })).json()) as {
      enrollments: Array<{ id: number }>;
    };
    const res = await adminPost(app, `/admin/api/enrollments/${pending.enrollments[0]!.id}/approve`, cookie, {
      user_code: started.user_code,
    });
    expect(res.status).toBe(200);
    expect(await stream.nextChange()).toContain("enrollments");
  });

  test("announces drift after an ack", async () => {
    const { id } = upsertDriftEvent(h.db, { source: "codex", severity: "additive", fingerprint: "fp-1" });
    const stream = await connect();
    expect((await adminPost(app, `/admin/api/drift/${id}/ack`, cookie)).status).toBe(200);
    expect(await stream.nextChange()).toContain("drift");
  });

  test("announces tokens after one is created", async () => {
    const stream = await connect();
    expect((await adminPost(app, "/admin/api/tokens", cookie, { scope: "search", name: "x" })).status).toBe(201);
    expect(await stream.nextChange()).toContain("tokens");
  });

  test("merges topics changed within the window into one event", async () => {
    const stream = await connect();
    events.publish("stats");
    events.publish("drift");
    events.publish("stats");
    const topics = await stream.nextChange();
    expect([...topics].sort()).toEqual(["drift", "stats"]);
  });

  test("sends nothing until something changes", async () => {
    const stream = await connect();
    await expect(stream.nextChange(150)).rejects.toThrow("no change event");
  });

  test("refuses connections beyond the cap with 503", async () => {
    const capped = createApp({ db: h.db, config: h.config, adminLoginFailureDelayMs: 0, eventStream: { ...FAST, maxConnections: 2 } });
    const { cookie: c } = await adminSession(capped, h);
    const headers = { Cookie: c };
    const first = await connect(capped, headers);
    await connect(capped, headers);
    expect((await capped.request(PATH, { headers })).status).toBe(503);
    await first.close();
    await Bun.sleep(20);
    const again = await connect(capped, headers);
    expect(again.status).toBe(200);
  });

  test("drops its subscription when the client disconnects", async () => {
    const stream = await connect();
    expect(events.listenerCount()).toBe(baseline + 1);
    await stream.close();
    await Bun.sleep(20);
    expect(events.listenerCount()).toBe(baseline);
  });

  test("ends the stream when the session signs out", async () => {
    const stream = await connect();
    expect(events.listenerCount()).toBe(baseline + 1);
    const res = await app.request("/admin/api/logout", { method: "POST", headers: { ...ADMIN_HEADERS, Cookie: cookie } });
    expect(res.status).toBe(200);
    await expect(stream.nextChange(500)).rejects.toThrow("stream ended");
    expect(events.listenerCount()).toBe(baseline);
  });

  test("ends the stream when the admin token is revoked", async () => {
    const { cookie: c, tokenId } = await adminSession(app, h);
    const stream = await connect(app, { Cookie: c });
    expect((await adminPost(app, `/admin/api/tokens/${tokenId}/revoke`, c)).status).toBe(200);
    await expect(stream.nextChange(500)).rejects.toThrow("stream ended");
  });

  test("keepalive notices a session that ended without a callback", async () => {
    const quick = createApp({ db: h.db, config: h.config, adminLoginFailureDelayMs: 0, eventStream: { ...FAST, keepaliveMs: 30 } });
    const { cookie: c, tokenId } = await adminSession(quick, h);
    const stream = await connect(quick, { Cookie: c });
    h.db.run("UPDATE tokens SET revoked_at = ? WHERE id = ?", [new Date().toISOString(), tokenId]);
    await expect(stream.nextChange(500)).rejects.toThrow("stream ended");
  });
});

describe("changes made by another connection", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "retrospecticus-events-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("reach the stream through the database's data version", async () => {
    const path = join(dir, "db.sqlite");
    const first = openDb(path);
    const second = openDb(path);
    try {
      const polling = createApp({
        db: first,
        config: defaultConfig({ data_dir: dir }),
        adminLoginFailureDelayMs: 0,
        eventStream: { ...FAST, dataVersionPollMs: 50 },
      });
      const { token } = issueToken(first, { scope: "admin" });
      const signedIn = await polling.request("/admin/api/login", { method: "POST", headers: ADMIN_HEADERS, body: JSON.stringify({ token }) });
      const c = signedIn.headers.get("Set-Cookie")!.split(";")[0]!;
      const { id } = upsertDriftEvent(first, { source: "codex", severity: "additive", fingerprint: "fp-2" });
      const stream = await connect(polling, { Cookie: c });
      await Bun.sleep(120);
      ackDriftEvent(second, id);
      const topics = await stream.nextChange(2000);
      expect(topics).toEqual(expect.arrayContaining(["drift", "machines", "stats", "tokens", "enrollments", "embedding"]));
      expect(topics).not.toContain("settings");
    } finally {
      for (const close of open.splice(0)) await close();
      first.close();
      second.close();
    }
  });
});
