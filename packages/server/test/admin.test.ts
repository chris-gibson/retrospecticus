import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ENROLL_TTL_SECONDS, EnrollPollResponseSchema, SEARCH_PATH } from "@retrospecticus/shared";
import { hashToken, issueToken } from "../src/auth.ts";
import { listFiles } from "../src/db/files.ts";
import { getTokenById, listTokens, revokeToken } from "../src/db/tokens.ts";
import {
  ADMIN_HEADERS,
  adminGet,
  adminPost,
  adminSession,
  clockedApp,
  poll,
  postJson,
  startEnroll,
  type Clocked,
} from "./enroll-helpers.ts";
import { createHarness, type Harness } from "./harness.ts";

let h: Harness;
let clock: Clocked;

beforeEach(() => {
  h = createHarness();
  clock = clockedApp(h);
});
afterEach(() => h.cleanup());

async function pendingList(cookie: string) {
  const res = await adminGet(clock.app, "/admin/api/enrollments", cookie);
  expect(res.status).toBe(200);
  return ((await res.json()) as { enrollments: Array<Record<string, unknown>> }).enrollments;
}

describe("page", () => {
  test("GET /admin serves the page uncached and locked down", async () => {
    const res = await clock.app.request("/admin");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    const html = await res.text();
    expect(html).toContain("Retrospecticus admin");
    expect(html).not.toMatch(/<(script|link)[^>]+(src|href)=/);
  });

  test("the inline script and style match the CSP hashes, and the script parses", async () => {
    const res = await clock.app.request("/admin");
    const csp = res.headers.get("Content-Security-Policy")!;
    const html = await res.text();
    const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!;
    const style = html.match(/<style>([\s\S]*)<\/style>/)![1]!;
    const hash = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
    expect(csp).toContain(`script-src ${hash(script)}`);
    expect(csp).toContain(`style-src ${hash(style)}`);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(() => new Function(script)).not.toThrow();
    expect(html).not.toContain("${");
  });

  test("API responses are uncached", async () => {
    const { cookie } = await adminSession(clock.app, h);
    expect((await adminGet(clock.app, "/admin/api/tokens", cookie)).headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("login", () => {
  test("sets a session cookie with the intended attributes and records the token's use", async () => {
    const { token, row } = issueToken(h.db, { scope: "admin" });
    const res = await postJson(clock.app, "/admin/api/login", { token }, ADMIN_HEADERS);
    expect(res.status).toBe(200);
    const cookie = res.headers.get("Set-Cookie")!;
    expect(cookie).toMatch(/^retrospecticus_admin=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/admin");
    expect(cookie).toContain("Max-Age=43200");
    expect(cookie).not.toContain("Secure");
    expect(getTokenById(h.db, row.id)?.last_used_at).not.toBeNull();

    const session = await adminGet(clock.app, "/admin/api/session", cookie.split(";")[0]!);
    expect(await session.json()).toEqual({ token: { id: row.id, name: row.name } });
  });

  test("refuses non-admin, revoked, unknown and missing tokens", async () => {
    const search = h.token("search");
    const ingest = h.token("ingest", "laptop");
    const revoked = issueToken(h.db, { scope: "admin" });
    revokeToken(h.db, revoked.row.id);
    for (const body of [{ token: search }, { token: ingest }, { token: revoked.token }, { token: "rsp_admin_x" }, {}]) {
      const res = await postJson(clock.app, "/admin/api/login", body, ADMIN_HEADERS);
      expect(res.status).toBe(401);
      expect(res.headers.get("Set-Cookie")).toBeNull();
    }
    expect(getTokenById(h.db, revoked.row.id)?.last_used_at).toBeNull();
  });

  test("a failed login is slowed down", async () => {
    const { createApp } = await import("../src/app.ts");
    const app = createApp({ db: h.db, config: h.config, adminLoginFailureDelayMs: 120 });
    const started = performance.now();
    const res = await postJson(app, "/admin/api/login", { token: "wrong" }, ADMIN_HEADERS);
    expect(res.status).toBe(401);
    expect(performance.now() - started).toBeGreaterThanOrEqual(100);
  });

  test("the API refuses requests without a session", async () => {
    for (const path of ["/admin/api/session", "/admin/api/enrollments", "/admin/api/machines", "/admin/api/tokens"]) {
      expect((await clock.app.request(path)).status).toBe(401);
      expect((await adminGet(clock.app, path, "retrospecticus_admin=forged")).status).toBe(401);
    }
    expect((await postJson(clock.app, "/admin/api/tokens", { scope: "search", name: "x" }, ADMIN_HEADERS)).status).toBe(
      401,
    );
  });

  test("logout ends the session", async () => {
    const { cookie } = await adminSession(clock.app, h);
    const res = await adminPost(clock.app, "/admin/api/logout", cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await adminGet(clock.app, "/admin/api/session", cookie)).status).toBe(401);
  });

  test("a session lasts twelve hours", async () => {
    const { cookie } = await adminSession(clock.app, h);
    clock.advance(12 * 3600 - 1);
    expect((await adminGet(clock.app, "/admin/api/session", cookie)).status).toBe(200);
    clock.advance(1);
    expect((await adminGet(clock.app, "/admin/api/session", cookie)).status).toBe(401);
  });

  test("revoking the admin token behind a session kills the session", async () => {
    const { cookie, tokenId } = await adminSession(clock.app, h);
    revokeToken(h.db, tokenId);
    expect((await adminGet(clock.app, "/admin/api/session", cookie)).status).toBe(401);
  });

  test("revoking the session's own token through the API ends the session", async () => {
    const { cookie, tokenId } = await adminSession(clock.app, h);
    const res = await adminPost(clock.app, `/admin/api/tokens/${tokenId}/revoke`, cookie);
    expect(await res.json()).toEqual({ result: "revoked", session_ended: true });
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await adminGet(clock.app, "/admin/api/session", cookie)).status).toBe(401);
  });
});

describe("CSRF", () => {
  test("state-changing calls need the JSON content type and the admin header", async () => {
    const { cookie } = await adminSession(clock.app, h);
    const body = JSON.stringify({ scope: "search", name: "x" });
    const attempts: RequestInit[] = [
      { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body },
      { method: "POST", headers: { Cookie: cookie, "Content-Type": "text/plain", "X-Retrospecticus-Admin": "1" }, body },
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", "X-Retrospecticus-Admin": "1" },
        body: "scope=search&name=x",
      },
      { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "X-Retrospecticus-Admin": "0" }, body },
      { method: "POST", headers: { Cookie: cookie, "X-Retrospecticus-Admin": "1" }, body },
      { method: "PUT", headers: { Cookie: cookie, ...ADMIN_HEADERS }, body },
      { method: "DELETE", headers: { Cookie: cookie, ...ADMIN_HEADERS } },
    ];
    for (const init of attempts) {
      expect((await clock.app.request("/admin/api/tokens", init)).status).toBe(403);
    }
    expect(listTokens(h.db)).toHaveLength(1);

    const login = await clock.app.request("/admin/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: h.token("admin") }),
    });
    expect(login.status).toBe(403);

    const ok = await clock.app.request("/admin/api/tokens", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json; charset=utf-8", "X-Retrospecticus-Admin": "1" },
      body,
    });
    expect(ok.status).toBe(201);
  });
});

