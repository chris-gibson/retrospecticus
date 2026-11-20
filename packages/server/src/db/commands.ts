import { randomBytes } from "node:crypto";
import { compareVersions } from "@retrospecticus/shared";
import type { Db } from "./index.ts";

export type CommandStatus = "pending" | "delivered" | "done" | "failed" | "expired";

export interface CommandRow {
  id: string;
  machine: string;
  command: "update";
  target_version: string;
  status: CommandStatus;
  message: string | null;
  created_at: string;
  delivered_at: string | null;
  /** The ingest token the command went to: re-enrolling can leave two valid tokens for one machine name. */
  delivered_token_id: number | null;
  finished_at: string | null;
}

export const PENDING_EXPIRY_MS = 24 * 60 * 60 * 1000;
export const DELIVERED_TIMEOUT_MS = 15 * 60 * 1000;
export const NO_REPORT_MESSAGE = "no report from the collector";
const MAX_MESSAGE_CHARS = 300;

const OPEN = "status IN ('pending', 'delivered')";

/** Applied lazily, whenever commands are read or handed out, so nothing needs a timer. */
export function expireCommands(db: Db, now: Date): number {
  const at = now.toISOString();
  const expired = db.run(`UPDATE machine_commands SET status = 'expired', finished_at = ? WHERE status = 'pending' AND created_at < ?`, [
    at,
    new Date(now.getTime() - PENDING_EXPIRY_MS).toISOString(),
  ]);
  const silent = db.run(
    `UPDATE machine_commands SET status = 'failed', message = ?, finished_at = ?
     WHERE status = 'delivered' AND delivered_at < ?`,
    [NO_REPORT_MESSAGE, at, new Date(now.getTime() - DELIVERED_TIMEOUT_MS).toISOString()],
  );
  return expired.changes + silent.changes;
}

export function getOpenCommand(db: Db, machine: string, now: Date): CommandRow | null {
  expireCommands(db, now);
  return db.query<CommandRow, [string]>(`SELECT * FROM machine_commands WHERE machine = ? AND ${OPEN}`).get(machine);
}

/** Null when the machine already has an open command. */
export function createUpdateCommand(db: Db, machine: string, targetVersion: string, now: Date): CommandRow | null {
  if (getOpenCommand(db, machine, now)) return null;
  const id = randomBytes(12).toString("hex");
  db.run(
    `INSERT INTO machine_commands (id, machine, command, target_version, status, created_at)
     VALUES (?, ?, 'update', ?, 'pending', ?)`,
    [id, machine, targetVersion, now.toISOString()],
  );
  return db.query<CommandRow, [string]>("SELECT * FROM machine_commands WHERE id = ?").get(id);
}

/** The newest command per machine, so the admin page can show how the last upgrade went. */
export function latestCommands(db: Db, now: Date): Map<string, CommandRow> {
  expireCommands(db, now);
  const rows = db
    .query<CommandRow, []>(
      `SELECT c.* FROM machine_commands c
       WHERE c.rowid = (SELECT c2.rowid FROM machine_commands c2 WHERE c2.machine = c.machine
                        ORDER BY c2.created_at DESC, c2.rowid DESC LIMIT 1)`,
    )
    .all();
  return new Map(rows.map((row) => [row.machine, row]));
}

function settle(db: Db, id: string, status: "done" | "failed", message: string | null, now: Date): boolean {
  const result = db.run(`UPDATE machine_commands SET status = ?, message = ?, finished_at = ? WHERE id = ? AND ${OPEN}`, [
    status,
    message === null ? null : message.slice(0, MAX_MESSAGE_CHARS),
    now.toISOString(),
    id,
  ]);
  return result.changes > 0;
}

export interface CommandHeartbeat {
  collector_version: string;
  remote_update?: boolean;
  command_result?: { id: string; ok: boolean; message?: string };
}

/**
 * Settles whatever the heartbeat proves, then returns the command to hand out, if any. A delivered command is handed
 * out again on every heartbeat from the token it went to until it settles, since the answer carrying it can be lost;
 * the collector ignores a command it has already taken up. Only that token's heartbeats settle it.
 */
export function applyHeartbeat(db: Db, machine: string, tokenId: number, heartbeat: CommandHeartbeat, now: Date): CommandRow | null {
  expireCommands(db, now);
  const open = db.query<CommandRow, [string]>(`SELECT * FROM machine_commands WHERE machine = ? AND ${OPEN}`).get(machine);
  if (!open) return null;
  if (open.status === "delivered" && open.delivered_token_id !== tokenId) return null;

  const order = compareVersions(heartbeat.collector_version, open.target_version);
  if (order !== null && order >= 0) {
    settle(db, open.id, "done", null, now);
    return null;
  }
  const result = heartbeat.command_result;
  if (result && result.id === open.id && !result.ok) {
    settle(db, open.id, "failed", result.message || "the collector reported a failure", now);
    return null;
  }
  if (heartbeat.remote_update !== true) {
    settle(db, open.id, "failed", "remote updates are off on this machine", now);
    return null;
  }
  if (open.status === "pending") {
    // Conditional, so the command is claimed once even if two heartbeats race.
    const claimed = db.run(
      "UPDATE machine_commands SET status = 'delivered', delivered_at = ?, delivered_token_id = ? WHERE id = ? AND status = 'pending'",
      [now.toISOString(), tokenId, open.id],
    );
    if (claimed.changes === 0) return null;
  }
  return open;
}
