import type { TokenScope } from "@retrospecticus/shared";
import { nowIso, type Db } from "./index.ts";

export interface TokenRow {
  id: number;
  name: string;
  hash: string;
  scope: TokenScope;
  machine: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface NewToken {
  name: string;
  hash: string;
  scope: TokenScope;
  machine: string | null;
}

export function insertToken(db: Db, token: NewToken): TokenRow {
  const result = db.run("INSERT INTO tokens (name, hash, scope, machine, created_at) VALUES (?, ?, ?, ?, ?)", [
    token.name,
    token.hash,
    token.scope,
    token.machine,
    nowIso(),
  ]);
  return getTokenById(db, Number(result.lastInsertRowid))!;
}

export function getTokenById(db: Db, id: number): TokenRow | null {
  return db.query<TokenRow, [number]>("SELECT * FROM tokens WHERE id = ?").get(id);
}

export function getTokenByHash(db: Db, hash: string): TokenRow | null {
  return db.query<TokenRow, [string]>("SELECT * FROM tokens WHERE hash = ?").get(hash);
}

export function listTokens(db: Db): TokenRow[] {
  return db.query<TokenRow, []>("SELECT * FROM tokens ORDER BY id").all();
}

export function touchToken(db: Db, id: number): void {
  db.run("UPDATE tokens SET last_used_at = ? WHERE id = ?", [nowIso(), id]);
}

export type RevokeResult = "revoked" | "already-revoked" | "not-found";

export function revokeToken(db: Db, id: number): RevokeResult {
  const row = getTokenById(db, id);
  if (!row) return "not-found";
  if (row.revoked_at) return "already-revoked";
  db.run("UPDATE tokens SET revoked_at = ? WHERE id = ?", [nowIso(), id]);
  return "revoked";
}
