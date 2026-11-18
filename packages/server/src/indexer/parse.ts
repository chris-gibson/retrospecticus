import { closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/index.ts";
import {
  getFileById,
  getLatestGeneration,
  listFilesToParse,
  listOlderGenerations,
  rawRelativePath,
  recordParseProgress,
  type FileRow,
} from "../db/files.ts";
import {
  deleteDerivedForFile,
  deleteDerivedInRange,
  insertMessage,
  insertRecord,
  nextOrdinal,
  renumberSession,
} from "../db/messages.ts";
import { applySessionPatch, deleteSessionsForFile, ensureSession, markChunkDirty, type SessionOrigin } from "../db/sessions.ts";
import type { ParserRegistry } from "../parsers/index.ts";
import type { ParseContext, ParseResult, Parser } from "../parsers/types.ts";
import type { BatchStats, LineObserver } from "./types.ts";

export const DEFAULT_WINDOW_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_BYTES_PER_RUN = 16 * 1024 * 1024;

const NEWLINE = 0x0a;

export interface ParseOptions {
  /** Bytes read per transaction; a window grows past this only to reach the end of a longer line. */
  windowBytes?: number;
  /** Soft cap on bytes consumed by one `runParse` call, so the caller can yield to the event loop between calls. */
  maxBytesPerRun?: number;
}

export interface ParseRunStats extends BatchStats {
  files: number;
  bytes: number;
  /** True when at least one file advanced; false means every file is parsed up to its last complete line. */
  didWork: boolean;
}

interface Batch {
  /** Offset just past the newline that ends the last line processed. */
  end: number;
  stats: BatchStats;
}

/** Reads `[start, end)`, or less when the archive on disk is shorter than recorded. */
function readRange(fd: number, start: number, end: number): Buffer {
  const buffer = Buffer.allocUnsafe(end - start);
  let filled = 0;
  while (filled < buffer.length) {
    const n = readSync(fd, buffer, filled, buffer.length - filled, start + filled);
    if (n === 0) break;
    filled += n;
  }
  return filled === buffer.length ? buffer : buffer.subarray(0, filled);
}

/**
 * Returns whole lines starting at `start`, never reading past `limit`; an
 * empty result means only an unfinished line remains.
 *
 * Reading forward, the result ends at the last newline at or before `want`,
 * so a window never overshoots unless a single line is larger than it, in
 * which case it extends, doubling, to that line's newline. A reparse instead
 * ends at the first newline at or after `want - 1`: its range was chosen by
 * the caller and the line that `want` falls in belongs to it.
 */
function readWholeLines(fd: number, start: number, want: number, limit: number, mode: "forward" | "reparse"): Buffer {
  let end = Math.min(want, limit);
  let searchFrom = mode === "reparse" ? Math.max(0, end - start - 1) : 0;
  for (;;) {
    const buffer = readRange(fd, start, end);
    const newline = mode === "reparse" ? buffer.indexOf(NEWLINE, searchFrom) : buffer.lastIndexOf(NEWLINE);
    if (newline >= 0) return buffer.subarray(0, newline + 1);
    if (end >= limit || buffer.length < end - start) return buffer.subarray(0, 0);
    searchFrom = buffer.length;
    end = Math.min(limit, start + Math.max((end - start) * 2, 64 * 1024));
  }
}

/** A parser bug must not wedge the file: the line is reported as unreadable and the batch goes on. */
function parseLine(parser: Parser, line: string, ctx: ParseContext): ParseResult {
  try {
    return parser.parse(line, ctx);
  } catch (error) {
    return { kind: "unknown", reason: "validation", detail: `parser threw: ${String(error)}` };
  }
}

function tryParseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

interface BatchRequest {
  db: Db;
  rawDir: string;
  parser: Parser;
  observers: readonly LineObserver[];
  file: FileRow;
  start: number;
  want: number;
  limit: number;
  /** `forward` consumes new bytes; `reparse` replaces rows of bytes already consumed. */
  mode: "forward" | "reparse";
}

/**
 * Parses one window of whole lines in a single transaction: rows previously
 * derived from those bytes are deleted, then records, messages and session
 * patches are written and observers called, so a failure anywhere leaves the
 * file exactly as it was.
 */
function parseBatch(request: BatchRequest): Batch | null {
  const { db, parser, observers, file, start, mode } = request;
  const fd = openSync(join(request.rawDir, rawRelativePath(file)), "r");
  let buffer: Buffer;
  try {
    buffer = readWholeLines(fd, start, request.want, request.limit, mode);
  } finally {
    closeSync(fd);
  }
  if (buffer.length === 0) return null;

  const end = start + buffer.length;
  const origin: SessionOrigin = { source: file.source, machine: file.machine, fileId: file.id };
  const stats: BatchStats = { lines: 0, messages: 0, chars: 0 };

  db.transaction(() => {
    const ctx: ParseContext = {
      source: file.source,
      machine: file.machine,
      path: file.path,
      state: file.parser_state === null ? {} : (JSON.parse(file.parser_state) as Record<string, unknown>),
    };
    let harnessVersion = file.harness_version;

    if (mode === "forward" && start === 0) {
      for (const older of listOlderGenerations(db, file)) purgeFile(db, older);
    }
    const deleted = deleteDerivedInRange(db, file.id, start, end);
    const touched = new Set<string>(deleted.sessionIds);
    const ordinals = new Map<string, number>();

    let lineStart = 0;
    while (lineStart < buffer.length) {
      const newline = buffer.indexOf(NEWLINE, lineStart);
      const byteLength = newline - lineStart;
      const byteOffset = start + lineStart;
      const line = buffer.toString("utf8", lineStart, newline);
      lineStart = newline + 1;
      if (line.trim() === "") continue;

      const result = parseLine(parser, line, ctx);
      stats.lines++;

      if (result.kind !== "unknown" && result.session !== undefined) {
        applySessionPatch(db, result.session, origin, mode === "forward" ? "latest" : "outrank");
        harnessVersion = result.session.harnessVersion ?? harnessVersion;
      }
      if (result.kind === "messages") {
        const recordId = insertRecord(db, {
          fileId: file.id,
          byteOffset,
          byteLength,
          type: result.record.type,
          nativeId: result.record.nativeId,
          parentNativeId: result.record.parentNativeId,
          timestamp: result.record.timestamp,
        });
        result.messages.forEach((message, part) => {
          let ordinal = ordinals.get(message.sessionId);
          if (ordinal === undefined) {
            ensureSession(db, message.sessionId, origin);
            ordinal = nextOrdinal(db, message.sessionId);
          }
          ordinals.set(message.sessionId, ordinal + 1);
          insertMessage(db, {
            sessionId: message.sessionId,
            ordinal,
            role: message.role,
            text: message.text,
            recordId,
            part,
            toolName: message.toolName,
            timestamp: message.timestamp ?? result.record.timestamp,
          });
          touched.add(message.sessionId);
          stats.messages++;
          stats.chars += message.text.length;
        });
      }

      const parsed = { file, byteOffset, byteLength, line, json: tryParseJson(line), result, harnessVersion };
      for (const observer of observers) observer.onLine(db, parsed);
    }

    // Appended messages are already numbered in order; only replaced bytes can leave gaps or misplaced ordinals.
    const rewritten = mode === "reparse" || deleted.messages > 0;
    if (rewritten) for (const id of touched) renumberSession(db, id);
    markChunkDirty(db, touched, rewritten);

    recordParseProgress(db, file.id, {
      parsedOffset: mode === "forward" ? end : undefined,
      parserState: JSON.stringify(ctx.state),
      // "Last seen" means last in file order, which a reparse of earlier bytes must not rewind.
      harnessVersion: mode === "forward" ? harnessVersion : null,
      linesReadDelta: mode === "forward" ? stats.lines : 0,
      messagesProducedDelta: stats.messages - deleted.messages,
    });

    if (mode === "forward") {
      const current = getFileById(db, file.id) ?? file;
      for (const observer of observers) observer.onBatchEnd?.(db, current, stats);
    }
  })();

  return { end, stats };
}

function purgeFile(db: Db, file: FileRow): void {
  deleteDerivedForFile(db, file.id);
  deleteSessionsForFile(db, file.id);
}

/**
 * Only the newest generation of a path is indexed. An older one is marked as
 * consumed without being read, and anything it contributed earlier is removed.
 */
function retireSuperseded(db: Db, file: FileRow): boolean {
  const latest = getLatestGeneration(db, file);
  if (latest === null || latest.generation <= file.generation) return false;
  db.transaction(() => {
    purgeFile(db, file);
    recordParseProgress(db, file.id, {
      parsedOffset: file.size,
      parserState: null,
      harnessVersion: null,
      linesReadDelta: 0,
      messagesProducedDelta: -file.messages_produced,
    });
  })();
  return true;
}

function add(total: ParseRunStats, batch: Batch, start: number): void {
  total.lines += batch.stats.lines;
  total.messages += batch.stats.messages;
  total.chars += batch.stats.chars;
  total.bytes += batch.end - start;
  total.didWork = true;
}

function emptyRun(): ParseRunStats {
  return { files: 0, lines: 0, messages: 0, chars: 0, bytes: 0, didWork: false };
}

/**
 * The parse stage: consumes new complete lines of every file that has them,
 * one transaction per window. It stops early once `maxBytesPerRun` is spent;
 * call it again while `didWork` is true.
 */
export function runParse(
  db: Db,
  rawDir: string,
  parsers: ParserRegistry,
  observers: readonly LineObserver[] = [],
  options: ParseOptions = {},
): ParseRunStats {
  const windowBytes = options.windowBytes ?? DEFAULT_WINDOW_BYTES;
  const maxBytes = options.maxBytesPerRun ?? DEFAULT_MAX_BYTES_PER_RUN;
  const total = emptyRun();

  for (const listed of listFilesToParse(db)) {
    if (total.bytes >= maxBytes) break;
    if (retireSuperseded(db, listed)) {
      total.didWork = true;
      continue;
    }
    let file = listed;
    let advanced = false;
    while (file.parsed_offset < file.size && total.bytes < maxBytes) {
      const start = file.parsed_offset;
      const batch = parseBatch({
        db,
        rawDir,
        parser: parsers[file.source],
        observers,
        file,
        start,
        want: start + windowBytes,
        limit: file.size,
        mode: "forward",
      });
      if (batch === null) break;
      add(total, batch, start);
      advanced = true;
      file = getFileById(db, file.id)!;
    }
    if (advanced) total.files++;
  }
  return total;
}

/**
 * Re-runs the parser over lines that were already consumed, replacing what
 * they produced. `start` must be the first byte of a line (a `records` or
 * `quarantine` offset); `end` is exclusive and is carried forward to the end
 * of the line it falls in. The range is clamped to `parsed_offset`, and a
 * superseded generation is left alone. Observers see every line again through
 * `onLine`; `onBatchEnd` is not called, because no new lines were read.
 */
export function reparseRange(
  db: Db,
  rawDir: string,
  parsers: ParserRegistry,
  observers: readonly LineObserver[],
  fileId: number,
  start: number,
  end: number,
  options: ParseOptions = {},
): ParseRunStats {
  const total = emptyRun();
  const initial = getFileById(db, fileId);
  if (initial === null) throw new Error(`no file with id ${fileId}`);
  const latest = getLatestGeneration(db, initial);
  if (latest !== null && latest.generation > initial.generation) return total;

  const windowBytes = options.windowBytes ?? DEFAULT_WINDOW_BYTES;
  const stop = Math.min(end, initial.parsed_offset);
  if (start > 0 && start < stop) assertLineStart(rawDir, initial, start);

  let cursor = start;
  while (cursor < stop) {
    const file = getFileById(db, fileId)!;
    const batch = parseBatch({
      db,
      rawDir,
      parser: parsers[file.source],
      observers,
      file,
      start: cursor,
      want: Math.min(cursor + windowBytes, stop),
      limit: file.parsed_offset,
      mode: "reparse",
    });
    if (batch === null) break;
    add(total, batch, cursor);
    cursor = batch.end;
  }
  if (total.didWork) total.files = 1;
  return total;
}

/** Reparses everything consumed so far from one file. */
export function reparseFile(
  db: Db,
  rawDir: string,
  parsers: ParserRegistry,
  observers: readonly LineObserver[],
  fileId: number,
  options: ParseOptions = {},
): ParseRunStats {
  return reparseRange(db, rawDir, parsers, observers, fileId, 0, Number.MAX_SAFE_INTEGER, options);
}

function assertLineStart(rawDir: string, file: FileRow, offset: number): void {
  const fd = openSync(join(rawDir, rawRelativePath(file)), "r");
  try {
    const previous = readRange(fd, offset - 1, offset);
    if (previous.length !== 1 || previous[0] !== NEWLINE) {
      throw new Error(`offset ${offset} of file ${file.id} is not the start of a line`);
    }
  } finally {
    closeSync(fd);
  }
}
