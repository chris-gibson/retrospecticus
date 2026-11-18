import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { listChunks } from "../src/db/chunks.ts";
import { upsertFileSize } from "../src/db/files.ts";
import { openDb, type Db } from "../src/db/index.ts";
import { insertMessage, insertRecord, listMessages } from "../src/db/messages.ts";
import { applySessionPatch, getSession, markChunkDirty, type SessionOrigin } from "../src/db/sessions.ts";
import {
  applyChunkSettings,
  chunkSession,
  createChunkStage,
  estimateTokens,
  isSearchable,
  splitTurn,
} from "../src/indexer/chunk.ts";
import type { MessageRole } from "@retrospecticus/shared";

let db: Db;
let origin: SessionOrigin;
let nextOffset: number;
const nextOrdinals = new Map<string, number>();

beforeEach(() => {
  db = openDb(":memory:");
  const file = upsertFileSize(db, { machine: "m1", source: "claude-code", path: "p/s.jsonl" }, 0, 100);
  origin = { source: "claude-code", machine: "m1", fileId: file.id };
  nextOffset = 0;
  nextOrdinals.clear();
});
afterEach(() => db.close());

function makeSession(id: string, kind?: "main" | "subagent" | "guardian") {
  applySessionPatch(db, { id, kind }, origin);
}

function addMessage(sessionId: string, role: MessageRole, text: string) {
  const ordinal = nextOrdinals.get(sessionId) ?? 0;
  nextOrdinals.set(sessionId, ordinal + 1);
  const recordId = insertRecord(db, { fileId: origin.fileId, byteOffset: nextOffset, byteLength: 10, type: role });
  nextOffset += 10;
  insertMessage(db, {
    sessionId,
    ordinal,
    role,
    text,
    recordId,
    part: 0,
    timestamp: new Date(Date.UTC(2026, 10, 16, 10, 0, ordinal)).toISOString(),
  });
}

function run(sessionId: string, rewritten = false) {
  markChunkDirty(db, [sessionId], rewritten);
  return chunkSession(db, getSession(db, sessionId)!);
}

const ids = (sessionId: string) => listChunks(db, sessionId).map((c) => c.id);

describe("splitTurn", () => {
  test("a short turn is one chunk with the exact layout", () => {
    expect(splitTurn("hello", "world")).toEqual(["User: hello\n\nAssistant: world"]);
    expect(splitTurn(null, "world")).toEqual(["Assistant: world"]);
    expect(splitTurn("hello", "")).toEqual(["User: hello"]);
  });

  test("a long turn splits within the limit, overlaps and leads later parts", () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ${"word ".repeat(70)}`.trim());
    const parts = splitTurn("How do I do the thing?", paragraphs.join("\n\n"));
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) expect(estimateTokens(part)).toBeLessThanOrEqual(400);
    expect(parts[0]!.startsWith("User: How do I do the thing?\n\nAssistant: Paragraph 0")).toBe(true);
    for (const part of parts.slice(1)) expect(part.startsWith("User: How do I do the thing?\n\n")).toBe(true);
    for (let i = 1; i < parts.length; i++) {
      const previousEnd = parts[i - 1]!.slice(-100);
      expect(parts[i]!.includes(previousEnd)).toBe(true);
    }
  });

  test("the lead is the first 200 characters of the user text on one line", () => {
    const user = `first line\nsecond ${"x".repeat(400)}`;
    const parts = splitTurn(user, "a. ".repeat(1000));
    const lead = parts[1]!.split("\n\n")[0]!;
    expect(lead).toBe(`User: ${user.replace(/\s+/g, " ").slice(0, 200)}`);
    expect(lead).not.toContain("\n");
  });

  test("falls back to sentences when a paragraph is too long", () => {
    const text = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} ends here.`).join(" ");
    const parts = splitTurn("q", text);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(estimateTokens(part)).toBeLessThanOrEqual(400);
    expect(parts[1]!.split("\n\n")[1]).toMatch(/^[^.]*\.|^\S/);
  });

  test("hard cuts when there is no paragraph or sentence boundary", () => {
    const parts = splitTurn("q", "x".repeat(5000));
    expect(parts.length).toBeGreaterThan(3);
    for (const part of parts) expect(estimateTokens(part)).toBeLessThanOrEqual(400);
    expect(parts[1]!.startsWith("User: q\n\n")).toBe(true);
  });

  test("limits are parameters", () => {
    const parts = splitTurn("q", "word ".repeat(100), { maxTokens: 40, overlapTokens: 5 });
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(estimateTokens(part)).toBeLessThanOrEqual(40);
  });
});

