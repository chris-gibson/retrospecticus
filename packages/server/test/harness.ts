import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import {
  HEADER_GENERATION,
  HEADER_MACHINE,
  HEADER_OFFSET,
  HEADER_PATH,
  HEADER_SOURCE,
  INGEST_APPEND_PATH,
  type TokenScope,
} from "@retrospecticus/shared";
import { createApp } from "../src/app.ts";
import { issueToken, type AppEnv } from "../src/auth.ts";
import { defaultConfig, rawDir, type ServerConfig } from "../src/config.ts";
import { openDb, type Db } from "../src/db/index.ts";

export interface Harness {
  dataDir: string;
  rawDir: string;
  config: ServerConfig;
  db: Db;
  app: Hono<AppEnv>;
  ingestCount: () => number;
  token(scope: TokenScope, machine?: string): string;
  append(options: AppendOptions): Promise<Response>;
  archived(relative: string): Buffer;
  cleanup(): void;
}

export interface AppendOptions {
  token: string;
  machine?: string | null;
  source?: string;
  path?: string;
  offset?: number | string;
  generation?: number | string;
  body?: string | Uint8Array;
}

export function createHarness(): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), "retrospecticus-test-"));
  const config = defaultConfig({ data_dir: dataDir });
  const db = openDb(":memory:");
  let ingests = 0;
  const app = createApp({ db, config, onIngest: () => void ingests++ });

  return {
    dataDir,
    rawDir: rawDir(config),
    config,
    db,
    app,
    ingestCount: () => ingests,
    token: (scope, machine) => issueToken(db, { scope, machine }).token,
    async append(o) {
      const headers = new Headers({
        Authorization: `Bearer ${o.token}`,
        [HEADER_SOURCE]: o.source ?? "claude-code",
        [HEADER_PATH]: o.path ?? "proj/session.jsonl",
        [HEADER_OFFSET]: String(o.offset ?? 0),
        [HEADER_GENERATION]: String(o.generation ?? 0),
      });
      if (o.machine !== null) headers.set(HEADER_MACHINE, o.machine ?? "laptop");
      return app.request(INGEST_APPEND_PATH, { method: "PUT", headers, body: o.body ?? "" });
    },
    archived: (relative) => readFileSync(join(rawDir(config), relative)),
    cleanup() {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
