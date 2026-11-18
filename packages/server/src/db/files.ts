import type { Source } from "@retrospecticus/shared";
import { nowIso, type Db } from "./index.ts";

export interface FileRow {
  id: number;
  machine: string;
  source: Source;
  path: string;
  generation: number;
  size: number;
  parsed_offset: number;
  parser_state: string | null;
  harness_version: string | null;
  lines_read: number;
  messages_produced: number;
  created_at: string;
  updated_at: string;
}

export interface FileKey {
  machine: string;
  source: Source;
  path: string;
}

export function getFile(db: Db, key: FileKey, generation: number): FileRow | null {
  return db
    .query<FileRow, [string, string, string, number]>(
      "SELECT * FROM files WHERE machine = ? AND source = ? AND path = ? AND generation = ?",
    )
    .get(key.machine, key.source, key.path, generation);
}

export function getFileById(db: Db, id: number): FileRow | null {
  return db.query<FileRow, [number]>("SELECT * FROM files WHERE id = ?").get(id);
}

export function getLatestGeneration(db: Db, key: FileKey): FileRow | null {
  return db
    .query<FileRow, [string, string, string]>(
      "SELECT * FROM files WHERE machine = ? AND source = ? AND path = ? ORDER BY generation DESC LIMIT 1",
    )
    .get(key.machine, key.source, key.path);
}

export function upsertFileSize(db: Db, key: FileKey, generation: number, size: number): FileRow {
  const now = nowIso();
  db.run(
    `INSERT INTO files (machine, source, path, generation, size, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (machine, source, path, generation) DO UPDATE SET size = excluded.size, updated_at = excluded.updated_at`,
    [key.machine, key.source, key.path, generation, size, now, now],
  );
  return getFile(db, key, generation)!;
}

export function listFilesToParse(db: Db, limit = 100): FileRow[] {
  return db
    .query<FileRow, [number]>("SELECT * FROM files WHERE size > parsed_offset ORDER BY updated_at LIMIT ?")
    .all(limit);
}

export function listFiles(db: Db): FileRow[] {
  return db.query<FileRow, []>("SELECT * FROM files ORDER BY machine, source, path, generation").all();
}

/** Raw archive location relative to `<data_dir>/raw`. Generation 0 has no suffix. */
export function rawRelativePath(file: Pick<FileRow, "machine" | "source" | "path" | "generation">): string {
  const suffix = file.generation > 0 ? `.g${file.generation}` : "";
  return `${file.machine}/${file.source}/${file.path}${suffix}`;
}

export function listOlderGenerations(db: Db, file: FileRow): FileRow[] {
  return db
    .query<FileRow, [string, string, string, number]>(
      "SELECT * FROM files WHERE machine = ? AND source = ? AND path = ? AND generation < ? ORDER BY generation",
    )
    .all(file.machine, file.source, file.path, file.generation);
}

export interface ParseProgress {
  /** Left alone when undefined, which is how a reparse of old bytes keeps the forward position. */
  parsedOffset?: number;
  parserState: string | null;
  harnessVersion: string | null;
  linesReadDelta: number;
  messagesProducedDelta: number;
}

export function recordParseProgress(db: Db, fileId: number, progress: ParseProgress): void {
  db.run(
    `UPDATE files SET
       parsed_offset = COALESCE(?, parsed_offset),
       parser_state = ?,
       harness_version = COALESCE(?, harness_version),
       lines_read = lines_read + ?,
       messages_produced = MAX(0, messages_produced + ?)
     WHERE id = ?`,
    [
      progress.parsedOffset ?? null,
      progress.parserState,
      progress.harnessVersion,
      progress.linesReadDelta,
      progress.messagesProducedDelta,
      fileId,
    ],
  );
}
