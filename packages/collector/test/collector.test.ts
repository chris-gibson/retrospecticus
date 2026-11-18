import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { MAX_APPEND_BODY_BYTES } from "@retrospecticus/shared";
import { getFile, listFiles } from "../../server/src/db/files.ts";
import { getMachine } from "../../server/src/db/machines.ts";
import { COLLECTOR_VERSION } from "../src/heartbeat.ts";
import { stateKey } from "../src/state.ts";
import { createEnv, MACHINE, snapshotTree, waitFor, type TestEnv } from "./harness.ts";

let env: TestEnv;

beforeEach(() => {
  env = createEnv();
});
afterEach(async () => {
  await env.cleanup();
});

function expectArchived(source: string, relPath: string, local: string, generation = 0): void {
  const archived = env.archived(source, relPath, generation);
  expect(archived).not.toBeNull();
  expect(archived!.equals(readFileSync(local))).toBe(true);
}

function readState(): { version: number; files: Record<string, { inode: string; generation: number; bytes_sent: number }> } {
  return JSON.parse(readFileSync(env.stateFile, "utf8"));
}

describe("existing files", () => {
  test("everything already on disk is uploaded byte for byte, from both sources", async () => {
    const files: Array<[string, string, string]> = [
      ["claude-code", "-home-me-proj/aaaa.jsonl", '{"type":"user","text":"héllo"}\n{"type":"assistant"}\n'],
      ["claude-code", "-home-me-proj/aaaa/subagents/agent-1.jsonl", '{"type":"user"}\n'],
      ["claude-code", "proyecto ñandú/日本語 session.jsonl", '{"text":"スペース and 100% unicode"}\n'],
      ["codex", "2026/11/16/rollout-2026-11-16T10-00-00-abc.jsonl", '{"type":"session_meta"}\r\n{"type":"response_item"}\n'],
    ];
    const paths = files.map(([source, rel, content]) =>
      env.write(source === "codex" ? env.codexRoot : env.claudeRoot, rel, content),
    );
    env.write(env.claudeRoot, "-home-me-proj/empty.jsonl", "");
    env.write(env.claudeRoot, "-home-me-proj/notes.txt", "not a session\n");
    const before = [snapshotTree(env.claudeRoot), snapshotTree(env.codexRoot)];

    const result = await env.collector().scanOnce();

    expect(result).toMatchObject({ ok: true, files: 5, requests: 4, skipped: 0 });
    files.forEach(([source, rel], i) => expectArchived(source, rel, paths[i]!));
    expect(env.archived("claude-code", "-home-me-proj/empty.jsonl")).toBeNull();
    expect(env.archived("claude-code", "-home-me-proj/notes.txt")).toBeNull();
    expect(listFiles(env.server.db)).toHaveLength(4);
    expect([snapshotTree(env.claudeRoot), snapshotTree(env.codexRoot)]).toEqual(before);

    const again = await env.collector().scanOnce();
    expect(again).toMatchObject({ ok: true, requests: 0, uploadedBytes: 0 });
  });

  test("binary content, including bytes that are not valid UTF-8, survives unchanged", async () => {
    const bytes = Buffer.alloc(70_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) % 256;
    bytes[bytes.length - 1] = 0x0a;
    const local = env.write(env.codexRoot, "bin.jsonl", bytes);

    await env.collector().scanOnce();
    expectArchived("codex", "bin.jsonl", local);
  });

  test("a missing source root is skipped and the other source still uploads", async () => {
    rmSync(env.codexRoot, { recursive: true });
    const local = env.write(env.claudeRoot, "p/s.jsonl", "one\n");

    const result = await env.collector().scanOnce();

    expect(result.ok).toBe(true);
    expect(result.sources).toEqual([
      { name: "claude-code", files: 1, bytes_pending: 0, pending_files: 0 },
      { name: "codex", files: 0, bytes_pending: 0, pending_files: 0 },
    ]);
    expectArchived("claude-code", "p/s.jsonl", local);
    expect(existsSync(env.codexRoot)).toBe(false);
  });

  test("a symlink under the root is not followed", async () => {
    const secret = env.write(env.dir, "elsewhere/secret.jsonl", "private\n");
    const { symlinkSync } = await import("node:fs");
    env.write(env.claudeRoot, "p/real.jsonl", "real\n");
    symlinkSync(secret, join(env.claudeRoot, "p/link.jsonl"));
    symlinkSync(dirname(secret), join(env.claudeRoot, "linked-dir"));

    await env.collector().scanOnce();

    expect(listFiles(env.server.db).map((f) => f.path)).toEqual(["p/real.jsonl"]);
  });
});

