import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HEARTBEAT_PATH, MAX_APPEND_BODY_BYTES, VERSION } from "@retrospecticus/shared";
import { getFile, getLatestGeneration, listFiles } from "../src/db/files.ts";
import { getMachine } from "../src/db/machines.ts";
import { appendToArchive, normalizeIngestPath, reconcileArchive } from "../src/ingest/archive.ts";
import { createHarness, type Harness } from "./harness.ts";

const KEY = { machine: "laptop", source: "claude-code", path: "proj/session.jsonl" } as const;
const STORED = "laptop/claude-code/proj/session.jsonl";

let h: Harness;
let token: string;

beforeEach(() => {
  h = createHarness();
  token = h.token("ingest", "laptop");
});
afterEach(() => h.cleanup());

describe("append", () => {
  test("stores bytes and reports the new size", async () => {
    const res = await h.append({ token, body: '{"a":1}\n' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ size: 8, generation: 0 });
    expect(h.archived(STORED).toString()).toBe('{"a":1}\n');
    expect(getFile(h.db, KEY, 0)?.size).toBe(8);
    expect(h.ingestCount()).toBe(1);
  });

  test("re-sending the same bytes is refused and nothing is duplicated", async () => {
    const body = '{"a":1}\n';
    expect((await h.append({ token, body })).status).toBe(200);

    const again = await h.append({ token, body });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ size: 8, generation: 0 });
    expect(h.archived(STORED).toString()).toBe(body);
    expect(getFile(h.db, KEY, 0)?.size).toBe(8);
    expect(h.ingestCount()).toBe(1);
  });

  test("an offset that is not the current size is refused, in either direction", async () => {
    await h.append({ token, body: "0123456789\n" });

    for (const offset of [5, 50]) {
      const res = await h.append({ token, offset, body: "more\n" });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ size: 11, generation: 0 });
    }
    expect(h.archived(STORED).toString()).toBe("0123456789\n");

    const resumed = await h.append({ token, offset: 11, body: "more\n" });
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toEqual({ size: 16, generation: 0 });
    expect(h.archived(STORED).toString()).toBe("0123456789\nmore\n");
  });

  test("a new path must start at generation 0, offset 0", async () => {
    for (const attempt of [{ offset: 4 }, { generation: 1 }, { generation: 3, offset: 9 }]) {
      const res = await h.append({ token, body: "x\n", ...attempt });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ size: 0, generation: 0 });
    }
    expect(listFiles(h.db)).toEqual([]);
    expect(existsSync(join(h.rawDir, STORED))).toBe(false);
  });

  test("after a crash between the write and the row update, the disk size wins", async () => {
    await h.append({ token, body: "line one\n" });
    // The process died after fsync but before files.size moved.
    appendFileSync(join(h.rawDir, STORED), "line two\n");
    expect(getFile(h.db, KEY, 0)?.size).toBe(9);

    const retry = await h.append({ token, offset: 9, body: "line two\n" });
    expect(retry.status).toBe(409);
    expect(await retry.json()).toEqual({ size: 18, generation: 0 });
    expect(getFile(h.db, KEY, 0)?.size).toBe(18);

    const resumed = await h.append({ token, offset: 18, body: "line three\n" });
    expect(resumed.status).toBe(200);
    expect(h.archived(STORED).toString()).toBe("line one\nline two\nline three\n");
    expect(getFile(h.db, KEY, 0)?.size).toBe(29);
  });

  test("a crash that lost the row of a brand new file does not duplicate its bytes", async () => {
    mkdirSync(join(h.rawDir, "laptop/claude-code/proj"), { recursive: true });
    writeFileSync(join(h.rawDir, STORED), "line one\n");

    const retry = await h.append({ token, body: "line one\n" });
    expect(retry.status).toBe(409);
    expect(await retry.json()).toEqual({ size: 9, generation: 0 });
    expect(h.archived(STORED).toString()).toBe("line one\n");
    expect(getFile(h.db, KEY, 0)?.size).toBe(9);
  });

  test("start-up reconciliation repairs a stale row", async () => {
    await h.append({ token, body: "line one\n" });
    appendFileSync(join(h.rawDir, STORED), "line two\n");

    const changed = reconcileArchive(h.db, h.rawDir);
    expect(changed.map((c) => [c.file.path, c.file.size, c.diskSize])).toEqual([["proj/session.jsonl", 9, 18]]);
    expect(getFile(h.db, KEY, 0)?.size).toBe(18);
    expect(reconcileArchive(h.db, h.rawDir)).toEqual([]);
  });

  test("a generation bump starts a new file and keeps the old one", async () => {
    await h.append({ token, body: "old contents\n" });

    const skipped = await h.append({ token, generation: 2, body: "x\n" });
    expect(skipped.status).toBe(409);
    expect(await skipped.json()).toEqual({ size: 13, generation: 0 });

    const midway = await h.append({ token, generation: 1, offset: 13, body: "x\n" });
    expect(midway.status).toBe(409);
    expect(await midway.json()).toEqual({ size: 13, generation: 0 });

    const bumped = await h.append({ token, generation: 1, body: "new\n" });
    expect(bumped.status).toBe(200);
    expect(await bumped.json()).toEqual({ size: 4, generation: 1 });
    expect(h.archived(STORED).toString()).toBe("old contents\n");
    expect(h.archived(`${STORED}.g1`).toString()).toBe("new\n");
    expect(getLatestGeneration(h.db, KEY)?.generation).toBe(1);

    const stale = await h.append({ token, generation: 0, offset: 13, body: "late\n" });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ size: 4, generation: 1 });
    expect(h.archived(STORED).toString()).toBe("old contents\n");

    const next = await h.append({ token, generation: 1, offset: 4, body: "more\n" });
    expect(next.status).toBe(200);
    expect(h.archived(`${STORED}.g1`).toString()).toBe("new\nmore\n");
  });

  test("concurrent appends to one path are serialised", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => h.append({ token, body: "same line\n" }).then((r) => r.status)),
    );
    expect(results.filter((s) => s === 200)).toHaveLength(1);
    expect(results.filter((s) => s === 409)).toHaveLength(7);
    expect(h.archived(STORED).toString()).toBe("same line\n");
  });

  test("binary bodies are stored byte for byte", async () => {
    const body = new Uint8Array(70_000).map((_, i) => (i * 31) % 256);
    expect((await h.append({ token, body })).status).toBe(200);
    expect(Buffer.compare(h.archived(STORED), body)).toBe(0);
  });

  test("the two sources of one machine do not share files", async () => {
    await h.append({ token, source: "claude-code", path: "a.jsonl", body: "claude\n" });
    const res = await h.append({ token, source: "codex", path: "a.jsonl", body: "codex\n" });
    expect(res.status).toBe(200);
    expect(h.archived("laptop/claude-code/a.jsonl").toString()).toBe("claude\n");
    expect(h.archived("laptop/codex/a.jsonl").toString()).toBe("codex\n");
  });

  test("each append stamps the machine's last ingest time", async () => {
    expect(getMachine(h.db, "laptop")).toBeNull();
    await h.append({ token, body: "x\n" });
    expect(getMachine(h.db, "laptop")?.last_ingest_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
});

describe("header validation", () => {
  test.each([
    ["unknown source", { source: "cursor" }],
    ["negative offset", { offset: "-1" }],
    ["fractional offset", { offset: "1.5" }],
    ["non-numeric offset", { offset: "abc" }],
    ["offset beyond safe integers", { offset: "99999999999999999999" }],
    ["non-numeric generation", { generation: "one" }],
    ["negative generation", { generation: "-1" }],
  ])("%s is a 400", async (_name, bad) => {
    const res = await h.append({ token, body: "x\n", ...bad });
    expect(res.status).toBe(400);
    expect(listFiles(h.db)).toEqual([]);
  });

  test("a missing machine header is a 400", async () => {
    const res = await h.append({ token, machine: null, body: "x\n" });
    expect(res.status).toBe(400);
  });
});

describe("path handling", () => {
  const traversal = [
    "../escape.jsonl",
    "..",
    "a/../../escape.jsonl",
    "a/../b.jsonl",
    "proj/../../../etc/passwd",
    "/etc/passwd",
    "//etc/passwd",
    "a//b.jsonl",
    "a/./b.jsonl",
    "./a.jsonl",
    "a/",
    "a\\..\\..\\b.jsonl",
    "..\\escape.jsonl",
    "session.jsonl.g1",
    `${"a".repeat(1025)}`,
  ];

  test.each(traversal)("rejects %p", async (path) => {
    const res = await h.append({ token, path, body: "x\n" });
    expect(res.status).toBe(400);
    expect(listFiles(h.db)).toEqual([]);
    expect(existsSync(join(h.rawDir, "laptop"))).toBe(false);
    expect(readdirSync(h.dataDir)).toEqual([]);
  });

  test("a percent-encoded path is decoded before it is stored", async () => {
    const cases = [
      { literal: "proj/sub agents/my session.jsonl", body: "space\n" },
      { literal: "proyecto-ñandú/日本語/sesión.jsonl", body: "unicode\n" },
      { literal: "proj/100%25 done.jsonl", body: "percent\n" },
    ];
    for (const { literal, body } of cases) {
      const path = literal.split("/").map(encodeURIComponent).join("/");
      expect(path).toMatch(/^[\x21-\x7e]+$/);
      const res = await h.append({ token, path, body });
      expect(res.status).toBe(200);
      expect(h.archived(`laptop/claude-code/${literal}`).toString()).toBe(body);
      expect(getFile(h.db, { ...KEY, path: literal }, 0)?.size).toBe(body.length);
    }
  });

  test.each(["proj/%E0%A4%A.jsonl", "proj/%zz.jsonl", "proj/100%.jsonl", "a%2F..%2F..%2Fescape.jsonl", "%2E%2E/escape.jsonl", "a%5Cb.jsonl", "a%00b.jsonl"])(
    "rejects the encoded path %p",
    async (path) => {
      const res = await h.append({ token, path, body: "x\n" });
      expect(res.status).toBe(400);
      expect(listFiles(h.db)).toEqual([]);
      expect(existsSync(join(h.rawDir, "laptop"))).toBe(false);
    },
  );

  test("normalizeIngestPath refuses NUL and empty paths, which no header can carry", () => {
    expect(() => normalizeIngestPath("a\0b")).toThrow();
    expect(() => normalizeIngestPath("")).toThrow();
    expect(normalizeIngestPath("proj/sub agents/x.jsonl")).toBe("proj/sub agents/x.jsonl");
    expect(normalizeIngestPath("a...b/..c.jsonl")).toBe("a...b/..c.jsonl");
  });

  test("a symlink inside the archive cannot redirect a write outside it", async () => {
    const outside = join(h.dataDir, "outside");
    mkdirSync(outside);
    mkdirSync(join(h.rawDir, "laptop/claude-code"), { recursive: true });
    symlinkSync(outside, join(h.rawDir, "laptop/claude-code/link"));

    const res = await h.append({ token, path: "link/x.jsonl", body: "x\n" });
    expect(res.status).toBe(400);
    expect(readdirSync(outside)).toEqual([]);
    expect(listFiles(h.db)).toEqual([]);
  });

  test("a path the filesystem cannot hold is a 400, not a 500", async () => {
    await h.append({ token, path: "a.jsonl", body: "x\n" });
    const res = await h.append({ token, path: "a.jsonl/nested.jsonl", body: "x\n" });
    expect(res.status).toBe(400);
  });

  test("appendToArchive refuses a machine name that would climb out of raw/", async () => {
    const attempt = appendToArchive(h.db, h.rawDir, {
      machine: "..",
      source: "claude-code",
      path: "x.jsonl",
      generation: 0,
      offset: 0,
      body: new TextEncoder().encode("x\n"),
    });
    await expect(attempt).rejects.toThrow("escapes");
    expect(existsSync(join(h.dataDir, "claude-code"))).toBe(false);
  });
});

describe("body size", () => {
  test("a body of exactly the cap is accepted", async () => {
    const res = await h.append({ token, body: new Uint8Array(MAX_APPEND_BODY_BYTES) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ size: MAX_APPEND_BODY_BYTES, generation: 0 });
  });

  test("a body one byte over the cap is refused and nothing is written", async () => {
    const res = await h.append({ token, body: new Uint8Array(MAX_APPEND_BODY_BYTES + 1) });
    expect(res.status).toBe(413);
    expect(listFiles(h.db)).toEqual([]);
    expect(existsSync(join(h.rawDir, STORED))).toBe(false);
  });

  test("an oversized streamed body with no Content-Length is refused", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 9) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const res = await h.app.request("/v1/ingest/append", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Machine": "laptop",
        "X-Source": "claude-code",
        "X-Path": "proj/session.jsonl",
        "X-Offset": "0",
        "X-Generation": "0",
      },
      body,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(existsSync(join(h.rawDir, STORED))).toBe(false);
  });
});

