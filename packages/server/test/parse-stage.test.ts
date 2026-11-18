import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getFileById, rawRelativePath, upsertFileSize, type FileRow } from "../src/db/files.ts";
import { openDb, type Db } from "../src/db/index.ts";
import { countMessages, listMessages, listRecordsForFile } from "../src/db/messages.ts";
import { clearChunkDirty, getSession, listChunkDirtySessions, listSessions, listSessionsForFile } from "../src/db/sessions.ts";
import { reparseFile, reparseRange, runParse } from "../src/indexer/parse.ts";
import type { BatchStats, LineObserver, ParsedLine } from "../src/indexer/types.ts";
import { parsers } from "../src/parsers/index.ts";
import type { Parser } from "../src/parsers/types.ts";
import { archive, archiveFixture, archivedPath, fixtureLines, manifest, tempDir } from "./fixture-helpers.ts";

type Json = Record<string, any>;

let db: Db;
let rawDir: string;

beforeEach(() => {
  db = openDb(":memory:");
  rawDir = tempDir();
});
afterEach(() => {
  db.close();
  rmSync(rawDir, { recursive: true, force: true });
});

const T0 = Date.parse("2026-11-16T10:00:00.000Z");
const at = (i: number) => new Date(T0 + i * 1000).toISOString();

function userLine(i: number, text: string, sessionId = "s-1"): string {
  return JSON.stringify({
    type: "user",
    uuid: `u-${sessionId}-${i}`,
    parentUuid: null,
    sessionId,
    timestamp: at(i),
    cwd: "/work/app",
    version: "2.1.325",
    promptSource: "typed",
    message: { role: "user", content: text },
  });
}

function assistantLine(i: number, text: string, sessionId = "s-1"): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `a-${sessionId}-${i}`,
    parentUuid: null,
    sessionId,
    timestamp: at(i),
    cwd: "/work/app",
    version: "2.1.325",
    message: {
      role: "assistant",
      content: [
        { type: "text", text },
        { type: "tool_use", id: `t-${i}`, name: "Bash", input: { command: "ls" } },
      ],
    },
  });
}

const CLAUDE = { source: "claude-code", path: "proj/s-1.jsonl" } as const;

function jsonl(lines: string[]): string {
  return lines.map((l) => `${l}\n`).join("");
}

function appendRaw(file: FileRow, content: string): FileRow {
  appendFileSync(join(rawDir, rawRelativePath(file)), content);
  return upsertFileSize(db, file, file.generation, file.size + Buffer.byteLength(content));
}

/** Everything the parse stage derives, without row ids, which a reparse is free to change. */
function derived() {
  return {
    sessions: listSessions(db).map(({ chunk_dirty: _dirty, ...session }) => session),
    messages: db
      .query<Json, []>(
        `SELECT m.session_id, m.ordinal, m.role, m.text, m.part, m.tool_name, m.timestamp,
                r.file_id, r.byte_offset, r.byte_length, r.record_type, r.native_id, r.parent_native_id
         FROM messages m JOIN records r ON r.id = m.record_id ORDER BY m.session_id, m.ordinal`,
      )
      .all(),
    records: db.query<Json, []>("SELECT file_id, byte_offset, byte_length, record_type, native_id, timestamp FROM records ORDER BY file_id, byte_offset").all(),
    files: db.query<Json, []>("SELECT id, parsed_offset, parser_state, harness_version, lines_read, messages_produced FROM files ORDER BY id").all(),
  };
}

function expectDenseOrdinals(): void {
  for (const session of listSessions(db)) {
    const ordinals = listMessages(db, session.id).map((m) => m.ordinal);
    expect(ordinals).toEqual(ordinals.map((_, i) => i));
  }
}

function archiveAllFixtures(): FileRow[] {
  return manifest.map((entry) => archiveFixture(db, rawDir, entry));
}

