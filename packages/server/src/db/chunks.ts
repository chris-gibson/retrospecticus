import type { MessageRole } from "@retrospecticus/shared";
import { listVectorTables, type Db } from "./index.ts";
import type { MessageRow } from "./messages.ts";

export interface ChunkRow {
  id: number;
  session_id: string;
  start_message_id: number;
  end_message_id: number;
  /** Ordinal of the turn's first message, which is what `get_session` takes as `around_ordinal`. */
  ordinal: number;
  part: number;
  text: string;
  text_hash: string;
  token_estimate: number;
  timestamp: string | null;
}

/** A chunk without its text, which is all the chunk stage needs to diff against. */
export type ChunkKey = Pick<
  ChunkRow,
  "id" | "start_message_id" | "end_message_id" | "ordinal" | "part" | "text_hash" | "timestamp"
>;

export interface NewChunk {
  sessionId: string;
  startMessageId: number;
  endMessageId: number;
  ordinal: number;
  part: number;
  text: string;
  textHash: string;
  tokenEstimate: number;
  timestamp: string | null;
}

export type ChunkPosition = Pick<NewChunk, "startMessageId" | "endMessageId" | "ordinal" | "timestamp">;

export function insertChunk(db: Db, chunk: NewChunk): number {
  const result = db.run(
    `INSERT INTO chunks (session_id, start_message_id, end_message_id, ordinal, part, text, text_hash, token_estimate, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      chunk.sessionId,
      chunk.startMessageId,
      chunk.endMessageId,
      chunk.ordinal,
      chunk.part,
      chunk.text,
      chunk.textHash,
      chunk.tokenEstimate,
      chunk.timestamp,
    ],
  );
  return Number(result.lastInsertRowid);
}

/** Moves a chunk whose text is unchanged, so it keeps its id and with it its vectors. */
export function updateChunkPosition(db: Db, id: number, position: ChunkPosition): void {
  db.run("UPDATE chunks SET start_message_id = ?, end_message_id = ?, ordinal = ?, timestamp = ? WHERE id = ?", [
    position.startMessageId,
    position.endMessageId,
    position.ordinal,
    position.timestamp,
    id,
  ]);
}

/**
 * The only way chunks may be deleted. A vector table is keyed by chunk id and
 * SQLite reuses the ids of deleted rows, so a vector left behind would attach
 * itself to whatever chunk is created next.
 */
export function deleteChunks(db: Db, ids: readonly number[]): number {
  if (ids.length === 0) return 0;
  const statements = [
    ...listVectorTables(db).map((table) => db.query(`DELETE FROM "${table}" WHERE chunk_id = ?`)),
    db.query("DELETE FROM chunks WHERE id = ?"),
  ];
  for (const id of ids) for (const statement of statements) statement.run(id);
  return ids.length;
}

export function deleteChunksForSession(db: Db, sessionId: string): number {
  const ids = db.query<{ id: number }, [string]>("SELECT id FROM chunks WHERE session_id = ?").all(sessionId);
  return deleteChunks(
    db,
    ids.map((row) => row.id),
  );
}

export function deleteChunksForFile(db: Db, fileId: number): number {
  const ids = db
    .query<{ id: number }, [number]>(
      "SELECT c.id FROM chunks c JOIN sessions s ON s.id = c.session_id WHERE s.file_id = ?",
    )
    .all(fileId);
  return deleteChunks(
    db,
    ids.map((row) => row.id),
  );
}

export function listChunkKeys(db: Db, sessionId: string, fromOrdinal = 0): ChunkKey[] {
  return db
    .query<ChunkKey, [string, number]>(
      `SELECT id, start_message_id, end_message_id, ordinal, part, text_hash, timestamp
       FROM chunks WHERE session_id = ? AND ordinal >= ? ORDER BY ordinal, part`,
    )
    .all(sessionId, fromOrdinal);
}

export function listChunks(db: Db, sessionId: string): ChunkRow[] {
  return db.query<ChunkRow, [string]>("SELECT * FROM chunks WHERE session_id = ? ORDER BY ordinal, part").all(sessionId);
}

export function getChunk(db: Db, id: number): ChunkRow | null {
  return db.query<ChunkRow, [number]>("SELECT * FROM chunks WHERE id = ?").get(id);
}

export function countChunks(db: Db, sessionId?: string): number {
  const row =
    sessionId === undefined
      ? db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM chunks").get()
      : db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM chunks WHERE session_id = ?").get(sessionId);
  return row?.n ?? 0;
}

export interface ChunkedTurn {
  start_message_id: number;
  ordinal: number;
}

/** The last turn of a session that has chunks, which is where incremental chunking resumes. */
export function getLastChunkedTurn(db: Db, sessionId: string): ChunkedTurn | null {
  return db
    .query<ChunkedTurn, [string]>(
      "SELECT start_message_id, ordinal FROM chunks WHERE session_id = ? ORDER BY ordinal DESC LIMIT 1",
    )
    .get(sessionId);
}

/** True while the message a turn started with is still the same row in the same place. */
export function messageIsAt(db: Db, messageId: number, sessionId: string, ordinal: number): boolean {
  const row = db
    .query<{ n: number }, [number, string, number]>(
      "SELECT COUNT(*) AS n FROM messages WHERE id = ? AND session_id = ? AND ordinal = ?",
    )
    .get(messageId, sessionId, ordinal);
  return (row?.n ?? 0) > 0;
}

export function listMessagesWithRoles(
  db: Db,
  sessionId: string,
  roles: readonly MessageRole[],
  fromOrdinal = 0,
): MessageRow[] {
  const placeholders = roles.map(() => "?").join(", ");
  return db
    .query<MessageRow, (string | number)[]>(
      `SELECT * FROM messages WHERE session_id = ? AND ordinal >= ? AND role IN (${placeholders}) ORDER BY ordinal`,
    )
    .all(sessionId, fromOrdinal, ...roles);
}
