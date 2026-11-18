/**
 * Removes what scrubbing leaves behind that still describes the person the
 * sessions came from: when they worked and how much. It runs on fixture files
 * after the scrubber, file by file.
 *
 * - Timestamps keep their order and equality within a file but nothing else:
 *   the file's distinct instants become one second apart from a fixed date, a
 *   different day per file. Codex file names carry the start time too, so they
 *   are renamed to match.
 * - Numbers become stable stand-ins, except the ones a parser reads (ordinals)
 *   and small counts and codes (0 to 10), which say nothing about the person.
 * - `entrypoint` and `originator` name the app the session ran in; they become
 *   `cli` and `codex-tui`, and app-specific context kinds lose the app's name.
 */

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const CODEX_NAME_TIME = /^(rollout-)\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-)/;
const KEPT_NUMBER_KEYS = new Set(["ordinal", "subagent_history_start_ordinal", "index"]);
const BASE = Date.UTC(2001, 0, 1);
const DAY_MS = 86_400_000;

export interface FixtureFile {
  /** Path within the version directory, e.g. `rollout-...jsonl` or `<session>/subagents/agent-x.jsonl`. */
  name: string;
  lines: string[];
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function standInNumber(key: string, value: number): number {
  if (Number.isInteger(value)) {
    if (value >= 0 && value <= 10) return value;
    const digits = String(Math.abs(value)).length;
    const low = 10 ** (digits - 1);
    const n = low + (hash(`${key}:${value}`) % (9 * low));
    return value < 0 ? -n : n;
  }
  const scale = Math.max(1, 10 ** Math.floor(Math.log10(Math.abs(value)) + 1));
  return Math.round(((hash(`${key}:${value}`) % 10_000) / 10_000) * scale * 1000) / 1000;
}

function collectTimestamps(value: Json, into: Set<string>): void {
  if (typeof value === "string") {
    if (ISO_TIMESTAMP.test(value)) into.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectTimestamps(v, into);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) collectTimestamps(v, into);
  }
}

function rewrite(value: Json, key: string, times: Map<string, string>): Json {
  if (typeof value === "string") {
    if (key === "entrypoint") return "cli";
    if (key === "originator") return "codex-tui";
    if (key === "content_item_kinds") return value.replace(/t3_code/g, "client");
    return times.get(value) ?? value;
  }
  if (typeof value === "number") return KEPT_NUMBER_KEYS.has(key) ? value : standInNumber(key, value);
  if (Array.isArray(value)) return value.map((v) => rewrite(v, key, times));
  if (value !== null && typeof value === "object") {
    const out: { [key: string]: Json } = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewrite(v, k, times);
    return out;
  }
  return value;
}

export function normalizeFixtureFile(file: FixtureFile, fileIndex: number): FixtureFile {
  const records = file.lines.map((line) => JSON.parse(line) as Json);
  const seen = new Set<string>();
  for (const r of records) collectTimestamps(r, seen);
  const ordered = [...seen].sort((a, b) => Date.parse(a) - Date.parse(b) || (a < b ? -1 : a > b ? 1 : 0));
  const start = BASE + fileIndex * DAY_MS;
  const times = new Map(ordered.map((t, i) => [t, new Date(start + i * 1000).toISOString()]));

  const stamp = new Date(start).toISOString().slice(0, 19).replace(/:/g, "-");
  const name = file.name.replace(CODEX_NAME_TIME, `$1${stamp}$2`);
  return { name, lines: records.map((r) => JSON.stringify(rewrite(r, "", times))) };
}
