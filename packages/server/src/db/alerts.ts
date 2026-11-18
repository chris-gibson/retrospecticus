import type { Alert } from "@retrospecticus/shared";
import { nowIso, type Db } from "./index.ts";

export interface OutboxRow {
  id: number;
  kind: Alert["kind"];
  severity: Alert["severity"];
  title: string;
  body: string;
  dedupe_key: string;
  created_at: string;
  sent_at: string | null;
  attempts: number;
}

/**
 * Queues an alert for the dispatcher. A dedupe key that was ever queued is
 * dropped, so callers can raise the same condition on every tick. Returns
 * whether a row was added.
 */
export function enqueueAlert(db: Db, alert: Alert): boolean {
  const result = db.run(
    `INSERT OR IGNORE INTO alert_outbox (kind, severity, title, body, dedupe_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [alert.kind, alert.severity, alert.title, alert.body, alert.dedupeKey, nowIso()],
  );
  return result.changes > 0;
}

export function listPendingAlerts(db: Db, severities?: readonly Alert["severity"][]): OutboxRow[] {
  const rows = db.query<OutboxRow, []>("SELECT * FROM alert_outbox WHERE sent_at IS NULL ORDER BY id").all();
  return severities ? rows.filter((r) => severities.includes(r.severity)) : rows;
}

export function listAlerts(db: Db): OutboxRow[] {
  return db.query<OutboxRow, []>("SELECT * FROM alert_outbox ORDER BY id").all();
}

export function markAlertsSent(db: Db, ids: readonly number[]): void {
  const stmt = db.query("UPDATE alert_outbox SET sent_at = ? WHERE id = ?");
  const now = nowIso();
  for (const id of ids) stmt.run(now, id);
}

export function recordAlertAttempt(db: Db, ids: readonly number[]): void {
  const stmt = db.query("UPDATE alert_outbox SET attempts = attempts + 1 WHERE id = ?");
  for (const id of ids) stmt.run(id);
}

/** Lets a condition that cleared and came back alert again. */
export function forgetAlert(db: Db, dedupeKey: string): void {
  db.run("DELETE FROM alert_outbox WHERE dedupe_key = ?", [dedupeKey]);
}

/** Withdraws alerts that have not gone out yet; returns how many were removed. */
export function deleteUnsentAlerts(db: Db, dedupeKeys: readonly string[]): number {
  const stmt = db.query("DELETE FROM alert_outbox WHERE dedupe_key = ? AND sent_at IS NULL");
  let removed = 0;
  for (const key of dedupeKeys) removed += stmt.run(key).changes;
  return removed;
}

export function toAlert(row: OutboxRow): Alert {
  return { kind: row.kind, severity: row.severity, title: row.title, body: row.body, dedupeKey: row.dedupe_key };
}
