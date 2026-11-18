import type { SessionKind, Source } from "@retrospecticus/shared";
import type { SessionPatch } from "../parsers/types.ts";
import { deleteChunksForFile } from "./chunks.ts";
import type { Db } from "./index.ts";

export interface SessionRow {
  id: string;
  source: Source;
  machine: string;
  kind: SessionKind;
  project_path: string | null;
  git_branch: string | null;
  title: string | null;
  title_rank: number;
  started_at: string | null;
  ended_at: string | null;
  parent_session_id: string | null;
  harness_version: string | null;
  file_id: number | null;
  chunk_dirty: number;
}

export interface SessionOrigin {
  source: Source;
  machine: string;
  fileId: number;
}

/** Creates the row when missing; the first file to mention a session owns it. */
export function ensureSession(db: Db, id: string, origin: SessionOrigin): void {
  db.run("INSERT OR IGNORE INTO sessions (id, source, machine, file_id) VALUES (?, ?, ?, ?)", [
    id,
    origin.source,
    origin.machine,
    origin.fileId,
  ]);
}

/**
 * Merges a parser's patch into the session row so that applying the same
 * patches again, in any order, leaves the row unchanged; a reparse of an old
 * byte range depends on that. Kind and parent are constant per session, the
 * project, branch and version are those the session started with, and the
 * time span only ever widens. A title of equal rank replaces the current one
 * only when reading forward (`titleMode: "latest"`), so that a later rename
 * wins; a reparse passes `"outrank"` to keep an old title record from
 * displacing a newer one.
 */
export function applySessionPatch(
  db: Db,
  patch: SessionPatch,
  origin: SessionOrigin,
  titleMode: "latest" | "outrank" = "latest",
): void {
  ensureSession(db, patch.id, origin);
  db.run(
    `UPDATE sessions SET
       kind = COALESCE(?, kind),
       parent_session_id = COALESCE(?, parent_session_id),
       project_path = COALESCE(project_path, ?),
       git_branch = COALESCE(git_branch, ?),
       harness_version = COALESCE(harness_version, ?),
       started_at = CASE WHEN ? IS NOT NULL AND (started_at IS NULL OR ? < started_at) THEN ? ELSE started_at END,
       ended_at = CASE WHEN ? IS NOT NULL AND (ended_at IS NULL OR ? > ended_at) THEN ? ELSE ended_at END
     WHERE id = ?`,
    [
      patch.kind ?? null,
      patch.parentSessionId ?? null,
      patch.projectPath ?? null,
      patch.gitBranch ?? null,
      patch.harnessVersion ?? null,
      patch.timestamp ?? null,
      patch.timestamp ?? null,
      patch.timestamp ?? null,
      patch.timestamp ?? null,
      patch.timestamp ?? null,
      patch.timestamp ?? null,
      patch.id,
    ],
  );
  if (patch.title !== undefined) {
    const comparison = titleMode === "latest" ? "<=" : "<";
    db.run(`UPDATE sessions SET title = ?, title_rank = ? WHERE id = ? AND (title IS NULL OR title_rank ${comparison} ?)`, [
      patch.title.text,
      patch.title.rank,
      patch.id,
      patch.title.rank,
    ]);
  }
}

export function getSession(db: Db, id: string): SessionRow | null {
  return db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(id);
}

export function listSessions(db: Db): SessionRow[] {
  return db.query<SessionRow, []>("SELECT * FROM sessions ORDER BY started_at, id").all();
}

export function listSessionsForFile(db: Db, fileId: number): SessionRow[] {
  return db.query<SessionRow, [number]>("SELECT * FROM sessions WHERE file_id = ? ORDER BY id").all(fileId);
}

export function listChildSessions(db: Db, parentId: string): SessionRow[] {
  return db
    .query<SessionRow, [string]>("SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY started_at, id")
    .all(parentId);
}

/** New messages were appended; chunks of earlier turns are still valid. */
export const CHUNK_DIRTY_APPENDED = 1;
/** Existing messages were replaced or renumbered, so no earlier chunk can be trusted. */
export const CHUNK_DIRTY_REWRITTEN = 2;

export function markChunkDirty(db: Db, sessionIds: Iterable<string>, rewritten = false): void {
  const stmt = db.query("UPDATE sessions SET chunk_dirty = MAX(chunk_dirty, ?) WHERE id = ?");
  const level = rewritten ? CHUNK_DIRTY_REWRITTEN : CHUNK_DIRTY_APPENDED;
  for (const id of sessionIds) stmt.run(level, id);
}

/** Every session's chunks are rebuilt from its messages on the next chunk pass. */
export function markAllChunkDirty(db: Db): number {
  return db.run("UPDATE sessions SET chunk_dirty = ?", [CHUNK_DIRTY_REWRITTEN]).changes;
}

export function listChunkDirtySessions(db: Db, limit = 50): SessionRow[] {
  return db
    .query<SessionRow, [number]>("SELECT * FROM sessions WHERE chunk_dirty > 0 ORDER BY started_at, id LIMIT ?")
    .all(limit);
}

export function clearChunkDirty(db: Db, id: string): void {
  db.run("UPDATE sessions SET chunk_dirty = 0 WHERE id = ?", [id]);
}

/**
 * Messages go with the sessions through the schema's cascades. Chunks are
 * removed explicitly first, because a cascade cannot reach the vector tables.
 */
export function deleteSessionsForFile(db: Db, fileId: number): number {
  deleteChunksForFile(db, fileId);
  return db.run("DELETE FROM sessions WHERE file_id = ?", [fileId]).changes;
}
