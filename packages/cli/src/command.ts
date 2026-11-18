import { dbPath, type ServerConfig } from "@retrospecticus/server/config.ts";
import { openConfigStore, type ConfigStore } from "@retrospecticus/server/config-store.ts";
import { openDb, type Db } from "@retrospecticus/server/db/index.ts";

export interface CommandContext {
  /** Arguments after the command name. */
  args: string[];
  /** Value of the global `--config` option, if given. */
  configPath?: string;
  /** Standard input, for commands that read a value piped in (`secrets set`). Defaults to the process's. */
  stdin?: () => Promise<string>;
  out(line: string): void;
  err(line: string): void;
}

export interface Command {
  summary: string;
  usage: string;
  /** Resolves to the process exit code. */
  run(ctx: CommandContext): Promise<number>;
}

/** Thrown for mistakes in how a command was invoked; the dispatcher prints the message and the usage. */
export class UsageError extends Error {
  override name = "UsageError";
}

/** The config and secrets files; one-shot commands read them once and do not watch them. */
export function storeFor(ctx: CommandContext): ConfigStore {
  return openConfigStore({ configPath: ctx.configPath });
}

export function configFor(ctx: CommandContext): ServerConfig {
  return storeFor(ctx).current();
}

export async function withDb<T>(
  ctx: CommandContext,
  task: (db: Db, config: ServerConfig, store: ConfigStore) => T | Promise<T>,
): Promise<T> {
  const store = storeFor(ctx);
  const config = store.current();
  const db = openDb(dbPath(config));
  try {
    return await task(db, config, store);
  } finally {
    db.close();
  }
}