describe("runParse over the fixtures", () => {
  test("indexes every fixture, links subagents and guardians, and leaves nothing to do", () => {
    const files = archiveAllFixtures();
    const stats = runParse(db, rawDir, parsers, [], { maxBytesPerRun: Number.MAX_SAFE_INTEGER });
    expect(stats.didWork).toBe(true);
    expect(stats.files).toBe(files.length);
    expect(stats.lines).toBe(manifest.reduce((n, m) => n + m.lines, 0));
    expect(stats.messages).toBe(countMessages(db));
    expect(stats.messages).toBeGreaterThan(300);

    for (const file of files) {
      const row = getFileById(db, file.id)!;
      expect(row.parsed_offset).toBe(row.size);
      expect(row.harness_version).not.toBeNull();
    }
    expectDenseOrdinals();
    expect(runParse(db, rawDir, parsers).didWork).toBe(false);

    const subagent = manifest.find((m) => m.role === "subagent")!;
    const [, parentId, agentId] = /([^/]+)\/subagents\/agent-([^/]+)\.jsonl$/.exec(archivedPath(subagent))!;
    const child = getSession(db, `${parentId}:${agentId}`)!;
    expect(child.kind).toBe("subagent");
    expect(child.parent_session_id).toBe(parentId!);
    expect(getSession(db, parentId!)!.kind).toBe("main");
    expect(countMessages(db, child.id)).toBeGreaterThan(0);

    const guardian = manifest.find((m) => m.role === "guardian")!;
    const guardianFile = files[manifest.indexOf(guardian)]!;
    const guardianSessions = listSessionsForFile(db, guardianFile.id);
    expect(guardianSessions).toHaveLength(1);
    expect(guardianSessions[0]!.kind).toBe("guardian");
    expect(getSession(db, guardianSessions[0]!.parent_session_id!)).not.toBeNull();
    expect(countMessages(db, guardianSessions[0]!.id)).toBe(0);
    expect(listRecordsForFile(db, guardianFile.id)).toEqual([]);
    const guardianRow = getFileById(db, guardianFile.id)!;
    expect(guardianRow.lines_read).toBe(guardian.lines);
    expect(guardianRow.messages_produced).toBe(0);

    const spawned = manifest.find((m) => m.role === "spawned")!;
    const spawnedSessions = listSessionsForFile(db, files[manifest.indexOf(spawned)]!.id);
    expect(spawnedSessions.map((s) => s.kind)).toEqual(["subagent"]);
    expect(getSession(db, spawnedSessions[0]!.parent_session_id!)!.source).toBe("codex");

    for (const session of listSessions(db)) {
      expect(session.started_at! <= session.ended_at!).toBe(true);
      if (session.kind === "main" && session.source === "codex" && countMessages(db, session.id) > 0) {
        expect(session.title).not.toBeNull();
      }
    }
  });

  test("the window size does not change the result", () => {
    archiveAllFixtures();
    runParse(db, rawDir, parsers, [], { maxBytesPerRun: Number.MAX_SAFE_INTEGER });
    const whole = derived();

    const other = openDb(":memory:");
    const otherRaw = tempDir();
    try {
      for (const entry of manifest) archiveFixture(other, otherRaw, entry);
      let runs = 0;
      while (runParse(other, otherRaw, parsers, [], { windowBytes: 2000, maxBytesPerRun: 150_000 }).didWork) runs++;
      expect(runs).toBeGreaterThan(5);
      const saved = db;
      db = other;
      const windowed = derived();
      db = saved;
      expect(windowed).toEqual(whole);
    } finally {
      other.close();
      rmSync(otherRaw, { recursive: true, force: true });
    }
  });

  test("reparsing whole files and arbitrary line ranges reproduces the same rows", () => {
    const files = archiveAllFixtures();
    runParse(db, rawDir, parsers, [], { maxBytesPerRun: Number.MAX_SAFE_INTEGER });
    const before = derived();

    for (const file of files) reparseFile(db, rawDir, parsers, [], file.id, { windowBytes: 50_000 });
    expect(derived()).toEqual(before);

    for (const file of files) {
      const records = listRecordsForFile(db, file.id);
      if (records.length < 6) continue;
      const from = records[Math.floor(records.length / 3)]!;
      const to = records[Math.floor((2 * records.length) / 3)]!;
      const stats = reparseRange(db, rawDir, parsers, [], file.id, from.byte_offset, to.byte_offset + to.byte_length);
      expect(stats.lines).toBeGreaterThan(0);
    }
    expect(derived()).toEqual(before);
    expectDenseOrdinals();
  });
});