describe("appends", () => {
  test("bytes appended after the first upload follow on the next scan", async () => {
    const local = env.write(env.claudeRoot, "p/s.jsonl", "line 1\n");
    const collector = env.collector();
    await collector.scanOnce();
    expectArchived("claude-code", "p/s.jsonl", local);

    appendFileSync(local, "line 2\nline 3\n");
    const result = await collector.scanOnce();

    expect(result).toMatchObject({ ok: true, requests: 1, uploadedBytes: 14 });
    expectArchived("claude-code", "p/s.jsonl", local);
    expect(readState().files[stateKey("claude-code", "p/s.jsonl")]).toEqual({
      inode: String(statSync(local, { bigint: true }).ino),
      generation: 0,
      bytes_sent: 21,
    });
  });

  test("a restarted collector continues from its state file without re-sending", async () => {
    const local = env.write(env.claudeRoot, "p/s.jsonl", "line 1\n");
    await env.collector().scanOnce();

    appendFileSync(local, "line 2\n");
    const result = await env.collector().scanOnce();

    expect(result).toMatchObject({ requests: 1, uploadedBytes: 7 });
    expectArchived("claude-code", "p/s.jsonl", local);
  });

  test("the running daemon picks up new files and appends by polling", async () => {
    const collector = env.collector();
    collector.start();

    const a = env.write(env.claudeRoot, "p/a.jsonl", "a1\n");
    await waitFor(() => env.archived("claude-code", "p/a.jsonl")?.length === 3, "first upload");

    const b = env.write(env.codexRoot, "2026/b.jsonl", "b1\n");
    for (let i = 2; i <= 20; i++) {
      appendFileSync(a, `a${i}\n`);
      await Bun.sleep(1);
    }
    const expected = statSync(a).size;
    await waitFor(() => env.archived("claude-code", "p/a.jsonl")?.length === expected, "appends");
    await waitFor(() => env.archived("codex", "2026/b.jsonl") !== null, "second file");

    expectArchived("claude-code", "p/a.jsonl", a);
    expectArchived("codex", "2026/b.jsonl", b);
  });

  test("the watcher triggers an upload long before the next poll", async () => {
    const collector = env.collector({ poll_seconds: 3600, watch: true, watch_debounce_ms: 10 });
    collector.start();
    // The first scan finds nothing and arms the watchers; from here only a watch event can cause a scan.
    await waitFor(() => env.logs.some((line) => line.includes("collector")), "start");
    await Bun.sleep(50);

    const local = env.write(env.claudeRoot, "p/watched.jsonl", "seen\n");
    await waitFor(() => env.archived("claude-code", "p/watched.jsonl") !== null, "watched upload");
    appendFileSync(local, "again\n");
    await waitFor(() => env.archived("claude-code", "p/watched.jsonl")?.length === 11, "watched append");

    expectArchived("claude-code", "p/watched.jsonl", local);
  });
});

describe("partial lines", () => {
  test("a trailing partial line is withheld until its newline arrives", async () => {
    const local = env.write(env.claudeRoot, "p/s.jsonl", '{"a":1}\n{"b":');
    const collector = env.collector();

    const first = await collector.scanOnce();
    expect(env.archived("claude-code", "p/s.jsonl")!.toString()).toBe('{"a":1}\n');
    expect(first.sources[0]).toEqual({ name: "claude-code", files: 1, bytes_pending: 5, pending_files: 1 });

    appendFileSync(local, "2");
    expect((await collector.scanOnce()).requests).toBe(0);
    expect(env.archived("claude-code", "p/s.jsonl")!.toString()).toBe('{"a":1}\n');

    appendFileSync(local, '}\n{"c"');
    await collector.scanOnce();
    expect(env.archived("claude-code", "p/s.jsonl")!.toString()).toBe('{"a":1}\n{"b":2}\n');

    appendFileSync(local, ":3}\n");
    await collector.scanOnce();
    expectArchived("claude-code", "p/s.jsonl", local);
  });

  test("a file with no newline yet is not sent at all, and leaves no trace on the server", async () => {
    const local = env.write(env.claudeRoot, "p/s.jsonl", '{"still":"writing"');
    const collector = env.collector();

    expect(await collector.scanOnce()).toMatchObject({ ok: true, requests: 0 });
    expect(listFiles(env.server.db)).toEqual([]);

    appendFileSync(local, "}\n");
    await collector.scanOnce();
    expectArchived("claude-code", "p/s.jsonl", local);
  });

  test("a partial line longer than the read-back block is still withheld", async () => {
    const local = env.write(env.claudeRoot, "p/s.jsonl", `first\n${"x".repeat(200_000)}`);
    const collector = env.collector();

    await collector.scanOnce();
    expect(env.archived("claude-code", "p/s.jsonl")!.toString()).toBe("first\n");

    appendFileSync(local, "\n");
    await collector.scanOnce();
    expectArchived("claude-code", "p/s.jsonl", local);
  });
});

