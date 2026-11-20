import type { Heartbeat } from "@retrospecticus/shared";
import { nowIso, type Db } from "./index.ts";

export interface MachineRow {
  machine: string;
  collector_version: string | null;
  last_heartbeat_at: string | null;
  last_ingest_at: string | null;
  /** JSON of the `sources` array from the last heartbeat. */
  sources: string | null;
  hostname: string | null;
  platform: string | null;
  /** When the collector process started. */
  started_at: string | null;
  /** The collector's own last successful upload, as it reported it. */
  last_upload_at: string | null;
  last_scan_at: string | null;
  /** JSON `{ at, message }` of the collector's latest problem, or null. */
  last_error: string | null;
  /** Where the collector's executable is, as it reported it. */
  exec_path: string | null;
}

const MAX_ERROR_CHARS = 300;

export function recordHeartbeat(db: Db, machine: string, heartbeat: Heartbeat): void {
  const error = heartbeat.last_error
    ? JSON.stringify({ at: heartbeat.last_error.at, message: heartbeat.last_error.message.slice(0, MAX_ERROR_CHARS) })
    : null;
  db.run(
    `INSERT INTO machines (machine, collector_version, last_heartbeat_at, sources,
       hostname, platform, started_at, last_upload_at, last_scan_at, last_error, exec_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (machine) DO UPDATE SET
       collector_version = excluded.collector_version,
       last_heartbeat_at = excluded.last_heartbeat_at,
       sources = excluded.sources,
       hostname = excluded.hostname,
       platform = excluded.platform,
       started_at = excluded.started_at,
       last_upload_at = excluded.last_upload_at,
       last_scan_at = excluded.last_scan_at,
       last_error = excluded.last_error,
       exec_path = excluded.exec_path`,
    [
      machine,
      heartbeat.collector_version,
      nowIso(),
      JSON.stringify(heartbeat.sources),
      heartbeat.hostname ?? null,
      heartbeat.platform ?? null,
      heartbeat.started_at ?? null,
      heartbeat.last_upload_at ?? null,
      heartbeat.last_scan_at ?? null,
      error,
      heartbeat.exec_path ?? null,
    ],
  );
}

export function recordIngest(db: Db, machine: string): void {
  db.run(
    `INSERT INTO machines (machine, last_ingest_at) VALUES (?, ?)
     ON CONFLICT (machine) DO UPDATE SET last_ingest_at = excluded.last_ingest_at`,
    [machine, nowIso()],
  );
}

export function getMachine(db: Db, machine: string): MachineRow | null {
  return db.query<MachineRow, [string]>("SELECT * FROM machines WHERE machine = ?").get(machine);
}

export function listMachines(db: Db): MachineRow[] {
  return db.query<MachineRow, []>("SELECT * FROM machines ORDER BY machine").all();
}

export interface MachineSummary extends MachineRow {
  active_ingest_tokens: number;
}

export function listMachineSummaries(db: Db): MachineSummary[] {
  return db
    .query<MachineSummary, []>(
      `SELECT m.*,
         (SELECT COUNT(*) FROM tokens t
          WHERE t.scope = 'ingest' AND t.machine = m.machine AND t.revoked_at IS NULL) AS active_ingest_tokens
       FROM machines m
       ORDER BY m.machine`,
    )
    .all();
}
