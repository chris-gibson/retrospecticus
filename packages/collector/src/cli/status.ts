import { existsSync } from "node:fs";
import { loadCollectorConfig, resolveCollectorConfigPath } from "../config.ts";
import { humanBytes, humanDuration } from "../status-page.ts";
import type { StatusSnapshot } from "../status-page.ts";
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
  await statusPage(env, config.status_page);
  return 0;
}

async function statusPage(env: CliEnv, page: { enabled: boolean; port: number }): Promise<void> {
  if (!page.enabled) {
    env.out("Status page: disabled");
    return;
  }
  const url = `http://127.0.0.1:${page.port}/`;
  env.out(`Status page: ${url}`);
  try {
    const res = await env.fetch(`${url}status.json`, { signal: timeoutSignal(env, 1500) });
    if (!res.ok) return;
    const live = (await res.json()) as StatusSnapshot;
    env.out(`Daemon:  answering, up ${humanDuration(live.uptime_seconds)}`);
    env.out(`  Last upload: ${live.last_upload_at ?? "never"}`);
    env.out(`  Pending:     ${humanBytes(live.sources.reduce((n, s) => n + s.bytes_pending, 0))}`);
    env.out(`  Last error:  ${live.last_error ? `${live.last_error.message} (${live.last_error.at})` : "none"}`);
  } catch {
    env.out("Daemon:  not answering on the status page");
  }
}
