import { nowIso, vectorTableName, type Db } from "./index.ts";

export interface MachineStatus {
  machine: string;
  last_ingest_at: string | null;
  last_heartbeat_at: string | null;
  files: number;
  parse_backlog_bytes: number;
}

export interface EmbeddingStatus {
  /** Null when no embedding model is active, in which case search is keyword only. */
  active_model: string | null;
  backlog: number;
}

export interface OpenDriftEvent {
  id: number;
  source: string;
  severity: string;
  discriminator: string | null;
  first_seen: string;
  count: number;
}

export interface DriftStatus {
  open: number;
  /** The most severe open events first, at most `OPEN_DRIFT_SHOWN`. */
  events: OpenDriftEvent[];
}

export interface StatusReport {
  generated_at: string;
  machines: MachineStatus[];
  embedding: EmbeddingStatus;
  drift: DriftStatus;
}

export const OPEN_DRIFT_SHOWN = 10;

/** Severities that mean messages may be missing from the index rather than merely unfamiliar. */
export const RECALL_AFFECTING_SEVERITIES = ["breaking", "yield"] as const;

export function machineStatuses(db: Db): MachineStatus[] {
  return db
    .query<MachineStatus, []>(
      `WITH names AS (SELECT machine FROM machines UNION SELECT machine FROM files)
       SELECT n.machine,
              m.last_ingest_at,
              m.last_heartbeat_at,
              (SELECT COUNT(*) FROM files f WHERE f.machine = n.machine) AS files,
              (SELECT COALESCE(SUM(MAX(f.size - f.parsed_offset, 0)), 0) FROM files f WHERE f.machine = n.machine)
                AS parse_backlog_bytes
       FROM names n LEFT JOIN machines m ON m.machine = n.machine
       ORDER BY n.machine`,
    )
    .all();
}

export function embeddingStatus(db: Db): EmbeddingStatus {
  const active = db
    .query<{ slug: string }, []>("SELECT slug FROM embedding_models WHERE active = 1 ORDER BY created_at DESC LIMIT 1")
    .get();
  if (!active) return { active_model: null, backlog: 0 };
  const table = vectorTableName(active.slug);
  const exists = db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  const backlog = exists?.n
    ? db
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM chunks WHERE id NOT IN (SELECT chunk_id FROM "${table}")`,
        )
        .get()
    : db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM chunks").get();
  return { active_model: active.slug, backlog: backlog?.n ?? 0 };
}

export function openDriftStatus(db: Db): DriftStatus {
  const open = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM drift_events WHERE status = 'open'").get();
  const events = db
    .query<OpenDriftEvent, [number]>(
      `SELECT id, source, severity, discriminator, first_seen, count
       FROM drift_events WHERE status = 'open'
       ORDER BY CASE severity WHEN 'breaking' THEN 0 WHEN 'yield' THEN 1 WHEN 'additive' THEN 2 ELSE 3 END, first_seen, id
       LIMIT ?`,
    )
    .all(OPEN_DRIFT_SHOWN);
  return { open: open?.n ?? 0, events };
}

export function countRecallAffectingDrift(db: Db): number {
  const placeholders = RECALL_AFFECTING_SEVERITIES.map(() => "?").join(", ");
  const row = db
    .query<{ n: number }, string[]>(
      `SELECT COUNT(*) AS n FROM drift_events WHERE status = 'open' AND severity IN (${placeholders})`,
    )
    .get(...RECALL_AFFECTING_SEVERITIES);
  return row?.n ?? 0;
}

export function statusReport(db: Db, now: string = nowIso()): StatusReport {
  return {
    generated_at: now,
    machines: machineStatuses(db),
    embedding: embeddingStatus(db),
    drift: openDriftStatus(db),
  };
}

export interface SqliteCapabilities {
  fts5: boolean;
  /** The sqlite-vec version string, or null when the extension is not loaded. */
  vec_version: string | null;
}

export function sqliteCapabilities(db: Db): SqliteCapabilities {
  let fts5 = false;
  try {
    db.run("CREATE VIRTUAL TABLE temp.retrospecticus_doctor_fts USING fts5(body)");
    db.run("DROP TABLE temp.retrospecticus_doctor_fts");
    fts5 = true;
  } catch {
    fts5 = false;
  }
  let vec_version: string | null = null;
  try {
    vec_version = db.query<{ v: string }, []>("SELECT vec_version() AS v").get()?.v ?? null;
  } catch {
    vec_version = null;
  }
  return { fts5, vec_version };
}

export function parseBacklogBytes(db: Db): number {
  const row = db
    .query<{ n: number }, []>("SELECT COALESCE(SUM(MAX(size - parsed_offset, 0)), 0) AS n FROM files")
    .get();
  return row?.n ?? 0;
}
