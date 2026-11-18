import type { Db } from "../db/index.ts";
import type { FileRow } from "../db/files.ts";
import type { ParseResult } from "../parsers/types.ts";

export interface ParsedLine {
  file: FileRow;
  byteOffset: number;
  byteLength: number;
  line: string;
  /** Undefined when the line is not valid JSON. */
  json: unknown;
  result: ParseResult;
  harnessVersion: string | null;
}

/**
 * Hook into the parse stage. Observers run inside the same transaction as the
 * rows derived from the line, so what they write commits or rolls back with it.
 * The drift detector is an observer; the parse stage knows nothing about it.
 */
export interface LineObserver {
  onLine(db: Db, parsed: ParsedLine): void;
  /** Called once per parsed batch of one file, after its lines. */
  onBatchEnd?(db: Db, file: FileRow, stats: BatchStats): void;
}

export interface BatchStats {
  lines: number;
  messages: number;
  chars: number;
}

/**
 * A step that runs after parsing in each indexer tick (chunking, embedding).
 * Returns true when it did work, so the loop ticks again without sleeping.
 */
export interface IndexerStage {
  readonly name: string;
  run(db: Db): Promise<boolean> | boolean;
}
