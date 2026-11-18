import { parseArgs } from "node:util";
import { SOURCES, type Source } from "@retrospecticus/shared";
import { rawDir as rawDirOf } from "@retrospecticus/server/config.ts";
import { countQuarantine } from "@retrospecticus/server/db/drift.ts";
import { listFiles } from "@retrospecticus/server/db/files.ts";
import type { Db } from "@retrospecticus/server/db/index.ts";
import { reparseFile, reparseRange } from "@retrospecticus/server/indexer/parse.ts";
import { reparseQuarantined, type ReparseSummary } from "@retrospecticus/server/indexer/reparse.ts";
import type { LineObserver } from "@retrospecticus/server/indexer/types.ts";
import type { ParserRegistry } from "@retrospecticus/server/parsers/index.ts";
import { buildWiring } from "@retrospecticus/server/wiring.ts";
import { UsageError, withDb, type Command } from "../command.ts";

const usage = [
  "Usage:",
  "  retrospecticus reparse --quarantined",
  `  retrospecticus reparse [--source <${SOURCES.join("|")}>] [--since <date>]`,
  "",
  "--since takes an ISO 8601 date or time and selects files that received bytes since then.",
].join("\n");

export { reparseQuarantined, type ReparseSummary };

export interface FileSelection {
  source?: Source;
  /** ISO 8601 timestamp; files whose archive grew at or after it. */
  since?: string;
}

/** Re-runs the parser over whole files, for drift that left no quarantine behind (yield drops, additive fields). */
export function reparseFiles(
  db: Db,
  rawDir: string,
  parsers: ParserRegistry,
  observers: readonly LineObserver[],
  selection: FileSelection,
): ReparseSummary {
  const summary: ReparseSummary = { targets: 0, lines: 0, messages: 0, quarantined: 0 };
  const files = listFiles(db).filter(
    (f) =>
      (selection.source === undefined || f.source === selection.source) &&
      (selection.since === undefined || f.updated_at >= selection.since) &&
      f.parsed_offset > 0,
  );
  for (const file of files) {
    const stats = reparseFile(db, rawDir, parsers, observers, file.id);
    if (!stats.didWork) continue;
    summary.targets++;
    summary.lines += stats.lines;
    summary.messages += stats.messages;
  }
  summary.quarantined = countQuarantine(db);
  return summary;
}

function parseSince(value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new UsageError(`--since is not a date: ${value}`);
  return new Date(ms).toISOString();
}

const command: Command = {
  summary: "Re-run the parsers over quarantined lines or over whole files",
  usage,
  async run(ctx) {
    let values;
    try {
      ({ values } = parseArgs({
        args: ctx.args,
        options: { quarantined: { type: "boolean" }, source: { type: "string" }, since: { type: "string" } },
        allowPositionals: false,
        strict: true,
      }));
    } catch (err) {
      throw new UsageError((err as Error).message);
    }
    const { quarantined, source, since } = values;
    if (source !== undefined && !(SOURCES as readonly string[]).includes(source)) {
      throw new UsageError(`--source must be one of: ${SOURCES.join(", ")}`);
    }
    if (quarantined === true && (source !== undefined || since !== undefined)) {
      throw new UsageError("--quarantined cannot be combined with --source or --since");
    }
    if (quarantined !== true && source === undefined && since === undefined) {
      throw new UsageError("reparse needs --quarantined, or --source and/or --since");
    }
    const selection: FileSelection = {
      source: source as Source | undefined,
      since: since === undefined ? undefined : parseSince(since),
    };

    return withDb(ctx, (db, config, store) => {
      const { observers, parsers } = buildWiring(db, store);
      const rawDir = rawDirOf(config);
      if (quarantined === true) {
        const s = reparseQuarantined(db, rawDir, parsers, observers);
        ctx.out(`Reparsed ${s.targets} quarantined lines: ${s.messages} messages produced; ${s.quarantined} lines still quarantined.`);
      } else {
        const s = reparseFiles(db, rawDir, parsers, observers, selection);
        ctx.out(`Reparsed ${s.targets} files (${s.lines} lines, ${s.messages} messages); ${s.quarantined} lines quarantined.`);
      }
      return 0;
    });
  },
};

export default command;
