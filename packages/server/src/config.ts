import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

export const DEFAULT_CONFIG_PATH = "/etc/retrospecticus/config.json";
export const CONFIG_ENV_VAR = "RETROSPECTICUS_CONFIG";
export const LISTEN_HOST_ENV_VAR = "RETROSPECTICUS_LISTEN_HOST";
export const SECRETS_ENV_VAR = "RETROSPECTICUS_SECRETS";
export const SECRETS_FILE_NAME = "secrets.json";

const IndexerSchema = z.strictObject({
  poll_seconds: z.number().positive().default(2),
  yield_min_lines: z.number().int().nonnegative().default(200),
  /** Chunk size for search; changing it re-chunks every session. */
  chunk_tokens: z.number().int().min(32).default(400),
  chunk_overlap_tokens: z.number().int().nonnegative().default(50),
}).refine((s) => s.chunk_overlap_tokens < s.chunk_tokens, {
  message: "chunk_overlap_tokens must be smaller than chunk_tokens",
  path: ["chunk_overlap_tokens"],
});

const EmbeddingSchema = z.strictObject({
  provider: z.string().min(1).default("none"),
  model: z.string().min(1).default("text-embedding-3-small"),
  /** The embeddings API root, e.g. http://127.0.0.1:11434/v1 for Ollama; each provider has its own default. */
  base_url: z.string().url().optional(),
  /** Override the model's built-in task prompts; "" turns one off. */
  query_prefix: z.string().optional(),
  document_prefix: z.string().optional(),
  /** Only needed for a model whose size the provider does not already know. */
  dimensions: z.number().int().positive().optional(),
});

const SearchSchema = z.strictObject({
  /** How much the keyword ranking counts in hybrid search, relative to the vector ranking. */
  keyword_weight: z.number().nonnegative().default(2),
  vector_weight: z.number().nonnegative().default(1),
});

const DownloadsSchema = z.strictObject({
  /** owner/name of the repository whose releases carry the collector executables. */
  github_repo: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "expected owner/name")
    .default("chris-gibson/retrospecticus"),
});

const AlertsSchema = z.strictObject({
  collector_silent_hours: z.number().positive().default(48),
  embedding_backlog_chunks: z.number().int().nonnegative().default(5000),
  digest_hour: z.number().int().min(0).max(23).default(8),
});

const IgnoredTypeSchema = z
  .string()
  .min(1)
  .refine((t) => !t.includes("["), "give the record type without a [block,types] suffix");

const DriftSchema = z.strictObject({
  /** Record types (parser discriminators, e.g. system/stop_hook_summary) that are bookkeeping and need no parser support. */
  ignore_types: z
    .strictObject({
      "claude-code": z.array(IgnoredTypeSchema).default([]),
      codex: z.array(IgnoredTypeSchema).default([]),
    })
    .prefault({}),
});

export const ServerConfigSchema = z.strictObject({
  data_dir: z.string().min(1).default("/var/lib/retrospecticus"),
  // Loopback rather than a wildcard, so the server never listens publicly by accident. A container image sets the
  // environment variable to listen on every interface, and its port mapping then decides what is reachable.
  listen_host: z
    .string()
    .min(1)
    .default(() => process.env[LISTEN_HOST_ENV_VAR] || "127.0.0.1"),
  listen_port: z.number().int().min(0).max(65535).default(7878),
  indexer: IndexerSchema.prefault({}),
  search: SearchSchema.prefault({}),
  downloads: DownloadsSchema.prefault({}),
  embedding: EmbeddingSchema.prefault({}),
  alerts: AlertsSchema.prefault({}),
  drift: DriftSchema.prefault({}),
  // Each notifier factory validates its own section, so nothing here knows which adapters exist.
  notifiers: z.record(z.string(), z.unknown()).default({}),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type ServerConfigInput = z.input<typeof ServerConfigSchema>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function parseConfig(value: unknown, origin = "config"): ServerConfig {
  const result = ServerConfigSchema.safeParse(value);
  if (!result.success) throw new ConfigError(`Invalid ${origin}:\n${z.prettifyError(result.error)}`);
  return result.data;
}

export function resolveConfigPath(path?: string): string {
  return path ?? process.env[CONFIG_ENV_VAR] ?? DEFAULT_CONFIG_PATH;
}

/** The secrets file sits beside the config file, never in the data dir, which gets backed up. */
export function resolveSecretsPath(configPath: string, path?: string): string {
  return path ?? process.env[SECRETS_ENV_VAR] ?? join(dirname(configPath), SECRETS_FILE_NAME);
}

/** Null when the file does not exist. */
export function readOptionalFile(path: string, what: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigError(`Cannot read ${what} ${path}: ${(err as Error).message}`);
  }
}

export function parseJsonFile(bytes: Buffer, path: string, what: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (err) {
    throw new ConfigError(`${what} ${path} is not valid JSON: ${(err as Error).message}`);
  }
}

/** A missing file means every default, so a fresh install starts without one. */
export function loadConfig(path?: string): ServerConfig {
  const resolved = resolveConfigPath(path);
  const bytes = readOptionalFile(resolved, "config file");
  if (bytes === null) return defaultConfig();
  return parseConfig(parseJsonFile(bytes, resolved, "Config file"), `config file ${resolved}`);
}

export function defaultConfig(overrides: ServerConfigInput = {}): ServerConfig {
  return parseConfig(overrides);
}

export function rawDir(config: Pick<ServerConfig, "data_dir">): string {
  return join(config.data_dir, "raw");
}

export function dbPath(config: Pick<ServerConfig, "data_dir">): string {
  return join(config.data_dir, "db", "retrospecticus.sqlite");
}
