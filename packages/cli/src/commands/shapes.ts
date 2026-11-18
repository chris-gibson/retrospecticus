import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { Source } from "@retrospecticus/shared";
import { rawDir as rawDirOf } from "@retrospecticus/server/config.ts";
import { deleteUnsentAlerts } from "@retrospecticus/server/db/alerts.ts";
import { closeOpenInfoDriftEvents, learnShape, recordHarnessVersion, setBaselineLearned } from "@retrospecticus/server/db/drift.ts";
import { listFiles, rawRelativePath } from "@retrospecticus/server/db/files.ts";
import type { Db } from "@retrospecticus/server/db/index.ts";
import { classifyOutcome, driftDedupeKey, lineShape } from "@retrospecticus/server/drift/detector.ts";
import { buildWiring } from "@retrospecticus/server/wiring.ts";
import { parsers as defaultParsers, type ParserRegistry } from "@retrospecticus/server/parsers/index.ts";
import type { ParseContext, ParseResult } from "@retrospecticus/server/parsers/types.ts";
import { UsageError, withDb, type Command } from "../command.ts";

const usage = ["Usage:", "  retrospecticus shapes learn"].join("\n");

const READ_BYTES = 4 * 1024 * 1024;
const NEWLINE = 0x0a;

export interface RawLine {
  line: string;
  offset: number;
}

/** Complete lines of an archived file up to `limit`; a trailing line without its newline is not read. */
export function* readRawLines(path: string, limit: number): Generator<RawLine> {
  const fd = openSync(path, "r");
  try {
    let carry = Buffer.alloc(0);
    let carryOffset = 0;
    let position = 0;
    while (position < limit) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_BYTES, limit - position));
      const n = readSync(fd, chunk, 0, chunk.length, position);
      if (n === 0) break;
      position += n;
      const buffer = carry.length === 0 ? chunk.subarray(0, n) : Buffer.concat([carry, chunk.subarray(0, n)]);
      let lineStart = 0;
      for (let newline = buffer.indexOf(NEWLINE); newline >= 0; newline = buffer.indexOf(NEWLINE, lineStart)) {
        yield { line: buffer.toString("utf8", lineStart, newline), offset: carryOffset + lineStart };
        lineStart = newline + 1;
      }
      carry = Buffer.from(buffer.subarray(lineStart));
      carryOffset += lineStart;
    }
  } finally {
    closeSync(fd);
  }
}

export interface UnhandledShape {
  source: Source;
  discriminator: string;
  fingerprint: string;
  reason: string;
  detail: string | null;
  harnessVersion: string | null;
  count: number;
}

export interface LearnReport {
  files: number;
  lines: number;
  added: number;
  promoted: number;
  versions: number;
  unhandled: UnhandledShape[];
  /** Files listed in `files` whose archive is missing. */
  missing: string[];
  /** Open additive and version events acked because the baseline now covers them, and their withdrawn digest alerts. */
  closed: { additive: number; version: number; alerts: number };
}

function parseSafely(parse: (line: string, ctx: ParseContext) => ParseResult, line: string, ctx: ParseContext): ParseResult {
  try {
    return parse(line, ctx);
  } catch (error) {
    return { kind: "unknown", reason: "validation", detail: `parser threw: ${String(error)}` };
  }
}

function tryJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/**
 * The baseline: replays every archived file through its parser, from the
 * start with fresh parser state just as the indexer reads it, and records
 * every shape the parser reads in full as known, with its key paths. Then
 * marks the baseline as learned and closes the additive and version events
 * that were open, since the baseline covers them; it raises nothing itself.
 * Shapes the parser cannot read are returned, not learned, so they still
 * raise drift when the indexer meets them.
 */
