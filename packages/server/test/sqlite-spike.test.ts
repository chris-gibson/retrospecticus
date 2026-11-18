import { expect, test } from "bun:test";
import { openDb, vectorTableName } from "../src/db/index.ts";

test("bun:sqlite has FTS5 with bm25", () => {
  const db = openDb(":memory:");
  db.run("CREATE VIRTUAL TABLE spike_fts USING fts5(text, tokenize='porter unicode61')");
  db.run("INSERT INTO spike_fts (text) VALUES ('the collector pushes bytes'), ('unrelated line')");
  const rows = db
    .query<{ rowid: number }, [string]>("SELECT rowid FROM spike_fts WHERE spike_fts MATCH ? ORDER BY bm25(spike_fts)")
    .all("collectors");
  expect(rows.map((r) => r.rowid)).toEqual([1]);
});

test("sqlite-vec loads and answers a cosine KNN query", () => {
  const db = openDb(":memory:");
  const table = vectorTableName("spike-model");
  expect(table).toBe("vectors_spike_model");
  db.run(`CREATE VIRTUAL TABLE ${table} USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[4] distance_metric=cosine)`);
  const insert = db.prepare(`INSERT INTO ${table} (chunk_id, embedding) VALUES (?, ?)`);
  insert.run(1, new Float32Array([1, 0, 0, 0]));
  insert.run(2, new Float32Array([0, 1, 0, 0]));
  const rows = db
    .query<{ chunk_id: number; distance: number }, [Float32Array]>(
      `SELECT chunk_id, distance FROM ${table} WHERE embedding MATCH ? AND k = 2 ORDER BY distance`,
    )
    .all(new Float32Array([0.9, 0.1, 0, 0]));
  expect(rows.map((r) => r.chunk_id)).toEqual([1, 2]);
  expect(rows[0]!.distance).toBeLessThan(0.05);
});

test("the schema creates every fixed table", () => {
  const db = openDb(":memory:");
  const names = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
    .all()
    .map((r) => r.name);
  for (const t of [
    "files", "sessions", "records", "messages", "chunks", "chunks_fts", "embedding_models",
    "shapes", "drift_events", "quarantine", "tokens", "query_log",
  ]) {
    expect(names).toContain(t);
  }
});
