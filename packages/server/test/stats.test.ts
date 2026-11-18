import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { adminGet, clockedApp, type Clocked } from "./enroll-helpers.ts";
import { adminSession } from "./enroll-helpers.ts";
import { createHarness, type Harness } from "./harness.ts";
import { ADMIN_PAGE_CSP, ADMIN_PAGE_HTML } from "../src/admin/page.ts";
import { createHash } from "node:crypto";

let h: Harness;
let clock: Clocked;

beforeEach(() => {
  h = createHarness();
  clock = clockedApp(h);
});
afterEach(() => h.cleanup());

async function stats(): Promise<any> {
  const { cookie } = await adminSession(clock.app, h);
  const res = await adminGet(clock.app, "/admin/api/stats", cookie);
  expect(res.status).toBe(200);
  return res.json();
}

function seed(): void {
  const { db } = h;
  const t = "2026-11-16T10:00:00.000Z";
  db.run("INSERT INTO files (id, machine, source, path, size, created_at, updated_at) VALUES (1, 'laptop', 'claude-code', 'a', 1000, ?, ?)", [t, t]);
  db.run("INSERT INTO files (id, machine, source, path, size, created_at, updated_at) VALUES (2, 'desk', 'codex', 'b', 500, ?, ?)", [t, t]);
  db.run("INSERT INTO machines (machine, last_ingest_at, last_heartbeat_at) VALUES ('laptop', ?, ?)", [t, t]);
  const session = (id: string, source: string, machine: string, kind: string, project: string, started: string) =>
    db.run("INSERT INTO sessions (id, source, machine, kind, project_path, started_at) VALUES (?, ?, ?, ?, ?, ?)", [id, source, machine, kind, project, started]);
  session("s1", "claude-code", "laptop", "main", "/p/a", "2026-11-16T09:00:00.000Z");
  session("s2", "claude-code", "laptop", "subagent", "/p/a", "2026-11-15T09:00:00.000Z");
  session("s3", "codex", "desk", "main", "/p/b", "2026-11-15T20:00:00.000Z");
  session("g1", "claude-code", "laptop", "guardian", "/p/g", "2026-11-16T09:30:00.000Z");
  let rec = 0;
  const message = (sid: string, n: number) => {
    for (let i = 0; i < n; i++) {
      rec++;
      db.run("INSERT INTO records (id, file_id, byte_offset, byte_length, record_type) VALUES (?, 1, ?, 1, 'x')", [rec, rec]);
      db.run("INSERT INTO messages (session_id, ordinal, role, text, record_id) VALUES (?, ?, 'user', 't', ?)", [sid, i, rec]);
    }
  };
  message("s1", 3);
  message("s2", 1);
  message("s3", 2);
  message("g1", 5);
  const chunk = (sid: string, n: number) => {
    for (let i = 0; i < n; i++) {
      db.run("INSERT INTO chunks (session_id, start_message_id, end_message_id, ordinal, text, text_hash, token_estimate) VALUES (?, 1, 1, ?, 'c', ?, 1)", [sid, i, `${sid}${i}`]);
    }
  };
  chunk("s1", 2);
  chunk("s3", 1);
  chunk("g1", 4);
  db.run("INSERT INTO yield_stats (source, day, lines, messages, chars) VALUES ('codex', '2026-11-16', 1, 7, 1)");
  db.run("INSERT INTO drift_events (source, severity, fingerprint, first_seen, last_seen) VALUES ('codex', 'breaking', 'f1', ?, ?)", [t, t]);
  db.run("INSERT INTO drift_events (source, severity, fingerprint, first_seen, last_seen) VALUES ('codex', 'additive', 'f2', ?, ?)", [t, t]);
  db.run("INSERT INTO drift_events (source, severity, fingerprint, first_seen, last_seen, status) VALUES ('codex', 'additive', 'f3', ?, ?, 'acked')", [t, t]);
  db.run("INSERT INTO quarantine (file_id, byte_offset, byte_length, reason, created_at) VALUES (1, 0, 1, 'bad', ?)", [t]);
  db.run("INSERT INTO alert_outbox (kind, severity, title, body, dedupe_key, created_at, sent_at) VALUES ('k', 'info', 'sent one', 'b', 'd1', ?, ?)", [t, t]);
  db.run("INSERT INTO alert_outbox (kind, severity, title, body, dedupe_key, created_at) VALUES ('k', 'breaking', 'unsent one', 'b', 'd2', ?)", [t]);
  const q = (tool: string, query: string | null, n: number, at: string) =>
    db.run("INSERT INTO query_log (tool, query, result_count, created_at) VALUES (?, ?, ?, ?)", [tool, query, n, at]);
  q("search", "hello", 3, "2026-11-16T08:00:00.000Z");
  q("search", "x".repeat(500), 0, "2026-11-16T09:00:00.000Z");
  q("get_session", null, 1, "2026-11-10T09:00:00.000Z");
  q("search", "ancient", 1, "2025-01-01T00:00:00.000Z");
}

