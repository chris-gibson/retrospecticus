import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollectorConfigError, loadCollectorConfig, parseCollectorConfig, readToken } from "../src/config.ts";
import { buildHeartbeat, COLLECTOR_VERSION } from "../src/heartbeat.ts";
import { findEligibleEnd, resumePoint } from "../src/scanner.ts";
import { Backoff, encodeIngestPath } from "../src/uploader.ts";

const dir = mkdtempSync(join(tmpdir(), "retrospecticus-collector-units-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const home = join(dir, "home");
const minimal = { server_url: "http://100.64.0.1:7878/", token_file: "~/.config/retrospecticus/ingest-token", machine: "laptop" };

describe("config", () => {
  test("defaults follow the spec and resolve under the given home, never the real one", () => {
    const config = parseCollectorConfig(minimal, "test", { env: {}, home });

    expect(config).toEqual({
      server_url: "http://100.64.0.1:7878",
      token_file: join(home, ".config/retrospecticus/ingest-token"),
      machine: "laptop",
      poll_seconds: 30,
      state_file: join(home, ".local/state/retrospecticus/collector-state.json"),
      watch: true,
      watch_debounce_ms: 500,
      backoff_min_ms: 1000,
      backoff_max_ms: 300_000,
      heartbeat_seconds: 300,
      request_timeout_seconds: 120,
      max_body_bytes: 8 * 1024 * 1024,
      status_page: { enabled: true, port: 7879 },
      sources: [
        { name: "claude-code", root: join(home, ".claude/projects"), glob: "**/*.jsonl" },
        { name: "codex", root: join(home, ".codex/sessions"), glob: "**/*.jsonl" },
      ],
    });
  });

  test("CLAUDE_CONFIG_DIR and CODEX_HOME move the default roots; empty values do not", () => {
    const moved = parseCollectorConfig(minimal, "test", {
      env: { CLAUDE_CONFIG_DIR: "/srv/claude", CODEX_HOME: "~/alt-codex" },
      home,
    });
    expect(moved.sources.map((s) => s.root)).toEqual(["/srv/claude/projects", join(home, "alt-codex/sessions")]);

    const empty = parseCollectorConfig(minimal, "test", { env: { CLAUDE_CONFIG_DIR: "", CODEX_HOME: "" }, home });
    expect(empty.sources.map((s) => s.root)).toEqual([join(home, ".claude/projects"), join(home, ".codex/sessions")]);
  });

  test("the shipped example parses", () => {
    const example = join(import.meta.dir, "../../../deploy/collector.example.json");
    const config = loadCollectorConfig(example, { env: {}, home });
    expect(config.machine).toBe("my-laptop");
    expect(config.sources).toEqual(parseCollectorConfig(minimal, "test", { env: {}, home }).sources);
    expect(JSON.parse(readFileSync(example, "utf8"))).toHaveProperty("sources");
  });

  test.each([
    ["an unknown key", { ...minimal, serverurl: "x" }],
    ["a bad machine name", { ...minimal, machine: "has space" }],
    ["a non-http URL", { ...minimal, server_url: "ftp://example" }],
    ["an unknown source", { ...minimal, sources: [{ name: "cursor", root: "/x" }] }],
    ["a duplicated source", { ...minimal, sources: [{ name: "codex", root: "/x" }, { name: "codex", root: "/y" }] }],
    ["a relative root", { ...minimal, sources: [{ name: "codex", root: "sessions" }] }],
    ["a state file inside a source root", { ...minimal, state_file: "~/.codex/sessions/state.json" }],
    ["a state file that is a source root", { ...minimal, state_file: "/x", sources: [{ name: "codex", root: "/x" }] }],
    ["a body cap above the server's", { ...minimal, max_body_bytes: 8 * 1024 * 1024 + 1 }],
    ["inverted backoff bounds", { ...minimal, backoff_min_ms: 10, backoff_max_ms: 5 }],
  ])("rejects %s", (_name, value) => {
    expect(() => parseCollectorConfig(value, "test", { env: {}, home })).toThrow(CollectorConfigError);
  });

  test("an unknown key is an error naming the file and the key", () => {
    const path = join(dir, "strict.json");
    writeFileSync(path, JSON.stringify({ ...minimal, poll_secs: 5 }));
    expect(() => loadCollectorConfig(path, { env: {}, home })).toThrow(/strict\.json[\s\S]*poll_secs/);
    writeFileSync(path, JSON.stringify({ ...minimal, sources: [{ name: "codex", root: "/x", globs: "y" }] }));
    expect(() => loadCollectorConfig(path, { env: {}, home })).toThrow(/sources/);
  });

  test("a missing or malformed config file and a missing or empty token are reported as config errors", () => {
    expect(() => loadCollectorConfig(join(dir, "absent.json"))).toThrow(CollectorConfigError);
    writeFileSync(join(dir, "broken.json"), '{"server_url": ');
    expect(() => loadCollectorConfig(join(dir, "broken.json"))).toThrow(CollectorConfigError);

    expect(() => readToken({ token_file: join(dir, "no-token") })).toThrow(CollectorConfigError);
    writeFileSync(join(dir, "empty-token"), "\n");
    expect(() => readToken({ token_file: join(dir, "empty-token") })).toThrow(CollectorConfigError);
    writeFileSync(join(dir, "token"), "  rsp_ingest_abc\n");
    expect(readToken({ token_file: join(dir, "token") })).toBe("rsp_ingest_abc");
  });
});

describe("findEligibleEnd", () => {
  async function eligible(content: string | Buffer, from = 0): Promise<number> {
    const path = join(dir, `eligible-${Math.random().toString(36).slice(2)}`);
    writeFileSync(path, content);
    const handle = await open(path, "r");
    try {
      return await findEligibleEnd(handle, from, Buffer.byteLength(content));
    } finally {
      await handle.close();
    }
  }

  test("is the offset just past the last newline, or the start when there is none", async () => {
    expect(await eligible("")).toBe(0);
    expect(await eligible("abc")).toBe(0);
    expect(await eligible("abc\n")).toBe(4);
    expect(await eligible("abc\ndef")).toBe(4);
    expect(await eligible("abc\n\n")).toBe(5);
    expect(await eligible("\n")).toBe(1);
    expect(await eligible("abc\r\ndef\r")).toBe(5);
  });

  test("never looks before the starting offset", async () => {
    expect(await eligible("abc\ndef", 4)).toBe(4);
    expect(await eligible("abc\ndef\ngh", 4)).toBe(8);
    expect(await eligible("abc\ndef", 2)).toBe(4);
    expect(await eligible("abc\n", 4)).toBe(4);
  });

  test("finds a newline on either side of a read-back block boundary", async () => {
    const block = 64 * 1024;
    for (const newlineAt of [0, 1, block - 1, block, block + 1, 3 * block - 1, 3 * block]) {
      const bytes = Buffer.alloc(3 * block + 10, 0x78);
      bytes[newlineAt] = 0x0a;
      expect(await eligible(bytes)).toBe(newlineAt + 1);
    }
  });
});

describe("resumePoint", () => {
  const at = (generation: number, bytes_sent: number) => ({ inode: "7", generation, bytes_sent });

  test("the same generation resumes at the server's size", () => {
    expect(resumePoint(at(0, 0), { generation: 0, size: 40 }, 100)).toEqual(at(0, 40));
    expect(resumePoint(at(2, 90), { generation: 2, size: 40 }, 100)).toEqual(at(2, 40));
  });

  test("a newer generation on the server is adopted only if the local file can contain it", () => {
    expect(resumePoint(at(0, 0), { generation: 3, size: 40 }, 100)).toEqual(at(3, 40));
    expect(resumePoint(at(0, 0), { generation: 3, size: 40 }, 40)).toEqual(at(3, 40));
    expect(resumePoint(at(0, 0), { generation: 3, size: 40 }, 39)).toEqual(at(4, 0));
  });

  test("a generation the server never saw restarts right after the server's newest", () => {
    expect(resumePoint(at(5, 0), { generation: 1, size: 40 }, 100)).toEqual(at(2, 0));
    expect(resumePoint(at(2, 30), { generation: 1, size: 40 }, 100)).toEqual(at(2, 0));
    expect(resumePoint(at(5, 30), { generation: 0, size: 0 }, 100)).toEqual(at(0, 0));
  });
});

describe("Backoff", () => {
  test("doubles from the minimum to the maximum and starts over after a reset", () => {
    const backoff = new Backoff(1000, 300_000, () => 1);
    expect(backoff.active).toBe(false);
    const delays = Array.from({ length: 11 }, () => backoff.next());
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000]);
    expect(backoff.active).toBe(true);
    backoff.reset();
    expect(backoff.active).toBe(false);
    expect(backoff.next()).toBe(1000);
  });

  test("jitter stays between half the step and the step, and never under the minimum", () => {
    const low = new Backoff(1000, 300_000, () => 0);
    expect(Array.from({ length: 4 }, () => low.next())).toEqual([1000, 1000, 2000, 4000]);
    const random = new Backoff(1000, 300_000);
    for (let i = 0; i < 200; i++) {
      const delay = random.next();
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(300_000);
    }
  });
});

