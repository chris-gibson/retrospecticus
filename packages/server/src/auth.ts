import { createHash, randomBytes } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { HEADER_MACHINE, MACHINE_NAME_PATTERN, TOKEN_SCOPES, type TokenScope } from "@retrospecticus/shared";
import type { Db } from "./db/index.ts";
import { getTokenByHash, insertToken, touchToken, type TokenRow } from "./db/tokens.ts";

export const TOKEN_PREFIX = "rsp";

/** Hono environment shared by every route: `db` is set by `createApp`, `token` by `requireScope`. */
export type AppEnv = { Variables: { db: Db; token: TokenRow } };

export function isTokenScope(value: string): value is TokenScope {
  return (TOKEN_SCOPES as readonly string[]).includes(value);
}

export function generateToken(scope: TokenScope): string {
  return `${TOKEN_PREFIX}_${scope}_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface IssueTokenOptions {
  scope: TokenScope;
  machine?: string;
  name?: string;
}

export interface IssuedToken {
  /** The plaintext token. It is not recoverable after this call. */
  token: string;
  row: TokenRow;
}

export function issueToken(db: Db, options: IssueTokenOptions): IssuedToken {
  const { scope, machine } = options;
  if (scope === "ingest" && !machine) throw new Error("An ingest token must be bound to a machine");
  if (machine !== undefined && !MACHINE_NAME_PATTERN.test(machine)) {
    throw new Error(`Invalid machine name: ${JSON.stringify(machine)}`);
  }
  const token = generateToken(scope);
  const name = options.name ?? (machine ? `${scope}-${machine}` : scope);
  const row = insertToken(db, { name, hash: hashToken(token), scope, machine: machine ?? null });
  return { token, row };
}

function bearerToken(header: string | undefined): string | null {
  const match = header?.match(/^Bearer +(\S+)$/i);
  return match ? match[1]! : null;
}

/**
 * Admits only tokens of exactly `scope`; no scope implies another. For ingest
 * tokens the machine comes from the token, so an `X-Machine` header can only
 * confirm it, never choose it.
 */
export function requireScope(scope: TokenScope): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const presented = bearerToken(c.req.header("Authorization"));
    const row = presented ? getTokenByHash(c.get("db"), hashToken(presented)) : null;
    if (!row || row.revoked_at) {
      c.header("WWW-Authenticate", "Bearer");
      return c.json({ error: "invalid or missing token" }, 401);
    }
    if (row.scope !== scope) return c.json({ error: `token does not have the ${scope} scope` }, 403);
    if (scope === "ingest") {
      const machine = c.req.header(HEADER_MACHINE);
      if (!row.machine || (machine !== undefined && machine !== row.machine)) {
        return c.json({ error: "token is not bound to this machine" }, 403);
      }
    }
    touchToken(c.get("db"), row.id);
    c.set("token", row);
    await next();
  };
}
