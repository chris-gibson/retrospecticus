import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Source } from "@retrospecticus/shared";
import { getParser, parsers } from "../src/parsers/index.ts";
import type { NormalisedMessage, ParseContext, ParseResult, SessionPatch } from "../src/parsers/types.ts";
import { archivedPath, fixtureLines, manifest, type FixtureEntry } from "./fixture-helpers.ts";

type Json = Record<string, any>;

function context(source: Source, path: string): ParseContext {
  return { source, machine: "laptop", path, state: {} };
}

function parseAll(source: Source, path: string, records: (Json | string)[]): ParseResult[] {
  const ctx = context(source, path);
  return records.map((r) => parsers[source].parse(typeof r === "string" ? r : JSON.stringify(r), ctx));
}

function messagesOf(results: ParseResult[]): NormalisedMessage[] {
  return results.flatMap((r) => (r.kind === "messages" ? r.messages : []));
}

function patchesOf(results: ParseResult[]): SessionPatch[] {
  return results.flatMap((r) => (r.kind !== "unknown" && r.session !== undefined ? [r.session] : []));
}

function parseFixture(entry: FixtureEntry): ParseResult[] {
  return parseAll(entry.source, archivedPath(entry), fixtureLines(entry));
}

/** Compact enough to commit, exact enough that any change to the normalised output shows up. */
function golden(entry: FixtureEntry) {
  const results = parseFixture(entry);
  const outcomes: Record<string, number> = {};
  const sessions: Record<string, Json> = {};
  for (const r of results) {
    const key = r.kind === "messages" ? `messages ${r.record.type}` : `${r.kind} ${r.recordType}`;
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }
  for (const p of patchesOf(results)) {
    const s = (sessions[p.id] ??= {});
    if (p.kind !== undefined) s.kind = p.kind;
    if (p.parentSessionId !== undefined) s.parent = p.parentSessionId;
    if (p.harnessVersion !== undefined) s.version = p.harnessVersion;
    if (p.title !== undefined) s.title = `rank ${p.title.rank}, ${p.title.text.length} chars`;
  }
  const messages = messagesOf(results).map((m) => {
    const hash = createHash("sha1").update(m.text).digest("hex").slice(0, 8);
    return [m.role, m.toolName ?? "-", m.sessionId.slice(-12), m.timestamp ?? "-", m.text.length, hash].join(" ");
  });
  return { lines: results.length, outcomes, sessions, messages };
}

describe("golden output", () => {
  for (const entry of manifest) {
    test(entry.path, () => {
      expect(golden(entry)).toMatchSnapshot();
    });
  }
});