describe("isSearchable", () => {
  test("only user and assistant", () => {
    expect(isSearchable("user")).toBe(true);
    expect(isSearchable("assistant")).toBe(true);
    for (const role of ["tool_call", "tool_result", "reasoning"] as const) expect(isSearchable(role)).toBe(false);
  });
});

describe("chunkSession", () => {
  test("builds turns and leaves non-searchable messages out", () => {
    makeSession("s");
    addMessage("s", "user", "run the build");
    addMessage("s", "reasoning", "SECRETTHOUGHT plan");
    addMessage("s", "tool_call", "TOOLCALLTEXT ls");
    addMessage("s", "tool_result", "TOOLRESULTTEXT files");
    addMessage("s", "assistant", "the build passed");
    addMessage("s", "user", "now deploy");
    addMessage("s", "assistant", "deployed");
    expect(run("s")).toEqual({ inserted: 2, deleted: 0, kept: 0 });
    const chunks = listChunks(db, "s");
    expect(chunks.map((c) => c.text)).toEqual([
      "User: run the build\n\nAssistant: the build passed",
      "User: now deploy\n\nAssistant: deployed",
    ]);
    for (const word of ["SECRETTHOUGHT", "TOOLCALLTEXT", "TOOLRESULTTEXT"]) {
      expect(chunks.some((c) => c.text.includes(word))).toBe(false);
    }
    const messages = listMessages(db, "s");
    expect(chunks[0]).toMatchObject({
      start_message_id: messages[0]!.id,
      end_message_id: messages[4]!.id,
      ordinal: 0,
      part: 0,
      timestamp: messages[0]!.timestamp,
    });
    expect(chunks[1]).toMatchObject({ start_message_id: messages[5]!.id, end_message_id: messages[6]!.id, ordinal: 5 });
    expect(getSession(db, "s")!.chunk_dirty).toBe(0);
  });

  test("consecutive user messages are separate turns", () => {
    makeSession("s");
    addMessage("s", "user", "one");
    addMessage("s", "user", "two");
    addMessage("s", "assistant", "answer");
    run("s");
    expect(listChunks(db, "s").map((c) => c.text)).toEqual(["User: one", "User: two\n\nAssistant: answer"]);
  });

  test("an assistant-only session still produces chunks", () => {
    makeSession("s");
    addMessage("s", "assistant", "a");
    addMessage("s", "assistant", "b");
    run("s");
    expect(listChunks(db, "s").map((c) => c.text)).toEqual(["Assistant: a\n\nb"]);
  });

  test("guardian sessions get no chunks and lose existing ones", () => {
    makeSession("g", "guardian");
    addMessage("g", "user", "hi");
    addMessage("g", "assistant", "hello");
    expect(run("g")).toEqual({ inserted: 0, deleted: 0, kept: 0 });
    expect(listChunks(db, "g")).toEqual([]);
    expect(getSession(db, "g")!.chunk_dirty).toBe(0);

    makeSession("m");
    addMessage("m", "user", "hi");
    run("m");
    db.run("UPDATE sessions SET kind = 'guardian' WHERE id = 'm'");
    expect(run("m").deleted).toBe(1);
    expect(listChunks(db, "m")).toEqual([]);
  });

  test("appending keeps earlier chunk ids and only touches the last turn", () => {
    makeSession("s");
    addMessage("s", "user", "q1");
    addMessage("s", "assistant", "a1");
    addMessage("s", "user", "q2");
    addMessage("s", "assistant", "a2");
    run("s");
    const before = listChunks(db, "s");

    addMessage("s", "assistant", "a2 continued");
    addMessage("s", "user", "q3");
    addMessage("s", "assistant", "a3");
    const result = run("s");
    const after = listChunks(db, "s");
    expect(result).toEqual({ inserted: 2, deleted: 1, kept: 0 });
    expect(after.length).toBe(3);
    expect(after[0]!.id).toBe(before[0]!.id);
    expect(after[1]!.id).not.toBe(before[1]!.id);
    expect(after[1]!.text).toBe("User: q2\n\nAssistant: a2\n\na2 continued");
    expect(after[2]!.text).toBe("User: q3\n\nAssistant: a3");

    const unchanged = run("s");
    expect(unchanged).toEqual({ inserted: 0, deleted: 0, kept: 1 });
    expect(ids("s")).toEqual(after.map((c) => c.id));
  });

  test("a rewritten session re-chunks fully but surviving chunks keep their ids", () => {
    makeSession("s");
    addMessage("s", "user", "q1");
    addMessage("s", "assistant", "a1");
    addMessage("s", "user", "q2");
    addMessage("s", "assistant", "a2");
    run("s");
    const before = listChunks(db, "s");

    db.run("UPDATE messages SET text = 'a1 changed' WHERE session_id = 's' AND ordinal = 1");
    const result = run("s", true);
    const after = listChunks(db, "s");
    expect(result).toEqual({ inserted: 1, deleted: 1, kept: 1 });
    expect(after[0]!.text).toBe("User: q1\n\nAssistant: a1 changed");
    expect(after[1]!.id).toBe(before[1]!.id);
  });

  test("a surviving chunk that moved gets its position updated and keeps its id", () => {
    makeSession("s");
    addMessage("s", "user", "q1");
    addMessage("s", "assistant", "a1");
    addMessage("s", "user", "q2");
    addMessage("s", "assistant", "a2");
    run("s");
    const before = listChunks(db, "s");

    db.run("UPDATE messages SET ordinal = ordinal + 10 WHERE session_id = 's'");
    run("s", true);
    const after = listChunks(db, "s");
    expect(after.map((c) => c.id)).toEqual(before.map((c) => c.id));
    expect(after.map((c) => c.ordinal)).toEqual([10, 12]);
  });

  test("secrets are redacted in chunks but not in messages", () => {
    const secret = "sk-FAKEFAKEFAKEFAKEFAKE1234";
    makeSession("s");
    addMessage("s", "user", `my key is ${secret}`);
    addMessage("s", "assistant", "password=hunter2fake noted");
    run("s");
    const [chunk] = listChunks(db, "s");
    expect(chunk!.text).not.toContain(secret);
    expect(chunk!.text).not.toContain("hunter2fake");
    expect(chunk!.text).toContain("my key is [REDACTED]");
    expect(listMessages(db, "s")[0]!.text).toContain(secret);
  });

  test("chunks_fts finds a chunk word and stops after the chunk is deleted", () => {
    makeSession("s");
    addMessage("s", "user", "tell me about zeppelins");
    addMessage("s", "assistant", "they float");
    run("s");
    const [chunk] = listChunks(db, "s");
    const find = () =>
      db.query<{ rowid: number }, [string]>("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?").all("zeppelins");
    expect(find().map((r) => r.rowid)).toEqual([chunk!.id]);

    db.run("UPDATE messages SET text = 'tell me about blimps' WHERE session_id = 's' AND ordinal = 0");
    run("s", true);
    expect(find()).toEqual([]);
  });
});

