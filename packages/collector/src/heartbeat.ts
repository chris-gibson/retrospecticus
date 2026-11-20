import { HEARTBEAT_PATH, HeartbeatResponseSchema, type Heartbeat, type HeartbeatCommand, type Source, VERSION } from "@retrospecticus/shared";
import type { Uploader } from "./uploader.ts";

export const COLLECTOR_VERSION = VERSION;

export interface SourceStats {
  name: Source;
  files: number;
  /** Bytes on disk the server does not hold yet, including a trailing partial line. */
  bytes_pending: number;
  /** Files with at least one byte the server does not hold yet. */
  pending_files: number;
}

/** What the daemon knows about itself, reported with every heartbeat. */
export interface CollectorFacts {
  hostname: string;
  platform: string;
  started_at: string;
  last_upload_at: string | null;
  last_scan_at: string | null;
  last_error: { at: string; message: string } | null;
  exec_path: string | null;
  remote_update: boolean;
  /** A failed command the server has not yet been told about. */
  command_result?: { id: string; ok: boolean; message?: string };
}

export function buildHeartbeat(sources: readonly SourceStats[], facts?: CollectorFacts): Heartbeat {
  return {
    collector_version: COLLECTOR_VERSION,
    ...facts,
    sources: sources.map(({ name, files, bytes_pending, pending_files }) => ({ name, files, bytes_pending, pending_files })),
  };
}

export interface HeartbeatOutcome {
  /** Null on success, otherwise why it failed. A lost heartbeat is not retried; the next one replaces it. */
  error: string | null;
  /** What the server wants done, when it said so. */
  command: HeartbeatCommand | null;
}

export async function sendHeartbeat(
  uploader: Uploader,
  sources: readonly SourceStats[],
  facts: CollectorFacts,
  stop: AbortSignal,
): Promise<HeartbeatOutcome> {
  const res = await uploader.postJson(HEARTBEAT_PATH, buildHeartbeat(sources, facts), stop);
  if (!res.ok) return { error: res.error, command: null };
  // Only the server's own answer counts as delivered: a proxy's 200 page would otherwise clear a failure report that
  // never reached the server.
  const parsed = HeartbeatResponseSchema.safeParse(res.body);
  if (!parsed.success || !parsed.data.ok) return { error: "unexpected answer to the heartbeat (is a proxy in the way?)", command: null };
  return { error: null, command: parsed.data.command ?? null };
}