describe("heartbeat", () => {
  const heartbeat = {
    collector_version: "0.1.0",
    sources: [{ name: "claude-code", files: 3, bytes_pending: 120 }],
  };
  const post = (body: unknown, bearer = token, headers: Record<string, string> = {}) =>
    h.app.request(HEARTBEAT_PATH, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  test("records the machine named by the token", async () => {
    const res = await post(heartbeat);
    expect(res.status).toBe(200);
    const row = getMachine(h.db, "laptop")!;
    expect(row.collector_version).toBe("0.1.0");
    expect(row.last_heartbeat_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(JSON.parse(row.sources!)).toEqual(heartbeat.sources);
  });

  test("stores where the collector runs from, and accepts heartbeats from collectors that do not say", async () => {
    expect((await post({ ...heartbeat, exec_path: "/home/a/.local/bin/retrospecticus-collector" })).status).toBe(200);
    expect(getMachine(h.db, "laptop")!.exec_path).toBe("/home/a/.local/bin/retrospecticus-collector");
    expect((await post(heartbeat)).status).toBe(200);
    expect(getMachine(h.db, "laptop")!.exec_path).toBeNull();
  });

  test("a heartbeat does not erase the last ingest time, nor an ingest the heartbeat", async () => {
    await h.append({ token, body: "x\n" });
    await post(heartbeat);
    await h.append({ token, offset: 2, body: "y\n" });
    const row = getMachine(h.db, "laptop")!;
    expect(row.last_ingest_at).not.toBeNull();
    expect(row.last_heartbeat_at).not.toBeNull();
    expect(row.collector_version).toBe("0.1.0");
  });

  test("rejects a malformed body", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post({ collector_version: 1 })).status).toBe(400);
    expect(getMachine(h.db, "laptop")).toBeNull();
  });

  test("rejects a machine header that contradicts the token, and a non-ingest token", async () => {
    expect((await post(heartbeat, token, { "X-Machine": "desktop" })).status).toBe(403);
    expect((await post(heartbeat, h.token("admin"))).status).toBe(403);
    expect(getMachine(h.db, "laptop")).toBeNull();
    expect(getMachine(h.db, "desktop")).toBeNull();
  });
});

