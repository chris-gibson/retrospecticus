import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { ADMIN_PAGE_PATH, VERSION, compareVersions } from "@retrospecticus/shared";
import { hashToken, issueToken, type AppEnv } from "../auth.ts";
import { getEnrollRequest, listLivePending, settleEnrollRequest, type EnrollRequestRow } from "../db/enroll.ts";
import type { Db } from "../db/index.ts";
import { listMachineSummaries } from "../db/machines.ts";
import { getTokenByHash, getTokenById, listTokens, revokeToken, touchToken, type TokenRow } from "../db/tokens.ts";
import type { ConfigStore, ConfigView } from "../config-store.ts";
import { readJsonBody } from "../enroll.ts";
import { events } from "../events.ts";
import { registerEventsRoute, type EventStreamOptions, type SessionWatch } from "./events.ts";
import { ADMIN_PAGE_CSP, ADMIN_PAGE_HTML } from "./page.ts";
import { registerDriftRoutes, type DriftRouteDeps } from "./drift.ts";
import { registerProbeRoutes, type ProbeDeps } from "./probes.ts";
import { registerSettingsRoutes } from "./settings.ts";
import { SETUP_CLAIM_PATH, SETUP_PATH, createSetupState, registerSetupRoutes, type SetupState } from "./setup.ts";
import { registerStatsRoute } from "./stats.ts";

export const ADMIN_COOKIE = "retrospecticus_admin";
export const ADMIN_CSRF_HEADER = "X-Retrospecticus-Admin";
export const ADMIN_SESSION_SECONDS = 12 * 60 * 60;
const API = `${ADMIN_PAGE_PATH}/api`;
const MAX_ADMIN_BODY_BYTES = 16 * 1024;

export interface AdminDeps {
  db: Db;
  now: () => Date;
  /** Paid by every failed login or setup claim so guessing over HTTP is slow. */
  loginFailureDelayMs: number;
  /** What the settings and test endpoints read. */
  config: ConfigView;
  /** Absent when the server has no config file; the settings endpoints then refuse to edit. */
  configStore?: ConfigStore;
  /** Absent means no setup code was issued, so first-run setup is unavailable. */
  setup?: SetupState;
  probeTimeoutsMs?: ProbeDeps["timeoutsMs"];
  /** What the production indexer runs, so an ignored type is reparsed exactly as it will be indexed. */
  wiring?: DriftRouteDeps["wiring"];
  /** Timing and limits of the live event stream; tests shorten them. */
  eventStream?: Partial<EventStreamOptions>;
}

interface AdminSession {
  tokenId: number;
  expiresAt: number;
}

export type PublicToken = Omit<TokenRow, "hash">;

export function publicToken({ hash: _hash, ...rest }: TokenRow): PublicToken {
  return rest;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function codesMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const LoginSchema = z.object({ token: z.string().min(1).max(512) });
const ApproveSchema = z.object({ user_code: z.string().max(64) });
const CreateTokenSchema = z.object({ scope: z.literal("search"), name: z.string().trim().min(1).max(100) });

const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
};

function parseId(raw: string): number | null {
  return /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : null;
}

