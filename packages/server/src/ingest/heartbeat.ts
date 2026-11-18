import type { Context } from "hono";
import { HeartbeatSchema } from "@retrospecticus/shared";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth.ts";
import { events } from "../events.ts";
import { recordHeartbeat } from "../db/machines.ts";
import { readBodyCapped } from "./append.ts";

const MAX_HEARTBEAT_BYTES = 64 * 1024;

export function heartbeatHandler(deps: AppDeps): (c: Context<AppEnv>) => Promise<Response> {
  return async (c) => {
    const body = await readBodyCapped(c.req.raw, MAX_HEARTBEAT_BYTES);
    if (body === null) return c.json({ error: "heartbeat body is too large" }, 413);

    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return c.json({ error: "heartbeat body is not JSON" }, 400);
    }
    const heartbeat = HeartbeatSchema.safeParse(json);
    if (!heartbeat.success) return c.json({ error: "invalid heartbeat" }, 400);

    // requireScope guarantees an ingest token carries a machine.
    recordHeartbeat(deps.db, c.get("token").machine!, heartbeat.data);
    events.publish("machines");
    return c.json({ ok: true });
  };
}