describe("enrollment approval", () => {
  test("lists pending requests without device codes and flags known machines", async () => {
    const { cookie } = await adminSession(clock.app, h);
    const fresh = await startEnroll(clock.app, "newbox", { platform: "darwin-arm64", collector_version: "0.2.0" });
    await startEnroll(clock.app, "laptop");
    h.token("ingest", "laptop");

    const list = await pendingList(cookie);
    expect(list.map((r) => [r.machine, r.existing_machine])).toEqual([
      ["newbox", false],
      ["laptop", true],
    ]);
    expect(list[0]).toEqual({
      id: expect.any(Number),
      user_code: fresh.user_code,
      machine: "newbox",
      hostname: "newbox.local",
      platform: "darwin-arm64",
      collector_version: "0.2.0",
      ip: null,
      created_at: "2026-11-16T12:00:00.000Z",
      expires_at: "2026-11-16T12:10:00.000Z",
      existing_machine: false,
    });
    expect(JSON.stringify(list)).not.toContain(fresh.device_code);
    expect(JSON.stringify(list)).not.toContain(hashToken(fresh.device_code));

    h.db.run("INSERT INTO machines (machine) VALUES ('newbox')");
    expect((await pendingList(cookie))[0]!.existing_machine).toBe(true);
  });

  test("approval needs a session and the matching code, then the token is delivered once", async () => {
    const started = await startEnroll(clock.app, "laptop");
    const [request] = await pendingList((await adminSession(clock.app, h)).cookie);
    const approvePath = `/admin/api/enrollments/${request!.id}/approve`;

    const anonymous = await postJson(clock.app, approvePath, { user_code: started.user_code }, ADMIN_HEADERS);
    expect(anonymous.status).toBe(401);

    const { cookie } = await adminSession(clock.app, h);
    const wrongCode = started.user_code === "BBBB-BBBB" ? "CCCC-CCCC" : "BBBB-BBBB";
    expect((await adminPost(clock.app, approvePath, cookie, { user_code: wrongCode })).status).toBe(400);
    expect((await adminPost(clock.app, approvePath, cookie, {})).status).toBe(400);
    expect((await poll(clock.app, started.device_code)).body).toEqual({ status: "pending" });

    const approved = await adminPost(clock.app, approvePath, cookie, { user_code: started.user_code.toLowerCase() });
    expect(approved.status).toBe(200);
    expect((await adminPost(clock.app, approvePath, cookie, { user_code: started.user_code })).status).toBe(409);

    const first = await poll(clock.app, started.device_code);
    const delivered = EnrollPollResponseSchema.parse(first.body);
    if (delivered.status !== "approved") throw new Error(`expected approval, got ${delivered.status}`);
    expect(delivered.machine).toBe("laptop");
    expect(delivered.token).toMatch(/^rsp_ingest_/);
    expect((await poll(clock.app, started.device_code)).body).toEqual({ status: "expired" });

    expect(h.db.query("SELECT * FROM enroll_requests").all()).toEqual([]);
    const stored = JSON.stringify([
      h.db.query("SELECT * FROM enroll_requests").all(),
      h.db.query("SELECT * FROM tokens").all(),
    ]);
    expect(stored).not.toContain(delivered.token);
    expect(stored).not.toContain(delivered.token.slice("rsp_ingest_".length));
    const issued = listTokens(h.db).find((t) => t.scope === "ingest")!;
    expect(issued).toMatchObject({ machine: "laptop", name: "enroll:laptop.local", hash: hashToken(delivered.token) });

    expect((await h.append({ token: delivered.token, machine: "laptop", body: "x\n" })).status).toBe(200);
    expect((await h.append({ token: delivered.token, machine: "desktop", path: "other.jsonl", body: "y\n" })).status).toBe(
      403,
    );
    expect(listFiles(h.db).map((f) => f.machine)).toEqual(["laptop"]);
  });

  test("an approved request that expires before its poll delivers nothing", async () => {
    const started = await startEnroll(clock.app, "laptop");
    const { cookie } = await adminSession(clock.app, h);
    const [request] = await pendingList(cookie);
    await adminPost(clock.app, `/admin/api/enrollments/${request!.id}/approve`, cookie, { user_code: started.user_code });
    clock.advance(ENROLL_TTL_SECONDS);
    expect((await poll(clock.app, started.device_code)).body).toEqual({ status: "expired" });
    expect(listTokens(h.db).filter((t) => t.scope === "ingest")).toEqual([]);
  });

  test("expired and unknown requests cannot be approved or denied", async () => {
    const started = await startEnroll(clock.app, "laptop");
    const { cookie } = await adminSession(clock.app, h);
    const [request] = await pendingList(cookie);
    clock.advance(ENROLL_TTL_SECONDS);
    expect(await pendingList(cookie)).toEqual([]);
    const body = { user_code: started.user_code };
    expect((await adminPost(clock.app, `/admin/api/enrollments/${request!.id}/approve`, cookie, body)).status).toBe(404);
    expect((await adminPost(clock.app, `/admin/api/enrollments/${request!.id}/deny`, cookie)).status).toBe(404);
    expect((await adminPost(clock.app, "/admin/api/enrollments/9999/approve", cookie, body)).status).toBe(404);
    expect((await adminPost(clock.app, "/admin/api/enrollments/abc/deny", cookie)).status).toBe(404);
  });

  test("denying is reported to the collector once and cannot then be approved", async () => {
    const started = await startEnroll(clock.app, "laptop");
    const { cookie } = await adminSession(clock.app, h);
    const [request] = await pendingList(cookie);
    expect((await adminPost(clock.app, `/admin/api/enrollments/${request!.id}/deny`, cookie)).status).toBe(200);
    expect(await pendingList(cookie)).toEqual([]);
    const approve = await adminPost(clock.app, `/admin/api/enrollments/${request!.id}/approve`, cookie, {
      user_code: started.user_code,
    });
    expect(approve.status).toBe(409);
    expect((await poll(clock.app, started.device_code)).body).toEqual({ status: "denied" });
    expect((await poll(clock.app, started.device_code)).body).toEqual({ status: "expired" });
  });
});

