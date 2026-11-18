/**
 * Turns a real session record into one that is safe to commit: structure,
 * numbers, booleans and nulls survive; every string is replaced unless it sits
 * on a short allowlist of harness-defined discriminators. `auditRecord` is the
 * independent check that a value could only have come out of `Scrubber`.
 */
import type { Source } from "../packages/shared/src/index.ts";
import { CLAUDE_INJECTED_PREFIXES } from "../packages/server/src/parsers/claude-code.ts";
import { CODEX_INJECTED_PREFIXES } from "../packages/server/src/parsers/codex.ts";

const FILLER_WORDS = [
  "lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing", "elit", "sed", "do",
  "eiusmod", "tempor", "incididunt", "ut", "labore", "et", "dolore", "magna", "aliqua", "enim",
  "ad", "minim", "veniam", "quis", "nostrud", "exercitation", "ullamco", "laboris", "nisi", "aliquip",
  "ex", "ea", "commodo", "consequat", "duis", "aute", "irure", "in", "reprehenderit", "voluptate",
  "velit", "esse", "cillum", "fugiat", "nulla", "pariatur", "excepteur", "sint", "occaecat", "cupidatat",
  "non", "proident", "sunt", "culpa", "qui", "officia", "deserunt", "mollit", "anim", "id", "est", "laborum",
] as const;
const FILLER_SET: ReadonlySet<string> = new Set(FILLER_WORDS);

export const PLACEHOLDER_BASE64 = "<scrubbed:base64>";
export const PLACEHOLDER_ENCRYPTED = "<scrubbed:encrypted>";
const PLACEHOLDERS: ReadonlySet<string> = new Set([PLACEHOLDER_BASE64, PLACEHOLDER_ENCRYPTED]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAKE_UUID = /^00000000-0000-4000-8000-[0-9a-f]{12}$/;
const FAKE_ID = /^(?:[a-z]{1,8}_)?fake\d{6}$/;
const FAKE_MCP_TOOL = /^mcp__fake__tool_\d{4}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const PLAIN_KEY = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const SCRUBBED_KEY = /^key_\d+$/;

/**
 * Object keys can be data too (tool argument names, file names, tool-use ids,
 * MCP server names). The harness's own schema lives near the root, so a key
 * survives only when it is a plain identifier within KEY_DEPTH_LIMIT levels of
 * the root, outside the free-form subtrees, and does not look like an id.
 * Deeper down only the handful of keys the parsers read are kept.
 */
const KEY_DEPTH_LIMIT = 3;
const DEEP_KEYS: ReadonlySet<string> = new Set([
  "type", "text", "content", "source", "data", "media_type", "tool_name", "tool_use_id", "is_error", "id", "name",
  "role", "image_url", "encrypted_content", "other", "thread_spawn", "parent_thread_id", "depth", "agent_nickname",
  "agent_path", "agent_role",
]);
const FREE_FORM_KEYS: ReadonlySet<string> = new Set([
  "toolUseResult", "input", "arguments", "properties", "structuredContent", "_meta", "mcpMeta", "trackedFileBackups",
  "wireToolInputs", "modelUsage", "answers", "state", "env",
]);
const ID_LIKE_KEY = /^(?:toolu|call|msg|req|resp|rs|fc)_[A-Za-z0-9]{8,}$|^mcp__|\d{4}|[0-9a-f]{12}/i;

function keepsKey(key: string, depth: number, freeForm: boolean): boolean {
  if (freeForm || !PLAIN_KEY.test(key) || ID_LIKE_KEY.test(key)) return false;
  return depth <= KEY_DEPTH_LIMIT || DEEP_KEYS.has(key);
}
const BLOB_LIKE = /^[A-Za-z0-9+/=_-]{256,}$/;

const TOKEN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+.][A-Za-z0-9.]{1,20})?$/;
const LABEL = /^[A-Za-z][A-Za-z0-9_.-]{0,30}(?: [A-Za-z0-9_.-]{1,30}){0,2}$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;

type Matcher = "token" | "version" | "label" | "tool";

