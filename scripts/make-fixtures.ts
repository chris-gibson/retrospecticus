/**
 * Builds the committed fixtures from the live session directories. It only
 * ever reads those directories, and everything it writes has passed through
 * the scrubber and then its audit; a single audit violation aborts the run
 * before any file is written. The live directories keep growing, so a rerun
 * produces different fixtures and the golden snapshots must be updated with
 * it (`bun test -u packages/server/test/parsers.test.ts`). `--review` writes
 * every string and key that was kept verbatim to a file for a human to read
 * before committing. Timestamps, numbers and the app name are then normalized
 * (see normalize.ts), so the fixtures do not show when or how much anyone worked.
 *
 *   bun scripts/make-fixtures.ts [--out fixtures] [--dry-run] [--review <file outside the repo>]
 */
import { Glob } from "bun";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Source } from "../packages/shared/src/index.ts";
import { CLAUDE_INJECTED_PREFIXES } from "../packages/server/src/parsers/claude-code.ts";
import { CODEX_INJECTED_PREFIXES } from "../packages/server/src/parsers/codex.ts";
import { parsers } from "../packages/server/src/parsers/index.ts";
import { auditRecord, IdMap, isFakeId, isFiller, Scrubber } from "./scrub.ts";
import { normalizeFixtureFile } from "./normalize.ts";

/**
 * Whole sessions do not fit the 3 MB budget at full string length (the
 * smallest real ones are several hundred kilobytes), so long strings are
 * shortened: structure and record counts stay exact, lengths above the caps do not.
 */
const MAX_STRING = 240;
const MAX_TEXT = 4000;
const SESSION_BYTE_LIMIT = 340 * 1024;
const TOTAL_BYTE_BUDGET = 3 * 1024 * 1024;

type Json = Record<string, any>;
type Role = "main" | "subagent" | "guardian" | "spawned";

interface SourceFile {
  rel: string;
  lines: string[];
  version: string;
  role: Role;
  sessionId: string;
  parentId?: string;
  agentId?: string;
}

interface Output {
  source: Source;
  version: string;
  name: string;
  role: Role | "coverage";
  lines: string[];
  sourceLines: number;
}

