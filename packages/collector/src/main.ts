#!/usr/bin/env bun
import { rmSync, watch, type FSWatcher } from "node:fs";
import { homedir, hostname } from "node:os";
import { servicePaths } from "./cli/service.ts";
import { runCli } from "./cli/index.ts";
import { realEnv } from "./cli/env.ts";
import { loadCollectorConfig, readToken, resolveCollectorConfigPath, type CollectorConfig } from "./config.ts";
import { COLLECTOR_VERSION, sendHeartbeat, type CollectorFacts, type SourceStats } from "./heartbeat.ts";
import { createRemoteUpdater, realUpdateRunner, type UpdateRunner } from "./remote-update.ts";
import { listSourceFiles, syncFile, type Logger, type SourceFile } from "./scanner.ts";
import { serviceMode, startStatusServer, type StatusSnapshot } from "./status-page.ts";
import { StateStore } from "./state.ts";
import { Backoff, Uploader } from "./uploader.ts";

export interface ScanResult {
  /** False when the server could not be reached or refused everything; the pass stopped early and state did not move. */
  ok: boolean;
  /** Why the pass stopped early. */
  reason?: string;
  files: number;
  requests: number;
  uploadedBytes: number;
  /** Files left alone until they change, because the server refused them or they cannot be read. */
  skipped: number;
  sources: SourceStats[];
}

export interface CollectorOptions {
  log?: Logger;
  /** Overrides the token file, for callers that already hold the token. */
  token?: string;
  /** The config file this collector was started from; the update it spawns must read the same one. */
  configPath?: string;
  /** Replaces spawning the collector's own `update` command. */
  runUpdate?: UpdateRunner;
  /** False pretends to run from source. */
  compiled?: boolean;
  /** How long a clean `update` may leave this process running before that is reported as a failure. */
  updateGraceMs?: number;
}

const IS_COMPILED = Bun.main.includes("$bunfs") || Bun.main.includes("~BUN");

export interface Collector {
  readonly config: CollectorConfig;
  /** One full pass over every source, regardless of any backoff in progress. */
  scanOnce(): Promise<ScanResult>;
  /** What the status page shows: the same facts the heartbeat carries, plus local detail. */
  snapshot(): StatusSnapshot;
  /** Scans now, then keeps polling, watching and sending heartbeats until `stop`. */
  start(): void;
  /** Aborts any request in flight and resolves once nothing is running. The collector cannot be restarted. */
  stop(): Promise<void>;
}

const consoleLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export function createCollector(config: CollectorConfig, options: CollectorOptions = {}): Collector {
  const log = options.log ?? consoleLogger;
  const uploader = new Uploader({
    serverUrl: config.server_url,
    token: options.token ?? readToken(config),
    machine: config.machine,
    requestTimeoutMs: config.request_timeout_seconds * 1000,
  });
  const configPath = options.configPath ?? resolveCollectorConfigPath();
  // Without a file to reread (an in-memory config, as in tests) the setting is the one this collector started with.
  const remoteUpdateAllowed =
    options.configPath === undefined
      ? () => config.remote_update
      : (): boolean => {
          try {
            return loadCollectorConfig(configPath).remote_update;
          } catch {
            return false;
          }
        };
  const remoteUpdater = createRemoteUpdater({
    enabled: remoteUpdateAllowed,
    compiled: options.compiled ?? IS_COMPILED,
    configPath,
    run: options.runUpdate ?? realUpdateRunner,
    graceMs: options.updateGraceMs ?? 30_000,
    log,
  });
  const backoff = new Backoff(config.backoff_min_ms, config.backoff_max_ms);
  const abort = new AbortController();
  const pollMs = config.poll_seconds * 1000;
  const heartbeatMs = config.heartbeat_seconds * 1000;

  let state: StateStore | null = null;
  /** Files with nothing to do until their signature changes: fully uploaded, or refused. */
  const quiet = new Map<string, { signature: string; skipped: boolean }>();
  /** Tried last on the next pass, so one file the server chokes on cannot starve the rest. */
  let failedKey: string | null = null;
  let lastStats: SourceStats[] = [];

  let started = false;
  let stopped = false;
  let chain: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerDue = 0;
  let lastHeartbeatAt = Number.NEGATIVE_INFINITY;
  const startedAt = Date.now();
  // Starting is the proof the new binary works, so the copy an update kept for rollback can go.
  if (isCompiledBinary() && process.execPath === servicePaths(homedir()).binary) rmSync(`${process.execPath}.prev`, { force: true });
  let lastUploadAt: string | null = null;
  let lastScanAt: string | null = null;
  let lastHeartbeat: { at: string; error: string | null } | null = null;
  let lastError: { at: string; message: string } | null = null;
  /** Null until the server has been tried. */
  let reachable: boolean | null = null;
  const watchers = new Map<string, FSWatcher>();
  const watchFailures = new Set<string>();

  function recordError(message: string): void {
    lastError = { at: new Date().toISOString(), message: message.replace(/\s+/g, " ").slice(0, 300) };
  }

  function describeFailure(reason: string): string {
    const status = /^HTTP (\d{3})/.exec(reason)?.[1];
    if (status === "401" || status === "403") return `server rejected the token (${status})`;
    if (status) return `server error: ${reason}`;
    return `server unreachable: ${reason}`;
  }

  function facts(): CollectorFacts {
    return {
      hostname: hostname(),
      platform: `${process.platform}-${process.arch}`,
      started_at: new Date(startedAt).toISOString(),
      last_upload_at: lastUploadAt,
      last_scan_at: lastScanAt,
      last_error: lastError,
      exec_path: IS_COMPILED ? process.execPath : null,
      remote_update: remoteUpdateAllowed(),
      command_result: remoteUpdater.pendingResult() ?? undefined,
    };
  }

  async function loadState(): Promise<StateStore> {
    if (state) return state;
    const loaded = await StateStore.load(config.state_file);
    if (loaded.problem) log.warn(`state file ignored, resuming from the server's offsets: ${loaded.problem}`);
    state = loaded.store;
    return state;
  }

  async function scanPass(): Promise<ScanResult> {
    const store = await loadState();
    const result: ScanResult = { ok: true, files: 0, requests: 0, uploadedBytes: 0, skipped: 0, sources: [] };

    const listed: SourceFile[] = [];
    for (const source of config.sources) {
      try {
        listed.push(...(await listSourceFiles(source)));
      } catch (err) {
        log.warn(`${source.name}: cannot list ${source.root}: ${(err as Error).message}`);
      }
    }
    result.files = listed.length;

    const order =
      failedKey === null
        ? listed
        : [...listed].sort((a, b) => Number(a.key === failedKey) - Number(b.key === failedKey));
    failedKey = null;

    for (const file of order) {
      if (quiet.get(file.key)?.signature === file.signature) continue;
      quiet.delete(file.key);

      const synced = await syncFile(
        { state: store, uploader, maxBodyBytes: config.max_body_bytes, stop: abort.signal, log },
        file,
      );
      result.requests += synced.requests;
      result.uploadedBytes += synced.uploadedBytes;
      if (synced.uploadedBytes > 0) lastUploadAt = new Date().toISOString();

      if (synced.status === "unavailable") {
        result.ok = false;
        result.reason = synced.reason;
        failedKey = file.key;
        break;
      }
      if (synced.status === "skipped") {
        log.warn(`${file.source.name}/${file.relPath}: skipped until it changes: ${synced.reason}`);
        recordError(`file skipped: ${file.source.name}/${file.relPath} (${synced.reason})`);
      }
      // The signature predates the upload, so a file that grew meanwhile no longer matches it and is looked at again.
      if (synced.status === "settled" || synced.status === "skipped") {
        quiet.set(file.key, { signature: file.signature, skipped: synced.status === "skipped" });
      }
    }

    const seen = new Set(listed.map((file) => file.key));
    for (const key of quiet.keys()) if (!seen.has(key)) quiet.delete(key);

    result.sources = config.sources.map((source) => ({ name: source.name, files: 0, bytes_pending: 0, pending_files: 0 }));
    const byName = new Map(result.sources.map((stats) => [stats.name, stats]));
    for (const file of listed) {
      const stats = byName.get(file.source.name)!;
      stats.files++;
      const sent = store.get(file.key)?.bytes_sent ?? 0;
      const pending = Math.max(0, file.size - sent);
      stats.bytes_pending += pending;
      if (pending > 0) stats.pending_files++;
    }
    for (const entry of quiet.values()) if (entry.skipped) result.skipped++;
    lastStats = result.sources;
    lastScanAt = new Date().toISOString();
    return result;
  }

  /** Scans never overlap: two passes over one file would race on its offset. */
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  }

  function schedule(delayMs: number): void {
    if (stopped) return;
    const due = Date.now() + delayMs;
    if (timer !== null) {
      if (timerDue <= due) return;
      clearTimeout(timer);
    }
    timerDue = due;
    timer = setTimeout(() => {
      timer = null;
      void exclusive(tick);
    }, delayMs);
  }

  function ensureWatchers(): void {
    if (!config.watch) return;
    for (const source of config.sources) {
      if (watchers.has(source.name)) continue;
      try {
        const watcher = watch(source.root, { recursive: true, persistent: false }, () => {
          // While backing off, the retry timer already decides when the server is next tried.
          if (!backoff.active) schedule(config.watch_debounce_ms);
        });
        watcher.on("error", (err) => {
          log.warn(`${source.name}: watcher failed, polling carries on: ${(err as Error).message}`);
          watcher.close();
          watchers.delete(source.name);
        });
        watchers.set(source.name, watcher);
        watchFailures.delete(source.name);
      } catch (err) {
        // A root that does not exist yet is expected; it is retried on every poll and reported once.
        if (!watchFailures.has(source.name) && (err as NodeJS.ErrnoException).code !== "ENOENT") {
          log.warn(`${source.name}: cannot watch ${source.root}, polling only: ${(err as Error).message}`);
        }
        watchFailures.add(source.name);
      }
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    ensureWatchers();
    let result: ScanResult;
    try {
      result = await scanPass();
    } catch (err) {
      const reason = (err as Error).message;
      recordError(`scan failed: ${reason}`);
      result = { ok: false, reason, files: 0, requests: 0, uploadedBytes: 0, skipped: 0, sources: [] };
    }
    if (stopped) return;

    if (!result.ok) {
      reachable = false;
      recordError(describeFailure(result.reason ?? "unknown"));
      const wasHealthy = !backoff.active;
      const delay = backoff.next();
      if (wasHealthy) log.warn(`upload failed, backing off: ${result.reason}`);
      schedule(delay);
      return;
    }
    if (backoff.active) log.info("server reachable again");
    backoff.reset();
    reachable = true;
    if (result.uploadedBytes > 0) log.info(`uploaded ${result.uploadedBytes} bytes in ${result.requests} requests`);

    if (Date.now() - lastHeartbeatAt >= heartbeatMs) {
      lastHeartbeatAt = Date.now();
      const sentResult = remoteUpdater.pendingResult();
      const { error: problem, command } = await sendHeartbeat(uploader, lastStats, facts(), abort.signal);
      if (!stopped) {
        lastHeartbeat = { at: new Date().toISOString(), error: problem };
        if (problem !== null) {
          log.warn(`heartbeat failed: ${problem}`);
          recordError(`heartbeat failed: ${describeFailure(problem)}`);
        } else {
          if (sentResult) remoteUpdater.acknowledge(sentResult);
          if (command) remoteUpdater.handle(command);
        }
      }
    }
    schedule(pollMs);
  }

  return {
    config,

    snapshot() {
      return {
        collector_version: COLLECTOR_VERSION,
        machine: config.machine,
        server_url: config.server_url,
        hostname: hostname(),
        platform: `${process.platform}-${process.arch}`,
        started_at: new Date(startedAt).toISOString(),
        uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
        service_mode: serviceMode(process.env, process.platform),
        server_reachable: reachable,
        last_heartbeat_at: lastHeartbeat?.at ?? null,
        last_heartbeat_ok: lastHeartbeat ? lastHeartbeat.error === null : null,
        last_scan_at: lastScanAt,
        last_upload_at: lastUploadAt,
        last_error: lastError,
        sources: config.sources.map((source) => {
          const stats = lastStats.find((s) => s.name === source.name);
          return {
            name: source.name,
            root: source.root,
            files: stats?.files ?? 0,
            pending_files: stats?.pending_files ?? 0,
            bytes_pending: stats?.bytes_pending ?? 0,
          };
        }),
      };
    },

    scanOnce() {
      if (stopped) return Promise.reject(new Error("collector is stopped"));
      return exclusive(scanPass);
    },

    start() {
      if (started || stopped) return;
      started = true;
      log.info(
        `retrospecticus collector ${COLLECTOR_VERSION} for ${config.machine} -> ${config.server_url}; sources: ${config.sources.map((s) => `${s.name}=${s.root}`).join(", ")}`,
      );
      schedule(0);
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      abort.abort();
      await chain;
      try {
        await state?.save();
      } catch (err) {
        log.error(`cannot save state: ${(err as Error).message}`);
      }
    },
  };
}

async function runCollector(configPath: string | undefined): Promise<number> {
  const resolvedPath = resolveCollectorConfigPath(configPath);
  const config = loadCollectorConfig(resolvedPath);
  const collector = createCollector(config, { configPath: resolvedPath });
  const statusPage = config.status_page.enabled
    ? startStatusServer(() => collector.snapshot(), config.status_page.port, consoleLogger)
    : null;
  collector.start();
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  statusPage?.stop();
  await collector.stop();
  return 0;
}

if (import.meta.main) {
  const fatal = (err: unknown) => {
    console.error(`retrospecticus-collector: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
    process.exit(1);
  };
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
  process.exit(await runCli(process.argv.slice(2), realEnv(runCollector)));
}

function isCompiledBinary(): boolean {
  return Bun.main.includes("$bunfs") || Bun.main.includes("~BUN");
}
