import { nowIso, vectorTableName, type Db } from "./index.ts";

export interface ModelSpec {
  slug: string;
  provider: string;
  model: string;
  dimensions: number;
  /** Prepended to each search query before embedding. */
  query_prefix?: string;
  /** Prepended to each chunk before embedding; part of what the stored vectors mean. */
  document_prefix?: string;
}

export interface ModelRow extends ModelSpec {
  query_prefix: string;
  document_prefix: string;
  active: boolean;
  created_at: string;
}

export interface ModelSummary extends ModelRow {
  vectors: number;
  /** Chunks that have no vector in this model's table yet. */
  missing: number;
}

export interface ChunkToEmbed {
  id: number;
  text: string;
  text_hash: string;
}

export interface VectorRow {
  chunkId: number;
  embedding: Float32Array;
  /**
   * The hash of the text that was embedded. When given, the vector is dropped
   * if the chunk's text changed while the provider was working.
   */
  textHash?: string;
}

/** sqlite-vec refuses a larger k. */
export const MAX_KNN_K = 4096;

interface RawModelRow extends ModelSpec {
  query_prefix: string;
  document_prefix: string;
  active: number;
  created_at: string;
}

function toModel(row: RawModelRow): ModelRow {
  return { ...row, active: row.active === 1 };
}

function quoted(slug: string): string {
  return `"${vectorTableName(slug)}"`;
}

function tableExists(db: Db, slug: string): boolean {
  const row = db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(vectorTableName(slug));
  return (row?.n ?? 0) > 0;
}

export function getModel(db: Db, slug: string): ModelRow | null {
  const row = db.query<RawModelRow, [string]>("SELECT * FROM embedding_models WHERE slug = ?").get(slug);
  return row ? toModel(row) : null;
}

/**
 * Registers a model and creates its vector table. Idempotent, but a slug
 * cannot change dimensions or document prefix: its existing vectors would no
 * longer fit or no longer mean the same thing. The query prefix may change.
 */
