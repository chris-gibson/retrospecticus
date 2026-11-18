import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { listAlerts } from "../src/db/alerts.ts";
import { listDriftEvents, listQuarantine, setBaselineLearned } from "../src/db/drift.ts";
import { openDb, type Db } from "../src/db/index.ts";
import { createDriftDetector } from "../src/drift/detector.ts";
import { runParse } from "../src/indexer/parse.ts";
import { parsers } from "../src/parsers/index.ts";
import { archive, tempDir } from "./fixture-helpers.ts";

let db: Db;
let rawDir: string;

beforeEach(() => {
  db = openDb(":memory:");
  rawDir = tempDir();
});
afterEach(() => {
  db.close();
  rmSync(rawDir, { recursive: true, force: true });
});

function index(): void {
  const observers = [createDriftDetector({ now: () => new Date("2026-11-18T10:00:00.000Z") })];
  while (runParse(db, rawDir, parsers, observers).didWork) {
    // until idle
  }
}

const lines = (...records: object[]): string => records.map((r) => `${JSON.stringify(r)}\n`).join("");

test("a new bookkeeping record type is additive drift for the digest, not a quarantined breaking alert", () => {
  setBaselineLearned(db, "2026-11-18T09:00:00.000Z");
  archive(
    db,
    rawDir,
    { source: "claude-code", path: "p/s.jsonl" },
    lines({ type: "system", subtype: "brand_new_hook_summary", sessionId: "s-1", version: "2.1.400", hookCount: 1 }),
  );
  archive(
    db,
    rawDir,
    { source: "codex", path: "2026/11/18/rollout.jsonl" },
    lines({ timestamp: "2026-11-18T10:00:00.000Z", type: "event_msg", payload: { type: "brand_new_event" } }),
  );
  index();

  const events = listDriftEvents(db).filter((e) => e.severity !== "version");
  expect(events.map((e) => [e.source, e.severity, e.discriminator]).sort()).toEqual([
    ["claude-code", "additive", "system/brand_new_hook_summary"],
    ["codex", "additive", "event_msg/brand_new_event"],
  ]);
  expect(listQuarantine(db)).toEqual([]);
  expect(listAlerts(db).filter((a) => a.severity === "breaking")).toEqual([]);
});
