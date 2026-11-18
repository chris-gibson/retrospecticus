import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { MACHINE_NAME_PATTERN, SOURCES, type Source } from "@retrospecticus/shared";
import { rawDir as rawDirOf, type ServerConfig } from "@retrospecticus/server/config.ts";
import { toConfigView, type ConfigView } from "@retrospecticus/server/config-store.ts";
import { countChunks } from "@retrospecticus/server/db/chunks.ts";
import { listFiles, upsertFileSize } from "@retrospecticus/server/db/files.ts";
import { resetDerived, type Db } from "@retrospecticus/server/db/index.ts";
import { countMessages } from "@retrospecticus/server/db/messages.ts";
import { listSessions } from "@retrospecticus/server/db/sessions.ts";
import {
  clearVectorTables,
  countMissing,
  getActiveModel,
  restoreVectors,
  stashVectors,
} from "@retrospecticus/server/db/vectors.ts";
import { runUntilIdle } from "@retrospecticus/server/indexer/loop.ts";
import { buildWiring } from "@retrospecticus/server/wiring.ts";
import { UsageError, withDb, type Command } from "../command.ts";

const usage = [
  "Usage:",
  "  retrospecticus reindex --from-raw",
  "",
  "Drops everything derived from the raw archive and rebuilds it. Files, tokens, shapes, machines",
  "and embedding models are kept, and stored vectors are carried over by chunk text hash.",
].join("\n");

export interface ReindexSummary {
  files: number;
  sessions: number;
  messages: number;
  chunks: number;
  vectorsRestored: number;
}

function* walk(dir: string, prefix: string[] = []): Generator<{ segments: string[]; full: string }> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const segments = [...prefix, entry.name];
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, segments);
    else if (entry.isFile()) yield { segments, full };
  }
}

/** Makes `files` agree with the archive: missing rows are created, sizes follow the disk. */
function syncFilesFromDisk(db: Db, rawDir: string, log: (line: string) => void): number {
  let found = 0;
  let skipped = 0;
  const skip = (path: string, why: string): void => {
    skipped++;
    log(`  skipped ${path}: ${why}`);
  };
  try {
    readdirSync(rawDir);
  } catch {
    return 0;
  }
  for (const { segments, full } of walk(rawDir)) {
    const rel = segments.join("/");
    const [machine, source, ...rest] = segments;
    if (rest.length === 0 || machine === undefined || !MACHINE_NAME_PATTERN.test(machine)) {
      skip(rel, "not under <machine>/<source>/");
      continue;
    }
    if (!(SOURCES as readonly string[]).includes(source!)) {
      skip(rel, `unknown source ${source}`);
      continue;
    }
    const last = rest[rest.length - 1]!;
    const match = /^(.+)\.g(\d+)$/.exec(last);
    const generation = match ? Number(match[2]) : 0;
    const path = [...rest.slice(0, -1), match ? match[1]! : last].join("/");
    upsertFileSize(db, { machine, source: source as Source, path }, generation, statSync(full).size);
    found++;
  }
  if (skipped > 0) log(`  ${skipped} entries skipped`);
  return found;
}

export async function reindexFromRaw(
  db: Db,
  source: ServerConfig | ConfigView,
  log: (line: string) => void,
): Promise<ReindexSummary> {
  const view = toConfigView(source);
  const rawDir = rawDirOf(view.current());

  const stashed = stashVectors(db);
  log(`Stashed ${stashed} vectors by text hash.`);

  clearVectorTables(db);
  resetDerived(db);
  log("Dropped derived tables and rewound every file.");

  const found = syncFilesFromDisk(db, rawDir, log);
  log(`Archive walk: ${found} files, ${listFiles(db).length} file rows.`);

  const wiring = buildWiring(db, view);
  const stages = wiring.stages.filter((s) => s.name === "chunk");
  log("Parsing and chunking...");
  await runUntilIdle({ db, rawDir, parsers: wiring.parsers, observers: wiring.observers, stages });

  const vectorsRestored = restoreVectors(db);
  log(`Restored ${vectorsRestored} vectors.`);

  const summary: ReindexSummary = {
    files: listFiles(db).length,
    sessions: listSessions(db).length,
    messages: countMessages(db),
    chunks: countChunks(db),
    vectorsRestored,
  };
  log(
    `Rebuilt ${summary.files} files, ${summary.sessions} sessions, ${summary.messages} messages, ${summary.chunks} chunks; ${summary.vectorsRestored} vectors restored.`,
  );
  const active = getActiveModel(db);
  if (active) {
    const missing = countMissing(db, active.slug);
    log(`${missing} chunks have no vector for ${active.slug}${missing > 0 ? "; run reembed to fill them." : "."}`);
  }
  return summary;
}

const command: Command = {
  summary: "Rebuild the derived tables from the raw archive",
  usage,
  async run(ctx) {
    let values;
    try {
      ({ values } = parseArgs({
        args: ctx.args,
        options: { "from-raw": { type: "boolean" } },
        allowPositionals: false,
        strict: true,
      }));
    } catch (err) {
      throw new UsageError((err as Error).message);
    }
    if (values["from-raw"] !== true) throw new UsageError("reindex needs --from-raw");
    return withDb(ctx, async (db, _config, store) => {
      await reindexFromRaw(db, store, ctx.out);
      return 0;
    });
  },
};

export default command;