test("encodeIngestPath keeps separators and makes every segment header-safe", () => {
  expect(encodeIngestPath("a/b c/ñ.jsonl")).toBe("a/b%20c/%C3%B1.jsonl");
  expect(encodeIngestPath("100%/a\\b?#.jsonl")).toBe("100%25/a%5Cb%3F%23.jsonl");
  expect(decodeURIComponent(encodeIngestPath("proj/日本語 x.jsonl"))).toBe("proj/日本語 x.jsonl");
});

test("buildHeartbeat carries the version and only the protocol fields", () => {
  expect(buildHeartbeat([{ name: "codex", files: 2, bytes_pending: 9, pending_files: 1 }])).toEqual({
    collector_version: COLLECTOR_VERSION,
    sources: [{ name: "codex", files: 2, bytes_pending: 9, pending_files: 1 }],
  });
});

test("status_page defaults to enabled on 7879 and has no host option", () => {
  const base = { server_url: "http://x:7878", token_file: "/t", machine: "m", state_file: "/s" };
  expect(parseCollectorConfig(base).status_page).toEqual({ enabled: true, port: 7879 });
  expect(parseCollectorConfig({ ...base, status_page: { port: 9 } }).status_page).toEqual({ enabled: true, port: 9 });
  expect(parseCollectorConfig({ ...base, status_page: { enabled: false } }).status_page.enabled).toBe(false);
  expect(() => parseCollectorConfig({ ...base, status_page: { host: "0.0.0.0" } })).toThrow(CollectorConfigError);
});