describe("machines and tokens", () => {
  test("machines carry their active ingest token count", async () => {
    const { cookie } = await adminSession(clock.app, h);
    h.db.run("INSERT INTO machines (machine, collector_version) VALUES ('laptop', '0.1.0'), ('desktop', NULL)");
    h.token("ingest", "laptop");
    const revoked = issueToken(h.db, { scope: "ingest", machine: "laptop" });
    revokeToken(h.db, revoked.row.id);
    const res = await adminGet(clock.app, "/admin/api/machines", cookie);
    const { machines } = (await res.json()) as { machines: Array<Record<string, unknown>> };
    expect(machines.map((m) => [m.machine, m.active_ingest_tokens])).toEqual([
      ["desktop", 0],
      ["laptop", 1],
    ]);
  });

  test("machines include what the collector reported about itself", async () => {
    const { cookie } = await adminSession(clock.app, h);
    h.db.run(
      "INSERT INTO machines (machine, hostname, platform, started_at, last_upload_at, last_scan_at, last_error) VALUES ('laptop', 'lap', 'linux-x64', 's', 'u', 'c', '{\"at\":\"e\",\"message\":\"boom\"}')",
    );
    const res = await adminGet(clock.app, "/admin/api/machines", cookie);
    const { machines } = (await res.json()) as { machines: Array<Record<string, unknown>> };
    expect(machines[0]).toMatchObject({ hostname: "lap", platform: "linux-x64", started_at: "s", last_upload_at: "u", last_scan_at: "c" });
    expect(JSON.parse(machines[0]!.last_error as string).message).toBe("boom");
  });

  test("the token list never exposes hashes", async () => {
    const { cookie } = await adminSession(clock.app, h);
    h.token("ingest", "laptop");
    h.token("search");
    const res = await adminGet(clock.app, "/admin/api/tokens", cookie);
    const { tokens } = (await res.json()) as { tokens: Array<Record<string, unknown>> };
    expect(tokens).toHaveLength(3);
    for (const t of tokens) {
      expect(Object.keys(t).sort()).toEqual(
        ["created_at", "id", "last_used_at", "machine", "name", "revoked_at", "scope"].sort(),
      );
    }
    const text = JSON.stringify(tokens);
    for (const row of listTokens(h.db)) expect(text).not.toContain(row.hash);
  });

  test("creates search tokens only, and shows the token once", async () => {
    const { cookie } = await adminSession(clock.app, h);
    for (const body of [{ scope: "ingest", name: "x" }, { scope: "admin", name: "x" }, { scope: "search" }, { scope: "search", name: " " }]) {
      expect((await adminPost(clock.app, "/admin/api/tokens", cookie, body)).status).toBe(400);
    }
    const res = await adminPost(clock.app, "/admin/api/tokens", cookie, { scope: "search", name: "phone MCP" });
    expect(res.status).toBe(201);
    const { token, row } = (await res.json()) as { token: string; row: Record<string, unknown> & { id: number } };
    expect(token).toMatch(/^rsp_search_/);
    expect(row).toMatchObject({ name: "phone MCP", scope: "search", machine: null });
    expect(row.hash).toBeUndefined();
    expect(getTokenById(h.db, row.id)?.hash).toBe(hashToken(token));

    const search = await h.app.request(SEARCH_PATH, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(search.status).toBe(400);
  });

  test("revokes other tokens without ending the session", async () => {
    const { cookie } = await adminSession(clock.app, h);
    const { row } = issueToken(h.db, { scope: "search" });
    const res = await adminPost(clock.app, `/admin/api/tokens/${row.id}/revoke`, cookie);
    expect(await res.json()).toEqual({ result: "revoked", session_ended: false });
    expect(getTokenById(h.db, row.id)?.revoked_at).not.toBeNull();
    expect((await adminPost(clock.app, `/admin/api/tokens/${row.id}/revoke`, cookie)).status).toBe(200);
    expect((await adminPost(clock.app, "/admin/api/tokens/9999/revoke", cookie)).status).toBe(404);
    expect((await adminGet(clock.app, "/admin/api/session", cookie)).status).toBe(200);
  });
});
