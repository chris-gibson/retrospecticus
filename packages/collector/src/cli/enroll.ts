import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ENROLL_POLL_PATH,
  ENROLL_START_PATH,
  EnrollPollResponseSchema,
  EnrollStartResponseSchema,
  HEADER_MACHINE,
  HEARTBEAT_PATH,
  MACHINE_NAME_PATTERN,
  type EnrollStartRequest,
} from "@retrospecticus/shared";
import { loadCollectorConfig, parseCollectorConfig, resolveCollectorConfigPath } from "../config.ts";
import { COLLECTOR_VERSION, buildHeartbeat } from "../heartbeat.ts";
import { renderConfig, tildify, updateConfigText, writeConfigAtomic, type EnrolledSettings } from "./configfile.ts";
import { CliError, PromptClosed, UsageError, timeoutSignal, type CliEnv } from "./env.ts";
import { installService, printInstructions } from "./service.ts";

export interface EnrollOptions {
  server?: string;
  machine?: string;
  /** undefined means ask when interactive. */
  install?: boolean;
  /** undefined means ask when interactive, and otherwise leave the setting as it is (off for a new config). */
  remoteUpdate?: boolean;
  config?: string;
  force: boolean;
}

const REQUEST_TIMEOUT_MS = 15_000;

export function defaultMachineName(hostname: string): string {
  const short = (hostname.split(".")[0] ?? "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  return short.slice(0, 63) || "machine";
}

function describeDuration(seconds: number): string {
  if (seconds >= 120) return `${Math.round(seconds / 60)} minutes`;
  return seconds === 60 ? "1 minute" : `${seconds} seconds`;
}

async function errorDetail(res: Response): Promise<string> {
  const text = (await res.text().catch(() => "")).trim();
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown };
    const detail = body.error ?? body.message;
    if (typeof detail === "string") return detail;
  } catch {
    // Not JSON; the raw text is the best there is.
  }
  return text.slice(0, 200);
}

function normalizeServer(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`--server must be a URL such as http://192.168.1.10:7878 (got ${JSON.stringify(value)})`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UsageError("--server must be an http(s) URL");
  return value.replace(/\/+$/, "");
}

