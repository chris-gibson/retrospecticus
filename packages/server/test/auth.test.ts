import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { generateToken, hashToken, issueToken } from "../src/auth.ts";
import { listFiles } from "../src/db/files.ts";
import { getTokenById, listTokens, revokeToken } from "../src/db/tokens.ts";
import { createHarness, type Harness } from "./harness.ts";

let h: Harness;

beforeEach(() => {
  h = createHarness();
});
afterEach(() => h.cleanup());

async function expectRefused(res: Response, status: number): Promise<void> {
  expect(res.status).toBe(status);
  expect(listFiles(h.db)).toEqual([]);
  expect(existsSync(join(h.rawDir, "laptop"))).toBe(false);
}

describe("tokens", () => {
  test("have the documented format and only their hash is stored", () => {
    const { token, row } = issueToken(h.db, { scope: "ingest", machine: "laptop" });
    expect(token).toMatch(/^rsp_ingest_[A-Za-z0-9_-]{43}$/);
    expect(row.hash).toBe(hashToken(token));
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.machine).toBe("laptop");
    const stored = JSON.stringify(h.db.query("SELECT * FROM tokens").all());
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(token.slice("rsp_ingest_".length));
  });

  test("an ingest token must name a valid machine", () => {
    expect(() => issueToken(h.db, { scope: "ingest" })).toThrow();
    expect(() => issueToken(h.db, { scope: "ingest", machine: "../x" })).toThrow();
    expect(() => issueToken(h.db, { scope: "search", machine: "has space" })).toThrow();
    expect(listTokens(h.db)).toEqual([]);
  });

  test("revoking reports what happened", () => {
    const { row } = issueToken(h.db, { scope: "admin" });
    expect(revokeToken(h.db, row.id)).toBe("revoked");
    expect(revokeToken(h.db, row.id)).toBe("already-revoked");
    expect(revokeToken(h.db, 999)).toBe("not-found");
    expect(getTokenById(h.db, row.id)?.revoked_at).not.toBeNull();
  });
});

describe("requireScope", () => {
  test("a valid ingest token is accepted and its last use recorded", async () => {
    const { token, row } = issueToken(h.db, { scope: "ingest", machine: "laptop" });
    expect(row.last_used_at).toBeNull();
    expect((await h.append({ token, body: "x\n" })).status).toBe(200);
    expect(getTokenById(h.db, row.id)?.last_used_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  test("a missing or malformed Authorization header is a 401", async () => {
    const { token } = issueToken(h.db, { scope: "ingest", machine: "laptop" });
    for (const authorization of [undefined, "", token, `Basic ${token}`, "Bearer", `Bearer ${token} extra`]) {
      const headers: Record<string, string> = {
        "X-Machine": "laptop",
        "X-Source": "claude-code",
        "X-Path": "a.jsonl",
        "X-Offset": "0",
        "X-Generation": "0",
      };
      if (authorization !== undefined) headers.Authorization = authorization;
      const res = await h.app.request("/v1/ingest/append", { method: "PUT", headers, body: "x\n" });
      await expectRefused(res, 401);
    }
  });

  test("an unknown token is a 401", async () => {
    issueToken(h.db, { scope: "ingest", machine: "laptop" });
    await expectRefused(await h.append({ token: generateToken("ingest"), body: "x\n" }), 401);
  });

  test("a revoked token is a 401 and its last use is not touched", async () => {
    const { token, row } = issueToken(h.db, { scope: "ingest", machine: "laptop" });
    revokeToken(h.db, row.id);
    await expectRefused(await h.append({ token, body: "x\n" }), 401);
    expect(getTokenById(h.db, row.id)?.last_used_at).toBeNull();
  });

  test.each(["search", "admin"] as const)("a %s token cannot ingest", async (scope) => {
    const { token, row } = issueToken(h.db, { scope, machine: "laptop" });
    await expectRefused(await h.append({ token, body: "x\n" }), 403);
    expect(getTokenById(h.db, row.id)?.last_used_at).toBeNull();
  });

  test("an ingest token cannot write as another machine", async () => {
    const token = h.token("ingest", "laptop");
    h.token("ingest", "desktop");
    const res = await h.append({ token, machine: "desktop", body: "x\n" });
    expect(res.status).toBe(403);
    expect(listFiles(h.db)).toEqual([]);
    expect(existsSync(join(h.rawDir, "desktop"))).toBe(false);
  });

  test("machine names are compared exactly", async () => {
    const token = h.token("ingest", "laptop");
    for (const machine of ["Laptop", "laptop2", "lapto"]) {
      expect((await h.append({ token, machine, body: "x\n" })).status).toBe(403);
    }
    expect(listFiles(h.db)).toEqual([]);
  });
});