function compareVersions(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

function leadingMarker(text: unknown, markers: readonly string[]): string {
  if (typeof text !== "string") return "";
  return markers.find((m) => text.startsWith(m)) ?? "";
}

function blockTypes(content: unknown): string {
  if (typeof content === "string") return "string";
  if (!Array.isArray(content)) return typeof content;
  const types = content.map((b: Json) =>
    b.type === "tool_result" ? `tool_result(${blockTypes(b.content)}${b.is_error === true ? ",error" : ""})` : String(b.type),
  );
  return [...new Set(types)].sort().join("+");
}

/** Finer than the parser's discriminator, so each branch the parsers take has a sample. */
function claudeCoverageKey(o: Json, discriminator: string): string {
  const m = o.message;
  if (o.type === "user") {
    const text = typeof m?.content === "string" ? m.content : m?.content?.find?.((b: Json) => b.type === "text")?.text;
    return [
      discriminator,
      blockTypes(m?.content),
      o.isMeta === true ? "meta" : "",
      o.isCompactSummary === true ? "compact" : "",
      `src=${o.promptSource ?? ""}`,
      `origin=${o.origin?.kind ?? ""}`,
      leadingMarker(text, CLAUDE_INJECTED_PREFIXES),
    ].join("|");
  }
  if (o.type === "assistant") {
    const emptyThinking = Array.isArray(m?.content) && m.content.some((b: Json) => b.type === "thinking" && !b.thinking);
    return [discriminator, blockTypes(m?.content), o.isApiErrorMessage === true ? "apiError" : "", emptyThinking ? "emptyThinking" : ""].join("|");
  }
  if (discriminator === "attachment/queued_command") {
    return [discriminator, o.attachment?.commandMode ?? "", blockTypes(o.attachment?.prompt)].join("|");
  }
  return discriminator;
}

function codexRole(meta: Json): Role {
  if (meta.source?.subagent?.other === "guardian" || meta.thread_source === "guardian_review") return "guardian";
  if (meta.thread_source === "subagent" || meta.source?.subagent !== undefined) return "spawned";
  return "main";
}

function codexCoverageKey(o: Json, discriminator: string): string {
  const p: Json = o.payload ?? {};
  switch (discriminator) {
    case "session_meta":
      return `${discriminator}|${codexRole(p)}`;
    case "response_item/message": {
      const blocks = (p.content ?? []).map((b: Json) => `${b.type}${leadingMarker(b.text, CODEX_INJECTED_PREFIXES) === "" ? "" : "(context)"}`);
      return [discriminator, p.role, p.phase ?? "", [...new Set(blocks)].sort().join("+")].join("|");
    }
    case "response_item/reasoning":
      return `${discriminator}|${p.summary?.length > 0 ? "summary" : "encrypted"}`;
    case "response_item/function_call_output":
    case "response_item/custom_tool_call_output":
    case "response_item/agent_message":
      return `${discriminator}|${blockTypes(p.output ?? p.content)}`;
    case "event_msg/item_completed":
      return `${discriminator}|${p.item?.type ?? ""}`;
    default:
      return discriminator;
  }
}

async function readSource(root: string): Promise<{ rel: string; lines: string[] }[]> {
  const files: { rel: string; lines: string[] }[] = [];
  for await (const rel of new Glob("**/*.jsonl").scan({ cwd: root })) {
    const lines = (await Bun.file(join(root, rel)).text()).split("\n").filter((l) => l !== "");
    if (lines.length > 0) files.push({ rel, lines });
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

async function loadClaude(root: string): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  for (const { rel, lines } of await readSource(root)) {
    const sub = /([^/]+)\/subagents\/agent-([^/]+)\.jsonl$/.exec(rel);
    const first = lines.map((l) => JSON.parse(l) as Json).find((o) => typeof o.version === "string");
    if (first === undefined) continue;
    const sessionId = sub?.[1] ?? rel.split("/").pop()!.replace(/\.jsonl$/, "");
    out.push({
      rel,
      lines,
      version: first.version,
      role: sub ? "subagent" : "main",
      sessionId: sub ? `${sessionId}:${sub[2]}` : sessionId,
      parentId: sub ? sessionId : undefined,
      agentId: sub?.[2],
    });
  }
  return out;
}

async function loadCodex(root: string): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  for (const { rel, lines } of await readSource(root)) {
    const first = JSON.parse(lines[0]!) as Json;
    if (first.type !== "session_meta") continue;
    const meta: Json = first.payload;
    out.push({
      rel,
      lines,
      version: meta.cli_version,
      role: codexRole(meta),
      sessionId: meta.id,
      parentId: meta.parent_thread_id ?? meta.forked_from_id,
    });
  }
  return out;
}

class Builder {
  readonly outputs: Output[] = [];
  private readonly ids = new IdMap();

  constructor(private readonly source: Source) {}

  private scrubber(): Scrubber {
    return new Scrubber(this.source, { ids: this.ids, maxStringLength: MAX_STRING, maxTextLength: MAX_TEXT });
  }

  scrubbedSize(file: SourceFile): number {
    const probe = new Scrubber(this.source, { maxStringLength: MAX_STRING, maxTextLength: MAX_TEXT });
    return file.lines.reduce((n, line) => n + probe.scrubLine(line).length + 1, 0);
  }

  userMessages(file: SourceFile): number {
    const ctx = { source: this.source, machine: "probe", path: file.rel, state: {} };
    let n = 0;
    for (const line of file.lines) {
      const result = parsers[this.source].parse(line, ctx);
      if (result.kind === "messages") n += result.messages.filter((m) => m.role === "user").length;
    }
    return n;
  }

  private fixtureName(file: SourceFile): string {
    if (this.source === "codex") {
      const stamp = /rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-/.exec(file.rel)?.[1] ?? "unknown";
      return `rollout-${stamp}-${this.ids.fake(file.sessionId)}.jsonl`;
    }
    if (file.role === "subagent") {
      return `${this.ids.fake(file.parentId!)}/subagents/agent-${this.ids.fake(file.agentId!)}.jsonl`;
    }
    return `${this.ids.fake(file.sessionId)}.jsonl`;
  }

  /** A session over the per-file limit is cut after a whole line; the manifest records the original length. */
  addSession(file: SourceFile, version: string): void {
    const name = this.fixtureName(file);
    if (this.outputs.some((o) => o.name === name && o.version === version)) return;
    const scrubber = this.scrubber();
    const lines: string[] = [];
    let bytes = 0;
    for (const line of file.lines) {
      const scrubbed = scrubber.scrubLine(line);
      if (lines.length > 0 && bytes + scrubbed.length + 1 > SESSION_BYTE_LIMIT) break;
      lines.push(scrubbed);
      bytes += scrubbed.length + 1;
    }
    this.outputs.push({ source: this.source, version, name, role: file.role, lines, sourceLines: file.lines.length });
  }

  addCoverage(version: string, name: string, samples: string[]): void {
    const scrubber = this.scrubber();
    this.outputs.push({
      source: this.source,
      version,
      name,
      role: "coverage",
      lines: samples.map((l) => scrubber.scrubLine(l)),
      sourceLines: samples.length,
    });
  }
}

interface Sample {
  line: string;
  order: number;
}

/**
 * One smallest sample per coverage key for the oldest version, for the newest,
 * and, so that no observed discriminator goes unrepresented, for keys that only
 * ever appeared in versions between the two.
 */
function collectCoverage(
  source: Source,
  files: SourceFile[],
  oldest: string,
  newest: string,
): { oldest: string[]; newest: string[]; between: string[] } {
  const buckets = { oldest: new Map<string, Sample>(), newest: new Map<string, Sample>(), between: new Map<string, Sample>() };
  const keyOf = source === "claude-code" ? claudeCoverageKey : codexCoverageKey;
  let order = 0;
  for (const file of files) {
    let version = file.version;
    for (const line of file.lines) {
      const record = JSON.parse(line) as Json;
      if (source === "claude-code" && typeof record.version === "string") version = record.version;
      const bucket = version === oldest ? buckets.oldest : version === newest ? buckets.newest : buckets.between;
      const key = keyOf(record, parsers[source].discriminator(record));
      const current = bucket.get(key);
      if (current === undefined || line.length < current.line.length) bucket.set(key, { line, order: order++ });
    }
  }
  for (const key of [...buckets.between.keys()]) {
    if (buckets.oldest.has(key) || buckets.newest.has(key)) buckets.between.delete(key);
  }
  // A main session_meta leads each Codex file so the parser treats the rest as an ordinary session.
  const rank = (key: string): number => (key === "session_meta|main" ? 0 : key.startsWith("session_meta") ? 1 : 2);
  const ordered = (bucket: Map<string, Sample>): string[] =>
    [...bucket.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)).map(([, sample]) => sample.line);
  const mainMeta = buckets.newest.get("session_meta|main") ?? buckets.oldest.get("session_meta|main");
  const between = ordered(buckets.between);
  if (source === "codex" && between.length > 0 && mainMeta !== undefined) between.unshift(mainMeta.line);
  return { oldest: ordered(buckets.oldest), newest: ordered(buckets.newest), between };
}