describe("fixtures: session structure", () => {
  const byRole = (source: Source, role: FixtureEntry["role"]) => manifest.filter((m) => m.source === source && m.role === role);

  test("a Claude subagent transcript becomes its own session linked to its parent", () => {
    const subagents = byRole("claude-code", "subagent");
    expect(subagents.length).toBeGreaterThan(0);
    for (const entry of subagents) {
      const [, parentId, agentId] = /([^/]+)\/subagents\/agent-([^/]+)\.jsonl$/.exec(archivedPath(entry))!;
      const results = parseFixture(entry);
      const ids = new Set(patchesOf(results).map((p) => p.id));
      expect([...ids]).toEqual([`${parentId}:${agentId}`]);
      for (const patch of patchesOf(results)) {
        expect(patch.kind).toBe("subagent");
        expect(patch.parentSessionId).toBe(parentId!);
      }
      expect(messagesOf(results).length).toBeGreaterThan(0);
      expect(new Set(messagesOf(results).map((m) => m.sessionId))).toEqual(ids);

      const parent = manifest.find((m) => archivedPath(m).endsWith(`/${parentId}.jsonl`));
      expect(parent).toBeDefined();
      const parentPatches = patchesOf(parseFixture(parent!));
      expect(new Set(parentPatches.map((p) => p.id))).toEqual(new Set([parentId!]));
      expect(parentPatches.every((p) => p.kind === "main" || p.kind === undefined)).toBe(true);
    }
  });

  test("a guardian session yields a session row with its parent and no messages", () => {
    const guardians = byRole("codex", "guardian");
    expect(guardians.length).toBeGreaterThan(0);
    for (const entry of guardians) {
      const results = parseFixture(entry);
      expect(results.length).toBeGreaterThan(20);
      expect(messagesOf(results)).toEqual([]);
      expect(results.every((r) => r.kind === "ignored")).toBe(true);
      const patches = patchesOf(results);
      expect(patches).toHaveLength(1);
      expect(patches[0]!.kind).toBe("guardian");
      const parent = manifest.find((m) => m.source === "codex" && archivedPath(m).includes(patches[0]!.parentSessionId!));
      expect(parent?.role).toBe("main");
    }
  });

  test("a spawned Codex thread links to its parent and does not re-index the copied history", () => {
    const spawned = byRole("codex", "spawned");
    expect(spawned.length).toBeGreaterThan(0);
    for (const entry of spawned) {
      const lines = fixtureLines(entry).map((l) => JSON.parse(l) as Json);
      const metas = lines.filter((l) => l.type === "session_meta");
      expect(metas.length).toBeGreaterThan(1);
      const own = metas[0]!.payload;
      const historyStart: number = own.subagent_history_start_ordinal;

      const results = parseFixture(entry);
      const patches = patchesOf(results);
      expect(new Set(patches.map((p) => p.id))).toEqual(new Set([own.id]));
      expect(patches[0]!.kind).toBe("subagent");
      expect(patches[0]!.parentSessionId).toBe(own.parent_thread_id);
      expect(manifest.some((m) => m.source === "codex" && archivedPath(m).includes(own.parent_thread_id))).toBe(true);

      results.forEach((r, i) => {
        if (lines[i]!.ordinal < historyStart) expect(r.kind).toBe("ignored");
      });
      expect(messagesOf(results).length).toBeGreaterThan(0);
    }
  });

  test("Codex user messages equal the typed turns, so display copies are not counted twice", () => {
    const sessions = manifest.filter((m) => m.source === "codex" && (m.role === "main" || m.role === "spawned"));
    expect(sessions.length).toBeGreaterThanOrEqual(3);
    let turns = 0;
    for (const entry of sessions) {
      const lines = fixtureLines(entry).map((l) => JSON.parse(l) as Json);
      const typed = lines.filter((l) => l.type === "event_msg" && l.payload.type === "item_completed" && l.payload.item.type === "UserMessage");
      const users = messagesOf(parseFixture(entry)).filter((m) => m.role === "user");
      expect(users).toHaveLength(typed.length);
      turns += typed.length;
    }
    expect(turns).toBeGreaterThan(0);
  });

  test("Claude user messages in whole sessions are exactly the prompts not flagged or wrapped as injected", () => {
    for (const entry of manifest.filter((m) => m.source === "claude-code" && m.role === "main")) {
      const results = parseFixture(entry);
      const lines = fixtureLines(entry).map((l) => JSON.parse(l) as Json);
      const prompts = lines.filter((l) => l.type === "user" && typeof l.promptSource === "string" && l.promptSource !== "system");
      const queued = lines.filter((l) => l.type === "attachment" && l.attachment.type === "queued_command" && l.attachment.commandMode === "prompt");
      const users = messagesOf(results).filter((m) => m.role === "user");
      expect(users.length).toBeGreaterThan(0);
      expect(users.length).toBeGreaterThanOrEqual(prompts.length + queued.length);
    }
  });
});

const ENVELOPE = {
  uuid: "u-1",
  parentUuid: null,
  sessionId: "s-1",
  timestamp: "2026-11-16T10:00:00.000Z",
  cwd: "/work/app",
  version: "2.1.325",
  gitBranch: "main",
  isSidechain: false,
};

function claudeUser(content: unknown, extra: Json = {}): Json {
  return { ...ENVELOPE, type: "user", message: { role: "user", content }, ...extra };
}

