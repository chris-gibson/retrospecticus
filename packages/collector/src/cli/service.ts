import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { HEADER_MACHINE, TOKEN_REVOKE_SELF_PATH } from "@retrospecticus/shared";
import { loadCollectorConfig, type CollectorConfig } from "../config.ts";
import { CliError, timeoutSignal, type CliEnv } from "./env.ts";

export const SERVICE_NAME = "retrospecticus-collector";
export const LAUNCHD_LABEL = "com.retrospecticus.collector";

export interface PlannedCommand {
  argv: string[];
  /** launchctl bootout fails when nothing is loaded, which is fine. */
  ignoreFailure?: boolean;
  /** launchctl bootout returns before the job has gone, so a bootstrap right after it can fail with error 5 for a moment. */
  retries?: number;
}

export interface PlannedFile {
  path: string;
  content: string;
  /** Directory that has to exist first. */
  dir: string;
}

export interface ServicePlan {
  /** False on platforms without a supported service manager. */
  supported: boolean;
  /** Present when the running binary is copied into place. */
  copy: { from: string; to: string } | null;
  /** What the service executes. */
  runArgv: string[];
  files: PlannedFile[];
  commands: PlannedCommand[];
  notes: string[];
}

export function servicePaths(home: string) {
  return {
    binary: join(home, ".local", "bin", SERVICE_NAME),
    unit: join(home, ".config", "systemd", "user", `${SERVICE_NAME}.service`),
    plist: join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
    logDir: join(home, "Library", "Logs"),
    log: join(home, "Library", "Logs", `${SERVICE_NAME}.log`),
  };
}

export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

export const renderCommand = (argv: readonly string[]) => argv.map(shellQuote).join(" ");

function systemdQuote(arg: string): string {
  const escaped = arg.replaceAll("%", "%%");
  return /[\s"'\\]/.test(escaped) ? `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : escaped;
}

const xmlEscape = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function systemdUnit(runArgv: readonly string[]): string {
  return `[Unit]
Description=Retrospecticus collector
After=network-online.target

[Service]
ExecStart=${runArgv.map(systemdQuote).join(" ")}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
}

export function launchdPlist(runArgv: readonly string[], logPath: string): string {
  const args = runArgv.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

/** The commands that make the service run whatever binary and config are in place now. */
function restartCommands(env: CliEnv, plist: string): PlannedCommand[] {
  if (env.platform === "linux") return [{ argv: ["systemctl", "--user", "restart", SERVICE_NAME] }];
  return [
    { argv: ["launchctl", "bootout", `gui/${env.uid}/${LAUNCHD_LABEL}`], ignoreFailure: true },
    { argv: ["launchctl", "bootstrap", `gui/${env.uid}`, plist], retries: 5 },
  ];
}

export function planInstall(env: CliEnv, configPath: string): ServicePlan {
  const paths = servicePaths(env.home);
  const notes: string[] = [];
  let copy: ServicePlan["copy"] = null;
  let program: string[];

  if (env.isCompiled) {
    program = [paths.binary];
    if (resolve(env.execPath) !== paths.binary) copy = { from: env.execPath, to: paths.binary };
  } else {
    program = [env.execPath, env.mainPath];
    notes.push(
      `Running from source, so no binary is copied: the service runs \`${renderCommand(program)}\` straight from this checkout.`,
    );
  }
  const runArgv = [...program, "run", "--config", configPath];

  if (env.platform === "linux") {
    return {
      supported: true,
      copy,
      runArgv,
      files: [{ path: paths.unit, content: systemdUnit(runArgv), dir: dirname(paths.unit) }],
      commands: [
        { argv: ["systemctl", "--user", "daemon-reload"] },
        { argv: ["systemctl", "--user", "enable", SERVICE_NAME] },
        // Restart rather than start, so a re-enrolled machine picks up its new token and binary.
        ...restartCommands(env, paths.plist),
      ],
      notes: [...notes, "To keep it running while you are logged out: loginctl enable-linger $USER"],
    };
  }
  if (env.platform === "darwin") {
    return {
      supported: true,
      copy,
      runArgv,
      files: [
        { path: paths.plist, content: launchdPlist(runArgv, paths.log), dir: dirname(paths.plist) },
      ],
      commands: restartCommands(env, paths.plist),
      notes: [...notes, `Logs: ${paths.log}`],
    };
  }
  return { supported: false, copy, runArgv, files: [], commands: [], notes };
}

