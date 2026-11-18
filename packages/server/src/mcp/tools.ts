import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MessageRole } from "@retrospecticus/shared";
import type { Db } from "../db/index.ts";
import { getTranscriptSlice, listSessionSummaries, logQuery } from "../db/search.ts";
import { getSession } from "../db/sessions.ts";
import { statusReport } from "../db/status.ts";
import { normalizeInstant, searchFilterShape } from "../search/filters.ts";
import { formatSearchResults, formatSessionList, formatSessionSlice, formatStatus } from "../search/format.ts";
import { MAX_LIMIT, SEARCH_MODES, search, searchWarning, type RankWeights, type SearchResult, type VectorSearch } from "../search/index.ts";

export interface ToolContext {
  db: Db;
  /** The token the request authenticated with; written to `query_log`. */
  tokenId: number | null;
  vectorSearch?: VectorSearch;
  weights?: RankWeights;
}

export const searchMemoryShape = {
  query: z.string().min(1).max(4000).describe("What to look for, in plain words."),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(8).describe("How many passages to return."),
  ...searchFilterShape,
};
export const SearchMemoryInputSchema = z.object(searchMemoryShape);
export type SearchMemoryInput = z.infer<typeof SearchMemoryInputSchema>;

/** The HTTP search also takes a ranking mode, for comparing keyword and vector results by hand. */
export const HttpSearchInputSchema = SearchMemoryInputSchema.extend({ mode: z.enum(SEARCH_MODES).optional() });
export type HttpSearchInput = z.infer<typeof HttpSearchInputSchema>;

export const getSessionShape = {
  session_id: z.string().min(1).describe("A session_id from search_memory or list_sessions."),
  around_ordinal: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Centre the slice on this message ordinal; omit to read from the start."),
  window: z.number().int().min(1).max(50).default(6).describe("Messages either side of around_ordinal."),
  include_tools: z.boolean().default(false).describe("Also show tool calls, tool results and reasoning."),
};
export type GetSessionInput = z.infer<z.ZodObject<typeof getSessionShape>>;

export const listSessionsShape = {
  project: searchFilterShape.project,
  after: searchFilterShape.after.describe("ISO date or datetime; sessions that started at or after it."),
  before: searchFilterShape.before.describe("ISO date or datetime; sessions that started before it."),
  limit: z.number().int().min(1).max(200).default(20),
};
export type ListSessionsInput = z.infer<z.ZodObject<typeof listSessionsShape>>;

const CONVERSATION_ROLES: readonly MessageRole[] = ["user", "assistant"];
const ALL_ROLES: readonly MessageRole[] = ["user", "assistant", "tool_call", "tool_result", "reasoning"];

function text(body: string, isError = false): CallToolResult {
  return isError ? { content: [{ type: "text", text: body }], isError: true } : { content: [{ type: "text", text: body }] };
}

export interface SearchOutcome {
  results: SearchResult[];
  warning?: string;
}

/** Shared by the MCP tool and `POST /v1/search`; `tool` names the caller in `query_log`. */
export async function runSearch(ctx: ToolContext, input: HttpSearchInput, tool: string): Promise<SearchOutcome> {
  const { query, limit, ...filters } = input;
  const results = await search(ctx.db, { query, limit, ...filters }, { vectorSearch: ctx.vectorSearch, weights: ctx.weights });
  logQuery(ctx.db, { tokenId: ctx.tokenId, tool, query, resultCount: results.length });
  const warning = searchWarning(ctx.db);
  return warning ? { results, warning } : { results };
}

export async function searchMemory(ctx: ToolContext, input: SearchMemoryInput): Promise<CallToolResult> {
  const { results, warning } = await runSearch(ctx, input, "search_memory");
  return text(formatSearchResults(results, warning));
}

export function getSessionTool(ctx: ToolContext, input: GetSessionInput): CallToolResult {
  const session = getSession(ctx.db, input.session_id);
  if (!session || session.kind === "guardian") {
    logQuery(ctx.db, { tokenId: ctx.tokenId, tool: "get_session", query: input.session_id, resultCount: 0 });
    return text(`No session with id ${JSON.stringify(input.session_id)}.`, true);
  }
  const messages = getTranscriptSlice(ctx.db, session.id, {
    aroundOrdinal: input.around_ordinal,
    window: input.window,
    roles: input.include_tools ? ALL_ROLES : CONVERSATION_ROLES,
  });
  logQuery(ctx.db, { tokenId: ctx.tokenId, tool: "get_session", query: input.session_id, resultCount: messages.length });
  return text(
    formatSessionSlice(session, messages, {
      includeTools: input.include_tools,
      aroundOrdinal: input.around_ordinal,
      window: input.window,
    }),
  );
}

export function listSessionsTool(ctx: ToolContext, input: ListSessionsInput): CallToolResult {
  const sessions = listSessionSummaries(ctx.db, {
    project: input.project,
    after: input.after === undefined ? undefined : normalizeInstant(input.after),
    before: input.before === undefined ? undefined : normalizeInstant(input.before),
    limit: input.limit,
  });
  logQuery(ctx.db, {
    tokenId: ctx.tokenId,
    tool: "list_sessions",
    query: JSON.stringify(input),
    resultCount: sessions.length,
  });
  return text(formatSessionList(sessions));
}

export function memoryStatusTool(ctx: ToolContext): CallToolResult {
  const report = statusReport(ctx.db);
  logQuery(ctx.db, { tokenId: ctx.tokenId, tool: "memory_status", query: null, resultCount: report.drift.open });
  return text(formatStatus(report));
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "search_memory",
    {
      description:
        "Search past Claude Code and Codex sessions for passages about a topic. Returns quoted history with session ids and ordinals for get_session.",
      inputSchema: searchMemoryShape,
      annotations: { readOnlyHint: true },
    },
    (args) => searchMemory(ctx, args),
  );
  server.registerTool(
    "get_session",
    {
      description: "Read a slice of one past session's transcript, around a message ordinal or from the start.",
      inputSchema: getSessionShape,
      annotations: { readOnlyHint: true },
    },
    (args) => getSessionTool(ctx, args),
  );
  server.registerTool(
    "list_sessions",
    {
      description: "List past sessions with their titles, projects and dates, newest first.",
      inputSchema: listSessionsShape,
      annotations: { readOnlyHint: true },
    },
    (args) => listSessionsTool(ctx, args),
  );
  server.registerTool(
    "memory_status",
    {
      description: "Report index freshness per machine, the embedding backlog and open format-drift alerts.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => memoryStatusTool(ctx),
  );
}
