import { existsSync, statSync } from "node:fs";
import type { Db } from "./index.ts";
import { listModels } from "./vectors.ts";

export const STATS_DAYS = 30;
export const STATS_QUERY_MAX_CHARS = 200;

export interface GroupStats {
  sessions: number;
  messages: number;
  newest_session_started_at: string | null;
}

export interface SourceStats extends GroupStats {
  source: string;
}

export interface MachineStats extends GroupStats {
  machine: string;
  archive_bytes: number;
  last_ingest_at: string | null;
  last_heartbeat_at: string | null;
}

export interface DayCount {
  day: string;
  count: number;
}

export interface Stats {
  generated_at: string;
  library: {
    sessions: { total: number; main: number; subagent: number };
    messages: number;
    chunks: number;
    archive_bytes: number;
    database_bytes: number;
    wal_bytes: number | null;
    sources: SourceStats[];
    machines: MachineStats[];
  };
  activity: {
    sessions_per_day: DayCount[];
    /** Messages parsed per day, from yield_stats; the archive keeps no per-day byte counts. */
    messages_per_day: DayCount[];
  };
  embeddings: {
    backlog: number;
    models: Array<{ slug: string; model: string; dimensions: number; active: boolean; vectors: number; missing: number }>;
  };
  health: {
    open_drift: Array<{ severity: string; count: number }>;
    quarantine: number;
    unsent_alerts: number;
    recent_alerts: Array<{ title: string; severity: string; created_at: string; sent_at: string | null }>;
  };
  usage: {
    total_searches: number;
    searches_per_day: DayCount[];
    by_tool: Array<{ tool: string; count: number }>;
    recent: Array<{ tool: string; query: string | null; result_count: number; created_at: string }>;
  };
  top_projects: Array<{ project_path: string; sessions: number }>;
}

/** The last `days` UTC dates ending at `now`, oldest first. */
function lastDays(now: Date, days: number): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

function fillDays(days: string[], rows: Array<{ day: string; n: number }>): DayCount[] {
  const byDay = new Map(rows.map((r) => [r.day, r.n]));
  return days.map((day) => ({ day, count: byDay.get(day) ?? 0 }));
}

function newer(a: string | null, b: string | null): string | null {
  return a === null ? b : b === null ? a : a > b ? a : b;
}

function fileBytes(path: string): number | null {
  try {
    return existsSync(path) ? statSync(path).size : null;
  } catch {
    return null;
  }
}

function databaseSize(db: Db): { database_bytes: number; wal_bytes: number | null } {
  const pages = db.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 0;
  const pageSize = db.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size ?? 0;
  const file = db.query<{ name: string; file: string }, []>("PRAGMA database_list").all().find((r) => r.name === "main")?.file;
  return { database_bytes: pages * pageSize, wal_bytes: file ? fileBytes(`${file}-wal`) : null };
}

interface SessionRow {
  source: string;
  machine: string;
  kind: string;
  started_at: string | null;
  messages: number;
  chunks: number;
}