const ID_KEYS: ReadonlySet<string> = new Set([
  "uuid", "parentUuid", "logicalParentUuid", "leafUuid", "sessionId", "session_id", "agentId", "id",
  "tool_use_id", "call_id", "messageId", "snapshotMessageId", "sourceToolAssistantUUID", "sourceToolUseID",
  "promptId", "requestId", "continuedInSessionId", "bridgeSessionId", "commandUuid", "source_uuid",
  "submitUuid", "interruptedMessageId", "anchorUuid", "headUuid", "tailUuid", "uuids", "allUuids",
  "parent_thread_id", "forked_from_id", "thread_id", "threadId", "turn_id", "root_turn_id", "window_id",
  "first_window_id", "previous_window_id", "response_id", "compaction_response_id",
]);

const TIMESTAMP_KEYS: ReadonlySet<string> = new Set(["timestamp"]);
const BASE64_KEYS: ReadonlySet<string> = new Set(["data", "image_url"]);
const ENCRYPTED_KEYS: ReadonlySet<string> = new Set(["encrypted_content", "signature"]);

const CLAUDE_ALLOW: Readonly<Record<string, Matcher>> = {
  type: "token",
  subtype: "token",
  version: "version",
  operation: "token",
  mode: "token",
  permissionMode: "token",
  userType: "token",
  entrypoint: "token",
  sessionKind: "token",
  promptSource: "token",
  level: "token",
  renderedRole: "token",
  "origin.kind": "token",
  "compactMetadata.trigger": "token",
  "message.role": "token",
  "message.type": "token",
  "message.stop_reason": "token",
  "message.content[].type": "token",
  "message.content[].name": "tool",
  "message.content[].caller.type": "token",
  "message.content[].source.type": "token",
  "message.content[].content[].type": "token",
  "message.content[].content[].tool_name": "tool",
  "message.content[].content[].source.type": "token",
  "attachment.type": "token",
  "attachment.commandMode": "token",
  "attachment.origin.kind": "token",
  "attachment.prompt[].type": "token",
  "attachment.prompt[].source.type": "token",
};

const CODEX_ALLOW: Readonly<Record<string, Matcher>> = {
  type: "token",
  "payload.type": "token",
  "payload.role": "token",
  "payload.phase": "token",
  "payload.status": "token",
  "payload.name": "tool",
  "payload.namespace": "tool",
  "payload.content[].type": "token",
  "payload.summary[].type": "token",
  "payload.output[].type": "token",
  "payload.cli_version": "version",
  "payload.originator": "label",
  "payload.source": "token",
  "payload.source.subagent.other": "token",
  "payload.thread_source": "token",
  "payload.item.type": "token",
  "payload.internal_chat_message_metadata_passthrough.content_item_kinds[]": "token",
};

/** Paths whose leading injected-context marker the parsers branch on. */
const CLAUDE_MARKER_PATHS: ReadonlySet<string> = new Set([
  "message.content",
  "message.content[].text",
  "attachment.prompt",
  "attachment.prompt[].text",
]);
const CODEX_MARKER_PATHS: ReadonlySet<string> = new Set(["payload.content[].text"]);

interface SourceRules {
  allow: Readonly<Record<string, Matcher>>;
  markerPaths: ReadonlySet<string>;
  markers: readonly string[];
}

const RULES: Record<Source, SourceRules> = {
  "claude-code": { allow: CLAUDE_ALLOW, markerPaths: CLAUDE_MARKER_PATHS, markers: CLAUDE_INJECTED_PREFIXES },
  codex: { allow: CODEX_ALLOW, markerPaths: CODEX_MARKER_PATHS, markers: CODEX_INJECTED_PREFIXES },
};

function matches(matcher: Matcher, value: string): boolean {
  switch (matcher) {
    case "token":
      return TOKEN.test(value);
    case "version":
      return VERSION.test(value);
    case "label":
      return LABEL.test(value);
    case "tool":
      return TOOL_NAME.test(value) && !value.startsWith("mcp__");
  }
}

function leadingMarker(rules: SourceRules, path: string, value: string): string | undefined {
  if (!rules.markerPaths.has(path)) return undefined;
  let best: string | undefined;
  for (const marker of rules.markers) {
    if (value.startsWith(marker) && (best === undefined || marker.length > best.length)) best = marker;
  }
  return best;
}

