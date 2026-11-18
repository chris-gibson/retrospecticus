import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeSync,
  type FSWatcher,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  ConfigError,
  defaultConfig,
  parseConfig,
  parseJsonFile,
  readOptionalFile,
  resolveConfigPath,
  resolveSecretsPath,
  type ServerConfig,
  type ServerConfigInput,
} from "./config.ts";
import { createProvider } from "./embeddings/registry.ts";
import { buildNotifiers } from "./notifiers/registry.ts";
import { SECRET_NAMES, SecretsFileSchema, isSecretName, type SecretName, type SecretsFile } from "./secrets.ts";

/** Settings read only while the server starts; changing them in the file takes effect on the next start. */
export const RESTART_REQUIRED_KEYS = ["data_dir", "listen_host", "listen_port"] as const;
export type RestartRequiredKey = (typeof RESTART_REQUIRED_KEYS)[number];

export const CONFIG_FILE_MODE = 0o644;
export const SECRETS_FILE_MODE = 0o600;

/** `update` refused because the file on disk is no longer the version the caller edited. */
export class ConfigConflictError extends ConfigError {
  override name = "ConfigConflictError";
  constructor(
    readonly expectedVersion: string,
    readonly actualVersion: string,
  ) {
    super("The config file changed since it was read; reload it and apply the change again");
  }
}

export interface SecretStatus {
  set: boolean;
  updated_at: string | null;
}

export type ConfigListener = (next: ServerConfig, previous: ServerConfig) => void;

/** What the running parts of the server read settings and secrets through. */
export interface ConfigView {
  current(): ServerConfig;
  getSecret(name: SecretName): string | undefined;
  /** Called after the effective config changes; returns an unsubscribe function. */
  onChange(listener: ConfigListener): () => void;
}

export interface ConfigStore extends ConfigView {
  readonly configPath: string;
  readonly secretsPath: string;
  /** sha256 (hex) of the config file as last read from disk, valid or not; "" when there is no file. */
  version(): string;
  secretStatus(): Record<SecretName, SecretStatus>;
  /**
   * Validates `next`, refuses with ConfigConflictError when the file on disk
   * is not `expectedVersion`, then writes it atomically (keeping the previous
   * file as `<name>.bak`) and applies it. Returns the new version.
   */
  update(next: ServerConfigInput, expectedVersion: string): string;
  /** `null` removes the secret. Written atomically with mode 0600. */
  setSecret(name: SecretName, value: string | null): SecretStatus;
  /** Why the last read of either file failed, while the last good values stay in use; null when both are fine. */
  lastError(): string | null;
  /** A problem with the secrets file's permissions, e.g. readable by group or others; null when fine. */
  secretsPermissionProblem(): string | null;
  /** Restart-required keys whose value in the file differs from what the server started with. */
  pendingRestart(): RestartRequiredKey[];
  /** Re-reads both files now; the watcher calls this. */
  reload(): void;
  /** Starts following external edits to either file. */
  watch(): void;
  close(): void;
}

export interface ConfigStoreOptions {
  /** Defaults to $RETROSPECTICUS_CONFIG, then /etc/retrospecticus/config.json. */
  configPath?: string;
  /** Defaults to $RETROSPECTICUS_SECRETS, then secrets.json beside the config file. */
  secretsPath?: string;
  /** How long the watcher waits for a burst of file events to settle. Defaults to 200 ms. */
  debounceMs?: number;
  now?: () => Date;
  log?: { warn(message: string): void; error(message: string): void };
}

export const versionOf = (bytes: Buffer | string | null): string =>
  bytes === null ? "" : createHash("sha256").update(bytes).digest("hex");

/**
 * Checks what the schema cannot: that every notifier section is valid for
 * its adapter and that the embedding settings make a provider.
 */
export function validateConfig(config: ServerConfig): void {
  try {
    buildNotifiers(config.notifiers);
  } catch (err) {
    throw new ConfigError((err as Error).message);
  }
  try {
    createProvider(config.embedding);
  } catch (err) {
    throw new ConfigError(`Invalid embedding settings: ${(err as Error).message}`);
  }
}

