import { describe, expect, test } from "bun:test";
import { checkCollectors } from "../src/alerts/monitors.ts";
import { listAlerts } from "../src/db/alerts.ts";
import { openDb, type Db } from "../src/db/index.ts";

const NOW = new Date("2026-11-16T12:00:00.000Z");
const hoursAgo = (h: number, from = NOW) => new Date(from.getTime() - h * 3_600_000).toISOString();

function seed(db: Db, machine: string, heartbeat: string | null, ingest: string | null): void {
  db.run("INSERT INTO machines (machine, last_heartbeat_at, last_ingest_at) VALUES (?, ?, ?)", [machine, heartbeat, ingest]);
}

describe("checkCollectors", () => {
  test("a silent machine queues one alert per day however often it is checked", () => {
    const db = openDb(":memory:");
    seed(db, "laptop", hoursAgo(72), hoursAgo(80));
    expect(checkCollectors(db, { silentHours: 48, now: NOW })).toBe(1);
    expect(checkCollectors(db, { silentHours: 48, now: NOW })).toBe(0);
    expect(checkCollectors(db, { silentHours: 48, now: new Date(NOW.getTime() + 3_600_000) })).toBe(0);
    const alerts = listAlerts(db);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: "collector-silent",
      severity: "warning",
      title: "Collector silent: laptop",
      dedupe_key: "collector-silent:laptop:2026-11-16",
    });
    expect(alerts[0]!.body).toContain(hoursAgo(72));
    expect(alerts[0]!.body).toContain("72 hours");

    const tomorrow = new Date("2026-11-17T01:00:00.000Z");
    expect(checkCollectors(db, { silentHours: 48, now: tomorrow })).toBe(1);
    expect(listAlerts(db)).toHaveLength(2);
    db.close();
  });

  test("a machine seen recently queues nothing", () => {
    const db = openDb(":memory:");
    seed(db, "laptop", hoursAgo(1), hoursAgo(1));
    expect(checkCollectors(db, { silentHours: 48, now: NOW })).toBe(0);
    expect(listAlerts(db)).toHaveLength(0);
    db.close();
  });

  test("the later of heartbeat and ingest is what counts", () => {
    const db = openDb(":memory:");
    seed(db, "heartbeat-only", hoursAgo(1), hoursAgo(200));
    seed(db, "ingest-only", null, hoursAgo(2));
    seed(db, "both-old", hoursAgo(60), hoursAgo(100));
    expect(checkCollectors(db, { silentHours: 48, now: NOW })).toBe(1);
    expect(listAlerts(db).map((a) => a.title)).toEqual(["Collector silent: both-old"]);
    db.close();
  });

  test("the injected now decides, not the wall clock", () => {
    const db = openDb(":memory:");
    const stamp = new Date().toISOString();
    seed(db, "laptop", stamp, stamp);
    const later = new Date(Date.now() + 100 * 3_600_000);
    expect(checkCollectors(db, { silentHours: 48, now: later })).toBe(1);
    expect(listAlerts(db)[0]!.dedupe_key).toBe(`collector-silent:laptop:${later.toISOString().slice(0, 10)}`);
    db.close();
  });
});
