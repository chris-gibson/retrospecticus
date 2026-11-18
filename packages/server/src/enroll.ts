import { randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import { getConnInfo } from "hono/bun";
import {
  ADMIN_PAGE_PATH,
  ENROLL_MAX_PENDING,
  ENROLL_POLL_INTERVAL_SECONDS,
  ENROLL_POLL_PATH,
  ENROLL_START_PATH,
  ENROLL_TTL_SECONDS,
  EnrollPollRequestSchema,
  EnrollStartRequestSchema,
  USER_CODE_ALPHABET,
  type EnrollPollResponse,
  type EnrollStartResponse,
} from "@retrospecticus/shared";
import { events } from "./events.ts";
import { hashToken, issueToken, type AppEnv } from "./auth.ts";
import {
  countLivePending,
  deleteEnrollRequest,
  getEnrollRequestByDeviceHash,
  insertEnrollRequest,
  purgeExpiredEnrollRequests,
  userCodeExists,
} from "./db/enroll.ts";
import type { Db } from "./db/index.ts";
import { readBodyCapped } from "./ingest/append.ts";

const MAX_ENROLL_BODY_BYTES = 16 * 1024;

export interface EnrollDeps {
  db: Db;
  now: () => Date;
}

/** Unbiased: bytes past the largest multiple of the alphabet size are rejected rather than wrapped. */
export function generateUserCode(): string {
  const n = USER_CODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let code = "";
  while (code.length < 8) {
    for (const byte of randomBytes(16)) {
      if (byte >= limit) continue;
      code += USER_CODE_ALPHABET[byte % n];
      if (code.length === 8) break;
    }
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export async function readJsonBody(c: Context<AppEnv>, limit: number): Promise<unknown> {
  const body = await readBodyCapped(c.req.raw, limit);
  if (body === null) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
}

function remoteAddress(c: Context<AppEnv>): string | null {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    // No Bun server behind the request, as with app.request in tests.
    return null;
  }
}

export function registerEnrollRoutes(app: Hono<AppEnv>, deps: EnrollDeps): void {
  const { db, now } = deps;

  app.post(ENROLL_START_PATH, async (c) => {
    const parsed = EnrollStartRequestSchema.safeParse(await readJsonBody(c, MAX_ENROLL_BODY_BYTES));
    if (!parsed.success) return c.json({ error: "invalid enrollment request", issues: parsed.error.issues }, 400);

    const started = now();
    const nowIso = started.toISOString();
    const deviceCode = randomBytes(32).toString("base64url");
    const userCode = db.transaction(() => {
      purgeExpiredEnrollRequests(db, nowIso);
      if (countLivePending(db, nowIso) >= ENROLL_MAX_PENDING) return null;
      let code = generateUserCode();
      while (userCodeExists(db, code)) code = generateUserCode();
      insertEnrollRequest(db, {
        device_code_hash: hashToken(deviceCode),
        user_code: code,
        machine: parsed.data.machine,
        hostname: parsed.data.hostname ?? null,
        platform: parsed.data.platform ?? null,
        collector_version: parsed.data.collector_version ?? null,
        ip: remoteAddress(c),
        created_at: nowIso,
        expires_at: new Date(started.getTime() + ENROLL_TTL_SECONDS * 1000).toISOString(),
      });
      return code;
    })();
    events.publish("enrollments");
    if (userCode === null) return c.json({ error: "too many pending enrollment requests" }, 429);

    const response: EnrollStartResponse = {
      device_code: deviceCode,
      user_code: userCode,
      verification_url: new URL(c.req.url).origin + ADMIN_PAGE_PATH,
      expires_in: ENROLL_TTL_SECONDS,
      interval: ENROLL_POLL_INTERVAL_SECONDS,
    };
    c.header("Cache-Control", "no-store");
    return c.json(response, 201);
  });

  app.post(ENROLL_POLL_PATH, async (c) => {
    const parsed = EnrollPollRequestSchema.safeParse(await readJsonBody(c, MAX_ENROLL_BODY_BYTES));
    if (!parsed.success) return c.json({ error: "invalid poll request" }, 400);

    const nowIso = now().toISOString();
    const deviceHash = hashToken(parsed.data.device_code);
    const response = db.transaction((): EnrollPollResponse => {
      const request = getEnrollRequestByDeviceHash(db, deviceHash);
      if (!request) return { status: "expired" };
      if (request.expires_at <= nowIso) {
        deleteEnrollRequest(db, request.id);
        events.publish("enrollments");
        return { status: "expired" };
      }
      if (request.status === "pending") return { status: "pending" };
      deleteEnrollRequest(db, request.id);
      if (request.status === "denied") return { status: "denied" };
      const { token } = issueToken(db, {
        scope: "ingest",
        machine: request.machine,
        name: `enroll:${request.hostname || request.machine}`,
      });
      return { status: "approved", token, machine: request.machine };
    })();
    if (response.status === "approved") {
      events.publish("tokens");
      events.publish("machines");
    }
    c.header("Cache-Control", "no-store");
    return c.json(response);
  });
}