export function isFiller(value: string): boolean {
  const tokens = value.split(" ");
  const last = tokens.pop() ?? "";
  if (!tokens.every((t) => FILLER_SET.has(t))) return false;
  return FILLER_WORDS.some((w) => w.startsWith(last));
}

export function isFakeId(value: string): boolean {
  return FAKE_UUID.test(value) || FAKE_ID.test(value);
}

/** Shared across files of one run so parent and child sessions keep pointing at each other. */
export class IdMap {
  private readonly ids = new Map<string, string>();
  private readonly tools = new Map<string, string>();

  fake(real: string): string {
    let fake = this.ids.get(real);
    if (fake === undefined) {
      const n = this.ids.size + 1;
      if (UUID.test(real)) fake = `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
      else fake = `${/^[a-z]{1,8}_/.exec(real)?.[0] ?? ""}fake${String(n).padStart(6, "0")}`;
      this.ids.set(real, fake);
    }
    return fake;
  }

  fakeTool(real: string): string {
    let fake = this.tools.get(real);
    if (fake === undefined) {
      fake = `mcp__fake__tool_${String(this.tools.size + 1).padStart(4, "0")}`;
      this.tools.set(real, fake);
    }
    return fake;
  }
}

export interface ScrubOptions {
  ids?: IdMap;
  /** Caps filler length; only for keeping committed fixtures inside their size budget. */
  maxStringLength?: number;
  /** Separate cap for conversation text (the marker paths), so fixtures keep some long turns. */
  maxTextLength?: number;
}

export class Scrubber {
  readonly ids: IdMap;
  private readonly rules: SourceRules;
  private readonly maxStringLength: number;
  private readonly maxTextLength: number;
  private seed = 1;

  constructor(source: Source, options: ScrubOptions = {}) {
    this.rules = RULES[source];
    this.ids = options.ids ?? new IdMap();
    this.maxStringLength = options.maxStringLength ?? Number.POSITIVE_INFINITY;
    this.maxTextLength = options.maxTextLength ?? this.maxStringLength;
  }

  scrub(value: unknown): unknown {
    return this.walk(value, "", "", 0, false);
  }

  scrubLine(line: string): string {
    return JSON.stringify(this.scrub(JSON.parse(line)));
  }

  private walk(value: unknown, path: string, key: string, depth: number, freeForm: boolean): unknown {
    if (typeof value === "string") return this.scrubString(value, path, key);
    if (Array.isArray(value)) return value.map((v) => this.walk(v, `${path}[]`, key, depth, freeForm));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      let renamed = 0;
      for (const [k, v] of Object.entries(value)) {
        const kept = keepsKey(k, depth + 1, freeForm);
        const outKey = kept ? k : `key_${renamed++}`;
        const childKey = kept ? k : "";
        out[outKey] = this.walk(v, path === "" ? outKey : `${path}.${outKey}`, childKey, depth + 1, freeForm || FREE_FORM_KEYS.has(k));
      }
      return out;
    }
    return value;
  }

  private scrubString(value: string, path: string, key: string): string {
    if (value === "") return "";
    if (ID_KEYS.has(key)) return this.ids.fake(value);
    if (TIMESTAMP_KEYS.has(key) && ISO_TIMESTAMP.test(value)) return value;
    if (ENCRYPTED_KEYS.has(key)) return PLACEHOLDER_ENCRYPTED;
    if (BASE64_KEYS.has(key) || BLOB_LIKE.test(value)) return PLACEHOLDER_BASE64;
    const matcher = this.rules.allow[path];
    if (matcher !== undefined) {
      if (matches(matcher, value)) return value;
      if (matcher === "tool") return this.ids.fakeTool(value);
    }
    const cap = this.rules.markerPaths.has(path) ? this.maxTextLength : this.maxStringLength;
    const marker = leadingMarker(this.rules, path, value);
    if (marker !== undefined) return marker + this.filler(value.length - marker.length, cap);
    return this.filler(value.length, cap);
  }

  private filler(length: number, cap: number): string {
    const target = Math.min(length, cap);
    let out = "";
    while (out.length < target) {
      this.seed = (Math.imul(this.seed, 1103515245) + 12345) >>> 0;
      const word = FILLER_WORDS[(this.seed >>> 16) % FILLER_WORDS.length]!;
      out += out === "" ? word : ` ${word}`;
    }
    return out.slice(0, target);
  }
}

export function scrub(value: unknown, source: Source, options: ScrubOptions = {}): unknown {
  return new Scrubber(source, options).scrub(value);
}

export interface AuditViolation {
  path: string;
  reason: string;
}

/** Lists every string or key in `value` that the scrubber could not have produced. */
export function auditRecord(source: Source, value: unknown): AuditViolation[] {
  const rules = RULES[source];
  const violations: AuditViolation[] = [];

  const checkString = (s: string, path: string, key: string): void => {
    if (s === "" || PLACEHOLDERS.has(s)) return;
    if (ID_KEYS.has(key) && isFakeId(s)) return;
    if (TIMESTAMP_KEYS.has(key) && ISO_TIMESTAMP.test(s)) return;
    const matcher = rules.allow[path];
    if (matcher !== undefined && (matches(matcher, s) || (matcher === "tool" && FAKE_MCP_TOOL.test(s)))) return;
    const marker = leadingMarker(rules, path, s);
    if (marker !== undefined && isFiller(s.slice(marker.length))) return;
    if (isFiller(s)) return;
    violations.push({ path, reason: `string of length ${s.length} is neither allowlisted nor filler` });
  };

  const walk = (v: unknown, path: string, key: string, depth: number, freeForm: boolean): void => {
    if (typeof v === "string") checkString(v, path, key);
    else if (Array.isArray(v)) for (const e of v) walk(e, `${path}[]`, key, depth, freeForm);
    else if (v !== null && typeof v === "object") {
      for (const [k, child] of Object.entries(v)) {
        const scrubbed = SCRUBBED_KEY.test(k);
        if (!scrubbed && !keepsKey(k, depth + 1, freeForm)) {
          violations.push({ path, reason: `object key of length ${k.length} is neither schema nor renamed` });
        }
        walk(child, path === "" ? k : `${path}.${k}`, scrubbed ? "" : k, depth + 1, freeForm || FREE_FORM_KEYS.has(k));
      }
    }
  };

  walk(value, "", "", 0, false);
  return violations;
}

/** Visits every string value in a JSON tree; used by tests that scan fixtures for leaks. */
export function forEachString(value: unknown, visit: (s: string) => void): void {
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) for (const e of value) forEachString(e, visit);
  else if (value !== null && typeof value === "object") {
    for (const [k, child] of Object.entries(value)) {
      visit(k);
      forEachString(child, visit);
    }
  }
}

function usage(): never {
  console.error("usage: bun scripts/scrub.ts <claude-code|codex> < input.jsonl > output.jsonl\n       bun scripts/scrub.ts --check <claude-code|codex> <file.jsonl>...");
  process.exit(2);
}

async function main(argv: string[]): Promise<void> {
  const check = argv[0] === "--check";
  const source = (check ? argv[1] : argv[0]) as Source;
  if (source !== "claude-code" && source !== "codex") usage();

  if (check) {
    let bad = 0;
    for (const file of argv.slice(2)) {
      const lines = (await Bun.file(file).text()).split("\n");
      lines.forEach((line, i) => {
        if (line === "") return;
        for (const v of auditRecord(source, JSON.parse(line))) {
          bad++;
          console.error(`${file}:${i + 1} ${v.path}: ${v.reason}`);
        }
      });
    }
    console.log(bad === 0 ? "clean" : `${bad} violation(s)`);
    process.exit(bad === 0 ? 0 : 1);
  }

  const scrubber = new Scrubber(source);
  const out: string[] = [];
  for (const line of (await Bun.stdin.text()).split("\n")) if (line !== "") out.push(scrubber.scrubLine(line));
  process.stdout.write(out.length > 0 ? `${out.join("\n")}\n` : "");
}

if (import.meta.main) await main(process.argv.slice(2));