export function learnShapes(db: Db, rawDir: string, parsers: ParserRegistry = defaultParsers): LearnReport {
  const report: LearnReport = {
    files: 0,
    lines: 0,
    added: 0,
    promoted: 0,
    versions: 0,
    unhandled: [],
    missing: [],
    closed: { additive: 0, version: 0, alerts: 0 },
  };
  const unhandled = new Map<string, UnhandledShape>();
  // Learning a shape once per run is enough, and spares writing its key paths for every line.
  const learnedThisRun = new Set<string>();

  for (const file of listFiles(db)) {
    const path = join(rawDir, rawRelativePath(file));
    if (!existsSync(path)) {
      report.missing.push(rawRelativePath(file));
      continue;
    }
    const parser = parsers[file.source];
    const ctx: ParseContext = { source: file.source, machine: file.machine, path: file.path, state: {} };
    let harnessVersion: string | null = null;
    report.files++;

    db.transaction(() => {
      for (const { line, offset } of readRawLines(path, file.size)) {
        if (line.trim() === "") continue;
        report.lines++;
        const result = parseSafely(parser.parse, line, ctx);
        if (result.kind !== "unknown") harnessVersion = result.session?.harnessVersion ?? harnessVersion;
        const json = tryJson(line);
        const shape = lineShape(parser, json);
        const outcome = classifyOutcome(result);

        if (outcome.breaking) {
          const key = `${file.source}\u0000${shape.fingerprint}`;
          const entry = unhandled.get(key);
          if (entry !== undefined) entry.count++;
          else {
            unhandled.set(key, {
              source: file.source,
              discriminator: shape.discriminator,
              fingerprint: shape.fingerprint,
              reason: outcome.reason ?? "unknown",
              detail: outcome.detail,
              harnessVersion,
              count: 1,
            });
          }
        } else if (!learnedThisRun.has(`${file.source}\u0000${shape.fingerprint}`)) {
          learnedThisRun.add(`${file.source}\u0000${shape.fingerprint}`);
          const learned = learnShape(
            db,
            { source: file.source, hash: shape.fingerprint, discriminator: shape.discriminator, harnessVersion, sampleRef: `${file.id}:${offset}` },
            shape.paths,
          );
          if (learned === "added") report.added++;
          else if (learned === "promoted") report.promoted++;
        }
        if (harnessVersion !== null && recordHarnessVersion(db, file.source, harnessVersion)) report.versions++;
      }
    })();
  }

  db.transaction(() => {
    setBaselineLearned(db);
    const closed = closeOpenInfoDriftEvents(db);
    const alerts = deleteUnsentAlerts(db, closed.events.map((e) => driftDedupeKey(e.source, e.fingerprint)));
    report.closed = { additive: closed.additive, version: closed.version, alerts };
  })();

  report.unhandled = [...unhandled.values()].sort(
    (a, b) => a.source.localeCompare(b.source) || a.discriminator.localeCompare(b.discriminator),
  );
  return report;
}

function printReport(out: (line: string) => void, report: LearnReport): void {
  out(
    `Learned ${report.added} new shapes (${report.promoted} promoted from additive) and ${report.versions} harness versions ` +
      `from ${report.lines} lines in ${report.files} files.`,
  );
  for (const path of report.missing) out(`Skipped ${path}: not in the raw archive.`);
  const { closed } = report;
  out(
    `Baseline recorded. Closed ${closed.additive} additive and ${closed.version} version drift events ` +
      `and withdrew ${closed.alerts} unsent digest alerts.`,
  );
  if (report.unhandled.length === 0) {
    out("The parsers read every shape in the archive.");
    return;
  }
  out(`Not learned: ${report.unhandled.length} shapes the parsers cannot read (they will raise breaking drift):`);
  for (const u of report.unhandled) {
    out(
      `  ${u.source}  ${u.discriminator}  ${u.reason}  x${u.count}  ${u.fingerprint.slice(0, 16)}  ` +
        `version ${u.harnessVersion ?? "unknown"}${u.detail === null ? "" : `  (${u.detail})`}`,
    );
  }
}

const command: Command = {
  summary: "Learn the shapes of the archived corpus as the drift baseline",
  usage,
  async run(ctx) {
    const [sub, ...rest] = ctx.args;
    if (sub !== "learn") throw new UsageError(sub === undefined ? "shapes needs a subcommand" : `Unknown shapes subcommand: ${sub}`);
    if (rest.length > 0) throw new UsageError(`Unexpected argument: ${rest[0]}`);
    return withDb(ctx, (db, config, store) => {
      printReport(ctx.out, learnShapes(db, rawDirOf(config), buildWiring(db, store).parsers));
      return 0;
    });
  },
};

export default command;
