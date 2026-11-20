import { randomUUID } from "node:crypto";
import { accessSync, constants, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  dbPath,
  parseConfig,
  parseJsonFile,
  rawDir,
  readOptionalFile,
  resolveConfigPath,
  resolveSecretsPath,
  type ServerConfig,
} from "@retrospecticus/server/config.ts";
import { secretsModeProblem, validateConfig } from "@retrospecticus/server/config-store.ts";
import { SecretsFileSchema, type SecretName, type SecretsFile } from "@retrospecticus/server/secrets.ts";
import { countQuarantine, countOpenDriftEvents, isBaselineLearned } from "@retrospecticus/server/db/drift.ts";
import { listFiles } from "@retrospecticus/server/db/files.ts";
import { openDb, type Db } from "@retrospecticus/server/db/index.ts";
import { listMachines } from "@retrospecticus/server/db/machines.ts";
import { embeddingStatus, parseBacklogBytes, sqliteCapabilities } from "@retrospecticus/server/db/status.ts";
import { archiveTarget, archivedSize } from "@retrospecticus/server/ingest/archive.ts";
import { buildNotifiers } from "@retrospecticus/server/notifiers/registry.ts";
import { UsageError, type Command, type CommandContext } from "../command.ts";

type Level = "ok" | "warn" | "FAIL";

interface Check {
  level: Level;
  message: string;
}

const ok = (message: string): Check => ({ level: "ok", message });
const warn = (message: string): Check => ({ level: "warn", message });
const fail = (message: string): Check => ({ level: "FAIL", message });

const HOUR_MS = 3_600_000;
const MAX_MISMATCHES_LISTED = 5;

function checkConfigFile(path: string): { check: Check; config: ServerConfig | null } {
  try {
    const bytes = readOptionalFile(path, "config file");
    if (bytes === null) return { check: warn(`config file ${path} does not exist; using every default`), config: parseConfig({}) };
    const config = parseConfig(parseJsonFile(bytes, path, "Config file"), `config file ${path}`);
    validateConfig(config);
    return { check: ok(`config file ${path} loaded`), config };
  } catch (err) {
    return { check: fail((err as Error).message), config: null };
  }
}

function checkSecretsFile(path: string): { checks: Check[]; secrets: SecretsFile } {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { checks: [ok(`no secrets file at ${path}; no secrets set`)], secrets: {} };
    return { checks: [fail(`cannot read secrets file ${path}: ${(err as Error).message}`)], secrets: {} };
  }
  const checks: Check[] = [];
  let secrets: SecretsFile = {};
  try {
    const result = SecretsFileSchema.safeParse(parseJsonFile(readOptionalFile(path, "secrets file") ?? Buffer.from("{}"), path, "Secrets file"));
    if (result.success) {
      secrets = result.data;
      checks.push(ok(`secrets file ${path} loaded`));
    } else {
      checks.push(fail(`secrets file ${path} is invalid: ${result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`));
    }
  } catch (err) {
    checks.push(fail((err as Error).message));
  }
  const problem = secretsModeProblem(path, mode);
  checks.push(problem === null ? ok(`secrets file mode is ${(mode & 0o777).toString(8)}`) : fail(problem));
  return { checks, secrets };
}

/** The admin UI rewrites the config and secrets files in place, so their directory must be writable. */
function checkConfigDir(configPath: string): Check {
  const dir = dirname(configPath);
  try {
    accessSync(dir, constants.W_OK);
    return ok(`config directory ${dir} is writable`);
  } catch (err) {
    return warn(`config directory ${dir} is not writable by this user (${(err as NodeJS.ErrnoException).code}); settings cannot be saved from the admin UI`);
  }
}

/** A missing secret is not fatal at startup, only when the feature is used, so it is a warning. */
function checkNeededSecrets(config: ServerConfig, secrets: SecretsFile): Check[] {
  const needed: [SecretName, string][] = [];
  if (config.embedding.provider === "openai") needed.push(["embedding_api_key", "embedding.provider \"openai\""]);
  if (config.embedding.provider === "omlx") needed.push(["omlx_api_key", "embedding.provider \"omlx\""]);
  if ("discord" in config.notifiers) needed.push(["discord_webhook_url", "notifiers.discord"]);
  if ("email" in config.notifiers) needed.push(["smtp_url", "notifiers.email"]);
  return needed.map(([name, what]) =>
    secrets[name] ? ok(`${what} has its secret ${name}`) : warn(`${what} needs the secret ${name}; run \`retrospecticus secrets set ${name}\``),
  );
}

function checkDataDir(config: ServerConfig): Check {
  const probe = join(config.data_dir, `.doctor-${randomUUID()}`);
  try {
    mkdirSync(config.data_dir, { recursive: true });
    writeFileSync(probe, "");
    rmSync(probe);
    return ok(`data_dir ${config.data_dir} exists and is writable`);
  } catch (err) {
    return fail(`data_dir ${config.data_dir} is not usable: ${(err as Error).message}`);
  }
}

function checkSqlite(db: Db): Check {
  const caps = sqliteCapabilities(db);
  const missing = [caps.fts5 ? null : "FTS5", caps.vec_version ? null : "sqlite-vec"].filter((m) => m !== null);
  if (missing.length > 0) return fail(`SQLite is missing ${missing.join(" and ")}`);
  return ok(`SQLite has FTS5 and sqlite-vec ${caps.vec_version}`);
}

