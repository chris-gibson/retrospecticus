import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { INGEST_APPEND_PATH } from "@retrospecticus/shared";
import { issueToken } from "../src/auth.ts";
import { defaultConfig, rawDir as rawDirOf } from "../src/config.ts";
import { openDb, type Db } from "../src/db/index.ts";
import { countMessages, listMessages } from "../src/db/messages.ts";
import { listChunkDirtySessions } from "../src/db/sessions.ts";
import { runUntilIdle, startIndexer, type Indexer } from "../src/indexer/loop.ts";
import type { IndexerStage, LineObserver } from "../src/indexer/types.ts";
import { startServer, type RunningServer } from "../src/main.ts";
import { archive, archiveFixture, manifest, tempDir } from "./fixture-helpers.ts";

const CLAUDE = { source: "claude-code", path: "proj/s-1.jsonl" } as const;

function userLine(i: number, text: string): string {
  return `${JSON.stringify({
    type: "user",
    uuid: `u-${i}`,
    parentUuid: null,
    sessionId: "s-1",
    timestamp: new Date(Date.UTC(2026, 10, 16, 10, 0, i)).toISOString(),
    cwd: "/work/app",
    version: "2.1.325",
    message: { role: "user", content: text },
  })}\n`;
}

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(5);
  }
}

let db: Db;
let rawDir: string;
let indexer: Indexer | null;

beforeEach(() => {
  db = openDb(":memory:");
  rawDir = tempDir();
  indexer = null;
});
afterEach(async () => {
  await indexer?.stop();
  db.close();
  rmSync(rawDir, { recursive: true, force: true });
});

describe("runUntilIdle", () => {
  test("parses everything, then runs stages in order until none has work", async () => {
    for (const entry of manifest) archiveFixture(db, rawDir, entry);
    const calls: string[] = [];
    let chunkRuns = 0;
    const chunk: IndexerStage = {
      name: "chunk",
      run(sdb) {
        calls.push(`chunk:${countMessages(sdb) > 0}`);
        return chunkRuns++ < 2;
      },
    };
    const embed: IndexerStage = { name: "embed", run: async () => (calls.push("embed"), false) };
    const lines: number[] = [];
    const observer: LineObserver = { onLine: () => void lines.push(1) };

    await runUntilIdle({ db, rawDir, observers: [observer], stages: [chunk, embed], parse: { maxBytesPerRun: 200_000 } });

    expect(lines.length).toBe(manifest.reduce((n, m) => n + m.lines, 0));
    expect(db.query("SELECT COUNT(*) AS n FROM files WHERE size > parsed_offset").get()).toEqual({ n: 0 });
    expect(calls[0]).toBe("chunk:true");
    expect(calls.filter((c) => c === "embed").length).toBe(calls.filter((c) => c.startsWith("chunk")).length);
    expect(calls.at(-1)).toBe("embed");
    expect(listChunkDirtySessions(db, 1000).length).toBeGreaterThan(0);
  });

  test("throws on a failing stage unless an error handler is given", async () => {
    const broken: IndexerStage = { name: "embed", run: () => Promise.reject(new Error("provider down")) };
    await expect(runUntilIdle({ db, rawDir, stages: [broken] })).rejects.toThrow("provider down");

    const errors: string[] = [];
    let later = 0;
    await runUntilIdle({ db, rawDir, stages: [broken, { name: "after", run: () => (later++, false) }], onError: (_e, stage) => void errors.push(stage) });
    expect(errors).toEqual(["embed"]);
    expect(later).toBe(1);
  });
});

