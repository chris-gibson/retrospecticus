import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../src/app.ts";
import type { AppEnv } from "../src/auth.ts";
import { openConfigStore, type ConfigStore } from "../src/config-store.ts";
import { getDriftEvent, listOpenDriftEvents, listQuarantine } from "../src/db/drift.ts";
import { runParse } from "../src/indexer/parse.ts";
import { claudeCodeParser, parsers, withIgnoredTypes } from "../src/parsers/index.ts";
import { buildWiring, type Wiring } from "../src/wiring.ts";
import { adminGet, adminPost, adminSession } from "./enroll-helpers.ts";
import { archive } from "./fixture-helpers.ts";
import { createHarness, type Harness } from "./harness.ts";

let h: Harness;
let dir: string;
let store: ConfigStore;
let app: Hono<AppEnv>;
let wiring: Wiring;
let cookie: string;

const jsonl = (lines: unknown[]) => lines.map((l) => `${JSON.stringify(l)}\n`).join("");
const user = { type: "user", uuid: "u-1", parentUuid: null, sessionId: "s-1", timestamp: "2026-11-16T10:00:00.000Z", cwd: "/w", version: "2.1.325", message: { role: "user", content: "hi" } };
const hologram = (n: number) => ({ type: "hologram", sessionId: "s-1", body: `b${n}` });
const bad = { type: "user", sessionId: "s-1", message: 5 };

function index(): void {
  while (runParse(h.db, h.rawDir, wiring.parsers, wiring.observers).didWork) {
    // until idle
  }
}

