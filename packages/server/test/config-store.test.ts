import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, defaultConfig, type ServerConfig } from "../src/config.ts";
import {
  ConfigConflictError,
  RESTART_REQUIRED_KEYS,
  openConfigStore,
  versionOf,
  type ConfigStore,
  type ConfigStoreOptions,
} from "../src/config-store.ts";

let dir: string;
let configPath: string;
let secretsPath: string;
let logs: string[];
const stores: ConfigStore[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "retrospecticus-store-"));
  configPath = join(dir, "config.json");
  secretsPath = join(dir, "secrets.json");
  logs = [];
});
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  rmSync(dir, { recursive: true, force: true });
});

function open(options: ConfigStoreOptions = {}): ConfigStore {
  const store = openConfigStore({
    configPath,
    debounceMs: 10,
    log: { warn: (m) => logs.push(`warn ${m}`), error: (m) => logs.push(`error ${m}`) },
    ...options,
  });
  stores.push(store);
  return store;
}

const mode = (path: string) => statSync(path).mode & 0o777;

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

describe("loading", () => {
  test("no files at all means every default, version \"\" and no secrets", () => {
    const store = open();
    expect(store.current()).toEqual(defaultConfig());
    expect(store.version()).toBe("");
    expect(store.secretsPath).toBe(secretsPath);
    expect(store.secretStatus()).toEqual({
      embedding_api_key: { set: false, updated_at: null },
      discord_webhook_url: { set: false, updated_at: null },
      smtp_url: { set: false, updated_at: null },
      github_token: { set: false, updated_at: null },
    });
    expect(store.getSecret("smtp_url")).toBeUndefined();
    expect(store.lastError()).toBeNull();
    expect(store.pendingRestart()).toEqual([]);
  });

  test("the version is the sha256 of the file's bytes", () => {
    const text = JSON.stringify({ listen_port: 9 });
    writeFileSync(configPath, text);
    const store = open();
    expect(store.version()).toBe(versionOf(text));
    expect(store.version()).toMatch(/^[0-9a-f]{64}$/);
    expect(store.current().listen_port).toBe(9);
  });

  test.each([
    ["an unknown key", { listen_hots: "x" }],
    ["a removed *_file key", { embedding: { api_key_file: "/k" } }],
    ["an invalid notifier section", { notifiers: { discord: { webhook_url_file: "/x" } } }],
    ["an unknown notifier", { notifiers: { pager: {} } }],
    ["an embedding model with no known size", { embedding: { provider: "openai", model: "mystery" } }],
  ])("refuses to start from a file with %s", (_name, value) => {
    writeFileSync(configPath, JSON.stringify(value));
    expect(() => open()).toThrow(ConfigError);
  });

  test("an invalid secrets file is an error at startup", () => {
    writeFileSync(secretsPath, JSON.stringify({ openai: { value: "x", updated_at: new Date().toISOString() } }), { mode: 0o600 });
    expect(() => open()).toThrow(/secrets file/);
  });

  test("a secrets file readable by group or others is reported and logged", () => {
    writeFileSync(secretsPath, JSON.stringify({ smtp_url: { value: "smtp://x", updated_at: new Date().toISOString() } }));
    chmodSync(secretsPath, 0o644);
    const store = open();
    expect(store.getSecret("smtp_url")).toBe("smtp://x");
    expect(store.secretsPermissionProblem()).toContain("644");
    expect(logs.some((l) => l.startsWith("warn") && l.includes("chmod 600"))).toBe(true);
  });
});

describe("update", () => {
  test("validates strictly and leaves the file alone on a bad value", () => {
    writeFileSync(configPath, "{}");
    const store = open();
    const before = store.version();
    expect(() => store.update({ listen_port: 70000 }, before)).toThrow(ConfigError);
    expect(() => store.update({ bogus: 1 } as never, before)).toThrow(ConfigError);
    expect(() => store.update({ notifiers: { email: { from: "a" } } }, before)).toThrow(/email/);
    expect(readFileSync(configPath, "utf8")).toBe("{}");
    expect(store.version()).toBe(before);
  });

  test("refuses with a ConfigConflictError when the file changed since the given version", () => {
    writeFileSync(configPath, JSON.stringify({ listen_port: 1 }));
    const store = open();
    const seen = store.version();
    writeFileSync(configPath, JSON.stringify({ listen_port: 2 }));
    let error: unknown;
    try {
      store.update({ search: { keyword_weight: 5 } }, seen);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigConflictError);
    expect((error as ConfigConflictError).actualVersion).toBe(versionOf(JSON.stringify({ listen_port: 2 })));
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ listen_port: 2 });
  });

  test("creates the file when there was none, from version \"\"", () => {
    const store = open();
    const version = store.update({ search: { keyword_weight: 3 } }, "");
    expect(version).toBe(versionOf(readFileSync(configPath)));
    expect(existsSync(`${configPath}.bak`)).toBe(false);
    expect(store.current().search.keyword_weight).toBe(3);
  });

  test("writes atomically with mode 0644, keeps the previous file as .bak and notifies listeners", () => {
    const original = JSON.stringify({ alerts: { digest_hour: 3 } });
    writeFileSync(configPath, original);
    chmodSync(configPath, 0o600);
    const store = open();
    const changes: [ServerConfig, ServerConfig][] = [];
    store.onChange((next, previous) => changes.push([next, previous]));

    const version = store.update({ alerts: { digest_hour: 9 } }, store.version());
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ alerts: { digest_hour: 9 } });
    expect(readFileSync(`${configPath}.bak`, "utf8")).toBe(original);
    expect(mode(configPath)).toBe(0o644);
    expect(readdirSync(dir).sort()).toEqual(["config.json", "config.json.bak"]);
    expect(store.version()).toBe(version);
    expect(store.current().alerts.digest_hour).toBe(9);
    expect(changes).toHaveLength(1);
    expect(changes[0]![1].alerts.digest_hour).toBe(3);

    // Identical settings write the file but are not a change.
    store.update({ alerts: { digest_hour: 9 } }, version);
    expect(changes).toHaveLength(1);
  });

  test("restart-required keys are applied to the file and reported as pending", () => {
    const store = open();
    expect(RESTART_REQUIRED_KEYS).toEqual(["data_dir", "listen_host", "listen_port"]);
    store.update({ listen_port: 9999, search: { vector_weight: 4 } }, "");
    expect(store.pendingRestart()).toEqual(["listen_port"]);
    expect(store.current().listen_port).toBe(9999);
    store.update({ listen_port: 7878 }, store.version());
    expect(store.pendingRestart()).toEqual([]);
  });
});

