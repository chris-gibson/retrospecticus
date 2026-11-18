/**
 * Applies normalize.ts to fixtures already on disk, rewriting them and the
 * manifest in place. make-fixtures.ts normalizes new builds itself; this is for
 * fixtures built before it did.
 *
 *   bun scripts/normalize-fixtures.ts [--dir fixtures]
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { normalizeFixtureFile } from "./normalize.ts";

interface Entry {
  source: string;
  version: string;
  path: string;
  role: string;
  lines: number;
  truncatedFromLines?: number;
  bytes: number;
}

const i = process.argv.indexOf("--dir");
const dir = resolve(i === -1 ? "fixtures" : process.argv[i + 1]!);
const manifestPath = join(dir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Entry[];

const next = manifest.map((entry, index) => {
  const prefix = `${entry.source}/${entry.version}/`;
  const lines = readFileSync(join(dir, entry.path), "utf8").split("\n").filter((l) => l !== "");
  const out = normalizeFixtureFile({ name: entry.path.slice(prefix.length), lines }, index);
  rmSync(join(dir, entry.path));
  const target = join(dir, prefix + out.name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${out.lines.join("\n")}\n`);
  return { ...entry, path: prefix + out.name, bytes: out.lines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0) };
});
writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
for (const e of next) console.log(e.path);
