import type { Source } from "@retrospecticus/shared";
import { enqueueAlert } from "../db/alerts.ts";
import {
  addYieldStats,
  countRecordsInRange,
  getYieldStats,
  isGuardianOnlyFile,
  trailingMedianRatio,
  upsertDriftEvent,
} from "../db/drift.ts";
import type { FileRow } from "../db/files.ts";
import type { Db } from "../db/index.ts";
import type { BatchStats, LineObserver, ParsedLine } from "../indexer/types.ts";
import { driftDedupeKey } from "./detector.ts";

export const YIELD_WINDOW_DAYS = 14;
export const YIELD_MIN_HISTORY_DAYS = 7;

export interface YieldMonitorOptions {
  /** `indexer.yield_min_lines`: a file or day must read more lines than this before its yield is judged. A function is asked each time. */
  minLines: number | (() => number);
  now?: () => Date;
}

/**
 * Yield monitoring: catches format changes that still validate but move the
 * text somewhere the parser does not look.
 *
 * Only lines the parser accepted as conversation records (a `messages`
 * result, i.e. a row in `records`) count as lines expected to yield.
 * Metadata, titles, `session_meta`, guardian reviews and copied fork history
 * all come back `ignored`, so a file made only of those legitimately yields
 * nothing and never fires; unreadable lines are already breaking drift.
 * Conversation records that yield nothing one at a time do exist (meta
 * prompts, encrypted reasoning, developer messages), but never hundreds of
 * them with no message at all, which is what the file rule looks for.
 *
 * Days are the UTC day the indexer read the lines, so a backfill of old
 * sessions counts toward today and cannot reach back to judge an old day.
 */
export function createYieldMonitor(options: YieldMonitorOptions): LineObserver {
  const now = options.now ?? (() => new Date());
  const minLines = (): number => (typeof options.minLines === "function" ? options.minLines() : options.minLines);
  // Start of the forward batch in progress per file; a reparse never reaches onBatchEnd and is not tracked.
  const batchStart = new Map<number, number>();

  return {
    onLine(_db: Db, parsed: ParsedLine): void {
      if (parsed.byteOffset >= parsed.file.parsed_offset) batchStart.set(parsed.file.id, parsed.file.parsed_offset);
    },

    onBatchEnd(db: Db, file: FileRow, stats: BatchStats): void {
      const start = batchStart.get(file.id) ?? file.parsed_offset;
      batchStart.delete(file.id);
      if (isGuardianOnlyFile(db, file.id)) return;

      const expected = countRecordsInRange(db, file.id, start, file.parsed_offset);
      const at = now();
      const day = at.toISOString().slice(0, 10);
      addYieldStats(db, file.source, day, { lines: expected, messages: stats.messages, chars: stats.chars });

      const fileLines = countRecordsInRange(db, file.id, 0, file.parsed_offset);
      if (fileLines > minLines() && file.messages_produced === 0) {
        raiseYield(db, file.source, `file:${file.id}`, at, {
          title: `No messages from a ${file.source} file`,
          detail: `${fileLines} conversation records read from file ${file.id} (${file.machine}:${file.path}) produced no messages`,
          // The path names a project, so the alert that leaves the server only gives the file id.
          summary: `${fileLines} conversation records read from file ${file.id} on ${file.machine} produced no messages`,
          harnessVersion: file.harness_version,
        });
      }

      const today = getYieldStats(db, file.source, day);
      if (today === null || today.lines === 0 || today.lines <= minLines()) return;
      const { median, days } = trailingMedianRatio(db, file.source, day, YIELD_WINDOW_DAYS);
      const ratio = today.messages / today.lines;
      if (median !== null && days >= YIELD_MIN_HISTORY_DAYS && ratio < median / 2) {
        raiseYield(db, file.source, `day:${day}`, at, {
          title: `${file.source} message yield dropped on ${day}`,
          detail: `${ratio.toFixed(3)} messages per conversation record today against a ${days}-day median of ${median.toFixed(3)}`,
          harnessVersion: file.harness_version,
        });
      }
    },
  };
}

function raiseYield(
  db: Db,
  source: Source,
  fingerprint: string,
  at: Date,
  info: { title: string; detail: string; summary?: string; harnessVersion: string | null },
): void {
  const { id } = upsertDriftEvent(db, {
    source,
    severity: "yield",
    fingerprint,
    harnessVersion: info.harnessVersion,
    detail: info.detail,
    seenAt: at.toISOString(),
  });
  enqueueAlert(db, {
    kind: "drift",
    severity: "warning",
    title: info.title,
    body: [
      `${info.summary ?? info.detail}.`,
      "The lines still validate, so the content has probably moved somewhere the parser does not read.",
      `Inspect with: retrospecticus drift show ${id}`,
    ].join("\n"),
    dedupeKey: driftDedupeKey(source, fingerprint),
  });
}
