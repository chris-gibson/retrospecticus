import { createInterface } from "node:readline/promises";
import { homedir, hostname } from "node:os";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Everything the commands touch outside their own arguments, so tests can substitute all of it. */
export interface CliEnv {
  home: string;
  env: Record<string, string | undefined>;
  platform: string;
  arch: string;
  hostname: string;
  uid: number;
  isTTY: boolean;
  /** The running executable: the compiled binary, or `bun` when running from source. */
  execPath: string;
  /** The entry script; only meaningful when not compiled. */
  mainPath: string;
  isCompiled: boolean;
  prompt(question: string): Promise<string>;
  run(cmd: string[]): Promise<RunResult>;
  fetch: Fetch;
  out(line: string): void;
  err(line: string): void;
  now(): number;
  /** Rejects when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Aborted by Ctrl-C or SIGTERM. */
  signal: AbortSignal;
  runCollector(configPath: string | undefined): Promise<number>;
}

/** A wrong invocation: exit code 2. */
export class UsageError extends Error {
  override name = "UsageError";
}

/** An expected failure that deserves a one-line message: exit code 1. */
export class CliError extends Error {
  override name = "CliError";
}

export function timeoutSignal(env: CliEnv, ms: number): AbortSignal {
  return AbortSignal.any([env.signal, AbortSignal.timeout(ms)]);
}

export function realEnv(runCollector: CliEnv["runCollector"]): CliEnv {
  const controller = new AbortController();
  let interrupted = false;
  const interrupt = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    controller.abort();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);

  const mainPath = Bun.main;
  const isCompiled = mainPath.includes("$bunfs") || mainPath.includes("~BUN");

  return {
    home: homedir(),
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    hostname: hostname(),
    uid: process.getuid?.() ?? 0,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    execPath: process.execPath,
    mainPath,
    isCompiled,
    async prompt(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const onAbort = () => rl.close();
      controller.signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await rl.question(question);
      } finally {
        controller.signal.removeEventListener("abort", onAbort);
        rl.close();
      }
    },
    async run(cmd) {
      try {
        const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { code, stdout, stderr };
      } catch (err) {
        return { code: 127, stdout: "", stderr: (err as Error).message };
      }
    },
    fetch: (input, init) => fetch(input, init),
    out: (line) => void process.stdout.write(`${line}\n`),
    err: (line) => void process.stderr.write(`${line}\n`),
    now: () => Date.now(),
    sleep(ms, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error("aborted"));
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, ms);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    signal: controller.signal,
    runCollector,
  };
}
