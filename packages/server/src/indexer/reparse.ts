import { countQuarantine, listQuarantine } from "../db/drift.ts";
import type { Db } from "../db/index.ts";
import type { ParserRegistry } from "../parsers/index.ts";
import { reparseRange } from "./parse.ts";
import type { LineObserver } from "./types.ts";

export interface ReparseSummary {
  /** Quarantined ranges or whole files that were reparsed. */
  targets: number;
  lines: number;
  messages: number;
  /** Lines still quarantined afterwards, because the parser still cannot read them. */
  quarantined: number;
}

/** Re-runs the parser over quarantined lines, each in its own transaction; `fingerprint` limits it to one shape. */
export function reparseQuarantined(
  db: Db,
  rawDir: string,
  parsers: ParserRegistry,
  observers: readonly LineObserver[],
  filter: { fingerprint?: string } = {},
): ReparseSummary {
  const summary: ReparseSummary = { targets: 0, lines: 0, messages: 0, quarantined: 0 };
  for (const row of listQuarantine(db)) {
    if (filter.fingerprint !== undefined && row.fingerprint !== filter.fingerprint) continue;
    const stats = reparseRange(db, rawDir, parsers, observers, row.file_id, row.byte_offset, row.byte_offset + row.byte_length + 1);
    summary.targets++;
    summary.lines += stats.lines;
    summary.messages += stats.messages;
  }
  summary.quarantined = countQuarantine(db);
  return summary;
}
