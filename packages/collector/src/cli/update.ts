import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { HEADER_MACHINE, TOKEN_WHOAMI_PATH, compareVersions } from "@retrospecticus/shared";
import { loadCollectorConfig, resolveCollectorConfigPath, type CollectorConfig } from "../config.ts";
import { COLLECTOR_VERSION } from "../heartbeat.ts";
import { CliError, timeoutSignal, type CliEnv } from "./env.ts";
import { restartInstalledService, servicePaths } from "./service.ts";

const REQUEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export interface UpdateOptions {
  config?: string;
  /** Skip the download: the binary is already in place (install.sh just put it there). */
  restartOnly: boolean;
  /** Install the server's version even when this collector is newer. */
  force?: boolean;
}

function loadConfig(env: CliEnv, configPath: string): CollectorConfig {
  try {
    return loadCollectorConfig(configPath, { env: env.env, home: env.home });
  } catch (err) {
    throw new CliError(`${(err as Error).message} (run \`retrospecticus-collector enroll\` first)`);
  }
}

async function get(env: CliEnv, url: string, timeoutMs: number): Promise<Response> {
  let res: Response;
  try {
    res = await env.fetch(url, { signal: timeoutSignal(env, timeoutMs) });
  } catch (err) {
    if (env.signal.aborted) throw err;
    throw new CliError(`Cannot reach ${url}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new CliError(`${url} answered HTTP ${res.status}`);
  return res;
}

function checksumFor(sums: string, name: string): string | undefined {
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (match && match[2] === name) return match[1];
  }
  return undefined;
}

async function restart(env: CliEnv): Promise<void> {
  if (await restartInstalledService(env)) env.out("Restarted the service.");
  else env.out("No service is installed; restart the collector yourself if it is running.");
}

export async function update(env: CliEnv, options: UpdateOptions): Promise<number> {
  const configPath = resolveCollectorConfigPath(options.config, { env: env.env, home: env.home });
  const config = loadConfig(env, configPath);

  if (options.restartOnly) {
    try {
      await restart(env);
    } catch (err) {
      if (env.signal.aborted) throw err;
      throw new CliError(`Restarting the service failed: ${(err as Error).message.split("\n")[0]}. Run \`retrospecticus-collector install\` to start it again.`);
    }
    return 0;
  }
  if (!env.isCompiled) {
    throw new CliError("Running from source, so there is no binary to replace. Update the checkout instead (git pull, bun install).");
  }

  const health = (await (await get(env, `${config.server_url}/healthz`, REQUEST_TIMEOUT_MS)).json().catch(() => null)) as {
    version?: unknown;
  } | null;
  const latest = typeof health?.version === "string" ? health.version : null;
  if (!latest) throw new CliError(`${config.server_url} did not report its version; is it a Retrospecticus server?`);
  const order = compareVersions(COLLECTOR_VERSION, latest);
  if (order === 0) {
    env.out(`Already up to date (${COLLECTOR_VERSION}).`);
    return 0;
  }
  if (order !== null && order > 0 && !options.force) {
    env.out(`This collector (${COLLECTOR_VERSION}) is newer than the server (${latest}); nothing to do. --force installs the server's version.`);
    return 0;
  }

  const platform = `${env.platform}-${env.arch}`;
  if (!["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"].includes(platform)) {
    throw new CliError(`No collector is published for ${platform}.`);
  }
  const name = `retrospecticus-collector-${platform}`;
  env.out(`Updating ${COLLECTOR_VERSION} -> ${latest} from ${config.server_url}`);
  const sums = await (await get(env, `${config.server_url}/downloads/SHA256SUMS`, REQUEST_TIMEOUT_MS)).text();
  const expected = checksumFor(sums, name);
  if (!expected) throw new CliError(`The server's SHA256SUMS does not list ${name}; not installing.`);
  const bytes = new Uint8Array(await (await get(env, `${config.server_url}/downloads/collector/${platform}`, DOWNLOAD_TIMEOUT_MS)).arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== expected) {
    throw new CliError(`Checksum mismatch for ${name}; not installing.`);
  }

  const target = servicePaths(env.home).binary;
  mkdirSync(dirname(target), { recursive: true });
  // Renaming over the target works even while the old binary is running.
  const staging = `${target}.new`;
  // Kept until the service has restarted on the new binary, so a failed restart leaves the old version installed
  // and a later `update` tries again instead of reporting "already up to date".
  const previous = `${target}.prev`;
  const hadPrevious = existsSync(target);
  try {
    writeFileSync(staging, bytes);
    chmodSync(staging, 0o755);
    if (hadPrevious) copyFileSync(target, previous);
    renameSync(staging, target);
  } finally {
    rmSync(staging, { force: true });
  }
  env.out(`Installed ${target}`);
  try {
    await restart(env);
  } catch (err) {
    if (env.signal.aborted) throw err;
    if (hadPrevious) renameSync(previous, target);
    else rmSync(target, { force: true });
    throw new CliError(
      `Restarting the service failed, so the previous binary was put back: ${(err as Error).message.split("\n")[0]}. Fix that and run \`retrospecticus-collector update\` again.`,
    );
  }
  rmSync(previous, { force: true });
  return 0;
}

export const ENROLLED = 0;
export const NOT_ENROLLED = 1;
/** Distinct from usage errors (2), so install.sh never mistakes "could not tell" for "not enrolled" and enrolls twice. */
export const ENROLLMENT_UNKNOWN = 3;

function sameServer(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname.replace(/\/+$/, "") === y.pathname.replace(/\/+$/, "");
  } catch {
    return false;
  }
}

/** Quiet by design: the answer is the exit code, for install.sh. */
export async function enrolledWith(env: CliEnv, configOption: string | undefined, server: string): Promise<number> {
  const configPath = resolveCollectorConfigPath(configOption, { env: env.env, home: env.home });
  if (!existsSync(configPath)) return NOT_ENROLLED;
  let config: CollectorConfig;
  let token: string;
  try {
    config = loadCollectorConfig(configPath, { env: env.env, home: env.home });
    if (!sameServer(config.server_url, server)) return NOT_ENROLLED;
    if (!existsSync(config.token_file)) return NOT_ENROLLED;
    token = readFileSync(config.token_file, "utf8").trim();
  } catch {
    return ENROLLMENT_UNKNOWN;
  }
  try {
    const res = await env.fetch(config.server_url + TOKEN_WHOAMI_PATH, {
      headers: { Authorization: `Bearer ${token}`, [HEADER_MACHINE]: config.machine },
      signal: timeoutSignal(env, REQUEST_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) return NOT_ENROLLED;
    if (!res.ok) return ENROLLMENT_UNKNOWN;
    // A proxy's fallback page can answer 200 too; only the server's own answer naming this machine counts.
    const body = (await res.json().catch(() => null)) as { machine?: unknown } | null;
    return body?.machine === config.machine ? ENROLLED : ENROLLMENT_UNKNOWN;
  } catch {
    return ENROLLMENT_UNKNOWN;
  }
}
