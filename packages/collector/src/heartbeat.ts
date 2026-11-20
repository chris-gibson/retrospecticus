import { HEARTBEAT_PATH, type Heartbeat, type Source, VERSION } from "@retrospecticus/shared";
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
}

export function buildHeartbeat(sources: readonly SourceStats[], facts?: CollectorFacts): Heartbeat {
  return {
    collector_version: COLLECTOR_VERSION,
    ...facts,
    sources: sources.map(({ name, files, bytes_pending, pending_files }) => ({ name, files, bytes_pending, pending_files })),
  };
}

/** Returns null on success, otherwise why it failed. A lost heartbeat is not retried; the next one replaces it. */
export function sendHeartbeat(
  uploader: Uploader,
  sources: readonly SourceStats[],
  facts: CollectorFacts,
  stop: AbortSignal,
): Promise<string | null> {
  return uploader.postJson(HEARTBEAT_PATH, buildHeartbeat(sources, facts), stop);
}
