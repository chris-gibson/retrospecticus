import { z } from "zod";
import type { SessionKind } from "@retrospecticus/shared";
import type { NormalisedMessage, ParseContext, ParseResult, Parser, SessionPatch } from "./types.ts";

/**
 * `input_text` blocks of a user message that open with one of these are
 * harness context, not typed text. Observed on Codex 0.153.4 to 0.169.0; the
 * AGENTS.md block has no tag, only this heading. Newer records also label each
 * block in `internal_chat_message_metadata_passthrough.content_item_kinds`,
 * which is honoured when present (see INJECTED_KINDS).
 *
 * Not treated as injected: history that a client replays into a new thread as
 * ordinary user and assistant messages (kind `unknown`, seen once, before the
 * first turn of a thread handed over by T3 Code). It is conversation the owner
 * had, and nothing in the record separates it from a typed turn, so it is
 * indexed in the receiving session.
 */
export const CODEX_INJECTED_PREFIXES: readonly string[] = [
  "<environment_context>",
  "<codex_internal_context>",
  "<turn_aborted>",
  "<user_shell_command>",
  "<image>",
  "<image ",
  "</image>",
  "# AGENTS.md instructions",
];

const INJECTED_KINDS: ReadonlySet<string> = new Set([
  "agents_md.instructions",
  "environments.environment_context",
  "generic.turn_aborted",
  "shell.user_command",
  "goal.internal_context",
]);

const TITLE_RANK = 1;
const TITLE_LENGTH = 80;

const HANDLED = [
  "session_meta",
  "response_item/message",
  "response_item/reasoning",
  "response_item/function_call",
  "response_item/function_call_output",
  "response_item/custom_tool_call",
  "response_item/custom_tool_call_output",
  "response_item/agent_message",
] as const;

/**
 * Every `event_msg` is a display copy or telemetry: `item_completed` repeats
 * each turn of an ordinary session and `user_message`/`agent_message` do the
 * same in guardian sessions, so `response_item` is the only canonical source.
 */
const IGNORED = [
  "turn_context",
  "compacted",
  "token_usage_record",
  "world_state",
  "inter_agent_communication_metadata",
  "response_item/additional_tools",
  "response_item/compaction",
  "response_item/configuration_update",
  "event_msg/agent_message",
  "event_msg/context_compacted",
  "event_msg/item_completed",
  "event_msg/task_complete",
  "event_msg/task_started",
  "event_msg/thread_goal_updated",
  "event_msg/thread_settings_applied",
  "event_msg/token_count",
  "event_msg/turn_aborted",
  "event_msg/user_message",
] as const;

const HANDLED_SET: ReadonlySet<string> = new Set(HANDLED);
const IGNORED_SET: ReadonlySet<string> = new Set(IGNORED);

const Line = z.looseObject({
  timestamp: z.string(),
  type: z.string(),
  payload: z.looseObject({}),
  ordinal: z.number().optional(),
});

const SessionMeta = z.looseObject({
  id: z.string(),
  cwd: z.string(),
  cli_version: z.string(),
  timestamp: z.string().optional(),
  git: z.looseObject({ branch: z.string().optional() }).nullish(),
  source: z.unknown().optional(),
  thread_source: z.string().nullish(),
  parent_thread_id: z.string().nullish(),
  forked_from_id: z.string().nullish(),
  subagent_history_start_ordinal: z.number().nullish(),
});

const Block = z.looseObject({ type: z.string() });
const TextBlock = z.looseObject({ type: z.string(), text: z.string() });

const Message = z.looseObject({
  type: z.literal("message"),
  role: z.enum(["user", "assistant", "developer", "system"]),
  content: z.array(Block),
  id: z.string().optional(),
  internal_chat_message_metadata_passthrough: z
    .looseObject({ content_item_kinds: z.array(z.string()).optional() })
    .nullish(),
});

const Reasoning = z.looseObject({
  type: z.literal("reasoning"),
  id: z.string().optional(),
  summary: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
});