describe("runParse", () => {
  test("appended lines continue the session's ordinals and mark it for chunking", () => {
    let file = archive(db, rawDir, CLAUDE, jsonl([userLine(0, "first prompt"), assistantLine(1, "first answer")]));
    runParse(db, rawDir, parsers);
    expect(listMessages(db, "s-1").map((m) => [m.ordinal, m.role, m.part, m.tool_name])).toEqual([
      [0, "user", 0, null],
      [1, "assistant", 0, null],
      [2, "tool_call", 1, "Bash"],
    ]);
    expect(listChunkDirtySessions(db).map((s) => s.id)).toEqual(["s-1"]);
    clearChunkDirty(db, "s-1");

    expect(runParse(db, rawDir, parsers).didWork).toBe(false);
    expect(listChunkDirtySessions(db)).toEqual([]);

    file = appendRaw(file, jsonl([userLine(2, "second prompt")]));
    const stats = runParse(db, rawDir, parsers);
    expect(stats).toMatchObject({ files: 1, lines: 1, messages: 1, chars: "second prompt".length, didWork: true });
    expect(listMessages(db, "s-1").map((m) => m.ordinal)).toEqual([0, 1, 2, 3]);
    expect(listChunkDirtySessions(db).map((s) => s.id)).toEqual(["s-1"]);

    const session = getSession(db, "s-1")!;
    expect(session).toMatchObject({
      source: "claude-code",
      machine: "laptop",
      kind: "main",
      project_path: "/work/app",
      harness_version: "2.1.325",
      started_at: at(0),
      ended_at: at(2),
      file_id: file.id,
    });
    expect(getFileById(db, file.id)).toMatchObject({ parsed_offset: file.size, lines_read: 3, messages_produced: 4, harness_version: "2.1.325" });
  });

  test("records point at the exact bytes of their line", () => {
    const lines = [userLine(0, "naïve café ☕ prompt"), assistantLine(1, "réponse")];
    const file = archive(db, rawDir, CLAUDE, jsonl(lines));
    runParse(db, rawDir, parsers);
    const raw = Buffer.from(jsonl(lines));
    const records = listRecordsForFile(db, file.id);
    expect(records.map((r) => raw.subarray(r.byte_offset, r.byte_offset + r.byte_length).toString())).toEqual(lines);
    expect(records.map((r) => [r.record_type, r.native_id])).toEqual([
      ["user", "u-s-1-0"],
      ["assistant", "a-s-1-1"],
    ]);
  });

  test("an unfinished last line waits for its newline", () => {
    const second = userLine(1, "second prompt");
    let file = archive(db, rawDir, CLAUDE, `${userLine(0, "first prompt")}\n${second.slice(0, 40)}`);
    expect(runParse(db, rawDir, parsers).lines).toBe(1);
    expect(getFileById(db, file.id)!.parsed_offset).toBe(Buffer.byteLength(userLine(0, "first prompt")) + 1);
    expect(runParse(db, rawDir, parsers).didWork).toBe(false);

    file = appendRaw(file, `${second.slice(40)}\n`);
    expect(runParse(db, rawDir, parsers).lines).toBe(1);
    expect(listMessages(db, "s-1").map((m) => m.text)).toEqual(["first prompt", "second prompt"]);
    expect(getFileById(db, file.id)!.parsed_offset).toBe(file.size);
  });

  test("a line larger than the window is read whole", () => {
    const big = "x".repeat(50_000);
    archive(db, rawDir, CLAUDE, jsonl([userLine(0, "small"), userLine(1, big), userLine(2, "after")]));
    let runs = 0;
    while (runParse(db, rawDir, parsers, [], { windowBytes: 1024 }).didWork) runs++;
    expect(runs).toBe(1);
    expect(listMessages(db, "s-1").map((m) => m.text.length)).toEqual([5, 50_000, 5]);
  });

  test("maxBytesPerRun bounds one call and the next call resumes", () => {
    const lines = Array.from({ length: 40 }, (_, i) => userLine(i, `prompt number ${i} ${"y".repeat(200)}`));
    archive(db, rawDir, CLAUDE, jsonl(lines));
    const first = runParse(db, rawDir, parsers, [], { windowBytes: 1000, maxBytesPerRun: 3000 });
    expect(first.didWork).toBe(true);
    expect(first.lines).toBeLessThan(40);
    let total = first.lines;
    for (;;) {
      const next = runParse(db, rawDir, parsers, [], { windowBytes: 1000, maxBytesPerRun: 3000 });
      if (!next.didWork) break;
      total += next.lines;
    }
    expect(total).toBe(40);
    expect(listMessages(db, "s-1").map((m) => m.ordinal)).toEqual(lines.map((_, i) => i));
  });

  test("blank lines are skipped and unparseable lines produce nothing but still advance", () => {
    const file = archive(db, rawDir, CLAUDE, `${userLine(0, "one")}\n\n{broken json\n${JSON.stringify({ type: "brand-new" })}\n${userLine(1, "two")}\n`);
    const seen: ParsedLine[] = [];
    const stats = runParse(db, rawDir, parsers, [{ onLine: (_db, parsed) => void seen.push(parsed) }]);
    expect(stats.lines).toBe(4);
    expect(seen.map((p) => p.result.kind)).toEqual(["messages", "unknown", "unknown", "messages"]);
    expect(seen[1]!.json).toBeUndefined();
    expect(seen[2]!.json).toEqual({ type: "brand-new" });
    expect(listMessages(db, "s-1").map((m) => m.text)).toEqual(["one", "two"]);
    expect(getFileById(db, file.id)!.parsed_offset).toBe(file.size);
  });

  test("a parser that throws is reported as an unknown line instead of wedging the file", () => {
    const real = parsers["claude-code"];
    const flaky: Parser = { ...real, parse: (line, ctx) => { if (line.includes("explode")) throw new Error("boom"); return real.parse(line, ctx); } };
    archive(db, rawDir, CLAUDE, jsonl([userLine(0, "fine"), userLine(1, "explode"), userLine(2, "also fine")]));
    const seen: ParsedLine[] = [];
    runParse(db, rawDir, { ...parsers, "claude-code": flaky }, [{ onLine: (_db, parsed) => void seen.push(parsed) }]);
    expect(seen.map((p) => p.result.kind)).toEqual(["messages", "unknown", "messages"]);
    expect(seen[1]!.result).toMatchObject({ kind: "unknown", reason: "validation" });
    expect(listMessages(db, "s-1").map((m) => m.text)).toEqual(["fine", "also fine"]);
  });

  test("parser state persists across batches, so a Codex session keeps its identity", () => {
    const meta = { timestamp: at(0), type: "session_meta", payload: { id: "thread-1", cwd: "/work/app", cli_version: "0.169.0", source: "cli", thread_source: "user" } };
    const message = (i: number) => ({ timestamp: at(i), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `prompt ${i}` }] } });
    let file = archive(db, rawDir, { source: "codex", path: "2026/11/16/rollout-a.jsonl" }, jsonl([JSON.stringify(meta), JSON.stringify(message(1))]));
    runParse(db, rawDir, parsers);
    file = appendRaw(file, jsonl([JSON.stringify(message(2))]));
    runParse(db, rawDir, parsers);
    expect(listMessages(db, "thread-1").map((m) => m.text)).toEqual(["prompt 1", "prompt 2"]);
    expect(getSession(db, "thread-1")).toMatchObject({ title: "prompt 1", harness_version: "0.169.0", project_path: "/work/app" });
    expect(JSON.parse(getFileById(db, file.id)!.parser_state!)).toMatchObject({ sessionId: "thread-1", kind: "main" });
  });

  test("a later title of the same rank replaces the earlier one, and a custom title outranks both", () => {
    const title = (text: string) => JSON.stringify({ type: "ai-title", sessionId: "s-1", aiTitle: text });
    let file = archive(db, rawDir, CLAUDE, jsonl([userLine(0, "hello"), title("First guess")]));
    runParse(db, rawDir, parsers);
    expect(getSession(db, "s-1")!.title).toBe("First guess");
    file = appendRaw(file, jsonl([title("Better guess")]));
    runParse(db, rawDir, parsers);
    expect(getSession(db, "s-1")!.title).toBe("Better guess");
    file = appendRaw(file, jsonl([JSON.stringify({ type: "custom-title", sessionId: "s-1", customTitle: "Mine" }), title("Late guess")]));
    runParse(db, rawDir, parsers);
    expect(getSession(db, "s-1")).toMatchObject({ title: "Mine", title_rank: 2 });

    reparseRange(db, rawDir, parsers, [], file.id, 0, Buffer.byteLength(jsonl([userLine(0, "hello"), title("First guess")])));
    expect(getSession(db, "s-1")!.title).toBe("Mine");
  });
});

