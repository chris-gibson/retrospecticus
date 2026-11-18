import { isPlainKey } from "./fingerprint.ts";

/**
 * The record's structure with every string replaced by its length, so a
 * drift sample can be shown to an agent or pasted into an issue without
 * carrying transcript content. Keys that are data rather than schema become
 * `key_N`, the same convention the fixture scrubber uses.
 */
export function scrubSample(json: unknown): unknown {
  if (typeof json === "string") return `<str:${json.length}>`;
  if (Array.isArray(json)) return json.map(scrubSample);
  if (json !== null && typeof json === "object") {
    const out: Record<string, unknown> = {};
    let renamed = 0;
    for (const [key, value] of Object.entries(json)) {
      out[isPlainKey(key) ? key : `key_${renamed++}`] = scrubSample(value);
    }
    return out;
  }
  if (typeof json === "number" || typeof json === "boolean" || json === null) return json;
  return null;
}
