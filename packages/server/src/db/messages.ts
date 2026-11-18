import type { MessageRole } from "@retrospecticus/shared";
import type { Db } from "./index.ts";

export interface RecordRow {
  id: number;
  file_id: number;
  byte_offset: number;
  byte_length: number;
  record_type: string;
  native_id: string | null;
  parent_native_id: string | null;
  timestamp: string | null;
}

export interface MessageRow {
  id: number;
  session_id: string;
  ordinal: number;
  role: MessageRole;
  text: string;
  record_id: number;
  part: number;
  tool_name: string | null;
  timestamp: string | null;
}

export interface NewRecord {
  fileId: number;
  byteOffset: number;
  byteLength: number;
  type: string;
  nativeId?: string;
  parentNativeId?: string;
  timestamp?: string;
}

export interface NewMessage {
  sessionId: string;
  ordinal: number;
  role: MessageRole;
  text: string;
  recordId: number;
  part: number;
  toolName?: string;
  timestamp?: string;
}

export function insertRecord(db: Db, record: NewRecord): number {
  const result = db.run(
    `INSERT INTO records (file_id, byte_offset, byte_length, record_type, native_id, parent_native_id, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      record.fileId,
      record.byteOffset,
      record.byteLength,
      record.type,
      record.nativeId ?? null,
      record.parentNativeId ?? null,
      record.timestamp ?? null,
    ],
  );
  return Number(result.lastInsertRowid);
}

export function insertMessage(db: Db, message: NewMessage): void {
  db.run(
    `INSERT INTO messages (session_id, ordinal, role, text, record_id, part, tool_name, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      message.sessionId,
      message.ordinal,
      message.role,
      message.text,
      message.recordId,
      message.part,
      message.toolName ?? null,
      message.timestamp ?? null,
    ],
  );
}

export interface DeletedRange {
  /** Sessions that lost messages and so need their ordinals closed up. */
  sessionIds: string[];
  messages: number;
}

/**
 * Removes everything derived from lines starting in `[start, end)` of one
 * file: records, their messages (by cascade) and quarantine entries, so a
 * reparse of the range starts from nothing.
 */
export function deleteDerivedInRange(db: Db, fileId: number, start: number, end: number): DeletedRange {
  const affected = db
    .query<{ session_id: string; n: number }, [number, number, number]>(
      `SELECT m.session_id, COUNT(*) AS n FROM messages m JOIN records r ON r.id = m.record_id
       WHERE r.file_id = ? AND r.byte_offset >= ? AND r.byte_offset < ? GROUP BY m.session_id`,
    )
    .all(fileId, start, end);
  db.run("DELETE FROM records WHERE file_id = ? AND byte_offset >= ? AND byte_offset < ?", [fileId, start, end]);
  db.run("DELETE FROM quarantine WHERE file_id = ? AND byte_offset >= ? AND byte_offset < ?", [fileId, start, end]);
  return { sessionIds: affected.map((a) => a.session_id), messages: affected.reduce((n, a) => n + a.n, 0) };
}

export function deleteDerivedForFile(db: Db, fileId: number): DeletedRange {
  return deleteDerivedInRange(db, fileId, 0, Number.MAX_SAFE_INTEGER);
}

/** One past the highest ordinal in use, so appended messages continue the sequence. */
export function nextOrdinal(db: Db, sessionId: string): number {
  const row = db
    .query<{ next: number }, [string]>("SELECT COALESCE(MAX(ordinal) + 1, 0) AS next FROM messages WHERE session_id = ?")
    .get(sessionId);
  return row?.next ?? 0;
}

/**
 * Rewrites a session's ordinals as 0..n-1 in file order. Needed after rows in
 * the middle of a file were replaced, since the replacements were numbered
 * after the session's last message.
 */
export function renumberSession(db: Db, sessionId: string): void {
  db.run(
    `UPDATE messages SET ordinal = ranked.rn
     FROM (
       SELECT m.id, ROW_NUMBER() OVER (ORDER BY r.file_id, r.byte_offset, m.part) - 1 AS rn
       FROM messages m JOIN records r ON r.id = m.record_id
       WHERE m.session_id = ?
     ) AS ranked
     WHERE messages.id = ranked.id AND messages.ordinal != ranked.rn`,
    [sessionId],
  );
}

export function listMessages(db: Db, sessionId: string): MessageRow[] {
  return db.query<MessageRow, [string]>("SELECT * FROM messages WHERE session_id = ? ORDER BY ordinal").all(sessionId);
}

export function countMessages(db: Db, sessionId?: string): number {
  const row =
    sessionId === undefined
      ? db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM messages").get()
      : db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?").get(sessionId);
  return row?.n ?? 0;
}

export function listRecordsForFile(db: Db, fileId: number): RecordRow[] {
  return db.query<RecordRow, [number]>("SELECT * FROM records WHERE file_id = ? ORDER BY byte_offset").all(fileId);
}

export function getRecord(db: Db, id: number): RecordRow | null {
  return db.query<RecordRow, [number]>("SELECT * FROM records WHERE id = ?").get(id);
}
