import { z } from "zod";

/**
 * The release version of every package. A server hands out collectors of its
 * own version, and the release workflow refuses a tag that does not match.
 */
export const VERSION = "0.2.0";

export const SOURCES = ["claude-code", "codex"] as const;
export type Source = (typeof SOURCES)[number];
export const SourceSchema = z.enum(SOURCES);

export const TOKEN_SCOPES = ["ingest", "search", "admin"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

export const INGEST_APPEND_PATH = "/v1/ingest/append";
export const HEARTBEAT_PATH = "/v1/heartbeat";
/** An ingest token calls this to revoke itself, as `uninstall --purge` does before deleting it. */
export const TOKEN_REVOKE_SELF_PATH = "/v1/token/revoke";
/** Answers 200 only while the calling ingest token is accepted for the machine it names; changes nothing. */
export const TOKEN_WHOAMI_PATH = "/v1/token/whoami";
export const SEARCH_PATH = "/v1/search";
export const MCP_PATH = "/mcp";

export const HEADER_MACHINE = "X-Machine";
export const HEADER_SOURCE = "X-Source";
export const HEADER_PATH = "X-Path";
export const HEADER_OFFSET = "X-Offset";
export const HEADER_GENERATION = "X-Generation";

export const MAX_APPEND_BODY_BYTES = 8 * 1024 * 1024;

export const MACHINE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

/**
 * Body of both the 200 and the 409 reply to an append. `generation` is the
 * newest generation the server holds for the path, so a collector that lost
 * its state file can adopt it instead of colliding with archived bytes.
 */
export const AppendResponseSchema = z.object({
  size: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative(),
});
export type AppendResponse = z.infer<typeof AppendResponseSchema>;

/** Everything after `collector_version` and the per-source counts is optional so an older collector still validates. */
export const HeartbeatSchema = z.object({
  collector_version: z.string(),
  hostname: z.string().max(255).optional(),
  /** `<os>-<arch>`, for example linux-x64. */
  platform: z.string().max(64).optional(),
  /** ISO time the collector process started. */
  started_at: z.string().max(40).optional(),
  last_upload_at: z.string().max(40).nullable().optional(),
  last_scan_at: z.string().max(40).nullable().optional(),
  /** The executable the collector runs from, so the admin page can give a command that works there; null from source. */
  exec_path: z.string().max(4096).nullable().optional(),
  /** A short, safe description; never file contents or the token. */
  last_error: z.object({ at: z.string().max(40), message: z.string() }).nullable().optional(),
  /** Whether this collector's config lets the server tell it to update itself. */
  remote_update: z.boolean().optional(),
  /** The outcome of a command that failed, so the server can show why. Success is seen as the new version. */
  command_result: z
    .object({ id: z.string().max(64), ok: z.boolean(), message: z.string().max(500).optional() })
    .optional(),
  sources: z.array(
    z.object({
      name: SourceSchema,
      files: z.number().int().nonnegative(),
      bytes_pending: z.number().int().nonnegative(),
      /** Files with bytes the server does not hold yet. */
      pending_files: z.number().int().nonnegative().optional(),
    }),
  ),
});
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

/** What a heartbeat answer carries when the server wants the collector to do something. */
export const HeartbeatCommandSchema = z.object({
  id: z.string(),
  command: z.literal("update"),
  /** Informational: the collector always installs the server's own version. */
  version: z.string(),
});
export type HeartbeatCommand = z.infer<typeof HeartbeatCommandSchema>;

export const HeartbeatResponseSchema = z.object({ ok: z.boolean(), command: HeartbeatCommandSchema.optional() });
export type HeartbeatResponse = z.infer<typeof HeartbeatResponseSchema>;

export const MESSAGE_ROLES = ["user", "assistant", "tool_call", "tool_result", "reasoning"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const SESSION_KINDS = ["main", "subagent", "guardian"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export interface Alert {
  kind: "drift" | "collector-silent" | "embedding-backlog" | "embedding-error";
  severity: "breaking" | "warning" | "info";
  title: string;
  body: string;
  dedupeKey: string;
}

/*
 * Machine enrollment, modelled on the OAuth device flow. The collector starts
 * a request and shows the user code; an admin approves that code on the
 * server's /admin page; the collector's poll then receives its ingest token,
 * exactly once. Neither endpoint takes a bearer token.
 */
export const ENROLL_START_PATH = "/v1/enroll/start";
export const ENROLL_POLL_PATH = "/v1/enroll/poll";
export const ADMIN_PAGE_PATH = "/admin";

/** Seconds a request stays approvable. */
export const ENROLL_TTL_SECONDS = 600;
/** Seconds the collector waits between polls. */
export const ENROLL_POLL_INTERVAL_SECONDS = 3;
/** Pending requests the server holds at once; more are refused with 429. */
export const ENROLL_MAX_PENDING = 20;
/** Eight characters from an alphabet without look-alikes, shown as XXXX-XXXX. */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";
export const USER_CODE_PATTERN = /^[BCDFGHJKLMNPQRSTVWXZ2-9]{4}-[BCDFGHJKLMNPQRSTVWXZ2-9]{4}$/;

export const EnrollStartRequestSchema = z.object({
  machine: z.string().regex(MACHINE_NAME_PATTERN),
  hostname: z.string().max(255).optional(),
  /** e.g. "linux-x64", "darwin-arm64" */
  platform: z.string().max(64).optional(),
  collector_version: z.string().max(64).optional(),
});
export type EnrollStartRequest = z.infer<typeof EnrollStartRequestSchema>;

export const EnrollStartResponseSchema = z.object({
  /** Secret the collector polls with; never shown to the user. */
  device_code: z.string(),
  user_code: z.string().regex(USER_CODE_PATTERN),
  /** Where the admin approves, e.g. http://192.168.1.10:7878/admin */
  verification_url: z.string(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
});
export type EnrollStartResponse = z.infer<typeof EnrollStartResponseSchema>;

export const EnrollPollRequestSchema = z.object({ device_code: z.string().min(1) });

/**
 * "approved" carries the ingest token and is returned once; the request is
 * gone afterwards, so a repeat poll gets "expired". Unknown and timed-out
 * device codes are "expired" too.
 */
export const EnrollPollResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("denied") }),
  z.object({ status: z.literal("expired") }),
  z.object({ status: z.literal("approved"), token: z.string(), machine: z.string() }),
]);
export type EnrollPollResponse = z.infer<typeof EnrollPollResponseSchema>;
export { compareVersions } from "./versions.ts";
