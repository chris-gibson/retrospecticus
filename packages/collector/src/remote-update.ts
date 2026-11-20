import type { HeartbeatCommand } from "@retrospecticus/shared";
import type { Logger } from "./scanner.ts";

export interface UpdateRunResult {
  code: number;
  /** Stdout and stderr together, in the order they arrived as far as that is known. */
  output: string;
}

/** Runs `update` for the config at this path in a child process and waits for it to exit. */
export type UpdateRunner = (configPath: string) => Promise<UpdateRunResult>;

export interface CommandResult {
  id: string;
  ok: false;
  message: string;
}

export interface RemoteUpdaterOptions {
  /**
   * The config's remote_update as the file says now, not as it was at start: turning it off must take effect without
   * a restart, which may not happen (no service, or a failed one).
   */
  enabled: () => boolean;
  /** False when running from source, where there is no binary to replace. */
  compiled: boolean;
  configPath: string;
  run: UpdateRunner;
  /** How long a clean exit may go without this process being restarted before that counts as a failure. */
  graceMs: number;
  log: Logger;
  sleep?: (ms: number) => Promise<void>;
}

export interface RemoteUpdater {
  /** Starts the update in the background; commands that are not allowed, or arrive during an update, do nothing. */
  handle(command: HeartbeatCommand): void;
  /** What the next heartbeat should say about a failed command, until `acknowledge` confirms it was sent. */
  pendingResult(): CommandResult | null;
  acknowledge(result: CommandResult): void;
  /** Resolves when no update is in progress; for tests. */
  idle(): Promise<void>;
}

/** The last line that says something, since `update` ends with its verdict. */
export function lastUsefulLine(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.replace(/^retrospecticus-collector:\s*/, "").trim())
    .filter(Boolean);
  return (lines.at(-1) ?? "").slice(0, 300);
}

export function createRemoteUpdater(options: RemoteUpdaterOptions): RemoteUpdater {
  const { log } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let running: Promise<void> | null = null;
  let result: CommandResult | null = null;
  // The server repeats a command until it hears how it went, so one already taken up must not run again.
  const handled = new Set<string>();

  const fail = (id: string, message: string): void => {
    result = { id, ok: false, message };
    log.warn(`remote update failed: ${message}`);
  };

  async function execute(command: HeartbeatCommand): Promise<void> {
    log.info(`remote update requested (server version ${command.version})`);
    let outcome: UpdateRunResult;
    try {
      outcome = await options.run(options.configPath);
    } catch (err) {
      return fail(command.id, `could not run update: ${(err as Error).message}`);
    }
    if (outcome.code !== 0) {
      return fail(command.id, lastUsefulLine(outcome.output) || `update exited with code ${outcome.code}`);
    }
    // A service restart ends this process before the wait is over; still being here means nothing restarted it.
    await sleep(options.graceMs);
    fail(command.id, lastUsefulLine(outcome.output) || "update finished but the collector was not restarted");
  }

  return {
    handle(command) {
      if (command.command !== "update" || running || handled.has(command.id)) return;
      if (!options.enabled()) {
        handled.add(command.id);
        fail(command.id, "remote updates are turned off on this machine");
        return;
      }
      handled.add(command.id);
      if (!options.compiled) {
        fail(command.id, "running from source");
        return;
      }
      running = execute(command).finally(() => {
        running = null;
      });
    },
    pendingResult: () => result,
    acknowledge(sent) {
      if (result?.id === sent.id) result = null;
    },
    idle: async () => {
      await running;
    },
  };
}

export const realUpdateRunner: UpdateRunner = async (configPath) => {
  // Detached so launchd, which stops the daemon's process group, lets the updater finish. systemd stops the whole
  // service cgroup instead, so on Linux the restart ends the updater: by then the binary is already swapped (an atomic
  // rename), the new version starts, and the leftover .prev is removed when it does.
  const proc = Bun.spawn([process.execPath, "update", "--remote", "--config", configPath], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // The verdict is the last line: on stderr when it failed, on stdout when it did not.
  return { code, output: code === 0 ? `${stderr}\n${stdout}` : `${stdout}\n${stderr}` };
};