describe("GET /admin/api/stats", () => {
  test("requires an admin session", async () => {
    const res = await clock.app.request("/admin/api/stats");
    expect(res.status).toBe(401);
  });

  test("empty database gives zeros and empty arrays", async () => {
    const s = await stats();
    expect(s.library.sessions).toEqual({ total: 0, main: 0, subagent: 0 });
    expect(s.library.messages).toBe(0);
    expect(s.library.chunks).toBe(0);
    expect(s.library.archive_bytes).toBe(0);
    expect(s.library.database_bytes).toBeGreaterThan(0);
    expect(s.library.sources).toEqual([]);
    expect(s.library.machines).toEqual([]);
    expect(s.activity.sessions_per_day).toHaveLength(30);
    expect(s.activity.sessions_per_day.every((d: any) => d.count === 0)).toBe(true);
    expect(s.activity.sessions_per_day.at(-1).day).toBe("2026-11-16");
    expect(s.embeddings).toEqual({ backlog: 0, models: [] });
    expect(s.health).toEqual({ open_drift: [], quarantine: 0, unsent_alerts: 0, recent_alerts: [] });
    expect(s.usage.total_searches).toBe(0);
    expect(s.usage.by_tool).toEqual([]);
    expect(s.usage.recent).toEqual([]);
    expect(s.top_projects).toEqual([]);
  });

  test("counts a seeded database and leaves guardian sessions out", async () => {
    seed();
    const s = await stats();
    expect(s.library.sessions).toEqual({ total: 3, main: 2, subagent: 1 });
    expect(s.library.messages).toBe(6);
    expect(s.library.chunks).toBe(3);
    expect(s.library.archive_bytes).toBe(1500);
    expect(s.library.sources).toEqual([
      { source: "claude-code", sessions: 2, messages: 4, newest_session_started_at: "2026-11-16T09:00:00.000Z" },
      { source: "codex", sessions: 1, messages: 2, newest_session_started_at: "2026-11-15T20:00:00.000Z" },
    ]);
    const desk = s.library.machines.find((m: any) => m.machine === "desk");
    expect(desk).toMatchObject({ sessions: 1, messages: 2, archive_bytes: 500, last_ingest_at: null });
    const laptop = s.library.machines.find((m: any) => m.machine === "laptop");
    expect(laptop).toMatchObject({ sessions: 2, messages: 4, archive_bytes: 1000, last_ingest_at: "2026-11-16T10:00:00.000Z" });

    const perDay = Object.fromEntries(s.activity.sessions_per_day.map((d: any) => [d.day, d.count]));
    expect(perDay["2026-11-16"]).toBe(1);
    expect(perDay["2026-11-15"]).toBe(2);
    expect(s.activity.messages_per_day.find((d: any) => d.day === "2026-11-16").count).toBe(7);

    expect(s.health.open_drift).toEqual([
      { severity: "additive", count: 1 },
      { severity: "breaking", count: 1 },
    ]);
    expect(s.health.quarantine).toBe(1);
    expect(s.health.unsent_alerts).toBe(1);
    expect(s.health.recent_alerts.map((a: any) => a.title)).toEqual(["unsent one", "sent one"]);
    expect(s.health.recent_alerts[0].sent_at).toBeNull();

    expect(s.usage.total_searches).toBe(4);
    expect(s.usage.by_tool).toEqual([
      { tool: "search", count: 3 },
      { tool: "get_session", count: 1 },
    ]);
    const searchDays = Object.fromEntries(s.usage.searches_per_day.map((d: any) => [d.day, d.count]));
    expect(searchDays["2026-11-16"]).toBe(2);
    expect(searchDays["2026-11-10"]).toBe(1);
    expect(s.usage.recent).toHaveLength(4);
    expect(s.usage.recent[2].query).toHaveLength(200);
    expect(s.top_projects).toEqual([
      { project_path: "/p/a", sessions: 2 },
      { project_path: "/p/b", sessions: 1 },
    ]);
  });
});

describe("page", () => {
  test("the Stats section is served and the CSP still matches the inline script and style", async () => {
    const res = await clock.app.request("/admin");
    const html = await res.text();
    expect(html).toContain("Stats");
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toBe(ADMIN_PAGE_CSP);
    const inline = (tag: string) => html.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))![1]!;
    for (const [directive, tag] of [["script-src", "script"], ["style-src", "style"]] as const) {
      const hash = createHash("sha256").update(inline(tag)).digest("base64");
      expect(csp).toContain(`${directive} 'sha256-${hash}'`);
    }
    expect(ADMIN_PAGE_HTML).toBe(html);
  });
});
