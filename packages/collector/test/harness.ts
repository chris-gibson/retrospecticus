import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { issueToken } from "../../server/src/auth.ts";
import { defaultConfig } from "../../server/src/config.ts";
import { startServer, type RunningServer } from "../../server/src/main.ts";
import { parseCollectorConfig, type CollectorConfig, type CollectorConfigInput } from "../src/config.ts";
import { createCollector, type Collector, type CollectorOptions } from "../src/main.ts";
import type { Logger } from "../src/scanner.ts";

export const MACHINE = "testbox";

export interface TestEnv {
  dir: string;
  dataDir: string;
  claudeRoot: string;
  codexRoot: string;
  stateFile: string;
  server: RunningServer;
  port: number;
  logs: string[];
  config(overrides?: Partial<CollectorConfigInput>): CollectorConfig;
  collector(overrides?: Partial<CollectorConfigInput>, options?: CollectorOptions): Collector;
  /** Writes under a source root, creating directories. Returns the absolute path. */
  write(root: string, relPath: string, content: string | Uint8Array): string;
  archivePath(source: string, relPath: string, generation?: number): string;
  archived(source: string, relPath: string, generation?: number): Buffer | null;
  stopServer(): Promise<void>;
  /** Starts a fresh server process-equivalent on the same data directory and port. */
  restartServer(): void;
  cleanup(): Promise<void>;
}

export function createEnv(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "retrospecticus-collector-test-"));
  const dataDir = join(dir, "server-data");
  const claudeRoot = join(dir, "claude", "projects");
  const codexRoot = join(dir, "codex", "sessions");
  const stateFile = join(dir, "state", "collector-state.json");
  const tokenFile = join(dir, "ingest-token");
  mkdirSync(claudeRoot, { recursive: true });
  mkdirSync(codexRoot, { recursive: true });

  const logs: string[] = [];
  const log: Logger = {
    info: (message) => void logs.push(`info: ${message}`),
    warn: (message) => void logs.push(`warn: ${message}`),
    error: (message) => void logs.push(`error: ${message}`),
  };

  let server: RunningServer | null = startServer(defaultConfig({ data_dir: dataDir, listen_port: 0 }));
  const port = server.port;
  writeFileSync(tokenFile, `${issueToken(server.db, { scope: "ingest", machine: MACHINE }).token}\n`, { mode: 0o600 });

  const collectors: Collector[] = [];

  const env: TestEnv = {
    dir,
    dataDir,
    claudeRoot,
    codexRoot,
    stateFile,
    get server() {
      if (!server) throw new Error("server is stopped");
      return server;
    },
    port,
    logs,
    config(overrides = {}) {
      return parseCollectorConfig({
        server_url: `http://127.0.0.1:${port}`,
        token_file: tokenFile,
        machine: MACHINE,
        state_file: stateFile,
        poll_seconds: 0.02,
        watch: false,
        watch_debounce_ms: 5,
        backoff_min_ms: 5,
        backoff_max_ms: 40,
        heartbeat_seconds: 300,
        request_timeout_seconds: 10,
        sources: [
          { name: "claude-code", root: claudeRoot, glob: "**/*.jsonl" },
          { name: "codex", root: codexRoot, glob: "**/*.jsonl" },
        ],
        ...overrides,
      });
    },
    collector(overrides = {}, options = {}) {
      const collector = createCollector(env.config(overrides), { log, ...options });
      collectors.push(collector);
      return collector;
    },
    write(root, relPath, content) {
      const target = join(root, relPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      return target;
    },
    archivePath(source, relPath, generation = 0) {
      return join(dataDir, "raw", MACHINE, source, relPath + (generation > 0 ? `.g${generation}` : ""));
    },
    archived(source, relPath, generation = 0) {
      const target = env.archivePath(source, relPath, generation);
      return existsSync(target) ? readFileSync(target) : null;
    },
    async stopServer() {
      await server?.stop();
      server = null;
    },
    restartServer() {
      if (server) throw new Error("server is still running");
      server = startServer(defaultConfig({ data_dir: dataDir, listen_port: port }));
    },
    async cleanup() {
      await Promise.all(collectors.map((collector) => collector.stop()));
      await env.stopServer();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return env;
}

export async function waitFor(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

/** Every file under `root` with its bytes, to prove a scan left the tree exactly as it found it. */
export function snapshotTree(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.set(`${rel}/`, Buffer.alloc(0));
        walk(join(dir, entry.name), rel);
      } else {
        out.set(rel, readFileSync(join(dir, entry.name)));
      }
    }
  };
  walk(root, "");
  return out;
}