describe("surface", () => {
  test("healthz needs no token", async () => {
    const res = await h.app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: VERSION });
  });

  test("no route serves the raw archive", async () => {
    await h.append({ token, body: "secret\n" });
    const admin = h.token("admin");
    for (const path of ["/raw/" + STORED, "/" + STORED, "/v1/raw/" + STORED, "/v1/ingest/append"]) {
      const res = await h.app.request(path, { headers: { Authorization: `Bearer ${admin}` } });
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("secret");
    }
  });
});

describe("whoami", () => {
  test("answers 200 for the machine's own token and changes nothing", async () => {
    const get = (t: string, machine = "laptop") => h.app.request("/v1/token/whoami", { headers: { Authorization: `Bearer ${t}`, "X-Machine": machine } });
    const res = await get(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ machine: "laptop" });
    expect((await get(token, "desktop")).status).toBe(403);
    expect((await get("rt_nope")).status).toBe(401);
    expect((await get(h.token("search"))).status).toBe(403);
    expect((await h.append({ token, body: "x\n" })).status).toBe(200);
  });
});

describe("self-revoke", () => {
  test("an ingest token revokes itself and is refused afterwards", async () => {
    const post = (t: string) =>
      h.app.request("/v1/token/revoke", { method: "POST", headers: { Authorization: `Bearer ${t}`, "X-Machine": "laptop" } });
    const other = h.token("ingest", "desktop");
    expect(await (await post(token)).json()).toEqual({ result: "revoked" });
    expect((await post(token)).status).toBe(401);
    expect((await h.append({ token, body: "x\n" })).status).toBe(401);
    expect((await h.append({ token: other, machine: "desktop", body: "x\n" })).status).toBe(200);
  });

  test("other scopes and missing tokens cannot use it", async () => {
    const search = h.token("search");
    expect((await h.app.request("/v1/token/revoke", { method: "POST", headers: { Authorization: `Bearer ${search}` } })).status).toBe(403);
    expect((await h.app.request("/v1/token/revoke", { method: "POST" })).status).toBe(401);
  });
});
