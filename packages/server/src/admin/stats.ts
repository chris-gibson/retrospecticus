import type { Hono } from "hono";
import { ADMIN_PAGE_PATH } from "@retrospecticus/shared";
import type { AppEnv } from "../auth.ts";
import type { Db } from "../db/index.ts";
import { computeStats } from "../db/stats.ts";

/** Registered after the admin session guard, so it inherits the session requirement. */
export function registerStatsRoute(app: Hono<AppEnv>, deps: { db: Db; now: () => Date }): void {
  app.get(`${ADMIN_PAGE_PATH}/api/stats`, (c) => c.json(computeStats(deps.db, deps.now())));
}
