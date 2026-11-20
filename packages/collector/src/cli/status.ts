import { existsSync } from "node:fs";
import { compareVersions } from "@retrospecticus/shared";
import { loadCollectorConfig, resolveCollectorConfigPath, type CollectorConfig } from "../config.ts";
import { humanBytes, humanDuration } from "../status-page.ts";
import type { StatusSnapshot } from "../status-page.ts";
import { COLLECTOR_VERSION } from "../heartbeat.ts";
import { timeoutSignal, type CliEnv } from "./env.ts";
import { LAUNCHD_LABEL, SERVICE_NAME, servicePaths } from "./service.ts";

async function serviceState(env: CliEnv): Promise<string> {
  const paths = servicePaths(env.home);
  if (env.platform === "linux") {
    if (!existsSync(paths.unit)) return `not installed (no ${paths.unit})`;
    const result = await env.run(["systemctl", "--user", "is-active", SERVICE_NAME]);
    return `${result.stdout.trim() || "unknown"} (${paths.unit})`;
  }
  if (env.platform === "darwin") {
    if (!existsSync(paths.plist)) return `not installed (no ${paths.plist})`;
    const result = await env.run(["launchctl", "print", `gui/${env.uid}/${LAUNCHD_LABEL}`]);
    const state = /^\s*state = (\w+)/m.exec(result.stdout)?.[1];
    return `${result.code === 0 ? (state ?? "loaded") : "not loaded"} (${paths.plist})`;
  }
  return `unsupported on ${env.platform}`;
}

export async function status(env: CliEnv, configOption: string | undefined): Promise<number> {
  const configPath = resolveCollectorConfigPath(configOption, { env: env.env, home: env.home });
  env.out(`Config:  ${configPath}`);
  env.out(`Service: ${await serviceState(env)}`);

  let config;
  try {
    config = loadCollectorConfig(configPath, { env: env.env, home: env.home });
  } catch (err) {
    env.out(`Config problem: ${(err as Error).message.split("\n")[0]}`);
    return 1;
  }
  env.out(`Server:  ${config.server_url}`);
  env.out(`Machine: ${config.machine}`);
  env.out(`Token:   ${config.token_file} (${existsSync(config.token_file) ? "present" : "missing"})`);
  try {
    const res = await env.fetch(`${config.server_url}/healthz`, { signal: timeoutSignal(env, 5000) });
    env.out(`Reachable: ${res.ok ? "yes" : `no, HTTP ${res.status}`}`);
  } catch (err) {
    env.out(`Reachable: no (${(err as Error).message})`);
  }
  await statusPage(env, config);
  return 0;
}

export type DaemonProbe =
  | { kind: "ok"; snapshot: StatusSnapshot }
  | { kind: "off" }
  | { kind: "silent" }
  | { kind: "other"; machine: string };

/**
 * Asks the local status page what is running. Only an answer naming this config's machine and server counts: the
 * port can be held by another collector (or anything else) while this one runs without its page.
 */
export async function probeDaemon(env: CliEnv, config: Pick<CollectorConfig, "machine" | "server_url" | "status_page">): Promise<DaemonProbe> {
  if (!config.status_page.enabled) return { kind: "off" };
  try {
    const res = await env.fetch(`http://127.0.0.1:${config.status_page.port}/status.json`, { signal: timeoutSignal(env, 1500) });
    if (!res.ok) return { kind: "silent" };
    const live = (await res.json()) as Partial<StatusSnapshot>;
    if (typeof live.collector_version !== "string") return { kind: "silent" };
    if (live.machine !== config.machine || live.server_url !== config.server_url) return { kind: "other", machine: String(live.machine) };
    return { kind: "ok", snapshot: live as StatusSnapshot };
  } catch {
    return { kind: "silent" };
  }
}

/** True only when the running collector is known to be older than this binary. */
export function restartNeeded(running: string): boolean {
  return (compareVersions(running, COLLECTOR_VERSION) ?? 0) < 0;
}

export function describeUnknown(probe: Exclude<DaemonProbe, { kind: "ok" }>): string {
  if (probe.kind === "off") return "the status page is turned off";
  if (probe.kind === "other") return `the status page port answered for another collector (${probe.machine})`;
  return "the status page is not answering";
}

async function statusPage(env: CliEnv, config: CollectorConfig): Promise<void> {
  if (!config.status_page.enabled) {
    env.out("Status page: disabled");
    return;
  }
  env.out(`Status page: http://127.0.0.1:${config.status_page.port}/`);
  const probe = await probeDaemon(env, config);
  if (probe.kind !== "ok") {
    env.out(`Daemon:  unknown (${describeUnknown(probe)})`);
    return;
  }
  const live = probe.snapshot;
  env.out(`Daemon:  answering, version ${live.collector_version}, up ${humanDuration(live.uptime_seconds)}`);
  if (restartNeeded(live.collector_version)) {
    env.out(`  Restart needed: this binary is ${COLLECTOR_VERSION}, but the running collector is still ${live.collector_version}.`);
  }
  env.out(`  Last upload: ${live.last_upload_at ?? "never"}`);
  env.out(`  Pending:     ${humanBytes(live.sources.reduce((n, s) => n + s.bytes_pending, 0))}`);
  env.out(`  Last error:  ${live.last_error ? `${live.last_error.message} (${live.last_error.at})` : "none"}`);
}