export function computeStats(db: Db, now: Date): Stats {
  const days = lastDays(now, STATS_DAYS);
  const since = days[0]!;
  const sinceIso = `${since}T00:00:00.000Z`;
  const count = (sql: string, ...params: string[]): number => db.query<{ n: number }, string[]>(sql).get(...params)?.n ?? 0;

  // Per-session counts come from the (session_id, ordinal) and (session_id, ...) indexes, so no table scan of text.
  const rows = db
    .query<SessionRow, []>(
      `SELECT s.source, s.machine, s.kind, s.started_at,
              (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS messages,
              (SELECT COUNT(*) FROM chunks c WHERE c.session_id = s.id) AS chunks
       FROM sessions s WHERE s.kind != 'guardian'`,
    )
    .all();

  const sessions = { total: 0, main: 0, subagent: 0 };
  let messages = 0;
  let chunks = 0;
  const sources = new Map<string, SourceStats>();
  const machines = new Map<string, GroupStats>();
  const bump = (g: GroupStats, r: SessionRow): void => {
    g.sessions++;
    g.messages += r.messages;
    g.newest_session_started_at = newer(g.newest_session_started_at, r.started_at);
  };
  const blank = (): GroupStats => ({ sessions: 0, messages: 0, newest_session_started_at: null });
  for (const r of rows) {
    sessions.total++;
    if (r.kind === "main") sessions.main++;
    else if (r.kind === "subagent") sessions.subagent++;
    messages += r.messages;
    chunks += r.chunks;
    if (!sources.has(r.source)) sources.set(r.source, { source: r.source, ...blank() });
    bump(sources.get(r.source)!, r);
    if (!machines.has(r.machine)) machines.set(r.machine, blank());
    bump(machines.get(r.machine)!, r);
  }

  const archive = new Map(
    db
      .query<{ machine: string; bytes: number }, []>("SELECT machine, COALESCE(SUM(size), 0) AS bytes FROM files GROUP BY machine")
      .all()
      .map((r) => [r.machine, r.bytes]),
  );
  const registered = db
    .query<{ machine: string; last_ingest_at: string | null; last_heartbeat_at: string | null }, []>(
      "SELECT machine, last_ingest_at, last_heartbeat_at FROM machines",
    )
    .all();
  const names = new Set([...machines.keys(), ...archive.keys(), ...registered.map((r) => r.machine)]);
  const machineStats: MachineStats[] = [...names].sort().map((machine) => {
    const reg = registered.find((r) => r.machine === machine);
    return {
      machine,
      ...(machines.get(machine) ?? blank()),
      archive_bytes: archive.get(machine) ?? 0,
      last_ingest_at: reg?.last_ingest_at ?? null,
      last_heartbeat_at: reg?.last_heartbeat_at ?? null,
    };
  });

  const models = listModels(db);
  const active = models.find((m) => m.active);

  return {
    generated_at: now.toISOString(),
    library: {
      sessions,
      messages,
      chunks,
      archive_bytes: count("SELECT COALESCE(SUM(size), 0) AS n FROM files"),
      ...databaseSize(db),
      sources: [...sources.values()].sort((a, b) => a.source.localeCompare(b.source)),
      machines: machineStats,
    },
    activity: {
      sessions_per_day: fillDays(
        days,
        db
          .query<{ day: string; n: number }, [string]>(
            `SELECT substr(started_at, 1, 10) AS day, COUNT(*) AS n FROM sessions
             WHERE started_at >= ? AND kind != 'guardian' GROUP BY day`,
          )
          .all(sinceIso),
      ),
      messages_per_day: fillDays(
        days,
        db
          .query<{ day: string; n: number }, [string]>(
            "SELECT day, SUM(messages) AS n FROM yield_stats WHERE day >= ? GROUP BY day",
          )
          .all(since),
      ),
    },
    embeddings: {
      backlog: active?.missing ?? 0,
      models: models.map((m) => ({
        slug: m.slug,
        model: m.model,
        dimensions: m.dimensions,
        active: Boolean(m.active),
        vectors: m.vectors,
        missing: m.missing,
      })),
    },
    health: {
      open_drift: db
        .query<{ severity: string; count: number }, []>(
          "SELECT severity, COUNT(*) AS count FROM drift_events WHERE status = 'open' GROUP BY severity ORDER BY severity",
        )
        .all(),
      quarantine: count("SELECT COUNT(*) AS n FROM quarantine"),
      unsent_alerts: count("SELECT COUNT(*) AS n FROM alert_outbox WHERE sent_at IS NULL"),
      recent_alerts: db
        .query<{ title: string; severity: string; created_at: string; sent_at: string | null }, []>(
          "SELECT title, severity, created_at, sent_at FROM alert_outbox ORDER BY id DESC LIMIT 5",
        )
        .all(),
    },
    usage: {
      total_searches: count("SELECT COUNT(*) AS n FROM query_log"),
      searches_per_day: fillDays(
        days,
        db
          .query<{ day: string; n: number }, [string]>(
            "SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM query_log WHERE created_at >= ? GROUP BY day",
          )
          .all(sinceIso),
      ),
      by_tool: db
        .query<{ tool: string; count: number }, []>(
          "SELECT tool, COUNT(*) AS count FROM query_log GROUP BY tool ORDER BY count DESC, tool",
        )
        .all(),
      recent: db
        .query<{ tool: string; query: string | null; result_count: number; created_at: string }, [number]>(
          `SELECT tool, substr(query, 1, ?) AS query, result_count, created_at FROM query_log ORDER BY id DESC LIMIT 10`,
        )
        .all(STATS_QUERY_MAX_CHARS),
    },
    top_projects: db
      .query<{ project_path: string; sessions: number }, []>(
        `SELECT project_path, COUNT(*) AS sessions FROM sessions
         WHERE project_path IS NOT NULL AND kind != 'guardian'
         GROUP BY project_path ORDER BY sessions DESC, project_path LIMIT 10`,
      )
      .all(),
  };
}
