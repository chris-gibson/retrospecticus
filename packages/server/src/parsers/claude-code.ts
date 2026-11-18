import { z } from "zod";
import type { NormalisedMessage, ParseContext, ParseResult, Parser, SessionPatch } from "./types.ts";

/**
 * A `user` record is only a typed prompt when none of these hold. Observed on
 * Claude Code 2.1.258 to 2.1.325:
 *  - `isMeta`: skill bodies, system reminders, local-command caveats, and the
 *    task prompt a parent agent hands to most subagents.
 *  - `isCompactSummary` (always paired with `isVisibleInTranscriptOnly`): the
 *    summary the harness writes after compaction.
 *  - `origin.kind` other than `human`, or `promptSource: "system"`: background
 *    task notifications delivered as a user turn.
 *  - text opening with one of the wrappers below: slash-command echoes, `!`
 *    shell input and output, and the interruption marker. These carry no
 *    `promptSource`, so the wrapper is the only signal.
 * Everything else (promptSource typed, queued, sdk, suggestion_accepted, or
 * absent) is indexed as user text. In a subagent file that is the task prompt
 * written by the parent agent, when the harness did not flag it `isMeta`; it
 * is kept because it is the question the subagent's answer belongs to.
 * `tool_result` blocks are indexed whatever the flags say.
 */
export const CLAUDE_INJECTED_PREFIXES: readonly string[] = [
  "<task-notification>",
  "<system-reminder>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<local-command-caveat>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "[Request interrupted by user",
];

const TITLE_RANK_AI = 1;
const TITLE_RANK_CUSTOM = 2;

const HANDLED = ["user", "assistant", "attachment/queued_command", "ai-title", "custom-title"] as const;

const IGNORED_ATTACHMENTS = [
  "agent_listing_delta",
  "at_mention_reference",
  "auto_mode",
  "batching_reminder_sent",
  "command_permissions",
  "compact_file_reference",
  "credential_org",
  "critical_system_reminder",
  "date",
  "date_change",
  "deferred_tools_delta",
  "deferred_tools_record",
  "directory",
  "edited_text_file",
  "environment",
  "file",
  "hook_system_message",
  "instructions",
  "mcp_instructions_delta",
  "model",
  "pdf_reference",
  "prompt_snapshot",
  "read_truncation_notice",
  "remote_session_change",
  "session_context",
  "silent_turn_reminder",
  "skill_listing",
  "task_reminder",
  "task_status",
  "thinking_drop",
  "total_tokens_reminder",
] as const;

const IGNORED_SYSTEM = ["away_summary", "compact_boundary", "informational", "local_command", "stop_hook_summary", "turn_duration"] as const;

const IGNORED = [
  "agent-name",
  "api-request",
  "api-request-blob",
  "api-request-shape",
  "atis-latch",
  "bridge-session",
  "continued-in",
  "cost-state",
  "file-history-delta",
  "file-history-snapshot",
  "frame-link",
  "last-prompt",
  "mode",
  "permission-mode",
  "pr-link",
  "queue-operation",
  "relocated",
  "session-owner",
  "tools-used",
  ...IGNORED_SYSTEM.map((s) => `system/${s}`),
  ...IGNORED_ATTACHMENTS.map((a) => `attachment/${a}`),
] as const;

const HANDLED_SET: ReadonlySet<string> = new Set(HANDLED);
const IGNORED_SET: ReadonlySet<string> = new Set(IGNORED);

const Block = z.looseObject({ type: z.string() });
const TextBlock = z.looseObject({ type: z.literal("text"), text: z.string() });
const ThinkingBlock = z.looseObject({ type: z.literal("thinking"), thinking: z.string() });
const ToolUseBlock = z.looseObject({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() });
const ToolResultBlock = z.looseObject({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(Block)]).nullish(),
});
const ToolReferenceBlock = z.looseObject({ type: z.literal("tool_reference"), tool_name: z.string() });

const Envelope = z.looseObject({
  uuid: z.string(),
  parentUuid: z.string().nullable(),
  sessionId: z.string(),
  timestamp: z.string(),
  cwd: z.string(),
  version: z.string(),
  gitBranch: z.string().optional(),
  agentId: z.string().optional(),
});

const Origin = z.looseObject({ kind: z.string() });

const UserRecord = Envelope.extend({
  type: z.literal("user"),
  isMeta: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
  isVisibleInTranscriptOnly: z.boolean().optional(),
  promptSource: z.string().optional(),
  origin: Origin.optional(),
  message: z.looseObject({ role: z.literal("user"), content: z.union([z.string(), z.array(Block)]) }),
});

const AssistantRecord = Envelope.extend({
  type: z.literal("assistant"),
  isApiErrorMessage: z.boolean().optional(),
  message: z.looseObject({ role: z.literal("assistant"), content: z.array(Block) }),
});