export function printInstructions(env: CliEnv, configPath: string): void {
  const plan = planInstall(env, configPath);
  if (!plan.supported) {
    env.out(`Background services are only supported on Linux and macOS (this is ${env.platform}).`);
    env.out(`Run the collector yourself with:\n  ${renderCommand(plan.runArgv)}`);
    return;
  }
  env.out("To run the collector in the background, do this by hand:");
  let step = 1;
  if (plan.copy) {
    env.out(`  ${step++}. Put the binary on your PATH:`);
    env.out(`       mkdir -p ${shellQuote(dirname(plan.copy.to))}`);
    env.out(`       cp ${shellQuote(plan.copy.from)} ${shellQuote(plan.copy.to)} && chmod 755 ${shellQuote(plan.copy.to)}`);
  }
  for (const file of plan.files) {
    env.out(`  ${step++}. Create ${file.path} containing:`);
    for (const line of file.content.trimEnd().split("\n")) env.out(`       ${line}`);
  }
  env.out(`  ${step}. Start it:`);
  for (const command of plan.commands) env.out(`       ${renderCommand(command.argv)}`);
  for (const note of plan.notes) env.out(`  ${note}`);
  env.out(`Or later, run \`${renderCommand(["retrospecticus-collector", "install", "--config", configPath])}\` to do all of this.`);
}

function failure(result: { stderr: string; stdout: string; code: number }): string {
  const text = (result.stderr || result.stdout).trim().split("\n")[0];
  return text ? text : `exit code ${result.code}`;
}

async function runPlanned(env: CliEnv, commands: readonly PlannedCommand[]): Promise<void> {
  for (const command of commands) {
    let result = await env.run(command.argv);
    for (let left = command.retries ?? 0; result.code !== 0 && left > 0; left--) {
      await env.sleep(1000, env.signal);
      result = await env.run(command.argv);
    }
    if (result.code !== 0 && !command.ignoreFailure) {
      throw new CliError(`\`${renderCommand(command.argv)}\` failed: ${failure(result)}`);
    }
  }
}

/** Restarts the service when one is installed; returns whether it did. */
export async function restartInstalledService(env: CliEnv): Promise<boolean> {
  const paths = servicePaths(env.home);
  const installed =
    (env.platform === "linux" && existsSync(paths.unit)) || (env.platform === "darwin" && existsSync(paths.plist));
  if (!installed) return false;
  if (env.platform === "darwin") {
    // kickstart -k restarts a loaded agent in place; only an agent that is not loaded needs bootstrapping.
    const kick = await env.run(["launchctl", "kickstart", "-k", `gui/${env.uid}/${LAUNCHD_LABEL}`]);
    if (kick.code === 0) return true;
  }
  await runPlanned(env, restartCommands(env, paths.plist));
  return true;
}

export async function installService(env: CliEnv, configPath: string): Promise<number> {
  try {
    loadCollectorConfig(configPath, { env: env.env, home: env.home });
  } catch (err) {
    throw new CliError(`${(err as Error).message} (run \`retrospecticus-collector enroll\` first)`);
  }
  const plan = planInstall(env, configPath);
  if (!plan.supported) {
    printInstructions(env, configPath);
    return 1;
  }

  if (plan.copy) {
    mkdirSync(dirname(plan.copy.to), { recursive: true });
    // Renaming over the target works even while the old binary is running.
    const staging = `${plan.copy.to}.new`;
    copyFileSync(plan.copy.from, staging);
    chmodSync(staging, 0o755);
    renameSync(staging, plan.copy.to);
    env.out(`Installed ${plan.copy.to}`);
  }
  for (const file of plan.files) {
    mkdirSync(file.dir, { recursive: true });
    writeFileSync(file.path, file.content);
    env.out(`Wrote ${file.path}`);
  }
  if (env.platform === "darwin") mkdirSync(servicePaths(env.home).logDir, { recursive: true });

  await runPlanned(env, plan.commands);
  env.out("Service installed and started; it starts again at login.");
  for (const note of plan.notes) env.out(note);
  return 0;
}