function smallest(builder: Builder, candidates: SourceFile[]): SourceFile | undefined {
  return candidates.map((file) => ({ file, size: builder.scrubbedSize(file) })).sort((a, b) => a.size - b.size || a.file.rel.localeCompare(b.file.rel))[0]?.file;
}

function smallestPair(builder: Builder, children: SourceFile[], all: SourceFile[]): [SourceFile, SourceFile] | undefined {
  const pairs: { child: SourceFile; parent: SourceFile; size: number }[] = [];
  for (const child of children) {
    const parent = all.find((f) => f.sessionId === child.parentId);
    if (parent !== undefined) pairs.push({ child, parent, size: builder.scrubbedSize(child) + builder.scrubbedSize(parent) });
  }
  const best = pairs.sort((a, b) => a.size - b.size || a.child.rel.localeCompare(b.child.rel))[0];
  return best === undefined ? undefined : [best.child, best.parent];
}

function build(source: Source, files: SourceFile[]): Builder {
  const builder = new Builder(source);
  if (files.length === 0) return builder;
  const versions = [...new Set(files.map((f) => f.version))].sort(compareVersions);
  const oldest = versions[0]!;
  const newest = versions[versions.length - 1]!;

  for (const version of new Set([oldest, newest])) {
    const here = files.filter((f) => f.version === version);
    for (const role of ["subagent", "spawned", "guardian"] as const) {
      const pair = smallestPair(builder, here.filter((f) => f.role === role), files);
      if (pair === undefined) continue;
      builder.addSession(pair[1], version);
      builder.addSession(pair[0], version);
    }
    const plain = smallest(builder, here.filter((f) => f.role === "main" && builder.userMessages(f) > 0));
    if (plain !== undefined) builder.addSession(plain, version);
  }

  const coverage = collectCoverage(source, files, oldest, newest);
  builder.addCoverage(oldest, "coverage.jsonl", coverage.oldest);
  if (newest !== oldest) builder.addCoverage(newest, "coverage.jsonl", coverage.newest);
  if (coverage.between.length > 0) builder.addCoverage(newest, "coverage-intermediate.jsonl", coverage.between);
  return builder;
}

