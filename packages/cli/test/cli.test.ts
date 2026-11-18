import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@retrospecticus/server/app.ts";
import { hashToken } from "@retrospecticus/server/auth.ts";
import { dbPath, loadConfig } from "@retrospecticus/server/config.ts";
import { openDb } from "@retrospecticus/server/db/index.ts";
import { listTokens } from "@retrospecticus/server/db/tokens.ts";
import { run } from "../src/main.ts";

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "retrospecticus-cli-"));
  configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ data_dir: join(dir, "data"), listen_host: "127.0.0.1", listen_port: 0 }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function cli(...args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(["--config", configPath, ...args], { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

function withDb<T>(task: (db: ReturnType<typeof openDb>) => T): T {
  const db = openDb(dbPath(loadConfig(configPath)));
  try {
    return task(db);
  } finally {
    db.close();
  }
}

describe("token create", () => {
  test("prints the token once, alone on stdout, and stores only its hash", async () => {
    const { code, out, err } = await cli("token", "create", "--scope", "ingest", "--machine", "laptop");
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^rsp_ingest_[A-Za-z0-9_-]{43}$/);
    expect(err.join("\n")).not.toContain(out[0]!);

    const rows = withDb(listTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: "ingest", machine: "laptop", name: "ingest-laptop", hash: hashToken(out[0]!) });
  });

  test("the printed token authenticates against the server", async () => {
    const { out } = await cli("token", "create", "--scope", "ingest", "--machine", "laptop", "--name", "work laptop");
    const config = loadConfig(configPath);
    const db = openDb(dbPath(config));
    try {
      const res = await createApp({ db, config }).request("/v1/ingest/append", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${out[0]}`,
          "X-Machine": "laptop",
          "X-Source": "codex",
          "X-Path": "a.jsonl",
          "X-Offset": "0",
          "X-Generation": "0",
        },
        body: "x\n",
      });
      expect(res.status).toBe(200);
      expect(listTokens(db)[0]?.name).toBe("work laptop");
    } finally {
      db.close();
    }
  });

  test("search and admin tokens need no machine", async () => {
    expect((await cli("token", "create", "--scope", "search")).out[0]).toMatch(/^rsp_search_/);
    expect((await cli("token", "create", "--scope", "admin")).out[0]).toMatch(/^rsp_admin_/);
    expect(withDb(listTokens).map((r) => [r.scope, r.machine])).toEqual([["search", null], ["admin", null]]);
  });

  test.each([
    ["no scope", ["token", "create"]],
    ["an unknown scope", ["token", "create", "--scope", "root"]],
    ["an ingest token with no machine", ["token", "create", "--scope", "ingest"]],
    ["a bad machine name", ["token", "create", "--scope", "ingest", "--machine", "../etc"]],
    ["an unknown flag", ["token", "create", "--scope", "admin", "--force"]],
    ["a stray positional", ["token", "create", "--scope", "admin", "extra"]],
  ])("refuses %s", async (_name, args) => {
    const { code, out, err } = await cli(...args);
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("Usage:");
    expect(withDb(listTokens)).toEqual([]);
  });
});

describe("token list and revoke", () => {
  test("list shows every token without revealing secrets", async () => {
    expect((await cli("token", "list")).out).toEqual(["No tokens."]);

    const created = (await cli("token", "create", "--scope", "ingest", "--machine", "laptop")).out[0]!;
    await cli("token", "create", "--scope", "search", "--name", "claude");

    const { code, out } = await cli("token", "list");
    expect(code).toBe(0);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatch(/^ID\s+SCOPE\s+MACHINE\s+NAME\s+CREATED\s+LAST USED\s+STATUS$/);
    expect(out[1]).toMatch(/^1\s+ingest\s+laptop\s+ingest-laptop\s+\S+\s+never\s+active$/);
    expect(out[2]).toMatch(/^2\s+search\s+-\s+claude\s+\S+\s+never\s+active$/);
    const listing = out.join("\n");
    expect(listing).not.toContain(created);
    expect(listing).not.toContain(hashToken(created));
  });

  test("revoke disables a token and list shows it", async () => {
    await cli("token", "create", "--scope", "admin");

    const first = await cli("token", "revoke", "1");
    expect(first.code).toBe(0);
    expect(first.out).toEqual(["Revoked token 1."]);
    expect(withDb(listTokens)[0]?.revoked_at).not.toBeNull();
    expect((await cli("token", "list")).out[1]).toMatch(/revoked \d{4}-/);

    const again = await cli("token", "revoke", "1");
    expect(again.code).toBe(0);
    expect(again.out).toEqual(["Token 1 was already revoked."]);
  });

  test("revoke fails for an unknown id and for a malformed one", async () => {
    expect((await cli("token", "revoke", "42")).code).toBe(1);
    expect((await cli("token", "revoke", "abc")).code).toBe(2);
    expect((await cli("token", "revoke")).code).toBe(2);
    expect((await cli("token", "revoke", "1", "2")).code).toBe(2);
  });
});

describe("dispatch", () => {
  test("an unknown command lists the known ones", async () => {
    const { code, err } = await cli("frobnicate");
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("Unknown command: frobnicate");
    expect(err.join("\n")).toMatch(/\bserve\b[\s\S]*\btoken\b/);
  });

  test("help exits 0 and names every command", async () => {
    const { code, out } = await cli("help");
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/\bserve\b[\s\S]*\btoken\b/);
  });

  test("an unknown token subcommand is a usage error", async () => {
    expect((await cli("token", "rotate")).code).toBe(2);
    expect((await cli("token")).code).toBe(2);
  });

  test("an invalid config file is reported, not thrown", async () => {
    writeFileSync(configPath, '{ "data_dir": ');
    const { code, err } = await cli("token", "list");
    expect(code).toBe(1);
    expect(err.join("\n")).toContain(configPath);
  });
});

describe("serve", () => {
  test("starts the server from the config and stops cleanly on SIGTERM", async () => {
    const main = join(import.meta.dir, "../src/main.ts");
    const proc = Bun.spawn([process.execPath, main, "--config", configPath, "serve"], {
      stdout: "pipe",
      stderr: "inherit",
    });
    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let printed = "";
      while (!printed.includes("\n")) {
        const { done, value } = await reader.read();
        if (done) break;
        printed += decoder.decode(value, { stream: true });
      }
      reader.releaseLock();
      const url = printed.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      expect(url).toBeDefined();

      const health = await fetch(`${url}/healthz`);
      expect(health.status).toBe(200);
      expect((await fetch(`${url}/v1/heartbeat`, { method: "POST", body: "{}" })).status).toBe(401);

      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(0);
    } finally {
      proc.kill("SIGKILL");
    }
  }, 20_000);
});
