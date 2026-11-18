import type { MessageRole, SessionKind, Source } from "@retrospecticus/shared";
import { events } from "../events.ts";
import type { SearchFilters } from "../search/filters.ts";
import { nowIso, type Db } from "./index.ts";
import type { MessageRow } from "./messages.ts";

/** A chunk with the facts of its session, as every search path returns it. */
export interface ChunkHit {
  chunk_id: number;
  session_id: string;
  ordinal: number;
  text: string;
  text_hash: string;
  timestamp: string | null;
  title: string | null;
  project_path: string | null;
  source: Source;
  machine: string;
  kind: SessionKind;
}

export interface RankedChunkHit extends ChunkHit {
  /** bm25 score; lower is better. */
  rank: number;
}

const HIT_COLUMNS = `c.id AS chunk_id, c.session_id, c.ordinal, c.text, c.text_hash, c.timestamp,
  s.title, s.project_path, s.source, s.machine, s.kind`;

type Param = string | number;

/** Filters expect bounds already normalised to UTC ISO strings (see `normalizeFilters`). */
function filterClause(filters: SearchFilters, timeColumn: string): { sql: string; params: Param[] } {
  // Guardian sessions are archived only; they must never surface in recall.
  const parts = ["s.kind != 'guardian'"];
  const params: Param[] = [];
  if (filters.source !== undefined) {
    parts.push("s.source = ?");
    params.push(filters.source);
  }
  if (filters.machine !== undefined) {
    parts.push("s.machine = ?");
    params.push(filters.machine);
  }
  if (filters.project !== undefined) {
    // instr rather than LIKE so `%` and `_` in a path are literal.
    parts.push("instr(s.project_path, ?) > 0");
    params.push(filters.project);
  }
  if (filters.after !== undefined) {
    parts.push(`${timeColumn} >= ?`);
    params.push(filters.after);
  }
  if (filters.before !== undefined) {
    parts.push(`${timeColumn} < ?`);
    params.push(filters.before);
  }
  return { sql: parts.join(" AND "), params };
}

/** `match` must be a well-formed FTS5 expression; build it with `buildFtsQuery`. */
export function ftsQuery(db: Db, match: string, filters: SearchFilters, limit: number): RankedChunkHit[] {
  const where = filterClause(filters, "c.timestamp");
  return db
    .query<RankedChunkHit, Param[]>(
      `SELECT ${HIT_COLUMNS}, bm25(chunks_fts) AS rank
       FROM chunks_fts
       JOIN chunks c ON c.id = chunks_fts.rowid
       JOIN sessions s ON s.id = c.session_id
       WHERE chunks_fts MATCH ? AND ${where.sql}
       ORDER BY rank, c.id
       LIMIT ?`,
    )
    .all(match, ...where.params, limit);
}

/** Unordered; ids that are missing or fail the filters are left out. */
export function getChunkHits(db: Db, ids: readonly number[], filters: SearchFilters): ChunkHit[] {
  if (ids.length === 0) return [];
  const where = filterClause(filters, "c.timestamp");
  const placeholders = ids.map(() => "?").join(", ");
  return db
    .query<ChunkHit, Param[]>(
      `SELECT ${HIT_COLUMNS}
       FROM chunks c JOIN sessions s ON s.id = c.session_id
       WHERE c.id IN (${placeholders}) AND ${where.sql}`,
    )
    .all(...ids, ...where.params);
}

export interface SessionSummary {
  id: string;
  title: string | null;
  project_path: string | null;
  source: Source;
  machine: string;
  kind: SessionKind;
  started_at: string | null;
  ended_at: string | null;
}

export interface SessionListOptions {
  project?: string;
  after?: string;
  before?: string;
  limit: number;
}

/** Newest first; `after` and `before` apply to the session's start. */
export function listSessionSummaries(db: Db, options: SessionListOptions): SessionSummary[] {
  const where = filterClause(
    { project: options.project, after: options.after, before: options.before },
    "s.started_at",
  );
  return db
    .query<SessionSummary, Param[]>(
      `SELECT s.id, s.title, s.project_path, s.source, s.machine, s.kind, s.started_at, s.ended_at
       FROM sessions s
       WHERE ${where.sql}
       ORDER BY s.started_at IS NULL, s.started_at DESC, s.id
       LIMIT ?`,
    )
    .all(...where.params, options.limit);
}

export interface TranscriptSliceOptions {
  aroundOrdinal?: number;
  window: number;
  roles: readonly MessageRole[];
}

/**
 * With `aroundOrdinal`, the messages whose ordinal lies within `window` of it;
 * otherwise the first `2 * window` messages of the allowed roles.
 */
export function getTranscriptSlice(db: Db, sessionId: string, options: TranscriptSliceOptions): MessageRow[] {
  if (options.roles.length === 0) return [];
  const roles = options.roles.map(() => "?").join(", ");
  if (options.aroundOrdinal !== undefined) {
    return db
      .query<MessageRow, Param[]>(
        `SELECT * FROM messages
         WHERE session_id = ? AND role IN (${roles}) AND ordinal BETWEEN ? AND ?
         ORDER BY ordinal, part`,
      )
      .all(
        sessionId,
        ...options.roles,
        options.aroundOrdinal - options.window,
        options.aroundOrdinal + options.window,
      );
  }
  return db
    .query<MessageRow, Param[]>(
      `SELECT * FROM messages WHERE session_id = ? AND role IN (${roles}) ORDER BY ordinal, part LIMIT ?`,
    )
    .all(sessionId, ...options.roles, options.window * 2);
}

export interface QueryLogEntry {
  tokenId: number | null;
  tool: string;
  query: string | null;
  resultCount: number;
}

export function logQuery(db: Db, entry: QueryLogEntry): void {
  db.run("INSERT INTO query_log (token_id, tool, query, result_count, created_at) VALUES (?, ?, ?, ?, ?)", [
    entry.tokenId,
    entry.tool,
    entry.query,
    entry.resultCount,
    nowIso(),
  ]);
  events.publish("stats");
}

export interface QueryLogRow {
  id: number;
  token_id: number | null;
  tool: string;
  query: string | null;
  result_count: number;
  created_at: string;
}

export function listQueryLog(db: Db): QueryLogRow[] {
  return db.query<QueryLogRow, []>("SELECT * FROM query_log ORDER BY id").all();
}