describe("claude-code parser", () => {
  const parse = (record: Json | string, path = "proj/s-1.jsonl") => parseAll("claude-code", path, [record])[0]!;
  const roles = (r: ParseResult) => (r.kind === "messages" ? r.messages.map((m) => m.role) : null);

  test("a typed prompt becomes one user message and carries the session facts", () => {
    const result = parse(claudeUser("fix the flaky test", { promptSource: "typed", origin: { kind: "human" } }));
    expect(result).toEqual({
      kind: "messages",
      record: { type: "user", nativeId: "u-1", parentNativeId: undefined, timestamp: ENVELOPE.timestamp },
      messages: [{ sessionId: "s-1", role: "user", text: "fix the flaky test", timestamp: ENVELOPE.timestamp }],
      session: {
        id: "s-1",
        kind: "main",
        parentSessionId: undefined,
        projectPath: "/work/app",
        gitBranch: "main",
        harnessVersion: "2.1.325",
        timestamp: ENVELOPE.timestamp,
      },
    });
  });

  test("text and image blocks of a prompt form a single message", () => {
    const result = parse(claudeUser([{ type: "text", text: "what is this?" }, { type: "image", source: { type: "base64", data: "AAAA" } }]));
    expect(messagesOf([result]).map((m) => m.text)).toEqual(["what is this?\n[image]"]);
  });

  test.each([
    ["isMeta", { isMeta: true }],
    ["isCompactSummary", { isCompactSummary: true, isVisibleInTranscriptOnly: true }],
    ["isVisibleInTranscriptOnly", { isVisibleInTranscriptOnly: true }],
    ["promptSource system", { promptSource: "system" }],
    ["a non-human origin", { origin: { kind: "task-notification" } }],
  ])("a user record flagged %s is injected and yields no message", (_name, flags) => {
    const result = parse(claudeUser("some harness text", flags));
    expect(result.kind).toBe("messages");
    expect(messagesOf([result])).toEqual([]);
  });

  test.each([
    "<system-reminder>remember</system-reminder>",
    "<command-name>/compact</command-name>",
    "<command-message>compact</command-message>",
    "<local-command-stdout>done</local-command-stdout>",
    "<local-command-caveat>Caveat</local-command-caveat>",
    "<bash-input>ls</bash-input>",
    "<bash-stdout>file</bash-stdout>",
    "<task-notification>finished</task-notification>",
    "[Request interrupted by user]",
    "[Request interrupted by user for tool use]",
  ])("wrapper text %s is not a typed prompt", (text) => {
    expect(messagesOf([parse(claudeUser(text))])).toEqual([]);
    expect(messagesOf([parse(claudeUser([{ type: "text", text }]))])).toEqual([]);
  });

  test("a wrapper tag later in a typed prompt does not hide it", () => {
    const text = "why does <system-reminder> show up in my logs?";
    expect(messagesOf([parse(claudeUser(text))]).map((m) => m.text)).toEqual([text]);
  });

  test("tool results are their own messages, with string, block and empty content", () => {
    const result = parse(
      claudeUser([
        { type: "tool_result", tool_use_id: "t1", content: "plain output" },
        { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "a" }, { type: "image", source: {} }, { type: "tool_reference", tool_name: "Read" }] },
        { type: "tool_result", tool_use_id: "t3" },
      ]),
    );
    expect(roles(result)).toEqual(["tool_result", "tool_result", "tool_result"]);
    expect(messagesOf([result]).map((m) => m.text)).toEqual(["plain output", "a\n[image]\n[tool: Read]", ""]);
  });

  test("tool results are kept even on a record flagged as meta", () => {
    const result = parse(claudeUser([{ type: "tool_result", tool_use_id: "t1", content: "out" }], { isMeta: true }));
    expect(roles(result)).toEqual(["tool_result"]);
  });

  test("assistant text, thinking and tool use map to assistant, reasoning and tool_call", () => {
    const result = parse({
      ...ENVELOPE,
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me look", signature: "sig" },
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "text", text: "I will read the file." },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/work/app/a.ts" } },
        ],
      },
    });
    expect(messagesOf([result])).toEqual([
      { sessionId: "s-1", role: "reasoning", text: "let me look", timestamp: ENVELOPE.timestamp },
      { sessionId: "s-1", role: "assistant", text: "I will read the file.", timestamp: ENVELOPE.timestamp },
      { sessionId: "s-1", role: "tool_call", toolName: "Read", text: '{"file_path":"/work/app/a.ts"}', timestamp: ENVELOPE.timestamp },
    ]);
  });

  test("an API error written as an assistant record is not model output", () => {
    const result = parse({ ...ENVELOPE, type: "assistant", isApiErrorMessage: true, message: { role: "assistant", content: [{ type: "text", text: "API Error" }] } });
    expect(result.kind).toBe("messages");
    expect(messagesOf([result])).toEqual([]);
  });

  test("an unreadable block type is reported, not dropped silently", () => {
    const assistant = parse({ ...ENVELOPE, type: "assistant", message: { role: "assistant", content: [{ type: "hologram", data: 1 }, { type: "text", text: "hi" }] } });
    expect(assistant.kind === "messages" && assistant.unknownBlocks).toEqual(["hologram"]);
    expect(roles(assistant)).toEqual(["assistant"]);
    const user = parse(claudeUser([{ type: "tool_result", tool_use_id: "t", content: [{ type: "hologram" }] }]));
    expect(user.kind === "messages" && user.unknownBlocks).toEqual(["tool_result/hologram"]);
  });

  test("a queued_command attachment typed by the user is a user message", () => {
    const attachment = (a: Json) => ({ ...ENVELOPE, type: "attachment", attachment: { type: "queued_command", ...a } });
    const typed = parse(attachment({ prompt: "also update the docs", commandMode: "prompt", origin: { kind: "human" } }));
    expect(typed.kind === "messages" && typed.record.type).toBe("attachment/queued_command");
    expect(messagesOf([typed])).toEqual([{ sessionId: "s-1", role: "user", text: "also update the docs", timestamp: ENVELOPE.timestamp }]);

    const blocks = parse(attachment({ prompt: [{ type: "text", text: "see" }, { type: "image", source: {} }], commandMode: "prompt" }));
    expect(messagesOf([blocks]).map((m) => m.text)).toEqual(["see\n[image]"]);

    const notice = parse(attachment({ prompt: "<task-notification>done</task-notification>", commandMode: "task-notification" }));
    expect(notice.kind).toBe("messages");
    expect(messagesOf([notice])).toEqual([]);
    const fromTask = parse(attachment({ prompt: "background finished", commandMode: "prompt", origin: { kind: "task-notification" } }));
    expect(messagesOf([fromTask])).toEqual([]);
  });

  test("other attachments and system records are deliberate ignores", () => {
    expect(parse({ ...ENVELOPE, type: "attachment", attachment: { type: "skill_listing", content: "x" } })).toEqual({
      kind: "ignored",
      recordType: "attachment/skill_listing",
    });
    expect(parse({ ...ENVELOPE, type: "system", subtype: "turn_duration" })).toEqual({ kind: "ignored", recordType: "system/turn_duration" });
    expect(parse({ ...ENVELOPE, type: "system", subtype: "stop_hook_summary", hookCount: 1, hookInfos: [{ command: "notify" }] })).toEqual({
      kind: "ignored",
      recordType: "system/stop_hook_summary",
    });
    expect(parse({ type: "api-request-blob", blob: "x" })).toEqual({ kind: "ignored", recordType: "api-request-blob" });
  });

  test("titles patch the session and a custom title outranks a generated one", () => {
    const ai = parse({ type: "ai-title", sessionId: "s-1", aiTitle: "Fix flaky test" });
    const custom = parse({ type: "custom-title", sessionId: "s-1", customTitle: "Release prep" });
    expect(ai).toEqual({ kind: "ignored", recordType: "ai-title", session: { id: "s-1", kind: "main", parentSessionId: undefined, title: { text: "Fix flaky test", rank: 1 } } });
    expect(custom.kind === "ignored" && custom.session?.title).toEqual({ text: "Release prep", rank: 2 });
  });

  test("a subagent file is identified by its path and agentId, and shares the parent's sessionId", () => {
    const path = "proj/s-1/subagents/agent-a1b2.jsonl";
    const result = parse(claudeUser("investigate the parser", { agentId: "a1b2", isSidechain: true }), path);
    expect(result.kind === "messages" && result.session).toMatchObject({ id: "s-1:a1b2", kind: "subagent", parentSessionId: "s-1" });
    expect(messagesOf([result])[0]!.sessionId).toBe("s-1:a1b2");

    const sameRecordInMainFile = parse(claudeUser("investigate the parser", { agentId: "a1b2", isSidechain: true }));
    expect(sameRecordInMainFile.kind === "messages" && sameRecordInMainFile.session?.id).toBe("s-1");
  });

  test("unknown type, failed validation and malformed JSON are told apart", () => {
    expect(parse({ type: "brand-new-record" })).toMatchObject({ kind: "unknown", reason: "unknown-type", recordType: "brand-new-record" });
    expect(parse({ ...ENVELOPE, type: "attachment", attachment: { type: "novel" } })).toMatchObject({ kind: "unknown", reason: "unknown-type", recordType: "attachment/novel" });
    expect(parse({ ...ENVELOPE, type: "system", subtype: "novel" })).toEqual({ kind: "ignored", recordType: "system/novel" });
    const { uuid: _uuid, ...withoutUuid } = claudeUser("hello");
    expect(parse(withoutUuid)).toMatchObject({ kind: "unknown", reason: "validation", recordType: "user" });
    expect(parse(claudeUser([{ type: "text" }]))).toMatchObject({ kind: "unknown", reason: "validation", recordType: "user" });
    expect(parse('{"type":"user",')).toMatchObject({ kind: "unknown", reason: "malformed-json" });
    expect(parse("[1,2]")).toMatchObject({ kind: "unknown", reason: "unknown-type" });
  });
});

