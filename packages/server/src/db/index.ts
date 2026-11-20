import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as sqliteVec from "sqlite-vec";
import { DERIVED_SCHEMA, DERIVED_TABLES, KEPT_SCHEMA, SCHEMA_VERSION } from "./schema.ts";

export type Db = Database;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  loadSqliteVec(db);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

export const SQLITE_VEC_ENV_VAR = "RETROSPECTICUS_SQLITE_VEC";

/**
 * The npm package finds its library inside node_modules, which a compiled
 * executable does not have, so release builds ship the library beside the
 * executable or name it in the environment.
 */
function loadSqliteVec(db: Db): void {
  const explicit = process.env[SQLITE_VEC_ENV_VAR];
  if (explicit) {
    db.loadExtension(explicit);
    return;
  }
  try {
    sqliteVec.load(db);
  } catch (err) {
    const beside = join(dirname(process.execPath), process.platform === "darwin" ? "vec0.dylib" : "vec0.so");
    if (!existsSync(beside)) {
      throw new Error(
        `Cannot load sqlite-vec: ${(err as Error).message}. Put vec0 beside the executable or set ${SQLITE_VEC_ENV_VAR}.`,
      );
    }
    db.loadExtension(beside);
  }
}

function migrate(db: Db): void {
  db.run(KEPT_SCHEMA);
  db.run(DERIVED_SCHEMA);
  addMissingColumns(db, "embedding_models", {
    query_prefix: "TEXT NOT NULL DEFAULT ''",
    document_prefix: "TEXT NOT NULL DEFAULT ''",
  });
  addMissingColumns(db, "machine_commands", { delivered_token_id: "INTEGER" });
  addMissingColumns(db, "machines", {
    hostname: "TEXT",
    platform: "TEXT",
    started_at: "TEXT",
    last_upload_at: "TEXT",
    last_scan_at: "TEXT",
    last_error: "TEXT",
    exec_path: "TEXT",
    remote_update: "INTEGER",
  });
  db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
}

export function getMeta(db: Db, key: string): string | null {
  return db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [key, value]);
}

/** `CREATE TABLE IF NOT EXISTS` leaves an older table as it was, so columns added since are added here. */
function addMissingColumns(db: Db, table: string, columns: Record<string, string>): void {
  const have = new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, definition] of Object.entries(columns)) {
    if (!have.has(name)) db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

export function vectorTableName(slug: string): string {
  return `vectors_${slug.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

export function listVectorTables(db: Db): string[] {
  return db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vectors\\_%' ESCAPE '\\' AND sql LIKE '%vec0%'",
    )
    .all()
    .map((r) => r.name);
}

/**
 * Drops everything derived from the raw archive and rewinds every file so the
 * indexer rebuilds it. Vector tables are left for the caller to handle because
 * re-embedding costs money; see the reindex command.
 */
export function resetDerived(db: Db): void {
  db.transaction(() => {
    for (const t of ["chunks_ai", "chunks_ad", "chunks_au"]) db.run(`DROP TRIGGER IF EXISTS ${t}`);
    for (const t of DERIVED_TABLES) db.run(`DROP TABLE IF EXISTS ${t}`);
    db.run(DERIVED_SCHEMA);
    db.run(
      "UPDATE files SET parsed_offset = 0, parser_state = NULL, harness_version = NULL, lines_read = 0, messages_produced = 0",
    );
  })();
}

export function nowIso(): string {
  return new Date().toISOString();
}
