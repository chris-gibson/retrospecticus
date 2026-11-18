import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbPath, loadConfig, rawDir as rawDirOf, type ServerConfig } from "@retrospecticus/server/config.ts";
import { countChunks } from "@retrospecticus/server/db/chunks.ts";
import { getFile, listFiles } from "@retrospecticus/server/db/files.ts";
import { openDb, type Db } from "@retrospecticus/server/db/index.ts";
import { countMessages } from "@retrospecticus/server/db/messages.ts";
import { listSessions } from "@retrospecticus/server/db/sessions.ts";
import { activateModel, countMissing, countVectors, getActiveModel } from "@retrospecticus/server/db/vectors.ts";
import { createFakeProvider } from "@retrospecticus/server/embeddings/fake.ts";
import type { EmbeddingProvider } from "@retrospecticus/server/embeddings/types.ts";
import { embedAll, registerProvider } from "@retrospecticus/server/indexer/embed.ts";
import { runUntilIdle } from "@retrospecticus/server/indexer/loop.ts";
import { buildWiring } from "@retrospecticus/server/wiring.ts";
import { archive, archiveFixture, fixtureLines, manifest } from "../../server/test/fixture-helpers.ts";
import { run } from "../src/main.ts";
import { reindexFromRaw } from "../src/commands/reindex.ts";

let dir: string;
let configPath: string;
let config: ServerConfig;
let db: Db;
let raw: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "retrospecticus-reindex-"));
  configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ data_dir: join(dir, "data"), listen_host: "127.0.0.1", listen_port: 0 }));
  config = loadConfig(configPath);
  db = openDb(dbPath(config));
  raw = rawDirOf(config);
});
afterEach(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function cli(...args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(["--config", configPath, ...args], { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

function archiveSome(): void {
  const wanted = manifest.filter((e) => e.role === "main" || e.role === "subagent");
  expect(wanted.length).toBeGreaterThan(3);
  for (const entry of wanted) archiveFixture(db, raw, entry);
}

async function indexAndEmbed(provider: EmbeddingProvider): Promise<void> {
  const wiring = buildWiring(db, config);
  await runUntilIdle({ db, rawDir: raw, observers: wiring.observers, stages: wiring.stages.filter((s) => s.name === "chunk") });
  registerProvider(db, provider);
  activateModel(db, provider.slug);
  await embedAll(db, provider);
}

function counts() {
  return {
    sessions: listSessions(db).length,
    messages: countMessages(db),
    chunks: countChunks(db),
    hashes: db.query<{ text_hash: string }, []>("SELECT text_hash FROM chunks ORDER BY text_hash").all().map((r) => r.text_hash),
  };
}

function countingProvider(): { provider: EmbeddingProvider; calls: () => number } {
  const inner = createFakeProvider();
  let calls = 0;
  return {
    provider: {
      ...inner,
      async embed(texts) {
        calls++;
        return inner.embed(texts);
      },
    },
    calls: () => calls,
  };
}

function fileKeys() {
  return listFiles(db).map(({ machine, source, path, generation, size }) => ({ machine, source, path, generation, size }));
}

describe("reindex --from-raw", () => {
  test("rebuilds derived tables, restores vectors without the provider and keeps tokens and shapes", async () => {
    archiveSome();
    const { provider, calls } = countingProvider();
    await indexAndEmbed(provider);
    const before = counts();
    const vectors = countVectors(db, provider.slug);
    expect(before.chunks).toBeGreaterThan(0);
    expect(vectors).toBe(before.chunks);
    const callsBefore = calls();

    db.run("INSERT INTO tokens (name, hash, scope, created_at) VALUES ('t', 'abc', 'admin', '2026-11-01T00:00:00.000Z')");
    db.run(
      "INSERT INTO shapes (source, hash, discriminator, classification, first_seen, last_seen) VALUES ('codex', 'h1', 'd', 'known', 'x', 'y')",
    );

    const lines: string[] = [];
    const summary = await reindexFromRaw(db, config, (l) => lines.push(l));

    expect(counts()).toEqual(before);
    expect(summary).toMatchObject({ sessions: before.sessions, messages: before.messages, chunks: before.chunks });
    expect(summary.vectorsRestored).toBe(vectors);
    expect(countVectors(db, provider.slug)).toBe(vectors);
    expect(countMissing(db, getActiveModel(db)!.slug)).toBe(0);
    expect(calls()).toBe(callsBefore);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens WHERE hash = 'abc'").get()?.n).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM shapes WHERE hash = 'h1'").get()?.n).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'vector_stash'").get()?.n).toBe(0);
    expect(lines.length).toBeGreaterThanOrEqual(5);
  });

  test("rebuilds missing files rows from the directory walk, including a later generation", async () => {
    archiveSome();
    const main = manifest.find((e) => e.role === "main" && e.source === "claude-code")!;
    const path = main.path.split("/").slice(1).join("/");
    archive(db, raw, { source: "claude-code", path, generation: 1 }, fixtureLines(main).slice(0, 2).join("\n") + "\n");
    await indexAndEmbed(countingProvider().provider);
    const before = counts();
    const filesBefore = fileKeys();
    expect(filesBefore.some((f) => f.generation === 1)).toBe(true);

    db.run("PRAGMA foreign_keys = OFF");
    db.run("DELETE FROM files");
    db.run("PRAGMA foreign_keys = ON");
    await reindexFromRaw(db, config, () => {});

    expect(fileKeys()).toEqual(filesBefore);
    expect(counts()).toEqual(before);
    expect(getFile(db, { machine: "laptop", source: "claude-code", path }, 1)).not.toBeNull();
  });

  test("without --from-raw it exits 2 and changes nothing", async () => {
    archiveSome();
    const { provider } = countingProvider();
    await indexAndEmbed(provider);
    const before = counts();
    const result = await cli("reindex");
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("--from-raw");
    expect(counts()).toEqual(before);
    expect(countVectors(db, provider.slug)).toBe(before.chunks);
  });
});