describe("large files", () => {
  test("a 20 MiB file goes up in several requests, split inside a multi-megabyte line", async () => {
    const size = 20 * 1024 * 1024;
    const bytes = Buffer.alloc(size);
    for (let i = 0; i < size; i += 4096) bytes.writeUInt32LE(i, i);
    bytes.fill(0x61, 0, 1024);
    bytes[1023] = 0x0a;
    // One line of about 11 MiB, so no request boundary can fall on a newline.
    bytes[12 * 1024 * 1024] = 0x0a;
    for (let i = 13 * 1024 * 1024; i < size - 100; i += 500_000) bytes[i] = 0x0a;
    bytes[size - 100] = 0x0a;
    const local = env.write(env.codexRoot, "big.jsonl", bytes);
    const eligible = bytes.lastIndexOf(0x0a) + 1;
    expect(eligible).toBe(size - 99);

    const collector = env.collector();
    const result = await collector.scanOnce();

    expect(result.ok).toBe(true);
    expect(result.requests).toBe(Math.ceil(eligible / MAX_APPEND_BODY_BYTES));
    expect(result.requests).toBeGreaterThanOrEqual(3);
    expect(result.uploadedBytes).toBe(eligible);
    expect(env.archived("codex", "big.jsonl")!.equals(bytes.subarray(0, eligible))).toBe(true);

    appendFileSync(local, "\n");
    await collector.scanOnce();
    expectArchived("codex", "big.jsonl", local);
  });

  test("the body size is honoured exactly at small limits", async () => {
    const local = env.write(env.claudeRoot, "p/s.jsonl", "0123456789\nabcdefghij\nKLMNOPQRST\n");
    const result = await env.collector({ max_body_bytes: 7 }).scanOnce();

    expect(result.requests).toBe(5);
    expectArchived("claude-code", "p/s.jsonl", local);
  });
});

describe("generations", () => {
  test("a truncated file becomes generation 1 and generation 0 is preserved", async () => {
    const original = '{"n":1}\n{"n":2}\n{"n":3}\n';
    const local = env.write(env.claudeRoot, "p/s.jsonl", original);
    const collector = env.collector();
    await collector.scanOnce();

    truncateSync(local, 0);
    appendFileSync(local, '{"fresh":1}\n');
    await collector.scanOnce();

    expect(env.archived("claude-code", "p/s.jsonl", 0)!.toString()).toBe(original);
    expectArchived("claude-code", "p/s.jsonl", local, 1);
    expect(readState().files[stateKey("claude-code", "p/s.jsonl")]).toMatchObject({ generation: 1, bytes_sent: 12 });

    appendFileSync(local, '{"fresh":2}\n');
    await collector.scanOnce();
    expectArchived("claude-code", "p/s.jsonl", local, 1);
    expect(env.archived("claude-code", "p/s.jsonl", 0)!.toString()).toBe(original);
    expect(env.archived("claude-code", "p/s.jsonl", 2)).toBeNull();
  });

  test("a file replaced by a longer one with a new inode becomes generation 1", async () => {
    const original = "old 1\nold 2\n";
    const local = env.write(env.claudeRoot, "p/s.jsonl", original);
    const collector = env.collector();
    await collector.scanOnce();

    const replacement = env.write(env.dir, "staging/replacement.jsonl", "new 1\nnew 2\nnew 3\nnew 4\n");
    renameSync(replacement, local);
    await collector.scanOnce();

    expect(env.archived("claude-code", "p/s.jsonl", 0)!.toString()).toBe(original);
    expectArchived("claude-code", "p/s.jsonl", local, 1);
  });

  test("several truncations while the server is down cost only one generation", async () => {
    const local = env.write(env.claudeRoot, "p/s.jsonl", "first life\n");
    const collector = env.collector();
    await collector.scanOnce();
    await env.stopServer();

    for (const content of ["second\n", "3\n", "the fourth and final life\n"]) {
      writeFileSync(local, content);
      expect((await collector.scanOnce()).ok).toBe(false);
    }

    env.restartServer();
    expect((await collector.scanOnce()).ok).toBe(true);
    expect(env.archived("claude-code", "p/s.jsonl", 0)!.toString()).toBe("first life\n");
    expectArchived("claude-code", "p/s.jsonl", local, 1);
    expect(env.archived("claude-code", "p/s.jsonl", 2)).toBeNull();
  });
});