const QueuedCommandRecord = Envelope.extend({
  type: z.literal("attachment"),
  attachment: z.looseObject({
    type: z.literal("queued_command"),
    prompt: z.union([z.string(), z.array(Block)]),
    commandMode: z.string().optional(),
    origin: Origin.optional(),
  }),
});

const AiTitleRecord = z.looseObject({ type: z.literal("ai-title"), sessionId: z.string(), aiTitle: z.string() });
const CustomTitleRecord = z.looseObject({ type: z.literal("custom-title"), sessionId: z.string(), customTitle: z.string() });

type Envelope = z.infer<typeof Envelope>;
type Block = z.infer<typeof Block>;

class BlockError extends Error {}

function readBlock<T>(schema: z.ZodType<T>, block: Block): T {
  const parsed = schema.safeParse(block);
  if (!parsed.success) throw new BlockError(`${block.type} block: ${describe(parsed.error)}`);
  return parsed.data;
}

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
  if (record.type === "attachment") {
    const sub = isRecord(record.attachment) ? record.attachment.type : undefined;
    return typeof sub === "string" ? `attachment/${sub}` : "attachment";
  }
  if (record.type === "system") {
    return typeof record.subtype === "string" ? `system/${record.subtype}` : "system";
  }
  return record.type;
}

const SUBAGENT_PATH = /(?:^|\/)subagents\/agent-([^/]+)\.jsonl$/;

/**
 * A subagent transcript repeats its parent's `sessionId`; what sets it apart is
 * the `agentId` on its records and its place under `<session>/subagents/`. The
 * file name carries the same id, which covers records that lack the field.
 */
function sessionIdentity(
  sessionId: string,
  agentId: string | undefined,
  ctx: ParseContext,
): { id: string; kind: "main" | "subagent"; parentSessionId?: string } {
  const fromPath = SUBAGENT_PATH.exec(ctx.path)?.[1];
  if (fromPath === undefined) return { id: sessionId, kind: "main" };
  return { id: `${sessionId}:${agentId ?? fromPath}`, kind: "subagent", parentSessionId: sessionId };
}

function envelopePatch(record: Envelope, ctx: ParseContext): SessionPatch {
  const identity = sessionIdentity(record.sessionId, record.agentId, ctx);
  return {
    id: identity.id,
    kind: identity.kind,
    parentSessionId: identity.parentSessionId,
    projectPath: record.cwd,
    gitBranch: record.gitBranch,
    harnessVersion: record.version,
    timestamp: record.timestamp,
  };
}

function hasInjectedPrefix(text: string): boolean {
  const trimmed = text.trimStart();
  return CLAUDE_INJECTED_PREFIXES.some((p) => trimmed.startsWith(p));
}

function toolResultText(content: string | Block[] | null | undefined, unknownBlocks: Set<string>): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    switch (block.type) {
      case "text":
        parts.push(readBlock(TextBlock, block).text);
        break;
      case "image":
        parts.push("[image]");
        break;
      case "document":
        parts.push("[document]");
        break;
      case "tool_reference":
        parts.push(`[tool: ${readBlock(ToolReferenceBlock, block).tool_name}]`);
        break;
      default:
        unknownBlocks.add(`tool_result/${block.type}`);
    }
  }
  return parts.join("\n");
}

/** Text and image blocks of one prompt become a single user message, in block order. */
function promptText(content: string | Block[], unknownBlocks: Set<string>): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(readBlock(TextBlock, block).text);
    else if (block.type === "image") parts.push("[image]");
    else if (block.type !== "tool_result") unknownBlocks.add(block.type);
  }
  return parts.join("\n");
}

function parseUser(raw: unknown, ctx: ParseContext): ParseResult {
  const record = UserRecord.parse(raw);
  const session = envelopePatch(record, ctx);
  const unknownBlocks = new Set<string>();
  const messages: NormalisedMessage[] = [];
  const content = record.message.content;

  const injected =
    record.isMeta === true ||
    record.isCompactSummary === true ||
    record.isVisibleInTranscriptOnly === true ||
    record.promptSource === "system" ||
    (record.origin !== undefined && record.origin.kind !== "human");

  const text = promptText(content, unknownBlocks);
  if (!injected && text.trim() !== "" && !hasInjectedPrefix(text)) {
    messages.push({ sessionId: session.id, role: "user", text, timestamp: record.timestamp });
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const result = readBlock(ToolResultBlock, block);
      messages.push({
        sessionId: session.id,
        role: "tool_result",
        text: toolResultText(result.content, unknownBlocks),
        timestamp: record.timestamp,
      });
    }
  }
  return result("user", record, messages, session, unknownBlocks);
}

/**
 * `isApiErrorMessage` records hold the harness's own error text under a
 * synthetic model, not model output, so they yield nothing.
 */