describe("startIndexer", () => {
  test("wake() makes it pick up new bytes without waiting for the poll", async () => {
    indexer = startIndexer({ db, rawDir, pollSeconds: 3600 });
    await Bun.sleep(20);
    archive(db, rawDir, CLAUDE, userLine(0, "hello indexer"));
    await Bun.sleep(50);
    expect(countMessages(db)).toBe(0);

    indexer.wake();
    await until(() => countMessages(db) === 1);
    expect(listMessages(db, "s-1").map((m) => m.text)).toEqual(["hello indexer"]);
  });

  test("polls on its own", async () => {
    indexer = startIndexer({ db, rawDir, pollSeconds: 0.02 });
    await Bun.sleep(30);
    archive(db, rawDir, CLAUDE, userLine(0, "found by polling"));
    await until(() => countMessages(db) === 1);
  });

  test("keeps running stages and later ticks when one step fails", async () => {
    const errors: string[] = [];
    let healthy = 0;
    indexer = startIndexer({
      db,
      rawDir,
      pollSeconds: 0.01,
      stages: [
        { name: "embed", run: () => Promise.reject(new Error("provider down")) },
        { name: "after", run: () => (healthy++, false) },
      ],
      onError: (_error, stage) => void errors.push(stage),
    });
    await until(() => healthy >= 3);
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(new Set(errors)).toEqual(new Set(["embed"]));
    archive(db, rawDir, CLAUDE, userLine(0, "still parsed"));
    await until(() => countMessages(db) === 1);
  });

  test("stop() waits for the tick in progress and then nothing runs again", async () => {
    let running = false;
    let runs = 0;
    const slow: IndexerStage = {
      name: "slow",
      async run() {
        running = true;
        runs++;
        await Bun.sleep(40);
        running = false;
        return true;
      },
    };
    indexer = startIndexer({ db, rawDir, pollSeconds: 0.01, stages: [slow] });
    await until(() => running);
    await indexer.stop();
    expect(running).toBe(false);
    const after = runs;
    await Bun.sleep(80);
    expect(runs).toBe(after);
    indexer.wake();
    await indexer.stop();
  });
});

describe("startServer", () => {
  let server: RunningServer | null = null;
  let dataDir: string;

  beforeEach(() => {
    dataDir = tempDir();
  });
  afterEach(async () => {
    await server?.stop();
    server = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  function put(running: RunningServer, token: string, body: string): Promise<Response> {
    return fetch(running.url + INGEST_APPEND_PATH, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Machine": "laptop",
        "X-Source": CLAUDE.source,
        "X-Path": CLAUDE.path,
        "X-Offset": "0",
        "X-Generation": "0",
      },
      body,
    });
  }

  test("an ingest append wakes the indexer, which runs the injected observers and stages", async () => {
    const config = defaultConfig({ data_dir: dataDir, listen_port: 0, indexer: { poll_seconds: 3600 } });
    const seen: string[] = [];
    let stageRuns = 0;
    let ingests = 0;
    server = startServer(config, {
      onIngest: () => void ingests++,
      indexer: {
        observers: [{ onLine: (_db, parsed) => void seen.push(parsed.result.kind) }],
        stages: [{ name: "chunk", run: () => (stageRuns++, false) }],
      },
    });
    expect(server.indexer).not.toBeNull();
    const { token } = issueToken(server.db, { scope: "ingest", machine: "laptop" });
    const running = server;
    await Bun.sleep(20);
    const before = stageRuns;

    expect((await put(running, token, userLine(0, "over http"))).status).toBe(200);
    await until(() => countMessages(running.db) === 1);
    expect(ingests).toBe(1);
    expect(seen).toEqual(["messages"]);
    await until(() => stageRuns > before);
    expect(rawDirOf(config)).toContain(dataDir);
  });

  test("indexer: false leaves the archive unparsed", async () => {
    server = startServer(defaultConfig({ data_dir: dataDir, listen_port: 0, indexer: { poll_seconds: 0.01 } }), { indexer: false });
    expect(server.indexer).toBeNull();
    const { token } = issueToken(server.db, { scope: "ingest", machine: "laptop" });
    expect((await put(server, token, userLine(0, "nobody reads this"))).status).toBe(200);
    await Bun.sleep(60);
    expect(countMessages(server.db)).toBe(0);
  });
});
