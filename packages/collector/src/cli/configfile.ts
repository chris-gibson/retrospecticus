import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { DEFAULT_STATE_FILE } from "../config.ts";

export interface EnrolledSettings {
  server_url: string;
  machine: string;
  token_file: string;
  /** Left out when the user was not asked and gave no flag, so an existing choice survives re-enrolling. */
  remote_update?: boolean;
}

export function tildify(path: string, home: string): string {
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

const definedOnly = (settings: EnrolledSettings) => Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined));

const serialize = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Omits `sources` so the environment-aware defaults apply. */
export function renderConfig(settings: EnrolledSettings): string {
  return serialize({ ...definedOnly(settings), state_file: DEFAULT_STATE_FILE });
}

/** Throws when the text is not a JSON object. */
export function updateConfigText(text: string, settings: EnrolledSettings): { text: string; value: Record<string, unknown> } {
  const existing: unknown = JSON.parse(text);
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
    throw new Error("the config is not a JSON object");
  }
  const value = { ...existing, ...definedOnly(settings) } as Record<string, unknown>;
  return { text: serialize(value), value };
}

/** Sets one key, leaving the rest of the file as it was. Throws when the text is not a JSON object. */
export function setConfigKey(text: string, key: string, value: unknown): string {
  const existing: unknown = JSON.parse(text);
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
    throw new Error("the config is not a JSON object");
  }
  return serialize({ ...existing, [key]: value });
}

/** Temp file plus rename, so a crash never leaves a half-written config. */
export function writeConfigAtomic(path: string, content: string): void {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, content, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}