function parseAssistant(raw: unknown, ctx: ParseContext): ParseResult {
  const record = AssistantRecord.parse(raw);
  const session = envelopePatch(record, ctx);
  const unknownBlocks = new Set<string>();
  const messages: NormalisedMessage[] = [];
  if (record.isApiErrorMessage !== true) {
    for (const block of record.message.content) {
      const base = { sessionId: session.id, timestamp: record.timestamp };
      switch (block.type) {
        case "text": {
          const text = readBlock(TextBlock, block).text;
          if (text.trim() !== "") messages.push({ ...base, role: "assistant", text });
          break;
        }
        case "thinking": {
          const thinking = readBlock(ThinkingBlock, block).thinking;
          if (thinking.trim() !== "") messages.push({ ...base, role: "reasoning", text: thinking });
          break;
        }
        case "tool_use": {
          const use = readBlock(ToolUseBlock, block);
          messages.push({ ...base, role: "tool_call", toolName: use.name, text: JSON.stringify(use.input ?? null) });
          break;
        }
        default:
          unknownBlocks.add(block.type);
      }
    }
  }
  return result("assistant", record, messages, session, unknownBlocks);
}

/**
 * A `queued_command` attachment is a prompt absorbed into a running turn. It is
 * the only copy: when the harness instead dequeues the prompt normally it
 * writes a `user` record with `promptSource: "queued"` and no attachment.
 * `commandMode: "task-notification"` is the same channel carrying a background
 * task notice, which is not typed text.
 */
function parseQueuedCommand(raw: unknown, ctx: ParseContext): ParseResult {
  const record = QueuedCommandRecord.parse(raw);
  const session = envelopePatch(record, ctx);
  const unknownBlocks = new Set<string>();
  const messages: NormalisedMessage[] = [];
  const { commandMode, origin, prompt } = record.attachment;
  const typed = (commandMode === undefined || commandMode === "prompt") && (origin === undefined || origin.kind === "human");
  const text = promptText(prompt, unknownBlocks);
  if (typed && text.trim() !== "" && !hasInjectedPrefix(text)) {
    messages.push({ sessionId: session.id, role: "user", text, timestamp: record.timestamp });
  }
  return result("attachment/queued_command", record, messages, session, unknownBlocks);
}

function result(
  type: string,
  record: Envelope,
  messages: NormalisedMessage[],
  session: SessionPatch,
  unknownBlocks: Set<string>,
): ParseResult {
  return {
    kind: "messages",
    record: {
      type,
      nativeId: record.uuid,
      parentNativeId: record.parentUuid ?? undefined,
      timestamp: record.timestamp,
    },
    messages,
    session,
    ...(unknownBlocks.size > 0 ? { unknownBlocks: [...unknownBlocks].sort() } : {}),
  };
}

function parseTitle(raw: unknown, type: "ai-title" | "custom-title", ctx: ParseContext): ParseResult {
  const { sessionId, text, rank } =
    type === "ai-title"
      ? (({ sessionId, aiTitle }) => ({ sessionId, text: aiTitle, rank: TITLE_RANK_AI }))(AiTitleRecord.parse(raw))
      : (({ sessionId, customTitle }) => ({ sessionId, text: customTitle, rank: TITLE_RANK_CUSTOM }))(
          CustomTitleRecord.parse(raw),
        );
  const identity = sessionIdentity(sessionId, undefined, ctx);
  return {
    kind: "ignored",
    recordType: type,
    session: { id: identity.id, kind: identity.kind, parentSessionId: identity.parentSessionId, title: { text, rank } },
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
  if (IGNORED_SET.has(type)) return { kind: "ignored", recordType: type };
  // `system` records are harness bookkeeping and never carry conversation, so a new subtype is reported as additive drift
  // through the detector rather than quarantined as breaking.
  if (type.startsWith("system/")) return { kind: "ignored", recordType: type };
  if (!HANDLED_SET.has(type)) {
    return { kind: "unknown", reason: "unknown-type", recordType: type, detail: `unrecognised record type ${type}` };
  }
  try {
    switch (type) {
      case "user":
        return parseUser(raw, ctx);
      case "assistant":
        return parseAssistant(raw, ctx);
      case "attachment/queued_command":
        return parseQueuedCommand(raw, ctx);
      case "ai-title":
      case "custom-title":
        return parseTitle(raw, type, ctx);
    }
  } catch (error) {
    if (error instanceof z.ZodError) return { kind: "unknown", reason: "validation", recordType: type, detail: describe(error) };
    if (error instanceof BlockError) return { kind: "unknown", reason: "validation", recordType: type, detail: error.message };
    throw error;
  }
  return { kind: "unknown", reason: "unknown-type", recordType: type, detail: `no handler for ${type}` };
}

export const claudeCodeParser: Parser = {
  source: "claude-code",
  handledTypes: HANDLED,
  ignoredTypes: IGNORED,
  discriminator: discriminatorOf,
  parse,
};