describe("server downtime", () => {
  test("uploads resume after the server goes down and comes back", async () => {
    const a = env.write(env.claudeRoot, "p/a.jsonl", "a1\n");
    const collector = env.collector();
    collector.start();
    await waitFor(() => env.archived("claude-code", "p/a.jsonl") !== null, "first upload");
    // The server archives before the collector saves its state, so the snapshot below must wait for the save.
    await waitFor(
      () => existsSync(env.stateFile) && readState().files[stateKey("claude-code", "p/a.jsonl")]?.bytes_sent === 3,
      "state saved",
    );

    await env.stopServer();
    const stateBefore = readFileSync(env.stateFile, "utf8");
    appendFileSync(a, "a2 written while down\n");
    const b = env.write(env.codexRoot, "b.jsonl", "b1 created while down\n");
    await waitFor(() => env.logs.some((line) => line.includes("backing off")), "backoff");
    await Bun.sleep(60);

    expect(readFileSync(env.stateFile, "utf8")).toBe(stateBefore);
    expect(env.archived("claude-code", "p/a.jsonl")!.toString()).toBe("a1\n");
    expect(env.archived("codex", "b.jsonl")).toBeNull();

    env.restartServer();
    await waitFor(
      () => env.archived("claude-code", "p/a.jsonl")?.length === statSync(a).size && env.archived("codex", "b.jsonl") !== null,
      "catch-up",
    );
    expectArchived("claude-code", "p/a.jsonl", a);
    expectArchived("codex", "b.jsonl", b);
    await waitFor(() => env.logs.some((line) => line.includes("reachable again")), "recovery to be logged");

    appendFileSync(a, "a3 after recovery\n");
    await waitFor(() => env.archived("claude-code", "p/a.jsonl")?.length === statSync(a).size, "normal service");
    expectArchived("claude-code", "p/a.jsonl", a);
  });

  test("an unreachable server leaves state untouched and reports the pass as failed", async () => {
    env.write(env.claudeRoot, "p/a.jsonl", "a1\n");
    await env.stopServer();

    const result = await env.collector().scanOnce();

    expect(result.ok).toBe(false);
    expect(result.sources[0]).toEqual({ name: "claude-code", files: 1, bytes_pending: 3, pending_files: 1 });
    expect(existsSync(env.stateFile)).toBe(false);
  });

  test("a rejected token is treated as an outage, not as a bad file", async () => {
    const local = env.write(env.claudeRoot, "p/a.jsonl", "a1\n");
    writeFileSync(join(env.dir, "bad-token"), "rsp_ingest_not-a-real-token\n");
    const bad = env.collector({ token_file: join(env.dir, "bad-token") });

    expect(await bad.scanOnce()).toMatchObject({ ok: false, skipped: 0 });
    expect(existsSync(env.stateFile)).toBe(false);
    expect(listFiles(env.server.db)).toEqual([]);

    expect((await env.collector().scanOnce()).ok).toBe(true);
    expectArchived("claude-code", "p/a.jsonl", local);
  });
});