beforeEach(async () => {
  h = createHarness();
  dir = mkdtempSync(join(tmpdir(), "retrospecticus-admin-drift-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ data_dir: h.dataDir, listen_port: 0 }));
  store = openConfigStore({ configPath: join(dir, "config.json"), log: { warn: () => {}, error: () => {} } });
  wiring = buildWiring(h.db, store);
  app = createApp({ db: h.db, config: store, configStore: store, adminLoginFailureDelayMs: 0, wiring });
  cookie = (await adminSession(app, h)).cookie;
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  h.cleanup();
});

async function listing() {
  const res = await adminGet(app, "/admin/api/drift", cookie);
  expect(res.status).toBe(200);
  return (await res.json()) as { events: Array<Record<string, any>>; ignore_types: Record<string, string[]> };
}

describe("withIgnoredTypes", () => {
  const line = JSON.stringify(hologram(1));
  const ctx = () => ({ source: "claude-code" as const, machine: "m", path: "p", state: {} });

  test("turns a listed unknown type into ignored and reads the list on every call", () => {
    let list: string[] = [];
    const wrapped = withIgnoredTypes(parsers, (s) => (s === "claude-code" ? list : []));
    expect(wrapped["claude-code"].parse(line, ctx()).kind).toBe("unknown");
    list = ["hologram"];
    expect(wrapped["claude-code"].parse(line, ctx())).toEqual({ kind: "ignored", recordType: "hologram" });
    expect(wrapped.codex.parse(line, { ...ctx(), source: "codex" }).kind).toBe("unknown");
  });

  test("leaves validation failures, malformed JSON and handled records alone", () => {
    const wrapped = withIgnoredTypes(parsers, () => ["user", "(malformed)", "hologram"]);
    const parser = wrapped["claude-code"];
    for (const text of [JSON.stringify(bad), "{not json", JSON.stringify(user)]) {
      expect(parser.parse(text, ctx())).toEqual(claudeCodeParser.parse(text, ctx()));
    }
    expect(parser.parse(JSON.stringify(bad), ctx())).toMatchObject({ kind: "unknown", reason: "validation" });
  });

  test("passes the type lists through unchanged", () => {
    const wrapped = withIgnoredTypes(parsers, () => ["hologram"]);
    expect(wrapped["claude-code"].ignoredTypes).toBe(claudeCodeParser.ignoredTypes);
    expect(wrapped["claude-code"].handledTypes).toBe(claudeCodeParser.handledTypes);
  });
});

describe("drift admin API", () => {
  beforeEach(() => {
    archive(h.db, h.rawDir, { source: "claude-code", path: "p/s.jsonl" }, jsonl([user, hologram(1), hologram(2), bad]));
    index();
  });

  test("lists open events with whether each can be ignored", async () => {
    const { events, ignore_types } = await listing();
    expect(ignore_types).toEqual({ "claude-code": [], codex: [] });
    const byType = Object.fromEntries(events.filter((e) => e.severity === "breaking").map((e) => [e.discriminator, e]));
    expect(byType["hologram"]).toMatchObject({ source: "claude-code", count: 2, status: "open", ignorable: true, harness_version: "2.1.325" });
    expect(byType["user"].ignorable).toBe(false);
  });

  test("ignore updates the config, reparses that fingerprint only and acks the event", async () => {
    const { events } = await listing();
    const holo = events.find((e) => e.discriminator === "hologram")!;
    expect(listQuarantine(h.db)).toHaveLength(3);

    const res = await adminPost(app, `/admin/api/drift/${holo.id}/ignore`, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.reparsed).toEqual({ lines: 2, messages: 0, quarantined: 1 });
    expect(store.current().drift.ignore_types["claude-code"]).toEqual(["hologram"]);
    expect(listQuarantine(h.db).map((q) => q.reason)).toEqual(["validation"]);
    expect(getDriftEvent(h.db, holo.id)!.status).toBe("acked");
    expect(listOpenDriftEvents(h.db).some((e) => e.discriminator === "hologram")).toBe(false);

    const again = await adminPost(app, `/admin/api/drift/${holo.id}/ignore`, cookie);
    expect(again.status).toBe(200);
    expect(store.current().drift.ignore_types["claude-code"]).toEqual(["hologram"]);
  });

  test("new lines of an ignored type are skipped without drift", async () => {
    const { events } = await listing();
    await adminPost(app, `/admin/api/drift/${events.find((e) => e.discriminator === "hologram")!.id}/ignore`, cookie);
    archive(h.db, h.rawDir, { source: "claude-code", path: "p/t.jsonl" }, jsonl([hologram(9)]));
    index();
    expect(listQuarantine(h.db)).toHaveLength(1);
  });

  test("refuses to ignore an event that is not an unknown type", async () => {
    const { events } = await listing();
    const invalid = events.find((e) => e.discriminator === "user" && e.severity === "breaking")!;
    const res = await adminPost(app, `/admin/api/drift/${invalid.id}/ignore`, cookie);
    expect(res.status).toBe(400);
    expect(store.current().drift.ignore_types["claude-code"]).toEqual([]);
    expect((await adminPost(app, "/admin/api/drift/9999/ignore", cookie)).status).toBe(404);
  });

  test("ack closes an event without touching the config", async () => {
    const { events } = await listing();
    const id = events.find((e) => e.discriminator === "hologram")!.id;
    expect((await adminPost(app, `/admin/api/drift/${id}/ack`, cookie)).status).toBe(200);
    expect(getDriftEvent(h.db, id)!.status).toBe("acked");
    expect(store.current().drift.ignore_types["claude-code"]).toEqual([]);
    expect((await adminPost(app, "/admin/api/drift/9999/ack", cookie)).status).toBe(404);
  });

  test("unignore removes the type so new lines raise drift again", async () => {
    const { events } = await listing();
    await adminPost(app, `/admin/api/drift/${events.find((e) => e.discriminator === "hologram")!.id}/ignore`, cookie);
    const res = await adminPost(app, "/admin/api/drift/unignore", cookie, { source: "claude-code", type: "hologram" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).ignore_types).toEqual({ "claude-code": [], codex: [] });
    expect(store.current().drift.ignore_types["claude-code"]).toEqual([]);
    expect((await adminPost(app, "/admin/api/drift/unignore", cookie, { source: "nope", type: "x" })).status).toBe(400);
  });

  test("an app without a config store refuses to ignore", async () => {
    const plain = createApp({ db: h.db, config: h.config, adminLoginFailureDelayMs: 0 });
    const { cookie: c } = await adminSession(plain, h);
    const id = listOpenDriftEvents(h.db).find((e) => e.discriminator === "hologram")!.id;
    expect((await adminPost(plain, `/admin/api/drift/${id}/ignore`, c)).status).toBe(400);
  });
});
