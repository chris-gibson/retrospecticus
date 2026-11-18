import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { rawDir as rawDirOf } from "@retrospecticus/server/config.ts";
import {
  ackDriftEvent,
  getDriftEvent,
  getSampleForShape,
  listComparableShapes,
  listDriftEvents,
  type DriftEventRow,
  type ShapeRow,
} from "@retrospecticus/server/db/drift.ts";
import { getFileById, rawRelativePath } from "@retrospecticus/server/db/files.ts";
import type { Db } from "@retrospecticus/server/db/index.ts";
import { diffAgainstNearest, formatDiff, type ShapeCandidate } from "@retrospecticus/server/drift/diff.ts";
import { baseDiscriminator, keyPaths } from "@retrospecticus/server/drift/fingerprint.ts";
import { UsageError, withDb, type Command, type CommandContext } from "../command.ts";

const usage = [
  "Usage:",
  "  retrospecticus drift list [--all]",
  "  retrospecticus drift show <id>",
  "  retrospecticus drift ack <id>",
].join("\n");

function parse<T extends NonNullable<Parameters<typeof parseArgs>[0]>["options"]>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

function eventId(args: string[], sub: string): number {
  const { positionals } = parse(args, {});
  const raw = positionals[0];
  if (positionals.length !== 1 || raw === undefined || !/^\d+$/.test(raw)) {
    throw new UsageError(`${sub} needs one numeric event id (see \`drift list\`)`);
  }
  return Number(raw);
}

/** What the event is about: the record type for a shape, the version or the file/day for the others. */
function subject(event: DriftEventRow): string {
  return event.discriminator ?? event.fingerprint;
}

async function list(ctx: CommandContext, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { all: { type: "boolean" } });
  if (positionals.length > 0) throw new UsageError(`Unexpected argument: ${positionals[0]}`);
  return withDb(ctx, (db) => {
    const rows = listDriftEvents(db, values.all === true ? {} : { status: "open" });
    if (rows.length === 0) {
      ctx.out(values.all === true ? "No drift events." : "No open drift events.");
      return 0;
    }
    const table = [
      ["ID", "SEVERITY", "SOURCE", "STATUS", "COUNT", "LAST SEEN", "VERSION", "SUBJECT"],
      ...rows.map((r) => [
        String(r.id),
        r.severity,
        r.source,
        r.status,
        String(r.count),
        r.last_seen,
        r.harness_version ?? "-",
        subject(r),
      ]),
    ];
    const widths = table[0]!.map((_, col) => Math.max(...table.map((line) => line[col]!.length)));
    for (const line of table) ctx.out(line.map((cell, col) => cell.padEnd(widths[col]!)).join("  ").trimEnd());
    return 0;
  });
}

/** Reads the archived line a shape's `sample_ref` (`<fileId>:<byteOffset>`) points at. */
function readSampleRef(db: Db, rawDir: string, ref: string): unknown {
  const match = /^(\d+):(\d+)$/.exec(ref);
  if (match === null) return undefined;
  const file = getFileById(db, Number(match[1]));
  if (file === null) return undefined;
  const path = join(rawDir, rawRelativePath(file));
  if (!existsSync(path)) return undefined;
  const fd = openSync(path, "r");
  try {
    const parts: Buffer[] = [];
    let position = Number(match[2]);
    for (;;) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const n = readSync(fd, chunk, 0, chunk.length, position);
      if (n === 0) break;
      const newline = chunk.subarray(0, n).indexOf(0x0a);
      parts.push(chunk.subarray(0, newline < 0 ? n : newline));
      if (newline >= 0) break;
      position += n;
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * Key paths of a known shape. A shape first met as drift has its scrubbed
 * sample; a learned one only has its archive reference. Either way only the
 * structure is used, so nothing from the archive is printed.
 */
function candidatePaths(db: Db, rawDir: string, shape: ShapeRow): ShapeCandidate | null {
  const sample = getSampleForShape(db, shape.source, shape.hash);
  const json = sample !== null ? JSON.parse(sample) : shape.sample_ref !== null ? readSampleRef(db, rawDir, shape.sample_ref) : undefined;
  return json === undefined ? null : { hash: shape.hash, paths: keyPaths(json) };
}

async function show(ctx: CommandContext, args: string[]): Promise<number> {
  const id = eventId(args, "show");
  return withDb(ctx, (db, config) => {
    const event = getDriftEvent(db, id);
    if (event === null) {
      ctx.err(`No drift event with id ${id}.`);
      return 1;
    }
    ctx.out(`Drift event ${event.id}: ${event.severity} in ${event.source} (${event.status}${event.acked_at ? ` ${event.acked_at}` : ""})`);
    ctx.out(`Subject:     ${subject(event)}`);
    ctx.out(`Fingerprint: ${event.fingerprint}`);
    ctx.out(`Version:     ${event.harness_version ?? "unknown"}`);
    ctx.out(`Seen:        ${event.count} times, ${event.first_seen} to ${event.last_seen}`);
    if (event.detail !== null) ctx.out(`Detail:      ${event.detail}`);

    if (event.sample !== null) {
      ctx.out("");
      ctx.out("Scrubbed sample (every string replaced by its length):");
      for (const line of JSON.stringify(JSON.parse(event.sample), null, 2).split("\n")) ctx.out(line);
    }
    if ((event.severity === "breaking" || event.severity === "additive") && event.discriminator !== null && event.sample !== null) {
      const shapes = listComparableShapes(db, event.source, event.discriminator, baseDiscriminator(event.discriminator), event.fingerprint);
      const rawDir = rawDirOf(config);
      const candidates = shapes.map((s) => candidatePaths(db, rawDir, s)).filter((c): c is ShapeCandidate => c !== null);
      ctx.out("");
      for (const line of formatDiff(diffAgainstNearest(keyPaths(JSON.parse(event.sample)), candidates))) ctx.out(line);
    }
    return 0;
  });
}

async function ack(ctx: CommandContext, args: string[]): Promise<number> {
  const id = eventId(args, "ack");
  return withDb(ctx, (db) => {
    const result = ackDriftEvent(db, id);
    if (result === "not-found") {
      ctx.err(`No drift event with id ${id}.`);
      return 1;
    }
    ctx.out(result === "acked" ? `Acked drift event ${id}.` : `Drift event ${id} was already acked.`);
    const event = getDriftEvent(db, id)!;
    if (event.severity === "breaking") ctx.out("Once the parser reads it, run `retrospecticus reparse --quarantined`.");
    if (event.severity === "yield") {
      ctx.out(`Once the parser reads it, run \`retrospecticus reparse --source ${event.source} --since <date>\`.`);
    }
    return 0;
  });
}

const command: Command = {
  summary: "List, inspect and acknowledge format drift events",
  usage,
  async run(ctx) {
    const [sub, ...rest] = ctx.args;
    switch (sub) {
      case "list":
        return list(ctx, rest);
      case "show":
        return show(ctx, rest);
      case "ack":
        return ack(ctx, rest);
      default:
        throw new UsageError(sub === undefined ? "drift needs a subcommand" : `Unknown drift subcommand: ${sub}`);
    }
  },
};

export default command;