export function ensureModel(db: Db, spec: ModelSpec): ModelRow {
  if (!Number.isInteger(spec.dimensions) || spec.dimensions <= 0) {
    throw new Error(`Embedding model ${spec.slug} needs a positive whole number of dimensions, got ${spec.dimensions}`);
  }
  return db
    .transaction(() => {
      const existing = getModel(db, spec.slug);
      if (existing && existing.dimensions !== spec.dimensions) {
        throw new Error(
          `Embedding model ${spec.slug} is registered with ${existing.dimensions} dimensions, not ${spec.dimensions}`,
        );
      }
      const documentPrefix = spec.document_prefix ?? "";
      const queryPrefix = spec.query_prefix ?? "";
      if (existing && existing.document_prefix !== documentPrefix) {
        throw new Error(
          `Embedding model ${spec.slug} was embedded with document prefix ${JSON.stringify(existing.document_prefix)}, not ${JSON.stringify(documentPrefix)}. ` +
            "Restore the old prefix, or drop the model's vectors with `retrospecticus embedding drop " +
            spec.slug +
            "` and let them be rebuilt.",
        );
      }
      if (!existing) {
        db.run(
          `INSERT INTO embedding_models (slug, provider, model, dimensions, active, created_at, query_prefix, document_prefix)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
          [spec.slug, spec.provider, spec.model, spec.dimensions, nowIso(), queryPrefix, documentPrefix],
        );
      } else if (existing.query_prefix !== queryPrefix) {
        db.run("UPDATE embedding_models SET query_prefix = ? WHERE slug = ?", [queryPrefix, spec.slug]);
      }
      db.run(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${quoted(spec.slug)} USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[${spec.dimensions}] distance_metric=cosine)`,
      );
      return getModel(db, spec.slug)!;
    })
    .immediate();
}

export function getActiveModel(db: Db): ModelRow | null {
  const row = db
    .query<RawModelRow, []>("SELECT * FROM embedding_models WHERE active = 1 ORDER BY created_at DESC LIMIT 1")
    .get();
  return row ? toModel(row) : null;
}

export function listModels(db: Db): ModelSummary[] {
  return db
    .query<RawModelRow, []>("SELECT * FROM embedding_models ORDER BY created_at, slug")
    .all()
    .map((row) => ({ ...toModel(row), vectors: countVectors(db, row.slug), missing: countMissing(db, row.slug) }));
}

export function activateModel(db: Db, slug: string): void {
  db.transaction(() => {
    if (!getModel(db, slug)) throw new Error(`Unknown embedding model: ${slug}`);
    db.run("UPDATE embedding_models SET active = (slug = ?)", [slug]);
  }).immediate();
}

export function countVectors(db: Db, slug: string): number {
  if (!tableExists(db, slug)) return 0;
  return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${quoted(slug)}`).get()?.n ?? 0;
}

export function countMissing(db: Db, slug: string): number {
  const sql = tableExists(db, slug)
    ? `SELECT COUNT(*) AS n FROM chunks WHERE id NOT IN (SELECT chunk_id FROM ${quoted(slug)})`
    : "SELECT COUNT(*) AS n FROM chunks";
  return db.query<{ n: number }, []>(sql).get()?.n ?? 0;
}

/** Oldest first, so a backlog drains in the order it built up. */
export function listChunksWithoutVector(db: Db, slug: string, limit: number): ChunkToEmbed[] {
  return db
    .query<ChunkToEmbed, [number]>(
      `SELECT id, text, text_hash FROM chunks WHERE id NOT IN (SELECT chunk_id FROM ${quoted(slug)}) ORDER BY id LIMIT ?`,
    )
    .all(limit);
}

/**
 * Embedding happens outside any transaction, and another process (reembed
 * beside the server) may write the same table, so each row is checked again
 * here: a chunk deleted or rewritten meanwhile, or already embedded, is skipped.
 * Returns how many vectors were stored.
 */
export function insertVectors(db: Db, slug: string, rows: readonly VectorRow[]): number {
  if (rows.length === 0) return 0;
  const table = quoted(slug);
  const chunk = db.query<{ text_hash: string }, [number]>("SELECT text_hash FROM chunks WHERE id = ?");
  const existing = db.query<{ n: number }, [number]>(`SELECT COUNT(*) AS n FROM ${table} WHERE chunk_id = ?`);
  const insert = db.query(`INSERT INTO ${table} (chunk_id, embedding) VALUES (?, ?)`);
  return db
    .transaction(() => {
      let stored = 0;
      for (const row of rows) {
        const current = chunk.get(row.chunkId);
        if (!current || (row.textHash !== undefined && current.text_hash !== row.textHash)) continue;
        if ((existing.get(row.chunkId)?.n ?? 0) > 0) continue;
        insert.run(row.chunkId, row.embedding);
        stored++;
      }
      return stored;
    })
    .immediate();
}

/** Nearest first. */
export function knn(db: Db, slug: string, queryVector: Float32Array, k: number): number[] {
  const limit = Math.max(1, Math.min(MAX_KNN_K, Math.floor(k)));
  return db
    .query<{ chunk_id: number }, [Float32Array, number]>(
      `SELECT chunk_id FROM ${quoted(slug)} WHERE embedding MATCH ? AND k = ? ORDER BY distance`,
    )
    .all(queryVector, limit)
    .map((row) => row.chunk_id);
}

/**
 * Copies every vector into `vector_stash`, keyed by model and chunk text hash,
 * so a rebuild that renumbers chunk ids can put them back without calling a
 * provider. A regular table rather than a temp one, so it outlives the
 * connection. Returns the number of stashed vectors.
 */
export function stashVectors(db: Db): number {
  return db
    .transaction(() => {
      db.run(
        "CREATE TABLE IF NOT EXISTS vector_stash (slug TEXT NOT NULL, text_hash TEXT NOT NULL, embedding BLOB NOT NULL, PRIMARY KEY (slug, text_hash))",
      );
      // A stash left by an interrupted reindex is kept: by then the vec tables are empty and it is the only copy.
      for (const model of listModels(db)) {
        if (!tableExists(db, model.slug)) continue;
        db.run(
          `INSERT OR REPLACE INTO vector_stash (slug, text_hash, embedding)
           SELECT ?, c.text_hash, v.embedding FROM ${quoted(model.slug)} v JOIN chunks c ON c.id = v.chunk_id`,
          [model.slug],
        );
      }
      return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM vector_stash").get()?.n ?? 0;
    })
    .immediate();
}

/** Puts stashed vectors back on current chunks that lack one, then drops the stash. Returns how many were restored. */
export function restoreVectors(db: Db): number {
  return db
    .transaction(() => {
      let restored = 0;
      for (const model of listModels(db)) {
        if (!tableExists(db, model.slug)) continue;
        const table = quoted(model.slug);
        const before = countVectors(db, model.slug);
        db.run(
          `INSERT INTO ${table} (chunk_id, embedding)
           SELECT c.id, s.embedding FROM chunks c JOIN vector_stash s ON s.text_hash = c.text_hash AND s.slug = ?
           WHERE c.id NOT IN (SELECT chunk_id FROM ${table})`,
          [model.slug],
        );
        restored += countVectors(db, model.slug) - before;
      }
      db.run("DROP TABLE IF EXISTS vector_stash");
      return restored;
    })
    .immediate();
}

/** Forgets a model and its vectors. An active model leaves search on keywords until another is activated. */
export function dropModel(db: Db, slug: string): void {
  db.transaction(() => {
    if (!getModel(db, slug)) throw new Error(`Unknown embedding model: ${slug}`);
    db.run(`DROP TABLE IF EXISTS ${quoted(slug)}`);
    db.run("DELETE FROM embedding_models WHERE slug = ?", [slug]);
  }).immediate();
}

/** Chunk ids are about to disappear, so every vector row would point at nothing. */
export function clearVectorTables(db: Db): void {
  db.transaction(() => {
    for (const model of listModels(db)) {
      if (tableExists(db, model.slug)) db.run(`DELETE FROM ${quoted(model.slug)}`);
    }
  })();
}
