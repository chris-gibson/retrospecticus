import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { dbPath, defaultConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { startServer } from "../src/main.ts";
import { createApp } from "../src/app.ts";
import { hashToken, issueToken } from "../src/auth.ts";
import { createSetupState, generateSetupCode, normalizeSetupCode, type SetupState } from "../src/admin/setup.ts";
import { listTokens, revokeToken } from "../src/db/tokens.ts";
import { ADMIN_HEADERS, adminGet, postJson } from "./enroll-helpers.ts";
import { createHarness, type Harness } from "./harness.ts";

let h: Harness;
let setup: SetupState;
let code: string;

function app(delayMs = 0) {
  return createApp({ db: h.db, config: h.config, setup, adminLoginFailureDelayMs: delayMs });
}

beforeEach(() => {
  h = createHarness();
  setup = createSetupState(h.db);
  code = setup.issue()!;
});
afterEach(() => h.cleanup());

const claim = (a: ReturnType<typeof app>, body: unknown) => postJson(a, "/admin/api/setup/claim", body, ADMIN_HEADERS);

describe("setup code", () => {
  test("is four groups of four from the user-code alphabet, at least 60 bits, and differs each time", () => {
    expect(code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ2-9]{4}(-[BCDFGHJKLMNPQRSTVWXZ2-9]{4}){3}$/);
    expect(16 * Math.log2(28)).toBeGreaterThanOrEqual(60);
    const codes = new Set(Array.from({ length: 50 }, generateSetupCode));
    expect(codes.size).toBe(50);
  });

  test("is not issued when an admin token already exists", () => {
    issueToken(h.db, { scope: "admin" });
    const other = createSetupState(h.db);
    expect(other.issue()).toBeNull();
    expect(other.needed()).toBe(false);
  });

  test("normalizes case, dashes and spaces", () => {
    expect(normalizeSetupCode(" bcdf-ghjk lmnp-qrst ")).toBe("BCDFGHJKLMNPQRST");
  });
});

describe("GET /admin/api/setup", () => {
  test("says setup is needed until an admin token exists, with no session", async () => {
    const a = app();
    expect(await (await a.request("/admin/api/setup")).json()).toEqual({ needed: true });
    issueToken(h.db, { scope: "admin" });
    expect(await (await a.request("/admin/api/setup")).json()).toEqual({ needed: false });
  });

  test("is never needed for an app without an issued code", async () => {
    const plain = createApp({ db: h.db, config: h.config });
    expect(await (await plain.request("/admin/api/setup")).json()).toEqual({ needed: false });
  });
});

describe("POST /admin/api/setup/claim", () => {
  test("the right code creates a 'setup' admin token, returns it once and starts a session", async () => {
    const a = app();
    const res = await claim(a, { code: code.toLowerCase().replace(/-/g, " ") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; row: { id: number; name: string } };
    expect(body.token).toMatch(/^rsp_admin_/);
    expect(body.row.name).toBe("setup");
    const [row] = listTokens(h.db);
    expect(row).toMatchObject({ scope: "admin", name: "setup", hash: hashToken(body.token) });

    const cookie = res.headers.get("Set-Cookie")!;
    expect(cookie).toMatch(/^retrospecticus_admin=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/admin");
    const session = await adminGet(a, "/admin/api/session", cookie.split(";")[0]!);
    expect(await session.json()).toEqual({ token: { id: row!.id, name: "setup" } });

    expect(await (await a.request("/admin/api/setup")).json()).toEqual({ needed: false });
  });

  test("the code is consumed: a second claim gets 410", async () => {
    const a = app();
    expect((await claim(a, { code })).status).toBe(200);
    expect((await claim(a, { code })).status).toBe(410);
    expect(listTokens(h.db)).toHaveLength(1);
  });

  test("410 once any admin token exists, even with the right code", async () => {
    issueToken(h.db, { scope: "admin" });
    const res = await claim(app(), { code });
    expect(res.status).toBe(410);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(listTokens(h.db)).toHaveLength(1);
  });

  test("a revoked admin token does not count as an admin", async () => {
    const { row } = issueToken(h.db, { scope: "admin" });
    revokeToken(h.db, row.id);
    expect((await claim(app(), { code })).status).toBe(200);
  });

  test("wrong, missing and oversized codes are refused, slowly, and leave the code usable", async () => {
    const a = app();
    for (const body of [{ code: "BBBB-BBBB-BBBB-BBBB" }, { code: code.slice(0, -1) }, {}, { code: 7 }, { code: "x".repeat(100) }]) {
      const res = await claim(a, body);
      expect(res.status).toBe(400);
      expect(res.headers.get("Set-Cookie")).toBeNull();
    }
    expect(listTokens(h.db)).toEqual([]);

    const slow = app(120);
    const started = performance.now();
    expect((await claim(slow, { code: "BBBB-BBBB-BBBB-BBBB" })).status).toBe(400);
    expect(performance.now() - started).toBeGreaterThanOrEqual(100);

    expect((await claim(a, { code })).status).toBe(200);
  });

  test("the CSRF guard applies", async () => {
    const a = app();
    const bare = await a.request("/admin/api/setup/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(bare.status).toBe(403);
    const form = await a.request("/admin/api/setup/claim", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Retrospecticus-Admin": "1" },
      body: JSON.stringify({ code }),
    });
    expect(form.status).toBe(403);
    expect(listTokens(h.db)).toEqual([]);
  });

  test("an app without an issued code has nothing to claim", async () => {
    const plain = createApp({ db: h.db, config: h.config, adminLoginFailureDelayMs: 0 });
    expect((await claim(plain, { code })).status).toBe(410);
  });
});

describe("page", () => {
  test("/admin/setup serves the admin page with the same CSP", async () => {
    const a = app();
    const res = await a.request(`/admin/setup?code=${code}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBe((await a.request("/admin")).headers.get("Content-Security-Policy"));
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(await res.text()).toContain('id="setup-form"');
  });
});

describe("startServer", () => {
  async function started(listenHost: string, seedAdmin = false) {
    const config = defaultConfig({ data_dir: h.dataDir, listen_host: listenHost, listen_port: 0 });
    if (seedAdmin) {
      mkdirSync(dirname(dbPath(config)), { recursive: true });
      const db = openDb(dbPath(config));
      issueToken(db, { scope: "admin" });
      db.close();
    }
    const lines: string[] = [];
    const server = startServer(config, { indexer: false, log: (line) => lines.push(line) });
    await Bun.sleep(0);
    return { server, lines };
  }

  test("logs a claimable setup link and the bare code when no admin token exists", async () => {
    const { server, lines } = await started("127.0.0.1");
    try {
      expect(lines).toHaveLength(2);
      const url = lines[0]!.match(/^First-time setup: open (http:\/\/127\.0\.0\.1:\d+\/admin\/setup\?code=(\S+))$/)!;
      expect(url[2]).toBe(lines[1]!);
      const res = await fetch(`${server.url}/admin/api/setup/claim`, {
        method: "POST",
        headers: ADMIN_HEADERS,
        body: JSON.stringify({ code: lines[1] }),
      });
      expect(res.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  test("names the address slot instead of printing a wildcard bind address", async () => {
    const { server, lines } = await started("0.0.0.0");
    try {
      expect(lines[0]).toMatch(/^First-time setup: open http:\/\/<this server's address>:\d+\/admin\/setup\?code=[A-Z0-9-]{19}$/);
    } finally {
      await server.stop();
    }
  });

  test("logs nothing once an admin token exists", async () => {
    const { server, lines } = await started("127.0.0.1", true);
    await server.stop();
    expect(lines).toEqual([]);
  });
});