async function checkArchive(db: Db, config: ServerConfig): Promise<Check> {
  const root = rawDir(config);
  const files = listFiles(db);
  const mismatches: string[] = [];
  let total = 0;
  for (const file of files) {
    let actual: number;
    try {
      actual = await archivedSize(archiveTarget(root, file));
    } catch (err) {
      total++;
      if (mismatches.length < MAX_MISMATCHES_LISTED) {
        mismatches.push(`${file.machine}/${file.source}/${file.path}: ${(err as Error).message}`);
      }
      continue;
    }
    if (actual === file.size) continue;
    total++;
    if (mismatches.length < MAX_MISMATCHES_LISTED) {
      mismatches.push(`${file.machine}/${file.source}/${file.path} (generation ${file.generation}): row ${file.size} bytes, archive ${actual} bytes`);
    }
  }
  if (total === 0) return ok(`archive sizes match ${files.length} files rows`);
  const more = total > mismatches.length ? ` (and ${total - mismatches.length} more)` : "";
  return fail(`${total} archive size mismatches: ${mismatches.join("; ")}${more}`);
}

function checkParseBacklog(db: Db): Check {
  const bytes = parseBacklogBytes(db);
  return bytes === 0 ? ok("parse backlog is empty") : warn(`parse backlog is ${bytes} bytes`);
}

function checkEmbeddings(db: Db): Check {
  const status = embeddingStatus(db);
  if (status.active_model === null) return ok("embeddings disabled");
  if (status.backlog === 0) return ok(`embedding backlog is empty (${status.active_model})`);
  return warn(`${status.backlog} chunks await embedding (${status.active_model})`);
}

function checkDrift(db: Db): Check {
  const recall = countOpenDriftEvents(db, ["breaking", "yield"]);
  if (recall > 0) return fail(`${recall} open breaking or yield drift events; see \`drift list\``);
  const other = countOpenDriftEvents(db);
  if (other > 0) return warn(`${other} open additive or version drift events`);
  return ok("no open drift events");
}

function checkBaseline(db: Db): Check {
  if (isBaselineLearned(db)) return ok("drift baseline learned");
  return warn("drift baseline not learned; run `retrospecticus shapes learn` once the first history is indexed");
}

function checkQuarantine(db: Db): Check {
  const n = countQuarantine(db);
  return n === 0 ? ok("quarantine is empty") : warn(`${n} quarantined lines`);
}

function checkMachines(db: Db, config: ServerConfig, now: number): Check[] {
  const machines = listMachines(db);
  if (machines.length === 0) return [ok("no machines enrolled yet")];
  const limit = config.alerts.collector_silent_hours;
  return machines.map((m) => {
    const times = [m.last_heartbeat_at, m.last_ingest_at]
      .filter((t): t is string => t !== null)
      .map((t) => Date.parse(t))
      .filter((t) => !Number.isNaN(t));
    if (times.length === 0) return warn(`${m.machine}: no heartbeat or ingest yet`);
    const hours = (now - Math.max(...times)) / HOUR_MS;
    const label = `${m.machine}: last seen ${Math.floor(hours)} hours ago`;
    return hours > limit ? warn(`${label} (threshold ${limit})`) : ok(label);
  });
}

function checkNotifiers(config: ServerConfig): Check {
  try {
    const built = buildNotifiers(config.notifiers);
    return ok(`notifier config valid (${built.map((n) => n.name).join(", ")})`);
  } catch (err) {
    return fail((err as Error).message);
  }
}

async function run(ctx: CommandContext): Promise<number> {
  if (ctx.args.length > 0) throw new UsageError(`Unexpected argument: ${ctx.args[0]}`);
  const configPath = resolveConfigPath(ctx.configPath);
  const secretsPath = resolveSecretsPath(configPath);
  const loaded = checkConfigFile(configPath);
  const secretsFile = checkSecretsFile(secretsPath);
  const checks: Check[] = [loaded.check, ...secretsFile.checks, checkConfigDir(configPath)];
  const config = loaded.config;
  if (config === null) {
    report(ctx, checks);
    return 1;
  }
  checks.push(...checkNeededSecrets(config, secretsFile.secrets));
  const dataDir = checkDataDir(config);
  checks.push(dataDir);

  if (dataDir.level === "FAIL") {
    checks.push(checkNotifiers(config));
  } else {
    const db = openDb(dbPath(config));
    try {
      checks.push(
        checkSqlite(db),
        await checkArchive(db, config),
        checkParseBacklog(db),
        checkEmbeddings(db),
        checkDrift(db),
        checkBaseline(db),
        checkQuarantine(db),
        ...checkMachines(db, config, Date.now()),
        checkNotifiers(config),
      );
    } finally {
      db.close();
    }
  }

  report(ctx, checks);
  return checks.some((c) => c.level === "FAIL") ? 1 : 0;
}

function report(ctx: CommandContext, checks: Check[]): void {
  for (const check of checks) ctx.out(`${check.level.padEnd(4)} ${check.message}`);
}

const command: Command = {
  summary: "Check the installation and report problems",
  usage: "Usage: retrospecticus doctor",
  run,
};

export default command;
