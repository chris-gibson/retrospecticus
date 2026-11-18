import { createHash } from "node:crypto";
import type { Source } from "@retrospecticus/shared";

export const FINGERPRINT_DEPTH = 3;

/** Discriminator recorded for a line that is not valid JSON. */
export const MALFORMED_DISCRIMINATOR = "(malformed)";

const PLAIN_KEY = /^[A-Za-z_$][A-Za-z0-9_$]{0,39}$/;
const ID_LIKE_KEY = /^(?:toolu|call|msg|req|resp|rs|fc)_[A-Za-z0-9]{8,}$|^mcp__|\d{4}|[0-9a-f]{12}/i;
/** What the fixture scrubber renames non-identifier keys to; they stand for the same free-form keys. */
const SCRUBBED_KEY = /^key_\d+$/;

/**
 * Subtrees whose keys are chosen by tools or users rather than by the harness
 * (tool inputs and results, MCP metadata, environment maps). Their type is
 * part of the shape; their contents are not, or every new tool would look
 * like format drift.
 */
const FREE_FORM_KEYS: ReadonlySet<string> = new Set([
  "toolUseResult",
  "input",
  "arguments",
  "wireToolInputs",
  "structuredContent",
  "_meta",
  "mcpMeta",
  "properties",
  "env",
]);

export type JsonType = "string" | "number" | "boolean" | "null" | "object" | "array";

/** True for keys that name a field of the harness's schema rather than carry data (paths, ids, URLs). */
export function isPlainKey(key: string): boolean {
  return PLAIN_KEY.test(key) && !ID_LIKE_KEY.test(key) && !SCRUBBED_KEY.test(key);
}

export function jsonType(value: unknown): JsonType {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
    case "bigint":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The sorted set of `path:type` entries down to `depth` keys from the root.
 * Array elements are merged under a `[]` segment, which does not count toward
 * the depth, so an array contributes the union of its elements' shapes.
 */
export function keyPaths(json: unknown, depth = FINGERPRINT_DEPTH): string[] {
  const out = new Set<string>();
  if (!isObject(json)) {
    out.add(`$:${jsonType(json)}`);
    if (Array.isArray(json)) walkArray(json, "$", 0, depth, out);
    return [...out].sort();
  }
  walkObject(json, "", 0, depth, out);
  return [...out].sort();
}

function walkObject(value: Record<string, unknown>, path: string, level: number, depth: number, out: Set<string>): void {
  for (const [rawKey, child] of Object.entries(value)) {
    const key = isPlainKey(rawKey) ? rawKey : "*";
    const childPath = path === "" ? key : `${path}.${key}`;
    walkValue(child, childPath, level + 1, depth, out, FREE_FORM_KEYS.has(rawKey));
  }
}

function walkArray(value: unknown[], path: string, level: number, depth: number, out: Set<string>): void {
  for (const element of value) walkValue(element, `${path}[]`, level, depth, out, false);
}

function walkValue(value: unknown, path: string, level: number, depth: number, out: Set<string>, opaque: boolean): void {
  out.add(`${path}:${jsonType(value)}`);
  if (opaque) return;
  if (Array.isArray(value)) walkArray(value, path, level, depth, out);
  else if (isObject(value) && level < depth) walkObject(value, path, level, depth, out);
}

function blockTypes(blocks: unknown, prefix = ""): string[] {
  if (!Array.isArray(blocks)) return [];
  const types: string[] = [];
  for (const block of blocks) {
    if (isObject(block) && typeof block.type === "string") types.push(`${prefix}${block.type}`);
  }
  return types;
}

/**
 * Content block types the parsers read, wherever they read them, so that a
 * block type the parser does not know always lands in a new shape instead of
 * hiding inside a known one. Nested types carry the same prefixes the parsers
 * use when they report unknown blocks.
 */
export function contentBlockTypes(source: Source, json: unknown): string[] {
  if (!isObject(json)) return [];
  const types: string[] = [];
  if (source === "claude-code") {
    const content = isObject(json.message) ? json.message.content : undefined;
    types.push(...blockTypes(content));
    if (Array.isArray(content)) {
      for (const block of content) {
        if (isObject(block) && block.type === "tool_result") types.push(...blockTypes(block.content, "tool_result/"));
      }
    }
    if (isObject(json.attachment)) types.push(...blockTypes(json.attachment.prompt));
  } else {
    const payload = isObject(json.payload) ? json.payload : undefined;
    types.push(...blockTypes(payload?.content));
    types.push(...blockTypes(payload?.output, "output/"));
  }
  return [...new Set(types)].sort();
}

/** The parser's discriminator extended with the record's content block types, e.g. `assistant[text,tool_use]`. */
export function extendDiscriminator(source: Source, base: string, json: unknown): string {
  const types = contentBlockTypes(source, json);
  return types.length === 0 ? base : `${base}[${types.join(",")}]`;
}

/** Strips the block-type suffix added by `extendDiscriminator`. */
export function baseDiscriminator(discriminator: string): string {
  const bracket = discriminator.indexOf("[");
  return bracket < 0 ? discriminator : discriminator.slice(0, bracket);
}

export function fingerprint(source: Source, discriminator: string, json: unknown): string {
  return fingerprintOfPaths(source, discriminator, json === undefined ? [] : keyPaths(json));
}

/** The same hash as `fingerprint`, for a caller that already has the record's `keyPaths`. */
export function fingerprintOfPaths(source: Source, discriminator: string, paths: readonly string[]): string {
  return createHash("sha256").update([source, discriminator, ...paths].join("\n")).digest("hex");
}
