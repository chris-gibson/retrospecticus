import { cpSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Source } from "@retrospecticus/shared";
import { upsertFileSize, type FileRow } from "../src/db/files.ts";
import type { Db } from "../src/db/index.ts";

export const FIXTURE_ROOT = join(import.meta.dir, "../../../fixtures");

export interface FixtureEntry {
  source: Source;
  version: string;
  /** Relative to the fixture root: `<source>/<version>/<name>`. */
  path: string;
  role: "main" | "subagent" | "guardian" | "spawned" | "coverage";
  lines: number;
  truncatedFromLines?: number;
  bytes: number;
}

export const manifest: FixtureEntry[] = JSON.parse(readFileSync(join(FIXTURE_ROOT, "manifest.json"), "utf8"));

export function fixtureLines(entry: FixtureEntry): string[] {
  return readFileSync(join(FIXTURE_ROOT, entry.path), "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

/** A path as a collector would report it; the version directory stands in for the project or date directory. */
export function archivedPath(entry: FixtureEntry): string {
  return entry.path.split("/").slice(1).join("/");
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "retrospecticus-parse-"));
}

/** Writes bytes into the raw archive layout and records them in `files`, as an ingest append would. */
export function archive(
  db: Db,
  rawDir: string,
  key: { machine?: string; source: Source; path: string; generation?: number },
  content: string | Buffer,
): FileRow {
  const machine = key.machine ?? "laptop";
  const generation = key.generation ?? 0;
  const target = join(rawDir, machine, key.source, key.path + (generation > 0 ? `.g${generation}` : ""));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return upsertFileSize(db, { machine, source: key.source, path: key.path }, generation, Buffer.byteLength(content));
}

export function archiveFixture(db: Db, rawDir: string, entry: FixtureEntry, machine = "laptop"): FileRow {
  const path = archivedPath(entry);
  const target = join(rawDir, machine, entry.source, path);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(FIXTURE_ROOT, entry.path), target);
  return upsertFileSize(db, { machine, source: entry.source, path }, 0, statSync(target).size);
}
