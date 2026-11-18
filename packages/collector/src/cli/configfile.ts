import { DEFAULT_STATE_FILE } from "../config.ts";

export interface EnrolledSettings {
  server_url: string;
  machine: string;
  token_file: string;
}

export function tildify(path: string, home: string): string {
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

const serialize = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Omits `sources` so the environment-aware defaults apply. */
export function renderConfig(settings: EnrolledSettings): string {
  return serialize({ ...settings, state_file: DEFAULT_STATE_FILE });
}

/** Throws when the text is not a JSON object. */
export function updateConfigText(text: string, settings: EnrolledSettings): { text: string; value: Record<string, unknown> } {
  const existing: unknown = JSON.parse(text);
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
    throw new Error("the config is not a JSON object");
  }
  const value = { ...existing, ...settings } as Record<string, unknown>;
  return { text: serialize(value), value };
}