/** For a human to read once after generation: every string that was kept verbatim, by path. */
function reviewReport(outputs: Output[]): string {
  const kept = new Map<string, Set<string>>();
  const keys = new Set<string>();
  const walk = (v: unknown, path: string): void => {
    if (typeof v === "string") {
      if (v !== "" && !isFiller(v) && !isFakeId(v)) {
        let set = kept.get(path);
        if (set === undefined) kept.set(path, (set = new Set()));
        set.add(v.length > 60 ? `${v.slice(0, 60)}...` : v);
      }
    } else if (Array.isArray(v)) for (const e of v) walk(e, `${path}[]`);
    else if (v !== null && typeof v === "object") {
      for (const [k, child] of Object.entries(v)) {
        keys.add(k);
        walk(child, path === "" ? k : `${path}.${k}`);
      }
    }
  };
  for (const output of outputs) for (const line of output.lines) walk(JSON.parse(line), output.source);
  const lines = ["# kept string values by path"];
  for (const [path, values] of [...kept].sort()) {
    const shown = [...values].sort();
    lines.push(`${path}\t(${shown.length})\t${shown.slice(0, 40).join(" | ")}`);
  }
  lines.push("", "# object keys", [...keys].sort().join(" "));
  return lines.join("\n");
}

async function main(argv: string[]): Promise<void> {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const outDir = resolve(flag("--out") ?? "fixtures");
  const dryRun = argv.includes("--dry-run");
  const claudeRoot = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  const codexRoot = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");

  const builders = [build("claude-code", await loadClaude(claudeRoot)), build("codex", await loadCodex(codexRoot))];
  const outputs = builders.flatMap((b) => b.outputs).map((o, i) => ({ ...o, ...normalizeFixtureFile(o, i) }));

  let violations = 0;
  for (const output of outputs) {
    for (const line of output.lines) violations += auditRecord(output.source, JSON.parse(line)).length;
  }
  if (violations > 0) throw new Error(`refusing to write fixtures: ${violations} string(s) escaped scrubbing`);

  const manifest = outputs.map((o) => ({
    source: o.source,
    version: o.version,
    path: `${o.source}/${o.version}/${o.name}`,
    role: o.role,
    lines: o.lines.length,
    truncatedFromLines: o.lines.length < o.sourceLines ? o.sourceLines : undefined,
    bytes: o.lines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0),
  }));
  const total = manifest.reduce((n, m) => n + m.bytes, 0);
  for (const m of manifest) {
    console.log(`${String(m.bytes).padStart(8)}  ${String(m.lines).padStart(5)} lines  ${m.role.padEnd(9)} ${m.path}${m.truncatedFromLines ? `  (first ${m.lines} of ${m.truncatedFromLines})` : ""}`);
  }
  console.log(`${String(total).padStart(8)}  total (budget ${TOTAL_BYTE_BUDGET})`);
  if (total > TOTAL_BYTE_BUDGET) throw new Error("fixtures exceed the size budget");

  const review = flag("--review");
  if (review !== undefined) writeFileSync(review, reviewReport(outputs));
  if (dryRun) return;

  for (const source of ["claude-code", "codex"] as const) rmSync(join(outDir, source), { recursive: true, force: true });
  for (const output of outputs) {
    const target = join(outDir, output.source, output.version, output.name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${output.lines.join("\n")}\n`);
  }
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

if (import.meta.main) await main(process.argv.slice(2));
