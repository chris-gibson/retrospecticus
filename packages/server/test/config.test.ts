import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_ENV_VAR,
  ConfigError,
  SECRETS_ENV_VAR,
  dbPath,
  defaultConfig,
  loadConfig,
  rawDir,
  resolveSecretsPath,
} from "../src/config.ts";

let dir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "retrospecticus-config-"));
  savedEnv = process.env[CONFIG_ENV_VAR];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[CONFIG_ENV_VAR];
  else process.env[CONFIG_ENV_VAR] = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

function write(value: unknown): string {
  const path = join(dir, "config.json");
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}

const FULL = {
  data_dir: "/srv/retro",
  listen_host: "100.64.0.7",
  listen_port: 9000,
  indexer: { poll_seconds: 5, yield_min_lines: 50 },
  embedding: { provider: "openai", model: "text-embedding-3-small" },
  alerts: { collector_silent_hours: 24, embedding_backlog_chunks: 100, digest_hour: 7 },
  notifiers: { discord: {}, email: { from: "a@example.com", to: ["owner@example.com"] } },
};

test("loads the full documented shape", () => {
  expect(loadConfig(write(FULL))).toEqual({
    data_dir: "/srv/retro",
    listen_host: "100.64.0.7",
    listen_port: 9000,
    indexer: { poll_seconds: 5, yield_min_lines: 50, chunk_tokens: 400, chunk_overlap_tokens: 50 },
    search: { keyword_weight: 2, vector_weight: 1 },
    downloads: { github_repo: "chris-gibson/retrospecticus" },
    embedding: { provider: "openai", model: "text-embedding-3-small" },
    alerts: { collector_silent_hours: 24, embedding_backlog_chunks: 100, digest_hour: 7 },
    drift: { ignore_types: { "claude-code": [], codex: [] } },
    notifiers: { discord: {}, email: { from: "a@example.com", to: ["owner@example.com"] } },
  });
});

test("fills defaults, including inside a partly given section", () => {
  const config = loadConfig(write({ data_dir: "/srv/retro", alerts: { digest_hour: 6 } }));
  expect(config).toEqual({
    data_dir: "/srv/retro",
    listen_host: "127.0.0.1",
    listen_port: 7878,
    indexer: { poll_seconds: 2, yield_min_lines: 200, chunk_tokens: 400, chunk_overlap_tokens: 50 },
    search: { keyword_weight: 2, vector_weight: 1 },
    downloads: { github_repo: "chris-gibson/retrospecticus" },
    embedding: { provider: "none", model: "text-embedding-3-small" },
    alerts: { collector_silent_hours: 48, embedding_backlog_chunks: 5000, digest_hour: 6 },
    drift: { ignore_types: { "claude-code": [], codex: [] } },
    notifiers: {},
  });
});

test("drift.ignore_types takes bare record types only", () => {
  const ok = loadConfig(write({ drift: { ignore_types: { codex: ["response_item/hologram"] } } }));
  expect(ok.drift.ignore_types).toEqual({ "claude-code": [], codex: ["response_item/hologram"] });
  expect(() => loadConfig(write({ drift: { ignore_types: { codex: ["assistant[text]"] } } }))).toThrow(ConfigError);
  expect(() => loadConfig(write({ drift: { ignore_types: { codex: [""] } } }))).toThrow(ConfigError);
});

test("defaultConfig applies overrides over the defaults", () => {
  const config = defaultConfig({ data_dir: "/tmp/x", listen_port: 0, embedding: { provider: "fake" } });
  expect(config.listen_port).toBe(0);
  expect(config.embedding).toEqual({ provider: "fake", model: "text-embedding-3-small" });
  expect(config.indexer.poll_seconds).toBe(2);
  expect(rawDir(config)).toBe("/tmp/x/raw");
  expect(dbPath(config)).toBe("/tmp/x/db/retrospecticus.sqlite");
});

test.each([
  ["a wrong type", { listen_port: "7878" }],
  ["an out-of-range port", { listen_port: 70000 }],
  ["an out-of-range digest hour", { alerts: { digest_hour: 24 } }],
  ["a misspelt top-level key", { listen_hots: "127.0.0.1" }],
  ["a misspelt section key", { indexer: { poll_second: 2 } }],
  ["a notifier section that is not an object", { notifiers: 3 }],
  ["broken JSON", '{ "data_dir": '],
  ["an overlap as large as the chunk", { indexer: { chunk_tokens: 100, chunk_overlap_tokens: 100 } }],
  ["a negative search weight", { search: { keyword_weight: -1 } }],
  ["the removed api_key_file setting", { embedding: { api_key_file: "/x" } }],
])("rejects %s", (_name, value) => {
  expect(() => loadConfig(write(value))).toThrow(ConfigError);
});

test("a missing file means every default", () => {
  expect(loadConfig(join(dir, "nope.json"))).toEqual(defaultConfig());
});

test("an unreadable path is a ConfigError that names it", () => {
  expect(() => loadConfig(dir)).toThrow(dir);
  expect(() => loadConfig(dir)).toThrow(ConfigError);
});

test("falls back to $RETROSPECTICUS_CONFIG when no path is given", () => {
  process.env[CONFIG_ENV_VAR] = write({ listen_port: 1234 });
  expect(loadConfig().listen_port).toBe(1234);
});

test("the secrets file sits beside the config unless $RETROSPECTICUS_SECRETS says otherwise", () => {
  const saved = process.env[SECRETS_ENV_VAR];
  try {
    delete process.env[SECRETS_ENV_VAR];
    expect(resolveSecretsPath("/etc/retrospecticus/config.json")).toBe("/etc/retrospecticus/secrets.json");
    process.env[SECRETS_ENV_VAR] = "/run/secrets.json";
    expect(resolveSecretsPath("/etc/retrospecticus/config.json")).toBe("/run/secrets.json");
  } finally {
    if (saved === undefined) delete process.env[SECRETS_ENV_VAR];
    else process.env[SECRETS_ENV_VAR] = saved;
  }
});