describe("observers", () => {
  test("see every line with its bytes, result and harness version, then the batch totals", () => {
    const lines = [userLine(0, "question"), JSON.stringify({ type: "mode", mode: "normal" }), assistantLine(1, "answer")];
    const file = archive(db, rawDir, CLAUDE, jsonl(lines));
    const seen: ParsedLine[] = [];
    const batches: { file: FileRow; stats: BatchStats }[] = [];
    const observer: LineObserver = {
      onLine: (_db, parsed) => void seen.push(parsed),
      onBatchEnd: (_db, f, stats) => void batches.push({ file: f, stats }),
    };
    runParse(db, rawDir, parsers, [observer]);

    const raw = Buffer.from(jsonl(lines));
    expect(seen.map((p) => raw.subarray(p.byteOffset, p.byteOffset + p.byteLength).toString())).toEqual(lines);
    expect(seen.map((p) => p.line)).toEqual(lines);
    expect(seen.map((p) => p.result.kind)).toEqual(["messages", "ignored", "messages"]);
    expect(seen.map((p) => p.harnessVersion)).toEqual(["2.1.325", "2.1.325", "2.1.325"]);
    expect(seen.every((p) => p.file.id === file.id && typeof p.json === "object")).toBe(true);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.stats).toEqual({ lines: 3, messages: 3, chars: "question".length + "answer".length + '{"command":"ls"}'.length });
    expect(batches[0]!.file).toMatchObject({ id: file.id, parsed_offset: file.size, lines_read: 3 });
  });

  test("what an observer writes commits with the batch, and its failure rolls the batch back", () => {
    db.run("CREATE TABLE seen (byte_offset INTEGER)");
    const file = archive(db, rawDir, CLAUDE, jsonl([userLine(0, "one"), userLine(1, "two")]));
    let failAt = 1;
    let calls = 0;
    const observer: LineObserver = {
      onLine(odb, parsed) {
        odb.run("INSERT INTO seen VALUES (?)", [parsed.byteOffset]);
        if (calls++ === failAt) throw new Error("observer failed");
      },
    };
    expect(() => runParse(db, rawDir, parsers, [observer])).toThrow("observer failed");
    expect(db.query("SELECT COUNT(*) AS n FROM seen").get()).toEqual({ n: 0 });
    expect(countMessages(db)).toBe(0);
    expect(listSessions(db)).toEqual([]);
    expect(getFileById(db, file.id)).toMatchObject({ parsed_offset: 0, lines_read: 0, parser_state: null });

    failAt = -1;
    runParse(db, rawDir, parsers, [observer]);
    expect(db.query("SELECT COUNT(*) AS n FROM seen").get()).toEqual({ n: 2 });
    expect(countMessages(db)).toBe(2);
  });

  test("a reparse replays onLine but not onBatchEnd", () => {
    const file = archive(db, rawDir, CLAUDE, jsonl([userLine(0, "one"), userLine(1, "two")]));
    let lines = 0;
    let batches = 0;
    const observer: LineObserver = { onLine: () => void lines++, onBatchEnd: () => void batches++ };
    runParse(db, rawDir, parsers, [observer]);
    reparseFile(db, rawDir, parsers, [observer], file.id);
    expect([lines, batches]).toEqual([4, 1]);
    expect(getFileById(db, file.id)).toMatchObject({ lines_read: 2, messages_produced: 2 });
  });
});