async function startEnrollment(env: CliEnv, server: string, machine: string) {
  const body: EnrollStartRequest = {
    machine,
    hostname: env.hostname,
    platform: `${env.platform}-${env.arch}`,
    collector_version: COLLECTOR_VERSION,
  };
  let res: Response;
  try {
    res = await env.fetch(server + ENROLL_START_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: timeoutSignal(env, REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (env.signal.aborted) throw err;
    throw new CliError(`Cannot reach ${server}: ${(err as Error).message}. Check the address and that the server is running.`);
  }
  if (res.status === 429) {
    throw new CliError("The server has too many pending enrollment requests. Approve or deny some on its /admin page, or wait a few minutes, then try again.");
  }
  if (res.status === 400) throw new CliError(`The server rejected the enrollment request: ${await errorDetail(res) || "bad request"}`);
  if (res.status === 404) throw new CliError(`${server} does not offer enrollment; is the server up to date?`);
  if (!res.ok) throw new CliError(`The server answered HTTP ${res.status}: ${await errorDetail(res) || res.statusText}`);
  const parsed = EnrollStartResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new CliError(`${server} sent an unexpected enrollment response; is that a Retrospecticus server?`);
  return parsed.data;
}

async function awaitApproval(
  env: CliEnv,
  server: string,
  start: { device_code: string; expires_in: number; interval: number },
): Promise<{ token: string; machine: string }> {
  const deadline = env.now() + start.expires_in * 1000;
  let warned = false;
  const transient = (reason: string) => {
    if (warned) return;
    warned = true;
    env.err(`(could not reach the server: ${reason}; still trying)`);
  };

  for (;;) {
    await env.sleep(start.interval * 1000, env.signal);
    let res: Response | null = null;
    try {
      res = await env.fetch(server + ENROLL_POLL_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: start.device_code }),
        signal: timeoutSignal(env, REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (env.signal.aborted) throw err;
      transient((err as Error).message);
    }

    if (res) {
      if (res.status === 429 || res.status >= 500) {
        transient(`HTTP ${res.status}`);
      } else if (!res.ok) {
        throw new CliError(`The server refused the poll with HTTP ${res.status}: ${await errorDetail(res) || res.statusText}`);
      } else {
        const parsed = EnrollPollResponseSchema.safeParse(await res.json().catch(() => null));
        if (!parsed.success) {
          transient("unexpected response");
        } else {
          warned = false;
          const poll = parsed.data;
          if (poll.status === "approved") {
            if (poll.token === "" || /\s/.test(poll.token)) throw new CliError("The server sent a malformed token.");
            return { token: poll.token, machine: poll.machine };
          }
          if (poll.status === "denied") throw new CliError("The request was denied. Nothing was written.");
          if (poll.status === "expired") throw new CliError("The request expired before it was approved. Run enroll again.");
        }
      }
    }
    if (env.now() >= deadline) throw new CliError("Timed out waiting for approval. Run enroll again.");
  }
}

function writeSecret(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
  // The mode above only applies to a file that did not exist.
  chmodSync(path, 0o600);
}

function writeConfig(env: CliEnv, configPath: string, settings: EnrolledSettings, force: boolean): string {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  if (!existsSync(configPath)) {
    writeConfigAtomic(configPath, renderConfig(settings));
    return "created";
  }

  let fallback = "";
  if (!force) {
    try {
      const updated = updateConfigText(readFileSync(configPath, "utf8"), settings);
      parseCollectorConfig(updated.value, "config", { env: env.env, home: env.home });
      writeConfigAtomic(configPath, updated.text);
      return "kept your other settings and updated server_url, machine and token_file";
    } catch (err) {
      fallback = ` (the existing file could not be edited safely: ${(err as Error).message.split("\n")[0]})`;
    }
  }
  const backup = `${configPath}.bak-${new Date(env.now()).toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(configPath, backup);
  writeConfigAtomic(configPath, renderConfig(settings));
  return `replaced${fallback}; the previous file is saved as ${backup}`;
}

async function verifyToken(env: CliEnv, configPath: string, token: string, machine: string): Promise<void> {
  try {
    const config = loadCollectorConfig(configPath, { env: env.env, home: env.home });
    const res = await env.fetch(config.server_url + HEARTBEAT_PATH, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        [HEADER_MACHINE]: machine,
      },
      body: JSON.stringify(buildHeartbeat([])),
      signal: timeoutSignal(env, REQUEST_TIMEOUT_MS),
    });
    if (res.ok) env.out(`Checked the token: the server accepted a heartbeat from ${machine}.`);
    else env.err(`warning: the token was saved but the server answered HTTP ${res.status} to a heartbeat.`);
  } catch (err) {
    if (env.signal.aborted) throw err;
    env.err(`warning: the token was saved but the check failed: ${(err as Error).message.split("\n")[0]}`);
  }
}

/** The existing config's remote_update when it is for this server; "other-server" when it was given to another. */
function existingConsent(env: CliEnv, configPath: string, server: string): boolean | "other-server" {
  let existing;
  try {
    existing = loadCollectorConfig(configPath, { env: env.env, home: env.home });
  } catch {
    return false;
  }
  if (!sameOrigin(existing.server_url, server)) return existing.remote_update ? "other-server" : false;
  return existing.remote_update;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname.replace(/\/+$/, "") === y.pathname.replace(/\/+$/, "");
  } catch {
    return false;
  }
}

async function confirm(env: CliEnv, question: string, defaultYes = true): Promise<boolean> {
  let answer: string;
  try {
    answer = (await env.prompt(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
  } catch (err) {
    // Closing the prompt is not consent; by the time this is asked the machine is enrolled, so decline rather than fail.
    if (err instanceof PromptClosed) {
      env.out("");
      return false;
    }
    throw err;
  }
  return answer === "" ? defaultYes : answer === "y" || answer === "yes";
}

export async function enroll(env: CliEnv, options: EnrollOptions): Promise<number> {
  if (!options.server) throw new UsageError("enroll needs --server <url>");
  const server = normalizeServer(options.server);
  const configPath = resolveCollectorConfigPath(options.config, { env: env.env, home: env.home });

  try {
    let machine = options.machine;
    if (machine === undefined) {
      const fallback = defaultMachineName(env.hostname);
      machine = env.isTTY ? (await env.prompt(`Machine name [${fallback}]: `)).trim() || fallback : fallback;
    }
    if (!MACHINE_NAME_PATTERN.test(machine)) {
      throw new UsageError(`machine name ${JSON.stringify(machine)} must be letters, digits, ".", "_" or "-", up to 63 characters, starting with a letter or digit`);
    }

    // Asked before the long wait for approval, and before the config is written, since installing the service reads it.
    // Consent belongs to one server: re-enrolling with the same one keeps the current choice (Enter never turns it
    // off), while a different server starts from off, asked or not.
    const kept = existingConsent(env, configPath, server);
    const remoteUpdate =
      options.remoteUpdate ??
      (env.isTTY
        ? await confirm(env, `Let ${server} update this collector from its admin page?`, kept === true)
        : kept === "other-server"
          ? false
          : undefined);

    const start = await startEnrollment(env, server, machine);
    env.out(`Approve this machine at ${start.verification_url}`);
    env.out(`Code: ${start.user_code}   (expires in ${describeDuration(start.expires_in)})`);
    env.out("Waiting for approval...");

    const approved = await awaitApproval(env, server, start);

    const tokenFile = join(env.home, ".config", "retrospecticus", "ingest-token");
    writeSecret(tokenFile, `${approved.token}\n`);
    const how = writeConfig(
      env,
      configPath,
      { server_url: server, machine: approved.machine, token_file: tildify(tokenFile, env.home), remote_update: remoteUpdate },
      options.force,
    );
    env.out(`Approved. Machine ${approved.machine} is enrolled.`);
    env.out(`Token written to ${tokenFile} (mode 600).`);
    env.out(`Config ${configPath}: ${how}.`);
    await verifyToken(env, configPath, approved.token, approved.machine);

    const install = options.install ?? (env.isTTY ? await confirm(env, "Install as a background service that starts at login?") : false);
    if (install) return await installService(env, configPath);
    printInstructions(env, configPath);
    return 0;
  } catch (err) {
    if (env.signal.aborted) {
      env.out("\nCancelled.");
      return 1;
    }
    throw err;
  }
}
