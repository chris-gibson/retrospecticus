import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { MACHINE_NAME_PATTERN, MAX_APPEND_BODY_BYTES, SourceSchema, type Source } from "@retrospecticus/shared";

export const CONFIG_ENV_VAR = "RETROSPECTICUS_COLLECTOR_CONFIG";
export const DEFAULT_CONFIG_PATH = "~/.config/retrospecticus/collector.json";
export const DEFAULT_STATE_FILE = "~/.local/state/retrospecticus/collector-state.json";
export const DEFAULT_GLOB = "**/*.jsonl";

const SourceConfigSchema = z.strictObject({
  name: SourceSchema,
  root: z.string().min(1),
  glob: z.string().min(1).default(DEFAULT_GLOB),
});

export const DEFAULT_STATUS_PORT = 7879;

/** There is deliberately no host option: the status page only ever listens on loopback. */
const StatusPageSchema = z.strictObject({
  enabled: z.boolean().default(true),
  port: z.number().int().min(0).max(65535).default(DEFAULT_STATUS_PORT),
});

const CollectorConfigSchema = z.strictObject({
  server_url: z.url({ protocol: /^https?$/ }),
  token_file: z.string().min(1),
  machine: z.string().regex(MACHINE_NAME_PATTERN),
  poll_seconds: z.number().positive().default(30),
  state_file: z.string().min(1).default(DEFAULT_STATE_FILE),
  watch: z.boolean().default(true),
  watch_debounce_ms: z.number().nonnegative().default(500),
  backoff_min_ms: z.number().positive().default(1000),
  backoff_max_ms: z.number().positive().default(5 * 60 * 1000),
  heartbeat_seconds: z.number().positive().default(5 * 60),
  request_timeout_seconds: z.number().positive().default(120),
  max_body_bytes: z.number().int().positive().max(MAX_APPEND_BODY_BYTES).default(MAX_APPEND_BODY_BYTES),
  status_page: StatusPageSchema.prefault({}),
  /** Lets the server tell this collector to replace itself with the server's version. Off unless chosen. */
  remote_update: z.boolean().default(false),
  sources: z.array(SourceConfigSchema).min(1).optional(),
});

export interface SourceConfig {
  name: Source;
  /** Absolute. */
  root: string;
  glob: string;
}

export interface CollectorConfig {
  /** Without a trailing slash. */
  server_url: string;
  token_file: string;
  machine: string;
  poll_seconds: number;
  state_file: string;
  /** False turns the filesystem watcher off and leaves polling alone. */
  watch: boolean;
  watch_debounce_ms: number;
  backoff_min_ms: number;
  backoff_max_ms: number;
  heartbeat_seconds: number;
  request_timeout_seconds: number;
  max_body_bytes: number;
  status_page: { enabled: boolean; port: number };
  remote_update: boolean;
  sources: SourceConfig[];
}

export type CollectorConfigInput = z.input<typeof CollectorConfigSchema>;

export class CollectorConfigError extends Error {
  override name = "CollectorConfigError";
}

export interface ConfigEnvironment {
  env?: Record<string, string | undefined>;
  home?: string;
}

export function expandHome(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/** `${VAR:-fallback}` semantics: an empty variable counts as unset. */
function envOr(env: Record<string, string | undefined>, name: string, fallback: string): string {
  const value = env[name];
  return value !== undefined && value !== "" ? value : fallback;
}

export function defaultSources(environment: ConfigEnvironment = {}): SourceConfig[] {
  const env = environment.env ?? process.env;
  const home = environment.home ?? homedir();
  return [
    {
      name: "claude-code",
      root: resolve(expandHome(envOr(env, "CLAUDE_CONFIG_DIR", "~/.claude"), home), "projects"),
      glob: DEFAULT_GLOB,
    },
    {
      name: "codex",
      root: resolve(expandHome(envOr(env, "CODEX_HOME", "~/.codex"), home), "sessions"),
      glob: DEFAULT_GLOB,
    },
  ];
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function parseCollectorConfig(
  value: unknown,
  origin = "config",
  environment: ConfigEnvironment = {},
): CollectorConfig {
  const result = CollectorConfigSchema.safeParse(value);
  if (!result.success) throw new CollectorConfigError(`Invalid ${origin}:\n${z.prettifyError(result.error)}`);
  const parsed = result.data;
  const home = environment.home ?? homedir();
  const fail = (message: string): never => {
    throw new CollectorConfigError(`Invalid ${origin}: ${message}`);
  };

  const absolute = (key: string, path: string): string => {
    const expanded = expandHome(path, home);
    if (!isAbsolute(expanded)) fail(`${key} must be an absolute path or start with ~/ (got ${JSON.stringify(path)})`);
    return resolve(expanded);
  };

  const sources: SourceConfig[] = parsed.sources
    ? parsed.sources.map((source, i) => ({ ...source, root: absolute(`sources[${i}].root`, source.root) }))
    : defaultSources(environment);

  const names = new Set<string>();
  for (const source of sources) {
    if (names.has(source.name)) fail(`source ${source.name} is listed more than once`);
    names.add(source.name);
  }

  const stateFile = absolute("state_file", parsed.state_file);
  // The collector must never write under a source root, and the state file is the one thing it writes.
  for (const source of sources) {
    if (isInside(source.root, stateFile)) fail(`state_file must not be inside the source root ${source.root}`);
  }
  if (parsed.backoff_max_ms < parsed.backoff_min_ms) fail("backoff_max_ms is below backoff_min_ms");

  return {
    ...parsed,
    server_url: parsed.server_url.replace(/\/+$/, ""),
    token_file: absolute("token_file", parsed.token_file),
    state_file: stateFile,
    sources,
  };
}

export function resolveCollectorConfigPath(path?: string, environment: ConfigEnvironment = {}): string {
  const env = environment.env ?? process.env;
  return resolve(expandHome(path ?? envOr(env, CONFIG_ENV_VAR, DEFAULT_CONFIG_PATH), environment.home ?? homedir()));
}

export function loadCollectorConfig(path?: string, environment: ConfigEnvironment = {}): CollectorConfig {
  const resolved = resolveCollectorConfigPath(path, environment);
  let text: string;
  try {
    text = readFileSync(resolved, "utf8");
  } catch (err) {
    throw new CollectorConfigError(`Cannot read config file ${resolved}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new CollectorConfigError(`Config file ${resolved} is not valid JSON: ${(err as Error).message}`);
  }
  return parseCollectorConfig(parsed, `config file ${resolved}`, environment);
}

export function readToken(config: Pick<CollectorConfig, "token_file">): string {
  let token: string;
  try {
    token = readFileSync(config.token_file, "utf8").trim();
  } catch (err) {
    throw new CollectorConfigError(`Cannot read token file ${config.token_file}: ${(err as Error).message}`);
  }
  if (token === "" || /\s/.test(token)) {
    throw new CollectorConfigError(`Token file ${config.token_file} does not hold a single token`);
  }
  return token;
}