describe("reparseRange", () => {
  function seed(): { file: FileRow; lines: string[]; offsets: number[] } {
    const lines = [userLine(0, "alpha"), assistantLine(1, "beta"), userLine(2, "gamma"), assistantLine(3, "delta"), userLine(4, "omega")];
    const offsets: number[] = [];
    let offset = 0;
    for (const line of lines) {
      offsets.push(offset);
      offset += Buffer.byteLength(line) + 1;
    }
    const file = archive(db, rawDir, CLAUDE, jsonl(lines));
    runParse(db, rawDir, parsers);
    return { file, lines, offsets };
  }

  test("replaces the rows of the range and renumbers the session densely in file order", () => {
    const { file, lines, offsets } = seed();
    const before = derived();
    const idsBefore = listMessages(db, "s-1").map((m) => m.id);
    clearChunkDirty(db, "s-1");

    const stats = reparseRange(db, rawDir, parsers, [], file.id, offsets[1]!, offsets[2]! + Buffer.byteLength(lines[2]!));
    expect(stats).toMatchObject({ lines: 2, messages: 3, files: 1, didWork: true });
    expect(derived()).toEqual(before);
    expect(listMessages(db, "s-1").map((m) => m.text)).toEqual(["alpha", "beta", '{"command":"ls"}', "gamma", "delta", '{"command":"ls"}', "omega"]);
    const idsAfter = listMessages(db, "s-1").map((m) => m.id);
    expect(idsAfter.slice(1, 4)).not.toEqual(idsBefore.slice(1, 4));
    expect([idsAfter[0], ...idsAfter.slice(4)]).toEqual([idsBefore[0]!, ...idsBefore.slice(4)]);
    expect(listChunkDirtySessions(db).map((s) => s.id)).toEqual(["s-1"]);
    expect(getFileById(db, file.id)).toMatchObject({ parsed_offset: file.size, lines_read: 5, messages_produced: 7 });
  });

  test("a line that used to fail gains its messages in the right place after a parser fix", () => {
    const real = parsers["claude-code"];
    const blind: Parser = {
      ...real,
      parse: (line, ctx) => (line.includes("gamma") ? { kind: "unknown", reason: "unknown-type", recordType: "user", detail: "not yet supported" } : real.parse(line, ctx)),
    };
    const lines = [userLine(0, "alpha"), userLine(1, "gamma"), userLine(2, "omega")];
    const file = archive(db, rawDir, CLAUDE, jsonl(lines));
    const quarantine: LineObserver = {
      onLine(odb, parsed) {
        if (parsed.result.kind !== "unknown") return;
        odb.run("INSERT INTO quarantine (file_id, byte_offset, byte_length, reason, created_at) VALUES (?, ?, ?, ?, ?)", [
          parsed.file.id,
          parsed.byteOffset,
          parsed.byteLength,
          parsed.result.reason,
          at(0),
        ]);
      },
    };
    runParse(db, rawDir, { ...parsers, "claude-code": blind }, [quarantine]);
    expect(listMessages(db, "s-1").map((m) => [m.ordinal, m.text])).toEqual([[0, "alpha"], [1, "omega"]]);
    const held = db.query<{ byte_offset: number; byte_length: number }, []>("SELECT byte_offset, byte_length FROM quarantine").all();
    expect(held).toHaveLength(1);

    const still = reparseRange(db, rawDir, { ...parsers, "claude-code": blind }, [quarantine], file.id, held[0]!.byte_offset, held[0]!.byte_offset + held[0]!.byte_length);
    expect(still.lines).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM quarantine").get()).toEqual({ n: 1 });

    const stats = reparseRange(db, rawDir, parsers, [quarantine], file.id, held[0]!.byte_offset, held[0]!.byte_offset + held[0]!.byte_length);
    expect(stats).toMatchObject({ lines: 1, messages: 1 });
    expect(db.query("SELECT COUNT(*) AS n FROM quarantine").get()).toEqual({ n: 0 });
    expect(listMessages(db, "s-1").map((m) => [m.ordinal, m.text])).toEqual([[0, "alpha"], [1, "gamma"], [2, "omega"]]);
    expect(getFileById(db, file.id)).toMatchObject({ lines_read: 3, messages_produced: 3 });
  });

  test("never reads past parsed_offset and refuses an offset inside a line", () => {
    const { file, offsets } = seed();
    const grown = appendRaw(file, jsonl([userLine(5, "not parsed yet")]));
    const stats = reparseRange(db, rawDir, parsers, [], file.id, offsets[4]!, Number.MAX_SAFE_INTEGER);
    expect(stats.lines).toBe(1);
    expect(countMessages(db, "s-1")).toBe(7);
    expect(getFileById(db, file.id)!.parsed_offset).toBe(file.size);
    expect(grown.size).toBeGreaterThan(file.size);

    expect(() => reparseRange(db, rawDir, parsers, [], file.id, offsets[1]! + 3, offsets[2]!)).toThrow("not the start of a line");
    expect(() => reparseRange(db, rawDir, parsers, [], 9999, 0, 10)).toThrow("no file");
    expect(reparseRange(db, rawDir, parsers, [], file.id, file.size, file.size + 10).didWork).toBe(false);
  });
});

