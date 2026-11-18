import type { Hono } from "hono";
import { ENROLL_POLL_PATH, ENROLL_START_PATH, type EnrollStartResponse } from "@retrospecticus/shared";
import { createApp } from "../src/app.ts";
import { issueToken, type AppEnv } from "../src/auth.ts";
import type { Harness } from "./harness.ts";

export const ADMIN_HEADERS = { "Content-Type": "application/json", "X-Retrospecticus-Admin": "1" };

export interface Clocked {
  app: Hono<AppEnv>;
  advance(seconds: number): void;
}

/** An app over the harness's database whose clock the test moves. */
export function clockedApp(h: Harness): Clocked {
  let t = Date.parse("2026-11-16T12:00:00.000Z");
  const app = createApp({ db: h.db, config: h.config, now: () => new Date(t), adminLoginFailureDelayMs: 0 });
  return { app, advance: (seconds) => void (t += seconds * 1000) };
}

export function postJson(app: Hono<AppEnv>, path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

export async function startEnroll(app: Hono<AppEnv>, machine = "laptop", extra: Record<string, unknown> = {}) {
  const res = await postJson(app, ENROLL_START_PATH, { machine, hostname: `${machine}.local`, ...extra });
  if (res.status !== 201) throw new Error(`enroll start failed: ${res.status}`);
  return (await res.json()) as EnrollStartResponse;
}

export async function poll(app: Hono<AppEnv>, deviceCode: string) {
  const res = await postJson(app, ENROLL_POLL_PATH, { device_code: deviceCode });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Signs in with a fresh admin token and returns the Cookie header value for the session. */
export async function adminSession(app: Hono<AppEnv>, h: Harness): Promise<{ cookie: string; tokenId: number }> {
  const { token, row } = issueToken(h.db, { scope: "admin" });
  const res = await postJson(app, "/admin/api/login", { token }, ADMIN_HEADERS);
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  const setCookie = res.headers.get("Set-Cookie")!;
  return { cookie: setCookie.split(";")[0]!, tokenId: row.id };
}

export function adminGet(app: Hono<AppEnv>, path: string, cookie: string) {
  return app.request(path, { headers: { Cookie: cookie } });
}

export function adminPost(app: Hono<AppEnv>, path: string, cookie: string, body: unknown = {}) {
  return postJson(app, path, body, { ...ADMIN_HEADERS, Cookie: cookie });
}
