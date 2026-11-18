import type { Db } from "./index.ts";

export type EnrollStatus = "pending" | "approved" | "denied";

export interface EnrollRequestRow {
  id: number;
  device_code_hash: string;
  user_code: string;
  machine: string;
  hostname: string | null;
  platform: string | null;
  collector_version: string | null;
  ip: string | null;
  status: EnrollStatus;
  created_at: string;
  expires_at: string;
}

export type NewEnrollRequest = Omit<EnrollRequestRow, "id" | "status">;

export function insertEnrollRequest(db: Db, request: NewEnrollRequest): EnrollRequestRow {
  const result = db.run(
    `INSERT INTO enroll_requests
       (device_code_hash, user_code, machine, hostname, platform, collector_version, ip, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      request.device_code_hash,
      request.user_code,
      request.machine,
      request.hostname,
      request.platform,
      request.collector_version,
      request.ip,
      request.created_at,
      request.expires_at,
    ],
  );
  return getEnrollRequest(db, Number(result.lastInsertRowid))!;
}

export function getEnrollRequest(db: Db, id: number): EnrollRequestRow | null {
  return db.query<EnrollRequestRow, [number]>("SELECT * FROM enroll_requests WHERE id = ?").get(id);
}

export function getEnrollRequestByDeviceHash(db: Db, hash: string): EnrollRequestRow | null {
  return db.query<EnrollRequestRow, [string]>("SELECT * FROM enroll_requests WHERE device_code_hash = ?").get(hash);
}

export function userCodeExists(db: Db, userCode: string): boolean {
  return db.query<{ n: number }, [string]>("SELECT 1 AS n FROM enroll_requests WHERE user_code = ?").get(userCode) !== null;
}

export function purgeExpiredEnrollRequests(db: Db, nowIso: string): number {
  return db.run("DELETE FROM enroll_requests WHERE expires_at <= ?", [nowIso]).changes;
}

export function countLivePending(db: Db, nowIso: string): number {
  return db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM enroll_requests WHERE status = 'pending' AND expires_at > ?")
    .get(nowIso)!.n;
}

export interface PendingEnrollment extends Omit<EnrollRequestRow, "device_code_hash" | "status"> {
  existing_machine: boolean;
}

export function listLivePending(db: Db, nowIso: string): PendingEnrollment[] {
  const rows = db
    .query<Omit<PendingEnrollment, "existing_machine"> & { existing_machine: number }, [string]>(
      `SELECT r.id, r.user_code, r.machine, r.hostname, r.platform, r.collector_version, r.ip, r.created_at, r.expires_at,
         (EXISTS (SELECT 1 FROM machines m WHERE m.machine = r.machine)
          OR EXISTS (SELECT 1 FROM tokens t
                     WHERE t.scope = 'ingest' AND t.machine = r.machine AND t.revoked_at IS NULL)) AS existing_machine
       FROM enroll_requests r
       WHERE r.status = 'pending' AND r.expires_at > ?
       ORDER BY r.created_at, r.id`,
    )
    .all(nowIso);
  return rows.map((r) => ({ ...r, existing_machine: r.existing_machine !== 0 }));
}

/** Moves a still-pending request to `status`; false if it was no longer pending. */
export function settleEnrollRequest(db: Db, id: number, status: "approved" | "denied"): boolean {
  return db.run("UPDATE enroll_requests SET status = ? WHERE id = ? AND status = 'pending'", [status, id]).changes === 1;
}

export function deleteEnrollRequest(db: Db, id: number): void {
  db.run("DELETE FROM enroll_requests WHERE id = ?", [id]);
}