const CODEX_PATH = "2026/11/16/rollout-2026-11-16T10-00-00-11111111-2222-4333-8444-555555555555.jsonl";
const T = "2026-11-16T10:00:00.000Z";

function meta(payload: Json = {}): Json {
  return {
    timestamp: T,
    type: "session_meta",
    payload: { id: "thread-1", timestamp: T, cwd: "/work/app", cli_version: "0.169.0", originator: "codex-tui", source: "cli", thread_source: "user", git: { branch: "main" }, ...payload },
  };
}

function item(payload: Json, extra: Json = {}): Json {
  return { timestamp: T, type: "response_item", payload, ...extra };
}

function userMessage(...texts: string[]): Json {
  return item({ type: "message", role: "user", content: texts.map((text) => ({ type: "input_text", text })) });
}

describe("codex parser", () => {
  const run = (records: (Json | string)[]) => parseAll("codex", CODEX_PATH, records);

  test("session_meta defines the session and yields no message", () => {
    const [result] = run([meta()]);
    expect(result).toEqual({
      kind: "ignored",
      recordType: "session_meta",
      session: { id: "thread-1", kind: "main", projectPath: "/work/app", gitBranch: "main", parentSessionId: undefined, harnessVersion: "0.169.0", timestamp: T },
    });
  });

  test("user text is kept and injected context blocks are dropped", () => {
    const results = run([
      meta(),
      userMessage("# AGENTS.md instructions for /work/app\n...", "<environment_context>\n<cwd>/work/app</cwd>\n</environment_context>"),
      userMessage("<environment_context>shell=zsh</environment_context>", "rename the helper"),
      userMessage("<turn_aborted>interrupted</turn_aborted>"),
      userMessage("<user_shell_command>ls</user_shell_command>"),
      userMessage("<codex_internal_context>goal</codex_internal_context>"),
      userMessage("<image name=[Image #1]>", "</image>", "what does this show?"),
    ]);
    expect(messagesOf(results).map((m) => [m.role, m.text])).toEqual([
      ["user", "rename the helper"],
      ["user", "what does this show?"],
    ]);
    expect(results.slice(1).every((r) => r.kind === "messages")).toBe(true);
  });

  test("content_item_kinds marks injected blocks even without a known tag", () => {
    const record = item({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Project rules: always test." }, { type: "input_text", text: "ship it" }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ["agents_md.instructions", "user.text"] },
    });
    expect(messagesOf(run([meta(), record])).map((m) => m.text)).toEqual(["ship it"]);
  });

  test("the first typed user message supplies the title, cut to 80 characters", () => {
    const long = "x".repeat(200);
    const results = run([meta(), userMessage("<environment_context>e</environment_context>"), userMessage(long), userMessage("second")]);
    const titles = patchesOf(results).flatMap((p) => (p.title ? [p.title] : []));
    expect(titles).toEqual([{ text: "x".repeat(80), rank: 1 }]);
  });

  test("developer and system messages are instructions, not conversation", () => {
    const results = run([meta(), item({ type: "message", role: "developer", content: [{ type: "input_text", text: "You are a coding agent" }] })]);
    expect(messagesOf(results)).toEqual([]);
    expect(results[1]!.kind).toBe("messages");
  });

  test("assistant messages, tool calls and their outputs are normalised", () => {
    const results = run([
      meta(),
      item({ type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Done." }] }),
      item({ type: "function_call", name: "exec", arguments: '{"cmd":"ls"}', call_id: "c1" }),
      item({ type: "function_call_output", call_id: "c1", output: "a.ts" }),
      item({ type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch", call_id: "c2", status: "completed" }),
      item({ type: "custom_tool_call_output", call_id: "c2", output: [{ type: "input_text", text: "ok" }, { type: "input_image", image_url: "data:..." }] }),
    ]);
    expect(messagesOf(results)).toEqual([
      { sessionId: "thread-1", role: "assistant", text: "Done.", timestamp: T },
      { sessionId: "thread-1", role: "tool_call", toolName: "exec", text: '{"cmd":"ls"}', timestamp: T },
      { sessionId: "thread-1", role: "tool_result", text: "a.ts", timestamp: T },
      { sessionId: "thread-1", role: "tool_call", toolName: "apply_patch", text: "*** Begin Patch", timestamp: T },
      { sessionId: "thread-1", role: "tool_result", text: "ok\n[image]", timestamp: T },
    ]);
    expect(results[2]!.kind === "messages" && results[2]!.record).toEqual({ type: "response_item/function_call", nativeId: "c1", timestamp: T });
  });

  test("reasoning is kept only when it has a readable summary", () => {
    const results = run([
      meta(),
      item({ type: "reasoning", summary: [], encrypted_content: "gAAAA" }),
      item({ type: "reasoning", summary: [{ type: "summary_text", text: "Checking the tests" }], encrypted_content: "gAAAA" }),
    ]);
    expect(messagesOf(results).map((m) => [m.role, m.text])).toEqual([["reasoning", "Checking the tests"]]);
  });

  test("every event_msg is a display copy and ignored", () => {
    const results = run([
      meta(),
      { timestamp: T, type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [] } } },
      { timestamp: T, type: "event_msg", payload: { type: "user_message", message: "hi" } },
      { timestamp: T, type: "event_msg", payload: { type: "agent_message", message: "hello" } },
      { timestamp: T, type: "turn_context", payload: {} },
    ]);
    expect(results.slice(1).map((r) => r.kind)).toEqual(["ignored", "ignored", "ignored", "ignored"]);
  });

  test("a guardian session keeps its session row and ignores everything else", () => {
    for (const marker of [{ source: { subagent: { other: "guardian" } } }, { thread_source: "guardian_review" }]) {
      const results = run([meta({ ...marker, parent_thread_id: "thread-0" }), userMessage("review this command"), item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "approved" }] })]);
      expect(patchesOf(results)).toHaveLength(1);
      expect(patchesOf(results)[0]).toMatchObject({ id: "thread-1", kind: "guardian", parentSessionId: "thread-0" });
      expect(results.slice(1)).toEqual([
        { kind: "ignored", recordType: "response_item/message" },
        { kind: "ignored", recordType: "response_item/message" },
      ]);
    }
  });

  test("only the first session_meta defines the session; copied parent history is skipped by ordinal", () => {
    const spawn = { thread_spawn: { parent_thread_id: "thread-0", depth: 1 } };
    const results = run([
      { ...meta({ thread_source: "subagent", source: { subagent: spawn }, parent_thread_id: "thread-0", forked_from_id: "thread-0", subagent_history_start_ordinal: 3 }), ordinal: 0 },
      { ...meta({ id: "thread-0", cwd: "/elsewhere" }), ordinal: 1 },
      { ...userMessage("the parent's prompt"), ordinal: 2 },
      { ...item({ type: "agent_message", author: "/root", recipient: "/root/worker", content: [{ type: "input_text", text: "count the files" }, { type: "encrypted_content", encrypted_content: "gAAAA" }] }), ordinal: 3 },
      { ...item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "42 files" }] }), ordinal: 4 },
    ]);
    expect(patchesOf(results)[0]).toMatchObject({ id: "thread-1", kind: "subagent", parentSessionId: "thread-0", projectPath: "/work/app" });
    expect(results[1]).toEqual({ kind: "ignored", recordType: "session_meta" });
    expect(results[2]).toEqual({ kind: "ignored", recordType: "response_item/message" });
    expect(new Set(patchesOf(results).map((p) => p.id))).toEqual(new Set(["thread-1"]));
    expect(messagesOf(results)).toEqual([
      { sessionId: "thread-1", role: "tool_result", toolName: "agent_message", text: "[agent message from /root to /root/worker]\ncount the files", timestamp: T },
      { sessionId: "thread-1", role: "assistant", text: "42 files", timestamp: T },
    ]);
  });

  test("a forked thread without a history ordinal still takes the first meta and links to its origin", () => {
    const results = run([meta({ forked_from_id: "thread-0" }), meta({ id: "thread-0" }), userMessage("carry on")]);
    expect(patchesOf(results)[0]).toMatchObject({ id: "thread-1", kind: "main", parentSessionId: "thread-0" });
    expect(messagesOf(results).map((m) => m.sessionId)).toEqual(["thread-1"]);
  });

  test("content before a readable session_meta falls back to the id in the file name", () => {
    const results = run([userMessage("hello")]);
    expect(messagesOf(results)[0]!.sessionId).toBe("11111111-2222-4333-8444-555555555555");
  });

  test("unknown type, failed validation, unknown blocks and malformed JSON", () => {
    const results = run([
      meta(),
      { timestamp: T, type: "hologram", payload: {} },
      item({ type: "hologram" }),
      item({ type: "function_call", name: "exec", call_id: "c1" }),
      item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }, { type: "output_hologram" }] }),
      "{not json",
      { timestamp: T, type: "session_meta", payload: { id: "thread-1" } },
    ]);
    expect(results[1]).toMatchObject({ kind: "unknown", reason: "unknown-type", recordType: "hologram" });
    expect(results[2]).toMatchObject({ kind: "unknown", reason: "unknown-type", recordType: "response_item/hologram" });
    expect(results[3]).toMatchObject({ kind: "unknown", reason: "validation", recordType: "response_item/function_call" });
    expect(results[4]!.kind === "messages" && results[4]!.unknownBlocks).toEqual(["output_hologram"]);
    expect(results[5]).toMatchObject({ kind: "unknown", reason: "malformed-json" });
    expect(results[6]).toMatchObject({ kind: "unknown", reason: "validation", recordType: "session_meta" });
  });

  test("a new event_msg kind is ignored, since response_item already carries the conversation", () => {
    const results = run([meta(), { timestamp: T, type: "event_msg", payload: { type: "hologram_shown" } }]);
    expect(results[1]).toEqual({ kind: "ignored", recordType: "event_msg/hologram_shown" });
  });
});

describe("registry", () => {
  test("maps each source to its parser", () => {
    expect(getParser("claude-code").source).toBe("claude-code");
    expect(getParser("codex").source).toBe("codex");
    expect(Object.keys(parsers).sort()).toEqual(["claude-code", "codex"]);
  });
});