describe("generations", () => {
  test("parsing a newer generation removes what the older one produced", () => {
    const old = archive(db, rawDir, CLAUDE, jsonl([userLine(0, "old one"), userLine(1, "old two"), userLine(2, "only in the old file", "s-old")]));
    runParse(db, rawDir, parsers);
    expect(countMessages(db)).toBe(3);

    const next = archive(db, rawDir, { ...CLAUDE, generation: 1 }, jsonl([userLine(0, "rewritten")]));
    runParse(db, rawDir, parsers);
    expect(listMessages(db, "s-1").map((m) => [m.ordinal, m.text])).toEqual([[0, "rewritten"]]);
    expect(getSession(db, "s-old")).toBeNull();
    expect(getSession(db, "s-1")!.file_id).toBe(next.id);
    expect(listRecordsForFile(db, old.id)).toEqual([]);
    expect(listRecordsForFile(db, next.id)).toHaveLength(1);
  });

  test("an older generation that still has unparsed bytes is retired without being indexed", () => {
    const old = archive(db, rawDir, CLAUDE, jsonl([userLine(0, "old")]));
    const next = archive(db, rawDir, { ...CLAUDE, generation: 1 }, jsonl([userLine(0, "new")]));
    const seen: number[] = [];
    while (runParse(db, rawDir, parsers, [{ onLine: (_db, p) => void seen.push(p.file.id) }]).didWork);
    expect(seen).toEqual([next.id]);
    expect(listMessages(db, "s-1").map((m) => m.text)).toEqual(["new"]);
    expect(getFileById(db, old.id)).toMatchObject({ parsed_offset: old.size, lines_read: 0 });
    expect(reparseFile(db, rawDir, parsers, [], old.id).didWork).toBe(false);
    expect(listMessages(db, "s-1").map((m) => m.text)).toEqual(["new"]);
  });

  test("the same path on another machine is a different file and is left alone", () => {
    archive(db, rawDir, { ...CLAUDE, machine: "desktop" }, jsonl([userLine(0, "desktop prompt", "s-desktop")]));
    archive(db, rawDir, CLAUDE, jsonl([userLine(0, "old")]));
    runParse(db, rawDir, parsers);
    archive(db, rawDir, { ...CLAUDE, generation: 1 }, jsonl([userLine(0, "new")]));
    runParse(db, rawDir, parsers);
    expect(listMessages(db, "s-desktop").map((m) => m.text)).toEqual(["desktop prompt"]);
    expect(getSession(db, "s-desktop")!.machine).toBe("desktop");
  });
});

test("fixture lines survive a round trip through the archive byte for byte", () => {
  const entry = manifest.find((m) => m.role === "coverage" && m.source === "codex")!;
  const file = archiveFixture(db, rawDir, entry);
  const seen: string[] = [];
  runParse(db, rawDir, parsers, [{ onLine: (_db, p) => void seen.push(p.line) }]);
  expect(seen).toEqual(fixtureLines(entry));
  expect(getFileById(db, file.id)!.lines_read).toBe(entry.lines);
});
