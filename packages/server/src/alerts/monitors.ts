import type { ServerConfig } from "../config.ts";
import { enqueueAlert } from "../db/alerts.ts";
import type { Db } from "../db/index.ts";
import { listMachines } from "../db/machines.ts";

const HOUR_MS = 3_600_000;

export interface CheckCollectorsOptions {
  silentHours: number;
  now?: Date;
}

/** Returns how many alerts were newly queued; the per-day dedupe key makes repeated checks quiet. */
export function checkCollectors(db: Db, { silentHours, now = new Date() }: CheckCollectorsOptions): number {
  const day = now.toISOString().slice(0, 10);
  let queued = 0;
  for (const m of listMachines(db)) {
    const times = [m.last_heartbeat_at, m.last_ingest_at]
      .filter((t): t is string => t !== null)
      .map((t) => Date.parse(t))
      .filter((t) => !Number.isNaN(t));
    if (times.length === 0) continue;
    const lastSeen = Math.max(...times);
    const silentFor = (now.getTime() - lastSeen) / HOUR_MS;
    if (silentFor <= silentHours) continue;
    const added = enqueueAlert(db, {
      kind: "collector-silent",
      severity: "warning",
      title: `Collector silent: ${m.machine}`,
      body: `No heartbeat or ingest from ${m.machine} since ${new Date(lastSeen).toISOString()} (${Math.floor(silentFor)} hours of silence; threshold ${silentHours}).`,
      dedupeKey: `collector-silent:${m.machine}:${day}`,
    });
    if (added) queued++;
  }
  return queued;
}

export function startMonitors(
  db: Db,
  config: ServerConfig | (() => ServerConfig),
  { intervalMs = 15 * 60_000 }: { intervalMs?: number } = {},
): () => Promise<void> {
  const tick = () => {
    try {
      const current = typeof config === "function" ? config() : config;
      checkCollectors(db, { silentHours: current.alerts.collector_silent_hours });
    } catch (err) {
      console.error(`monitor check failed: ${(err as Error).message}`);
    }
  };
  const timer = setInterval(tick, intervalMs);
  return async () => {
    clearInterval(timer);
  };
}