export function registerAdminRoutes(app: Hono<AppEnv>, deps: AdminDeps): void {
  const { db, now } = deps;
  // Keyed by the SHA-256 of the cookie value so a lookup's timing says nothing about live session ids.
  const sessions = new Map<string, AdminSession>();

  // Live event streams hold a callback here so they end with the session that opened them.
  const endCallbacks = new Map<string, Set<() => void>>();
  const endSession = (key: string): void => {
    sessions.delete(key);
    const callbacks = endCallbacks.get(key);
    endCallbacks.delete(key);
    for (const callback of callbacks ?? []) callback();
  };
  const dropSessionsFor = (tokenId: number): void => {
    for (const [key, session] of [...sessions]) if (session.tokenId === tokenId) endSession(key);
  };
  const sweep = (): void => {
    const t = now().getTime();
    for (const [key, session] of [...sessions]) if (session.expiresAt <= t) endSession(key);
  };
  const clearCookie = (c: Context<AppEnv>): void => {
    deleteCookie(c, ADMIN_COOKIE, { path: ADMIN_PAGE_PATH, httpOnly: true, sameSite: "Strict" });
  };

  app.use(ADMIN_PAGE_PATH, noStore);
  app.use(`${ADMIN_PAGE_PATH}/*`, noStore);

  const page = (c: Context<AppEnv>) => {
    c.header("Content-Security-Policy", ADMIN_PAGE_CSP);
    c.header("X-Frame-Options", "DENY");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    return c.html(ADMIN_PAGE_HTML);
  };
  app.get(ADMIN_PAGE_PATH, page);
  // The link printed at first start; the page reads the code from the query and then drops it from the address bar.
  app.get(`${ADMIN_PAGE_PATH}/setup`, page);
  app.get(`${ADMIN_PAGE_PATH}/`, (c) => c.redirect(ADMIN_PAGE_PATH));

  // A cross-site form cannot set a custom header or a JSON content type, and a cross-site fetch that does is preflighted and refused.
  const csrf: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD") return next();
    const contentType = c.req.header("Content-Type") ?? "";
    if (
      c.req.method !== "POST" ||
      !/^application\/json\s*(;|$)/i.test(contentType) ||
      c.req.header(ADMIN_CSRF_HEADER) !== "1"
    ) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  };

  const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
    const cookie = getCookie(c, ADMIN_COOKIE);
    const key = cookie ? sha256(cookie) : null;
    const session = key ? sessions.get(key) : undefined;
    const row = session && session.expiresAt > now().getTime() ? getTokenById(db, session.tokenId) : null;
    if (!session || !row || row.revoked_at || row.scope !== "admin") {
      if (key) endSession(key);
      return c.json({ error: "not signed in" }, 401);
    }
    c.set("token", row);
    await next();
  };

  const startSession = (c: Context<AppEnv>, tokenId: number): void => {
    sweep();
    const id = randomBytes(32).toString("base64url");
    sessions.set(sha256(id), { tokenId, expiresAt: now().getTime() + ADMIN_SESSION_SECONDS * 1000 });
    // No Secure flag: the server is reached over plain http on a private network, where a Secure cookie would never be sent.
    setCookie(c, ADMIN_COOKIE, id, {
      httpOnly: true,
      sameSite: "Strict",
      path: ADMIN_PAGE_PATH,
      maxAge: ADMIN_SESSION_SECONDS,
    });
  };

  const sessionless = new Set([`${API}/login`, `${API}/logout`, SETUP_PATH, SETUP_CLAIM_PATH]);
  app.use(`${API}/*`, csrf);
  app.use(`${API}/*`, async (c, next) => {
    if (sessionless.has(c.req.path)) return next();
    return requireSession(c, next);
  });

  registerSetupRoutes(app, {
    setup: deps.setup ?? createSetupState(db),
    failureDelayMs: deps.loginFailureDelayMs,
    startSession,
    maxBodyBytes: MAX_ADMIN_BODY_BYTES,
  });

  app.post(`${API}/login`, async (c) => {
    const parsed = LoginSchema.safeParse(await readJsonBody(c, MAX_ADMIN_BODY_BYTES));
    const row = parsed.success ? getTokenByHash(db, hashToken(parsed.data.token)) : null;
    if (!row || row.revoked_at || row.scope !== "admin") {
      await Bun.sleep(deps.loginFailureDelayMs);
      return c.json({ error: "not a valid admin token" }, 401);
    }
    touchToken(db, row.id);
    startSession(c, row.id);
    return c.json({ ok: true, token: { id: row.id, name: row.name } });
  });

  app.post(`${API}/logout`, (c) => {
    const cookie = getCookie(c, ADMIN_COOKIE);
    if (cookie) endSession(sha256(cookie));
    clearCookie(c);
    return c.json({ ok: true });
  });

  app.get(`${API}/session`, (c) => {
    const token = c.get("token");
    return c.json({ token: { id: token.id, name: token.name } });
  });

  app.get(`${API}/enrollments`, (c) => c.json({ enrollments: listLivePending(db, now().toISOString()) }));

  const liveRequest = (raw: string): EnrollRequestRow | null => {
    const id = parseId(raw);
    const request = id === null ? null : getEnrollRequest(db, id);
    return request && request.expires_at > now().toISOString() ? request : null;
  };

  app.post(`${API}/enrollments/:id/approve`, async (c) => {
    const parsed = ApproveSchema.safeParse(await readJsonBody(c, MAX_ADMIN_BODY_BYTES));
    if (!parsed.success) return c.json({ error: "user_code is required" }, 400);
    const request = liveRequest(c.req.param("id"));
    if (!request) return c.json({ error: "no such enrollment request, or it has expired" }, 404);
    if (request.status !== "pending") return c.json({ error: `request is already ${request.status}` }, 409);
    if (!codesMatch(parsed.data.user_code.trim().toUpperCase(), request.user_code)) {
      return c.json({ error: "code does not match this request" }, 400);
    }
    if (!settleEnrollRequest(db, request.id, "approved")) return c.json({ error: "request is no longer pending" }, 409);
    events.publish("enrollments");
    return c.json({ ok: true, machine: request.machine });
  });

  app.post(`${API}/enrollments/:id/deny`, (c) => {
    const request = liveRequest(c.req.param("id"));
    if (!request) return c.json({ error: "no such enrollment request, or it has expired" }, 404);
    if (!settleEnrollRequest(db, request.id, "denied")) return c.json({ error: `request is already ${request.status}` }, 409);
    events.publish("enrollments");
    return c.json({ ok: true });
  });

  const watchSession = (c: Context<AppEnv>): SessionWatch => {
    const key = sha256(getCookie(c, ADMIN_COOKIE) ?? "");
    return {
      alive() {
        const session = sessions.get(key);
        if (!session || session.expiresAt <= now().getTime()) return false;
        const row = getTokenById(db, session.tokenId);
        return row !== null && !row.revoked_at && row.scope === "admin";
      },
      onEnd(callback) {
        let callbacks = endCallbacks.get(key);
        if (!callbacks) endCallbacks.set(key, (callbacks = new Set()));
        callbacks.add(callback);
        const session = sessions.get(key);
        const remaining = session ? Math.min(Math.max(0, session.expiresAt - now().getTime()), 2 ** 31 - 1) : 0;
        const timer = setTimeout(() => endSession(key), remaining);
        return () => {
          clearTimeout(timer);
          endCallbacks.get(key)?.delete(callback);
        };
      },
    };
  };
  registerEventsRoute(app, { db, watchSession, options: deps.eventStream });
  registerStatsRoute(app, { db, now });
  registerSettingsRoutes(app, { db, view: deps.config, store: deps.configStore, maxBodyBytes: MAX_ADMIN_BODY_BYTES });
  registerDriftRoutes(app, { db, view: deps.config, store: deps.configStore, wiring: deps.wiring, maxBodyBytes: MAX_ADMIN_BODY_BYTES });
  registerProbeRoutes(app, { view: deps.config, maxBodyBytes: MAX_ADMIN_BODY_BYTES, timeoutsMs: deps.probeTimeoutsMs });

  app.get(`${API}/machines`, (c) =>
    c.json({
      // Only older collectors are outdated: `update` will not downgrade a newer one.
      machines: listMachineSummaries(db).map((m) => ({
        ...m,
        outdated: m.collector_version !== null && (compareVersions(m.collector_version, VERSION) ?? 0) < 0,
      })),
      server_version: VERSION,
    }),
  );

  app.get(`${API}/tokens`, (c) => c.json({ tokens: listTokens(db).map(publicToken) }));

  app.post(`${API}/tokens`, async (c) => {
    const parsed = CreateTokenSchema.safeParse(await readJsonBody(c, MAX_ADMIN_BODY_BYTES));
    if (!parsed.success) {
      return c.json({ error: "only search tokens can be created here, and they need a name" }, 400);
    }
    const { token, row } = issueToken(db, { scope: "search", name: parsed.data.name });
    events.publish("tokens");
    return c.json({ token, row: publicToken(row) }, 201);
  });

  // Revoking the token behind the current session is allowed; that session ends with it.
  app.post(`${API}/tokens/:id/revoke`, (c) => {
    const id = parseId(c.req.param("id"));
    const result = id === null ? "not-found" : revokeToken(db, id);
    if (result === "not-found") return c.json({ error: "no such token" }, 404);
    events.publish("tokens");
    events.publish("machines");
    dropSessionsFor(id!);
    const sessionEnded = id === c.get("token").id;
    if (sessionEnded) clearCookie(c);
    return c.json({ result, session_ended: sessionEnded });
  });
}