describe("lost or stale state", () => {
  test("a lost state file resumes from the server's offsets without duplicating anything", async () => {
    const a = env.write(env.claudeRoot, "p/a.jsonl", "a1\na2\n");
    const b = env.write(env.codexRoot, "b.jsonl", "b1\n");
    await env.collector().scanOnce();
    appendFileSync(a, "a3 after the loss\n");
    rmSync(dirname(env.stateFile), { recursive: true });

    const result = await env.collector().scanOnce();

    expect(result.ok).toBe(true);
    expect(result.uploadedBytes).toBe(18);
    expectArchived("claude-code", "p/a.jsonl", a);
    expectArchived("codex", "b.jsonl", b);
    expect(listFiles(env.server.db).map((f) => [f.path, f.generation, f.size])).toEqual([
      ["p/a.jsonl", 0, statSync(a).size],
      ["b.jsonl", 0, 3],
    ]);
    expect(readState().files[stateKey("codex", "b.jsonl")]).toMatchObject({ generation: 0, bytes_sent: 3 });
  });

  test("with state lost after a truncation, the newest generation is adopted, not duplicated", async () => {
    const local = env.write(env.claudeRoot, "p/s.jsonl", "generation zero, a long first life\n");
    const first = env.collector();
    await first.scanOnce();
    writeFileSync(local, "gen one\n");
    await first.scanOnce();
    appendFileSync(local, "more of gen one\n");
    rmSync(env.stateFile);

    await env.collector().scanOnce();

    expect(env.archived("claude-code", "p/s.jsonl", 0)!.toString()).toBe("generation zero, a long first life\n");
    expectArchived("claude-code", "p/s.jsonl", local, 1);
    expect(env.archived("claude-code", "p/s.jsonl", 2)).toBeNull();
    expect(readState().files[stateKey("claude-code", "p/s.jsonl")]).toMatchObject({ generation: 1, bytes_sent: 24 });
  });

  test("with state lost and a local file shorter than the server's copy, a new generation starts", async () => {
    const local = env.write(env.claudeRoot, "p/s.jsonl", "a long line the server will hold\n");
    await env.collector().scanOnce();
    rmSync(env.stateFile);
    writeFileSync(local, "short\n");

    await env.collector().scanOnce();

    expect(env.archived("claude-code", "p/s.jsonl", 0)!.toString()).toBe("a long line the server will hold\n");
    expectArchived("claude-code", "p/s.jsonl", local, 1);
  });

  test("a crash after the server stored bytes but before state was saved does not duplicate them", async () => {
    const local = env.write(env.claudeRoot, "p/s.jsonl", "one\n");
    await env.collector().scanOnce();
    const stale = join(env.dir, "stale-state.json");
    copyFileSync(env.stateFile, stale);
    appendFileSync(local, "two\n");
    await env.collector().scanOnce();
    copyFileSync(stale, env.stateFile);
    appendFileSync(local, "three\n");

    await env.collector().scanOnce();

    expectArchived("claude-code", "p/s.jsonl", local);
    expect(getFile(env.server.db, { machine: MACHINE, source: "claude-code", path: "p/s.jsonl" }, 0)?.size).toBe(14);
  });

  test("a corrupt state file is ignored rather than fatal", async () => {
    const local = env.write(env.claudeRoot, "p/s.jsonl", "one\n");
    await env.collector().scanOnce();
    writeFileSync(env.stateFile, '{"version":1,"files":{"trunc');
    appendFileSync(local, "two\n");

    expect((await env.collector().scanOnce()).ok).toBe(true);
    expectArchived("claude-code", "p/s.jsonl", local);
    expect(env.logs.some((line) => line.includes("state file ignored"))).toBe(true);
    expect(readState().version).toBe(1);
  });

  test("the state file is replaced atomically and holds only the documented fields", async () => {
    env.write(env.claudeRoot, "p/s.jsonl", "one\n");
    await env.collector().scanOnce();

    expect(readdirSync(dirname(env.stateFile))).toEqual(["collector-state.json"]);
    const state = readState();
    expect(Object.keys(state)).toEqual(["version", "files"]);
    expect(Object.keys(state.files)).toEqual(["claude-code\u0000p/s.jsonl"]);
    expect(Object.keys(state.files["claude-code\u0000p/s.jsonl"]!).sort()).toEqual(["bytes_sent", "generation", "inode"]);
  });
});