describe("secrets", () => {
  test("set writes mode 0600, status reports only set and updated_at, null removes", () => {
    const store = open({ now: () => new Date("2026-11-16T10:00:00.000Z") });
    const status = store.setSecret("embedding_api_key", "sk-very-secret");
    expect(status).toEqual({ set: true, updated_at: "2026-11-16T10:00:00.000Z" });
    expect(mode(secretsPath)).toBe(0o600);
    expect(store.getSecret("embedding_api_key")).toBe("sk-very-secret");
    expect(JSON.stringify(store.secretStatus())).not.toContain("sk-very-secret");
    expect(store.secretStatus().embedding_api_key).toEqual({ set: true, updated_at: "2026-11-16T10:00:00.000Z" });
    expect(JSON.parse(readFileSync(secretsPath, "utf8"))).toEqual({
      embedding_api_key: { value: "sk-very-secret", updated_at: "2026-11-16T10:00:00.000Z" },
    });
    expect(readdirSync(dir)).toEqual(["secrets.json"]);

    expect(store.setSecret("embedding_api_key", null)).toEqual({ set: false, updated_at: null });
    expect(store.getSecret("embedding_api_key")).toBeUndefined();
    expect(mode(secretsPath)).toBe(0o600);
  });

  test("rejects an empty value and an unknown name", () => {
    const store = open();
    expect(() => store.setSecret("smtp_url", "")).toThrow(ConfigError);
    expect(() => store.setSecret("openai" as never, "x")).toThrow(/Unknown secret/);
  });

  test("tightens a loose secrets file when it rewrites it", () => {
    writeFileSync(secretsPath, "{}");
    chmodSync(secretsPath, 0o644);
    const store = open();
    expect(store.secretsPermissionProblem()).not.toBeNull();
    store.setSecret("smtp_url", "smtp://x");
    expect(mode(secretsPath)).toBe(0o600);
    expect(store.secretsPermissionProblem()).toBeNull();
  });

  test("a secret set by another process is seen at the next read, without a watcher", () => {
    const server = open();
    expect(server.getSecret("discord_webhook_url")).toBeUndefined();
    open().setSecret("discord_webhook_url", "https://example.com/hook");
    expect(server.getSecret("discord_webhook_url")).toBe("https://example.com/hook");
  });
});

describe("external edits", () => {
  test("a watched store applies a valid edit and keeps the last good config over an invalid one", async () => {
    writeFileSync(configPath, JSON.stringify({ search: { keyword_weight: 1 } }));
    const store = open();
    store.watch();
    const seen: number[] = [];
    store.onChange((next) => seen.push(next.search.keyword_weight));

    writeFileSync(configPath, JSON.stringify({ search: { keyword_weight: 7 } }));
    await until(() => seen.includes(7), "the valid edit");
    expect(store.current().search.keyword_weight).toBe(7);
    expect(store.lastError()).toBeNull();

    const broken = '{ "search": { "keyword_weight": ';
    writeFileSync(configPath, broken);
    await until(() => store.lastError() !== null, "the invalid edit");
    expect(store.lastError()).toContain("not valid JSON");
    expect(store.current().search.keyword_weight).toBe(7);
    // The version follows the disk, so a UI can overwrite the broken file knowingly.
    expect(store.version()).toBe(versionOf(broken));
    expect(logs.some((l) => l.startsWith("error") && l.includes("Keeping the config last read"))).toBe(true);

    writeFileSync(configPath, JSON.stringify({ search: { keyword_weight: 8 }, bogus: true }));
    await until(() => store.lastError()?.includes("bogus") === true, "the invalid schema");
    expect(store.current().search.keyword_weight).toBe(7);

    writeFileSync(configPath, JSON.stringify({ search: { keyword_weight: 2 } }));
    await until(() => store.lastError() === null, "the fix");
    expect(store.current().search.keyword_weight).toBe(2);
    expect(seen).toEqual([7, 2]);
  });

  test("deleting the file falls back to the defaults", async () => {
    writeFileSync(configPath, JSON.stringify({ alerts: { digest_hour: 1 } }));
    const store = open();
    store.watch();
    rmSync(configPath);
    await until(() => store.current().alerts.digest_hour === 8, "the defaults");
    expect(store.version()).toBe("");
  });

  test("an external edit of a restart-required key is pending until restart", () => {
    const store = open();
    writeFileSync(configPath, JSON.stringify({ data_dir: join(dir, "elsewhere") }));
    store.reload();
    expect(store.pendingRestart()).toEqual(["data_dir"]);
  });
});