describe("createChunkStage", () => {
  test("processes dirty sessions and reports whether it did work", () => {
    makeSession("s");
    addMessage("s", "user", "hi");
    markChunkDirty(db, ["s"]);
    const stage = createChunkStage();
    expect(stage.name).toBe("chunk");
    expect(stage.run(db)).toBe(true);
    expect(listChunks(db, "s").length).toBe(1);
    expect(stage.run(db)).toBe(false);
  });

  test("new chunk settings re-chunk every session, keeping chunks whose text is unchanged", () => {
    makeSession("short");
    addMessage("short", "user", "hi");
    addMessage("short", "assistant", "hello");
    makeSession("long");
    addMessage("long", "user", "explain");
    addMessage("long", "assistant", Array.from({ length: 8 }, (_, i) => `Point ${i}. ${"detail ".repeat(40)}`).join("\n\n"));
    markChunkDirty(db, ["short", "long"]);
    createChunkStage().run(db);
    const shortIds = ids("short");
    expect(shortIds).toHaveLength(1);
    const longCount = ids("long").length;

    // A fresh database records the defaults without queuing anything.
    expect(applyChunkSettings(db, { maxTokens: 400, overlapTokens: 50 })).toBe(0);

    const smaller = createChunkStage({ maxTokens: 100, overlapTokens: 10 });
    expect(smaller.run(db)).toBe(true);
    expect(ids("short")).toEqual(shortIds);
    expect(ids("long").length).toBeGreaterThan(longCount);
    expect(listChunks(db, "long").every((c) => c.text.length <= 400)).toBe(true);

    // Same settings again: nothing to do.
    expect(createChunkStage({ maxTokens: 100, overlapTokens: 10 }).run(db)).toBe(false);
  });
});