export interface UninstallOptions {
  purge: boolean;
  config?: string;
}

export async function uninstallService(
  env: CliEnv,
  configPath: string,
  options: UninstallOptions,
): Promise<number> {
  const paths = servicePaths(env.home);
  const warn = (message: string) => env.err(`warning: ${message}`);

  if (env.platform === "linux") {
    if (existsSync(paths.unit)) {
      const stop = await env.run(["systemctl", "--user", "disable", "--now", SERVICE_NAME]);
      if (stop.code !== 0) warn(`could not stop the service: ${failure(stop)}`);
      rmSync(paths.unit);
      env.out(`Removed ${paths.unit}`);
      const reload = await env.run(["systemctl", "--user", "daemon-reload"]);
      if (reload.code !== 0) warn(`daemon-reload failed: ${failure(reload)}`);
    } else {
      env.out("No systemd service installed.");
    }
  } else if (env.platform === "darwin") {
    if (existsSync(paths.plist)) {
      await env.run(["launchctl", "bootout", `gui/${env.uid}/${LAUNCHD_LABEL}`]);
      rmSync(paths.plist);
      env.out(`Removed ${paths.plist}`);
    } else {
      env.out("No launchd agent installed.");
    }
  } else {
    env.out(`No service manager support on ${env.platform}; nothing to stop.`);
  }

  if (!options.purge) {
    env.out("Kept the config, token, state and binary. Use --purge to remove them too.");
    return 0;
  }

  const doomed = [configPath];
  let config: CollectorConfig | null = null;
  try {
    config = loadCollectorConfig(configPath, { env: env.env, home: env.home });
  } catch (err) {
    warn(`config unreadable, so its token and state files are left alone: ${(err as Error).message.split("\n")[0]}`);
  }
  if (config) {
    try {
      await revokeOwnToken(env, config, warn);
    } catch (err) {
      if (env.signal.aborted) throw err;
      warn(`could not revoke the token (${(err as Error).message.split("\n")[0]}); revoke it on the admin page's Tokens tab.`);
    }
    doomed.push(config.token_file, config.state_file);
  }
  // Only the copy that `install` made is removed; a binary run from elsewhere belongs to the user.
  doomed.push(paths.binary, paths.log);
  for (const path of doomed) {
    if (!existsSync(path)) continue;
    rmSync(path);
    env.out(`Removed ${path}`);
  }
  // rmdir refuses a directory that still holds anything, so files the user added survive.
  for (const dir of [join(env.home, ".config", "retrospecticus"), join(env.home, ".local", "state", "retrospecticus")]) {
    try {
      rmdirSync(dir);
      env.out(`Removed ${dir}`);
    } catch {
      // Missing or not empty.
    }
  }
  return 0;
}

/** So a purged machine's token cannot be used from a copy of the file; an unreachable server only costs a warning. */
async function revokeOwnToken(env: CliEnv, config: CollectorConfig, warn: (message: string) => void): Promise<void> {
  if (!existsSync(config.token_file)) return;
  const token = readFileSync(config.token_file, "utf8").trim();
  try {
    const res = await env.fetch(config.server_url + TOKEN_REVOKE_SELF_PATH, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, [HEADER_MACHINE]: config.machine },
      signal: timeoutSignal(env, 10_000),
    });
    const result = res.ok ? ((await res.json().catch(() => null)) as { result?: unknown } | null)?.result : undefined;
    if (result === "revoked" || result === "already-revoked") env.out(`Revoked this machine's token on ${config.server_url}.`);
    else if (res.ok) warn(`${config.server_url} gave an unexpected answer to revoking the token (is a proxy in the way?); revoke it on the admin page's Tokens tab.`);
    else if (res.status === 401) env.out("The server no longer accepts this machine's token, so there is nothing to revoke.");
    else warn(`the server answered HTTP ${res.status} to revoking the token; revoke it on the admin page's Tokens tab.`);
  } catch (err) {
    if (env.signal.aborted) throw err;
    warn(`could not reach ${config.server_url} to revoke the token (${(err as Error).message.split("\n")[0]}); revoke it on the admin page's Tokens tab.`);
  }
}