function parseConfigBytes(bytes: Buffer | null, path: string): ServerConfig {
  if (bytes === null) return defaultConfig();
  const config = parseConfig(parseJsonFile(bytes, path, "Config file"), `config file ${path}`);
  validateConfig(config);
  return config;
}

function parseSecretsBytes(bytes: Buffer, path: string): SecretsFile {
  const result = SecretsFileSchema.safeParse(parseJsonFile(bytes, path, "Secrets file"));
  if (!result.success) throw new ConfigError(`Invalid secrets file ${path}:\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** Group or other permission bits on the secrets file, worded for a log line or doctor. */
export function secretsModeProblem(path: string, mode: number): string | null {
  if ((mode & 0o077) === 0) return null;
  return `secrets file ${path} has mode ${(mode & 0o777).toString(8).padStart(3, "0")}; it must not be readable by group or others (chmod 600)`;
}

/** Temp file in the same directory, fsync, rename: readers see the old file or the new one, never a torn one. */
export function writeFileAtomic(path: string, data: string | Buffer, mode: number): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const bytes = typeof data === "string" ? Buffer.from(data) : data;
  const fd = openSync(tmp, "wx", mode);
  try {
    fchmodSync(fd, mode);
    for (let off = 0; off < bytes.length; ) off += writeSync(fd, bytes, off);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  try {
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Some filesystems refuse to fsync a directory; the rename itself is still atomic.
  }
}

function statStamp(path: string): string | null {
  try {
    const st = statSync(path);
    return `${st.ino}:${st.size}:${st.mtimeMs}:${st.mode}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Opens the config and secrets files. Throws ConfigError when either exists
 * but is invalid, since there is no last good value to fall back on yet.
 */
export function openConfigStore(options: ConfigStoreOptions = {}): ConfigStore {
  const configPath = resolveConfigPath(options.configPath);
  const secretsPath = resolveSecretsPath(configPath, options.secretsPath);
  const debounceMs = options.debounceMs ?? 200;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? { warn: (m: string) => console.warn(m), error: (m: string) => console.error(m) };

  const initialBytes = readOptionalFile(configPath, "config file");
  let config = parseConfigBytes(initialBytes, configPath);
  let configVersion = versionOf(initialBytes);
  const started = config;
  let configError: string | null = null;
  let configReadFailed = false;

  let secrets: SecretsFile = {};
  let secretsStamp: string | null | undefined;
  let secretsError: string | null = null;
  let permissionProblem: string | null = null;

  const listeners = new Set<ConfigListener>();
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** Cheap when nothing changed: a stat, compared with the last one. */
  function refreshSecrets(initial = false): void {
    let stamp: string | null;
    try {
      stamp = statStamp(secretsPath);
    } catch (err) {
      secretsError = `Cannot read secrets file ${secretsPath}: ${(err as Error).message}`;
      return;
    }
    if (stamp === secretsStamp) return;
    secretsStamp = stamp;
    if (stamp === null) {
      secrets = {};
      secretsError = null;
      permissionProblem = null;
      return;
    }
    try {
      const st = statSync(secretsPath);
      const bytes = readOptionalFile(secretsPath, "secrets file");
      secrets = bytes === null ? {} : parseSecretsBytes(bytes, secretsPath);
      secretsError = null;
      const problem = secretsModeProblem(secretsPath, st.mode);
      if (problem !== null && problem !== permissionProblem) log.warn(`warning: ${problem}`);
      permissionProblem = problem;
    } catch (err) {
      if (initial) throw err;
      secretsError = (err as Error).message;
      log.error(`${secretsError}\nKeeping the secrets last read.`);
    }
  }

  function apply(next: ServerConfig): void {
    const previous = config;
    config = next;
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    for (const listener of listeners) {
      try {
        listener(next, previous);
      } catch (err) {
        log.error(`applying the changed config failed: ${(err as Error).message}`);
      }
    }
  }

  function reloadConfig(): void {
    let bytes: Buffer | null;
    try {
      bytes = readOptionalFile(configPath, "config file");
    } catch (err) {
      configError = (err as Error).message;
      configReadFailed = true;
      log.error(`${configError}\nKeeping the config last read.`);
      return;
    }
    const version = versionOf(bytes);
    if (version === configVersion && !configReadFailed) return;
    configVersion = version;
    configReadFailed = false;
    try {
      const next = parseConfigBytes(bytes, configPath);
      configError = null;
      apply(next);
    } catch (err) {
      configError = (err as Error).message;
      log.error(`${configError}\nKeeping the config last read.`);
    }
  }

  function reload(): void {
    reloadConfig();
    refreshSecrets();
  }

  refreshSecrets(true);

  return {
    configPath,
    secretsPath,
    current: () => config,
    version: () => configVersion,
    getSecret(name) {
      refreshSecrets();
      return secrets[name]?.value;
    },
    secretStatus() {
      refreshSecrets();
      return Object.fromEntries(
        SECRET_NAMES.map((name) => {
          const entry = secrets[name];
          return [name, { set: entry !== undefined, updated_at: entry?.updated_at ?? null }];
        }),
      ) as Record<SecretName, SecretStatus>;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    update(next, expectedVersion) {
      const parsed = parseConfig(next, "config");
      validateConfig(parsed);
      const onDisk = readOptionalFile(configPath, "config file");
      const actual = versionOf(onDisk);
      if (actual !== expectedVersion) throw new ConfigConflictError(expectedVersion, actual);
      const text = `${JSON.stringify(next, null, 2)}\n`;
      if (onDisk !== null) writeFileAtomic(`${configPath}.bak`, onDisk, CONFIG_FILE_MODE);
      writeFileAtomic(configPath, text, CONFIG_FILE_MODE);
      configVersion = versionOf(text);
      configError = null;
      apply(parsed);
      return configVersion;
    },
    setSecret(name, value) {
      if (!isSecretName(name)) throw new ConfigError(`Unknown secret "${name}"; expected one of ${SECRET_NAMES.join(", ")}`);
      if (value !== null && value === "") throw new ConfigError(`Secret ${name} cannot be empty`);
      refreshSecrets();
      // Rewriting from a stale copy would silently drop whatever made the file unreadable.
      if (secretsError !== null) throw new ConfigError(`${secretsError}\nFix or remove the file before changing secrets.`);
      const next: SecretsFile = { ...secrets };
      if (value === null) delete next[name];
      else next[name] = { value, updated_at: now().toISOString() };
      writeFileAtomic(secretsPath, `${JSON.stringify(next, null, 2)}\n`, SECRETS_FILE_MODE);
      secrets = next;
      secretsStamp = statStamp(secretsPath);
      permissionProblem = null;
      const entry = next[name];
      return { set: entry !== undefined, updated_at: entry?.updated_at ?? null };
    },
    lastError() {
      const errors = [configError, secretsError].filter((e): e is string => e !== null);
      return errors.length === 0 ? null : errors.join("\n");
    },
    secretsPermissionProblem() {
      refreshSecrets();
      return permissionProblem;
    },
    pendingRestart: () => RESTART_REQUIRED_KEYS.filter((key) => config[key] !== started[key]),
    reload,
    watch() {
      if (watchers.length > 0) return;
      const names = new Set([basename(configPath), basename(secretsPath)]);
      for (const dir of new Set([dirname(configPath), dirname(secretsPath)])) {
        try {
          watchers.push(
            watch(dir, { persistent: false }, (_event, filename) => {
              if (filename !== null && !names.has(filename)) return;
              clearTimeout(timer);
              timer = setTimeout(reload, debounceMs);
            }),
          );
        } catch (err) {
          log.warn(`warning: cannot watch ${dir} for config changes: ${(err as Error).message}`);
        }
      }
    },
    close() {
      clearTimeout(timer);
      for (const w of watchers.splice(0)) w.close();
    },
  };
}

/** A fixed config with in-memory secrets, for tests and callers that have no files. */
export function staticConfig(config: ServerConfig, secrets: Partial<Record<SecretName, string>> = {}): ConfigView {
  return {
    current: () => config,
    getSecret: (name) => secrets[name],
    onChange: () => () => {},
  };
}

export function isConfigView(value: ServerConfig | ConfigView): value is ConfigView {
  return typeof (value as ConfigView).current === "function";
}

export function toConfigView(value: ServerConfig | ConfigView): ConfigView {
  return isConfigView(value) ? value : staticConfig(value);
}
