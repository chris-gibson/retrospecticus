import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadCollectorConfig } from "../../collector/src/config.ts";
import { dbPath, loadConfig, rawDir } from "@retrospecticus/server/config.ts";
import { validateConfig } from "@retrospecticus/server/config-store.ts";
import { setBaselineLearned, upsertDriftEvent } from "@retrospecticus/server/db/drift.ts";
import { rawRelativePath, upsertFileSize } from "@retrospecticus/server/db/files.ts";
import { openDb } from "@retrospecticus/server/db/index.ts";
import { run } from "../src/main.ts";

let dir: string;
let configPath: string;

function writeConfig(extra: Record<string, unknown> = {}): void {
  writeFileSync(configPath, JSON.stringify({ data_dir: join(dir, "data"), listen_host: "127.0.0.1", listen_port: 0, ...extra }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "retrospecticus-doctor-"));
  configPath = join(dir, "config.json");
  writeConfig();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function doctor(): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  const code = await run(["--config", configPath, "doctor"], { out: (l) => out.push(l), err: (l) => out.push(l) });
  return { code, out };
}

function withDb<T>(task: (db: ReturnType<typeof openDb>) => T): T {
  const config = loadConfig(configPath);
  mkdirSync(dirname(dbPath(config)), { recursive: true });
  const db = openDb(dbPath(config));
  try {
    return task(db);
  } finally {
    db.close();
  }
}

const key = { machine: "laptop", source: "claude-code" as const, path: "a/session.jsonl" };

function archiveFile(content: string, rowSize: number): void {
  const config = loadConfig(configPath);
  const target = join(rawDir(config), rawRelativePath({ ...key, generation: 0 }));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  withDb((db) => upsertFileSize(db, key, 0, rowSize));
}

describe("doctor", () => {
  test("a healthy empty install exits 0", async () => {
    const { code, out } = await doctor();
    expect(out.filter((l) => l.startsWith("FAIL"))).toEqual([]);
    expect(code).toBe(0);
    expect(out.some((l) => l.includes("no machines enrolled yet"))).toBe(true);
  });

  test("matching archive sizes pass", async () => {
    archiveFile("hello\n", 6);
    const { code, out } = await doctor();
    expect(code).toBe(0);
    expect(out.some((l) => l.startsWith("warn") && l.includes("parse backlog"))).toBe(true);
  });

  test("a size mismatch between a files row and the archive fails", async () => {
    archiveFile("hello\n", 99);
    const { code, out } = await doctor();
    expect(code).toBe(1);
    expect(out.some((l) => l.startsWith("FAIL") && l.includes("a/session.jsonl"))).toBe(true);
  });

  test("an open breaking drift event fails and an additive one only warns", async () => {
    withDb((db) => upsertDriftEvent(db, { source: "claude-code", severity: "additive", fingerprint: "f1" }));
    let result = await doctor();
    expect(result.code).toBe(0);
    expect(result.out.some((l) => l.startsWith("warn") && l.includes("open additive or version drift"))).toBe(true);

    withDb((db) => upsertDriftEvent(db, { source: "claude-code", severity: "breaking", fingerprint: "f2" }));
    result = await doctor();
    expect(result.code).toBe(1);
    expect(result.out.some((l) => l.startsWith("FAIL") && l.includes("drift"))).toBe(true);
  });

  test("warns until the drift baseline is learned", async () => {
    const hint = "warn drift baseline not learned; run `retrospecticus shapes learn` once the first history is indexed";
    let result = await doctor();
    expect(result.code).toBe(0);
    expect(result.out).toContain(hint);

    withDb((db) => setBaselineLearned(db));
    result = await doctor();
    expect(result.out).not.toContain(hint);
    expect(result.out).toContain("ok   drift baseline learned");
  });

  test("reports the config and secrets files and a writable config directory", async () => {
    const { out } = await doctor();
    expect(out).toContain(`ok   config file ${configPath} loaded`);
    expect(out).toContain(`ok   no secrets file at ${join(dir, "secrets.json")}; no secrets set`);
    expect(out).toContain(`ok   config directory ${dir} is writable`);
  });

  test("a missing config file only warns: the server runs on defaults", async () => {
    rmSync(configPath);
    const { out } = await doctor();
    expect(out[0]).toBe(`warn config file ${configPath} does not exist; using every default`);
  });

  test("an invalid config file fails and stops there", async () => {
    writeFileSync(configPath, '{ "listen_port": "x" }');
    const { code, out } = await doctor();
    expect(code).toBe(1);
    expect(out[0]).toStartWith("FAIL Invalid config file");
    expect(out.some((l) => l.includes("data_dir"))).toBe(false);
  });

  test("a secrets file readable by others fails; an invalid one fails", async () => {
    const secrets = join(dir, "secrets.json");
    writeFileSync(secrets, JSON.stringify({ smtp_url: { value: "smtp://x", updated_at: new Date().toISOString() } }));
    chmodSync(secrets, 0o640);
    let result = await doctor();
    expect(result.code).toBe(1);
    expect(result.out.some((l) => l.startsWith("FAIL") && l.includes("mode 640"))).toBe(true);
    expect(result.out.join("\n")).not.toContain("smtp://x");

    chmodSync(secrets, 0o600);
    expect((await doctor()).code).toBe(0);

    writeFileSync(secrets, JSON.stringify({ smtp: { value: "smtp://x", updated_at: "now" } }));
    result = await doctor();
    expect(result.code).toBe(1);
    expect(result.out.some((l) => l.startsWith("FAIL") && l.includes("is invalid"))).toBe(true);
  });

  test("warns when a configured feature lacks its secret", async () => {
    writeConfig({ notifiers: { discord: {}, email: { from: "a@example.com", to: ["b@example.com"] } } });
    const { code, out } = await doctor();
    expect(code).toBe(0);
    expect(out).toContain("warn notifiers.discord needs the secret discord_webhook_url; run `retrospecticus secrets set discord_webhook_url`");
    expect(out.some((l) => l.startsWith("warn notifiers.email needs the secret smtp_url"))).toBe(true);
  });

  test("warns when the config directory is not writable", async () => {
    if (process.getuid?.() === 0) return;
    chmodSync(dir, 0o500);
    try {
      const { out } = await doctor();
      expect(out.some((l) => l.startsWith(`warn config directory ${dir} is not writable`))).toBe(true);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("an invalid notifier config fails with the message", async () => {
    writeConfig({ notifiers: { discord: { webhook_url: "nope" } } });
    const { code, out } = await doctor();
    expect(code).toBe(1);
    expect(out.some((l) => l.startsWith("FAIL") && l.includes("Invalid config for notifier"))).toBe(true);
  });
});

describe("deploy examples", () => {
  const deploy = join(import.meta.dir, "..", "..", "..", "deploy");

  test("server.example.json loads through the real loader and validator", () => {
    const config = loadConfig(join(deploy, "server.example.json"));
    validateConfig(config);
    expect(config.listen_port).toBe(7878);
    expect(config.alerts.collector_silent_hours).toBe(48);
  });

  test("collector.example.json loads through the collector's loader", () => {
    const config = loadCollectorConfig(join(deploy, "collector.example.json"), { home: "/home/example", env: {} });
    expect(config.machine).toBe("my-laptop");
    expect(config.sources).toHaveLength(2);
  });
});
