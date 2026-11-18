import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INGEST_APPEND_PATH, MAX_APPEND_BODY_BYTES } from "@retrospecticus/shared";
import { issueToken } from "../src/auth.ts";
import { defaultConfig, dbPath, type ServerConfig } from "../src/config.ts";
import { getFile } from "../src/db/files.ts";
import { startServer, startServerFromFiles, type RunningServer } from "../src/main.ts";

const KEY = { machine: "laptop", source: "codex", path: "2026/11/16/rollout.jsonl" } as const;

let dataDir: string;
let config: ServerConfig;
let server: RunningServer | null;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "retrospecticus-server-"));
  config = defaultConfig({ data_dir: dataDir, listen_host: "127.0.0.1", listen_port: 0 });
  server = null;
});
afterEach(async () => {
  await server?.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

function put(running: RunningServer, token: string, offset: number, body: string | Uint8Array): Promise<Response> {
  return fetch(running.url + INGEST_APPEND_PATH, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Machine": KEY.machine,
      "X-Source": KEY.source,
      "X-Path": KEY.path,
      "X-Offset": String(offset),
      "X-Generation": "0",
    },
    body,
  });
}

test("serves the ingest API over a real socket and wakes the indexer hook", async () => {
  let woken = 0;
  server = startServer(config, { onIngest: () => void woken++ });
  const { token } = issueToken(server.db, { scope: "ingest", machine: "laptop" });

  expect((await fetch(`${server.url}/healthz`)).status).toBe(200);

  const res = await put(server, token, 0, "first\n");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ size: 6, generation: 0 });
  expect(woken).toBe(1);
  expect(dbPath(config)).toBe(join(dataDir, "db", "retrospecticus.sqlite"));
  expect(readFileSync(join(dataDir, "raw/laptop/codex", KEY.path), "utf8")).toBe("first\n");
});

test("an oversized body is refused over a real socket", async () => {
  server = startServer(config);
  const { token } = issueToken(server.db, { scope: "ingest", machine: "laptop" });
  const res = await put(server, token, 0, new Uint8Array(MAX_APPEND_BODY_BYTES + 1));
  expect(res.status).toBe(413);
  expect(getFile(server.db, KEY, 0)).toBeNull();
});

test("a restart after a crash reconciles files.size with the archive, and tokens persist", async () => {
  server = startServer(config);
  const { token } = issueToken(server.db, { scope: "ingest", machine: "laptop" });
  expect((await put(server, token, 0, "first\n")).status).toBe(200);
  await server.stop();

  appendFileSync(join(dataDir, "raw/laptop/codex", KEY.path), "second\n");

  server = startServer(config);
  expect(getFile(server.db, KEY, 0)?.size).toBe(13);
  const resumed = await put(server, token, 13, "third\n");
  expect(resumed.status).toBe(200);
  expect(readFileSync(join(dataDir, "raw/laptop/codex", KEY.path), "utf8")).toBe("first\nsecond\nthird\n");
});

test("started from config files, it follows an edited file and keeps the address it started with", async () => {
  const configPath = join(dataDir, "etc", "config.json");
  mkdirSync(join(dataDir, "etc"));
  writeFileSync(configPath, JSON.stringify({ data_dir: join(dataDir, "data"), listen_host: "127.0.0.1", listen_port: 0 }));
  const running = startServerFromFiles(configPath, { indexer: false });
  server = running;
  expect((await fetch(`${running.url}/healthz`)).status).toBe(200);
  writeFileSync(
    configPath,
    JSON.stringify({ data_dir: join(dataDir, "data"), listen_host: "127.0.0.1", listen_port: 1, alerts: { digest_hour: 3 } }),
  );
  const deadline = Date.now() + 3000;
  while (running.config.current().alerts.digest_hour !== 3) {
    if (Date.now() > deadline) throw new Error("the edit was not picked up");
    await Bun.sleep(20);
  }
  expect((await fetch(`${running.url}/healthz`)).status).toBe(200);
  expect(running.port).not.toBe(1);
});