describe("files the server refuses", () => {
  test("an unarchivable name is skipped until it changes and does not block other files", async () => {
    const bad = env.write(env.claudeRoot, "p/a\\b.jsonl", "cannot be archived\n");
    const reserved = env.write(env.claudeRoot, "p/session.g1", "reserved suffix\n");
    const good = env.write(env.claudeRoot, "p/z-good.jsonl", "fine\n");
    const collector = env.collector({
      sources: [{ name: "claude-code", root: env.claudeRoot, glob: "**/*" }],
    });

    const first = await collector.scanOnce();
    expect(first).toMatchObject({ ok: true, files: 3, requests: 3, skipped: 2 });
    expectArchived("claude-code", "p/z-good.jsonl", good);
    expect(listFiles(env.server.db).map((f) => f.path)).toEqual(["p/z-good.jsonl"]);
    expect(env.logs.filter((line) => line.includes("skipped until it changes"))).toHaveLength(2);

    appendFileSync(good, "still fine\n");
    const second = await collector.scanOnce();
    expect(second).toMatchObject({ ok: true, requests: 1, skipped: 2 });
    expectArchived("claude-code", "p/z-good.jsonl", good);
    expect(env.logs.filter((line) => line.includes("skipped until it changes"))).toHaveLength(2);

    appendFileSync(bad, "changed\n");
    const third = await collector.scanOnce();
    expect(third).toMatchObject({ ok: true, requests: 1, skipped: 2 });
    expect(readFileSync(bad, "utf8")).toBe("cannot be archived\nchanged\n");
    expect(readFileSync(reserved, "utf8")).toBe("reserved suffix\n");
  });
});

describe("heartbeat", () => {
  test("the daemon reports its version, file counts and pending bytes", async () => {
    env.write(env.claudeRoot, "p/a.jsonl", "a1\npartial");
    env.write(env.claudeRoot, "p/b.jsonl", "b1\n");
    env.write(env.codexRoot, "c.jsonl", "c1\n");
    env.collector().start();

    await waitFor(() => getMachine(env.server.db, MACHINE)?.last_heartbeat_at != null, "heartbeat");

    const row = getMachine(env.server.db, MACHINE)!;
    expect(row.collector_version).toBe(COLLECTOR_VERSION);
    expect(JSON.parse(row.sources!)).toEqual([
      { name: "claude-code", files: 2, bytes_pending: 7, pending_files: 1 },
      { name: "codex", files: 1, bytes_pending: 0, pending_files: 0 },
    ]);
    expect(row.last_ingest_at).not.toBeNull();
  });

  test("the heartbeat carries host facts, the last upload and the last error", async () => {
    env.write(env.claudeRoot, "p/a.jsonl", "a1\n");
    env.collector().start();
    await waitFor(() => getMachine(env.server.db, MACHINE)?.last_heartbeat_at != null, "heartbeat");

    const row = getMachine(env.server.db, MACHINE)!;
    expect(row.platform).toBe(`${process.platform}-${process.arch}`);
    expect(row.hostname).toBeTruthy();
    expect(Date.parse(row.started_at!)).not.toBeNaN();
    expect(Date.parse(row.last_upload_at!)).not.toBeNaN();
    expect(Date.parse(row.last_scan_at!)).not.toBeNaN();
    expect(row.last_error).toBeNull();
  });

  test("a skipped file is reported as the last error without its contents", async () => {
    const file = env.write(env.claudeRoot, "p/secret.jsonl", "TOP-SECRET-CONTENT\n");
    chmodSync(file, 0o000);
    const collector = env.collector();
    try {
      await collector.scanOnce();
    } finally {
      chmodSync(file, 0o600);
    }
    // Root can read a file with no permissions, so nothing is skipped there.
    if (process.getuid?.() === 0) return;
    const message = collector.snapshot().last_error?.message ?? "";
    expect(message).toContain("file skipped: claude-code/p/secret.jsonl");
    expect(message).not.toContain("TOP-SECRET");
  });

  test("heartbeats repeat on their interval", async () => {
    env.collector({ heartbeat_seconds: 0.03 }).start();
    await waitFor(() => getMachine(env.server.db, MACHINE)?.last_heartbeat_at != null, "first heartbeat");
    const first = getMachine(env.server.db, MACHINE)!.last_heartbeat_at;
    await waitFor(() => getMachine(env.server.db, MACHINE)!.last_heartbeat_at !== first, "second heartbeat");
  });
});

describe("lifecycle", () => {
  test("stop ends the daemon: later changes are not uploaded", async () => {
    const local = env.write(env.claudeRoot, "p/a.jsonl", "a1\n");
    const collector = env.collector();
    collector.start();
    await waitFor(() => env.archived("claude-code", "p/a.jsonl") !== null, "upload");

    await collector.stop();
    appendFileSync(local, "a2\n");
    await Bun.sleep(80);

    expect(env.archived("claude-code", "p/a.jsonl")!.toString()).toBe("a1\n");
    expect(collector.scanOnce()).rejects.toThrow("stopped");
  });
});