const FunctionCall = z.looseObject({
  type: z.literal("function_call"),
  name: z.string(),
  arguments: z.string(),
  call_id: z.string(),
});

const CustomToolCall = z.looseObject({
  type: z.literal("custom_tool_call"),
  name: z.string(),
  input: z.string(),
  call_id: z.string(),
});

const ToolOutput = z.looseObject({
  type: z.enum(["function_call_output", "custom_tool_call_output"]),
  call_id: z.string(),
  output: z.union([z.string(), z.array(Block)]),
});

const AgentMessage = z.looseObject({
  type: z.literal("agent_message"),
  id: z.string().optional(),
  author: z.string(),
  recipient: z.string(),
  content: z.array(Block),
});

type Block = z.infer<typeof Block>;

interface CodexState {
  sessionId?: string;
  kind?: SessionKind;
  cwd?: string;
  version?: string;
  parentSessionId?: string;
  /** Lines with a smaller `ordinal` are the parent's history, copied in when the thread was spawned. */
  historyStart?: number;
  /** Key of the user message that supplied the title, so a reparse emits the same title and no other. */
  titleFrom?: string;
}

class BlockError extends Error {}

function describe(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function discriminatorOf(record: unknown): string {
  if (!isRecord(record) || typeof record.type !== "string") return "(no type)";
  if (record.type === "response_item" || record.type === "event_msg") {
    const sub = isRecord(record.payload) ? record.payload.type : undefined;
    return typeof sub === "string" ? `${record.type}/${sub}` : record.type;
  }
  return record.type;
}

const ROLLOUT_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Falls back to the id in the file name so content survives a session_meta that failed validation. */
function sessionIdOf(state: CodexState, ctx: ParseContext): string {
  return state.sessionId ?? ROLLOUT_ID.exec(ctx.path)?.[1] ?? ctx.path;
}

/**
 * Guardian threads review a parent's tool calls and re-quote its transcript on
 * every review; they are archived but not indexed. Both markers are checked
 * because either one alone identifies them in every observed version.
 */
function kindOf(meta: z.infer<typeof SessionMeta>): SessionKind {
  const subagent = isRecord(meta.source) && isRecord(meta.source.subagent) ? meta.source.subagent : undefined;
  if (subagent?.other === "guardian" || meta.thread_source === "guardian_review") return "guardian";
  if (subagent !== undefined || meta.thread_source === "subagent") return "subagent";
  return "main";
}

function spawnParent(meta: z.infer<typeof SessionMeta>): string | undefined {
  const subagent = isRecord(meta.source) && isRecord(meta.source.subagent) ? meta.source.subagent : undefined;
  const spawn = subagent !== undefined && isRecord(subagent.thread_spawn) ? subagent.thread_spawn : undefined;
  return typeof spawn?.parent_thread_id === "string" ? spawn.parent_thread_id : undefined;
}

/**
 * A spawned or forked thread's file opens with its own session_meta followed
 * by a copy of the parent's meta and history. Only the first meta defines the
 * session; it is re-read when a reparse covers it again.
 */
function parseSessionMeta(payload: unknown, lineTimestamp: string, state: CodexState): ParseResult {
  const peekId = isRecord(payload) && typeof payload.id === "string" ? payload.id : undefined;
  if (state.sessionId !== undefined && peekId !== state.sessionId) {
    return { kind: "ignored", recordType: "session_meta" };
  }
  const meta = SessionMeta.parse(payload);
  state.sessionId = meta.id;
  state.kind = kindOf(meta);
  state.cwd = meta.cwd;
  state.version = meta.cli_version;
  state.parentSessionId = meta.parent_thread_id ?? meta.forked_from_id ?? spawnParent(meta);
  if (typeof meta.subagent_history_start_ordinal === "number") state.historyStart = meta.subagent_history_start_ordinal;
  const session: SessionPatch = {
    id: meta.id,
    kind: state.kind,
    projectPath: meta.cwd,
    gitBranch: meta.git?.branch,
    parentSessionId: state.parentSessionId,
    harnessVersion: meta.cli_version,
    timestamp: meta.timestamp ?? lineTimestamp,
  };
  return { kind: "ignored", recordType: "session_meta", session };
}

function blockText(block: Block): string {
  const parsed = TextBlock.safeParse(block);
  if (!parsed.success) throw new BlockError(`${block.type} block: ${describe(parsed.error)}`);
  return parsed.data.text;
}

function outputText(output: string | Block[], unknownBlocks: Set<string>): string {
  if (typeof output === "string") return output;
  const parts: string[] = [];
  for (const block of output) {
    if (block.type === "input_text" || block.type === "output_text") parts.push(blockText(block));
    else if (block.type === "input_image") parts.push("[image]");
    else unknownBlocks.add(`output/${block.type}`);
  }
  return parts.join("\n");
}

function isInjected(text: string, kind: string | undefined): boolean {
  if (kind !== undefined && INJECTED_KINDS.has(kind)) return true;
  const trimmed = text.trimStart();
  return CODEX_INJECTED_PREFIXES.some((p) => trimmed.startsWith(p));
}

function parseMessage(
  payload: unknown,
  timestamp: string,
  sessionId: string,
  state: CodexState,
  unknownBlocks: Set<string>,
): { messages: NormalisedMessage[]; nativeId?: string; session?: SessionPatch } {
  const message = Message.parse(payload);
  const kinds = message.internal_chat_message_metadata_passthrough?.content_item_kinds;
  const parts: string[] = [];
  message.content.forEach((block, i) => {
    switch (block.type) {
      case "input_text": {
        const text = blockText(block);
        if (message.role !== "user" || !isInjected(text, kinds?.[i])) parts.push(text);
        break;
      }
      case "output_text":
        parts.push(blockText(block));
        break;
      case "input_image":
        parts.push("[image]");
        break;
      default:
        unknownBlocks.add(block.type);
    }
  });
  // Developer and system messages are instructions to the model, never conversation.
  if (message.role === "developer" || message.role === "system") return { messages: [], nativeId: message.id };

  const text = parts.join("\n");
  if (text.trim() === "") return { messages: [], nativeId: message.id };

  let session: SessionPatch | undefined;
  if (message.role === "user") {
    // Older records have no id, and a batch of messages can share one timestamp.
    const key = `${message.id ?? ""}|${timestamp}|${text.length}`;
    state.titleFrom ??= key;
    if (state.titleFrom === key) {
      session = { id: sessionId, title: { text: text.trim().slice(0, TITLE_LENGTH), rank: TITLE_RANK } };
    }
  }
  return { messages: [{ sessionId, role: message.role, text, timestamp }], nativeId: message.id, session };
}

/**
 * `agent_message` is mail between threads of a multi-agent run. It is written
 * into the recipient's file only: a parent receives its subagents' reports and
 * a spawned thread receives its task this way. The text was produced by
 * another agent, so it is kept as a `tool_result` named `agent_message`
 * (stored and retrievable, not searched) rather than counted as a user turn.
 * The sender's side is already present as its `send_message` or `spawn_agent`
 * tool call. Encrypted blocks are unreadable and skipped.
 */
function parseAgentMessage(
  payload: unknown,
  timestamp: string,
  sessionId: string,
  unknownBlocks: Set<string>,
): { messages: NormalisedMessage[]; nativeId?: string } {
  const mail = AgentMessage.parse(payload);
  const parts: string[] = [];
  for (const block of mail.content) {
    if (block.type === "input_text") parts.push(blockText(block));
    else if (block.type !== "encrypted_content") unknownBlocks.add(`agent_message/${block.type}`);
  }
  const body = parts.join("\n");
  if (body.trim() === "") return { messages: [], nativeId: mail.id };
  const text = `[agent message from ${mail.author} to ${mail.recipient}]\n${body}`;
  return { messages: [{ sessionId, role: "tool_result", toolName: "agent_message", text, timestamp }], nativeId: mail.id };
}

function parseResponseItem(type: string, payload: unknown, timestamp: string, state: CodexState, ctx: ParseContext): ParseResult {
  const sessionId = sessionIdOf(state, ctx);
  const unknownBlocks = new Set<string>();
  let messages: NormalisedMessage[] = [];
  let nativeId: string | undefined;
  let session: SessionPatch | undefined;

  switch (type) {
    case "response_item/message":
      ({ messages, nativeId, session } = parseMessage(payload, timestamp, sessionId, state, unknownBlocks));
      break;
    case "response_item/reasoning": {
      // Reasoning is encrypted in nearly every record; only a plain-text summary can be kept.
      const reasoning = Reasoning.parse(payload);
      nativeId = reasoning.id;
      const text = reasoning.summary.map((s) => s.text ?? "").filter((t) => t.trim() !== "").join("\n");
      if (text !== "") messages = [{ sessionId, role: "reasoning", text, timestamp }];
      break;
    }
    case "response_item/function_call": {
      const call = FunctionCall.parse(payload);
      nativeId = call.call_id;
      messages = [{ sessionId, role: "tool_call", toolName: call.name, text: call.arguments, timestamp }];
      break;
    }
    case "response_item/custom_tool_call": {
      const call = CustomToolCall.parse(payload);
      nativeId = call.call_id;
      messages = [{ sessionId, role: "tool_call", toolName: call.name, text: call.input, timestamp }];
      break;
    }
    case "response_item/function_call_output":
    case "response_item/custom_tool_call_output": {
      const output = ToolOutput.parse(payload);
      nativeId = output.call_id;
      messages = [{ sessionId, role: "tool_result", text: outputText(output.output, unknownBlocks), timestamp }];
      break;
    }
    case "response_item/agent_message":
      ({ messages, nativeId } = parseAgentMessage(payload, timestamp, sessionId, unknownBlocks));
      break;
  }

  return {
    kind: "messages",
    record: { type, nativeId, timestamp },
    messages,
    session: { id: sessionId, timestamp, ...session },
    ...(unknownBlocks.size > 0 ? { unknownBlocks: [...unknownBlocks].sort() } : {}),
  };
}

function parse(line: string, ctx: ParseContext): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (error) {
    return { kind: "unknown", reason: "malformed-json", detail: String(error) };
  }
  const type = discriminatorOf(raw);
  // Every `event_msg` repeats or summarises `response_item` records, so a new kind loses no conversation and is
  // reported as additive drift through the detector rather than quarantined as breaking.
  if (type.startsWith("event_msg/") && !HANDLED_SET.has(type)) return { kind: "ignored", recordType: type };
  const known = HANDLED_SET.has(type) || IGNORED_SET.has(type);
  if (!known) {
    return { kind: "unknown", reason: "unknown-type", recordType: type, detail: `unrecognised record type ${type}` };
  }
  if (IGNORED_SET.has(type)) return { kind: "ignored", recordType: type };
  const state = ctx.state as CodexState;
  try {
    const record = Line.parse(raw);
    if (type === "session_meta") return parseSessionMeta(record.payload, record.timestamp, state);
    if (state.kind === "guardian") return { kind: "ignored", recordType: type };
    // The copied prefix is the parent's conversation and is indexed from the
    // parent's own file. Files written before `ordinal` existed cannot be told
    // apart this way and rely on search-time deduplication instead.
    if (state.historyStart !== undefined && record.ordinal !== undefined && record.ordinal < state.historyStart) {
      return { kind: "ignored", recordType: type };
    }
    return parseResponseItem(type, record.payload, record.timestamp, state, ctx);
  } catch (error) {
    if (error instanceof z.ZodError) return { kind: "unknown", reason: "validation", recordType: type, detail: describe(error) };
    if (error instanceof BlockError) return { kind: "unknown", reason: "validation", recordType: type, detail: error.message };
    throw error;
  }
}

export const codexParser: Parser = {
  source: "codex",
  handledTypes: HANDLED,
  ignoredTypes: IGNORED,
  discriminator: discriminatorOf,
  parse,
};
