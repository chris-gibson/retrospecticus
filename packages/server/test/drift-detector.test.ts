import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { listAlerts } from "../src/db/alerts.ts";
import {
  ackDriftEvent,
  countOpenDriftEvents,
  getShape,
  isBaselineLearned,
  isGuardianOnlyFile,
  listDriftEvents,
  listOpenDriftEvents,
  listQuarantine,
  listShapePaths,
  setBaselineLearned,
  trailingMedianRatio,
  addYieldStats,
} from "../src/db/drift.ts";
import { rawRelativePath, upsertFileSize, type FileRow } from "../src/db/files.ts";
import { openDb, type Db } from "../src/db/index.ts";
import { countMessages } from "../src/db/messages.ts";
import { createDriftDetector } from "../src/drift/detector.ts";
import { keyPaths } from "../src/drift/fingerprint.ts";
import { createYieldMonitor } from "../src/drift/yield.ts";
import { reparseRange, runParse } from "../src/indexer/parse.ts";
import type { LineObserver } from "../src/indexer/types.ts";
import { claudeCodeParser, parsers, type ParserRegistry } from "../src/parsers/index.ts";
import { archive, archiveFixture, manifest, tempDir } from "./fixture-helpers.ts";

let db: Db;
let rawDir: string;
let clock: Date;

beforeEach(() => {
  db = openDb(":memory:");
  rawDir = tempDir();
  clock = new Date("2026-11-16T10:00:00.000Z");
});
afterEach(() => {
  db.close();
  rmSync(rawDir, { recursive: true, force: true });
});

function observers(minLines = 200): LineObserver[] {
  const now = () => clock;
  return [createDriftDetector({ now }), createYieldMonitor({ minLines, now })];
}

let seq = 0;
function userLine(text: string, extra: Record<string, unknown> = {}, sessionId = "s-1"): string {
  seq++;
  return JSON.stringify({
    type: "user",
    uuid: `u-${seq}`,
    parentUuid: null,
    sessionId,
    timestamp: "2026-11-16T10:00:00.000Z",
    cwd: "/work/app",
    version: "2.1.325",
    promptSource: "typed",
    message: { role: "user", content: text },
    ...extra,
  });
}

const jsonl = (lines: string[]) => lines.map((l) => `${l}\n`).join("");

function append(file: FileRow, lines: string[]): FileRow {
  const content = jsonl(lines);
  appendFileSync(join(rawDir, rawRelativePath(file)), content);
  return upsertFileSize(db, file, file.generation, file.size + Buffer.byteLength(content));
}

function index(obs: LineObserver[], registry: ParserRegistry = parsers): void {
  while (runParse(db, rawDir, registry, obs).didWork) {
    // until idle
  }
}

describe("shape detector", () => {
  test("a new shape raises one additive event and the first version one version event", () => {
    setBaselineLearned(db);
    const obs = observers();
    let file = archive(db, rawDir, { source: "claude-code", path: "p/s.jsonl" }, jsonl([userLine("hello"), userLine("again")]));
    index(obs);

    const events = listDriftEvents(db);
    expect(events.map((e) => [e.severity, e.fingerprint.length > 20 ? "hash" : e.fingerprint, e.count])).toEqual([
      ["additive", "hash", 1],
      ["version", "2.1.325", 1],
    ]);
    expect(events[0]!.discriminator).toBe("user");
    expect(events[0]!.detail).toStartWith("first record of this type; key paths: cwd:string, message.content:string");
    expect(JSON.parse(events[0]!.sample!)).toMatchObject({ type: "<str:4>", message: { role: "<str:4>", content: "<str:5>" } });
    expect(listAlerts(db).map((a) => [a.severity, a.dedupe_key])).toEqual([
      ["info", `drift:claude-code:${events[0]!.fingerprint}`],
      ["info", "drift:claude-code:2.1.325"],
    ]);
    const shape = getShape(db, "claude-code", events[0]!.fingerprint)!;
    expect(shape).toMatchObject({ classification: "additive", sample_ref: `${file.id}:0`, harness_version: "2.1.325" });
    expect(listQuarantine(db)).toEqual([]);

    clock = new Date("2026-11-17T10:00:00.000Z");
    file = append(file, [userLine("third")]);
    index(obs);
    expect(listDriftEvents(db).map((e) => e.count)).toEqual([1, 1]);
    expect(listAlerts(db)).toHaveLength(2);
    expect(getShape(db, "claude-code", events[0]!.fingerprint)!.last_seen).toBe("2026-11-17T10:00:00.000Z");
  });

  test("an unknown record type is breaking and every sighting is quarantined", () => {
    const obs = observers();
    const strange = (n: number) => JSON.stringify({ type: "hologram", sessionId: "s-1", body: `secret body ${n}` });
    let file = archive(db, rawDir, { source: "claude-code", path: "p/s.jsonl" }, jsonl([userLine("hi"), strange(1)]));
    index(obs);
    file = append(file, [strange(2), userLine("x"), strange(3)]);
    index(obs);

    const breaking = listDriftEvents(db).filter((e) => e.severity === "breaking");
    expect(breaking).toHaveLength(1);
    expect(breaking[0]).toMatchObject({ discriminator: "hologram", count: 3, status: "open", harness_version: "2.1.325" });
    expect(breaking[0]!.detail).toContain("unrecognised record type hologram");
    expect(breaking[0]!.sample).not.toContain("secret");
    const quarantine = listQuarantine(db);
    expect(quarantine).toHaveLength(3);
    expect(quarantine.every((q) => q.reason === "unknown-type" && q.fingerprint === breaking[0]!.fingerprint)).toBe(true);
    const alerts = listAlerts(db).filter((a) => a.severity === "breaking");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.title).toBe("Breaking format drift in claude-code: hologram");
    expect(alerts[0]!.body).toContain(`drift show ${breaking[0]!.id}`);
    expect(alerts[0]!.body).toContain("choose \"Ignore this type\"");
    expect(getShape(db, "claude-code", breaking[0]!.fingerprint)!.classification).toBe("breaking");
    expect(countOpenDriftEvents(db, ["breaking", "yield"])).toBe(1);
  });

  test("malformed JSON is breaking without a sample or any of the text", () => {
    archive(db, rawDir, { source: "codex", path: "r.jsonl" }, '{"type":"session_meta", "payload": {"secret words\n');
    index(observers());
    const [event] = listDriftEvents(db);
    expect(event).toMatchObject({ severity: "breaking", discriminator: "(malformed)", sample: null, detail: "line is not valid JSON" });
    expect(listQuarantine(db)).toHaveLength(1);
    expect(JSON.stringify(listAlerts(db))).not.toContain("secret");
  });

  test("a known shape whose lines start failing is escalated, and recovers after ack and reparse", () => {
    setBaselineLearned(db);
    const obs = observers();
    let file = archive(db, rawDir, { source: "claude-code", path: "p/s.jsonl" }, jsonl([userLine("fine")]));
    index(obs);
    const [additive] = listDriftEvents(db);
    // Same keys and types, but a value the parser's schema rejects: invisible to the fingerprint.
    const rejected = userLine("hidden", { message: { role: "human", content: "lost text" } });
    file = append(file, [rejected, rejected]);
    index(obs);

    const breaking = listDriftEvents(db).filter((e) => e.severity === "breaking");
    expect(breaking).toHaveLength(1);
    expect(breaking[0]!.fingerprint).toBe(additive!.fingerprint);
    expect(breaking[0]!.count).toBe(2);
    expect(listQuarantine(db)).toHaveLength(2);
    const driftAlerts = listAlerts(db).filter((a) => a.dedupe_key === `drift:claude-code:${additive!.fingerprint}`);
    expect(driftAlerts.map((a) => a.severity)).toEqual(["breaking"]);

    // Acking without fixing the parser: the reparse proves it still fails, so the event reopens.
    expect(ackDriftEvent(db, breaking[0]!.id)).toBe("acked");
    for (const q of listQuarantine(db)) reparseRange(db, rawDir, parsers, obs, q.file_id, q.byte_offset, q.byte_offset + q.byte_length + 1);
    expect(listQuarantine(db)).toHaveLength(2);
    expect(listOpenDriftEvents(db).filter((e) => e.severity === "breaking")).toHaveLength(1);
    expect(listAlerts(db).filter((a) => a.severity === "breaking")).toHaveLength(1);

    const lenient: ParserRegistry = {
      ...parsers,
      "claude-code": {
        ...claudeCodeParser,
        parse: (line, ctx) => claudeCodeParser.parse(line.replace('"role":"human"', '"role":"user"'), ctx),
      },
    };
    const before = countMessages(db);
    expect(ackDriftEvent(db, breaking[0]!.id)).toBe("acked");
    for (const q of listQuarantine(db)) reparseRange(db, rawDir, lenient, obs, q.file_id, q.byte_offset, q.byte_offset + q.byte_length + 1);
    expect(listQuarantine(db)).toEqual([]);
    expect(countMessages(db)).toBe(before + 2);
    expect(listOpenDriftEvents(db).filter((e) => e.severity === "breaking")).toEqual([]);
    expect(getShape(db, "claude-code", additive!.fingerprint)!.classification).toBe("known");
  });

  test("a new mix of key paths already known for the record type raises nothing", () => {
    setBaselineLearned(db);
    const obs = observers();
    let file = archive(db, rawDir, { source: "claude-code", path: "p/s.jsonl" }, jsonl([userLine("a", { gitBranch: "main" })]));
    index(obs);
    file = append(file, [userLine("b", { isSidechain: false })]);
    index(obs);
    const before = listDriftEvents(db);
    expect(before.map((e) => [e.severity, e.detail?.split(";")[0] ?? null])).toEqual([
      ["additive", "first record of this type"],
      ["version", null],
      ["additive", "new key paths: isSidechain:boolean"],
    ]);
    const alertsBefore = listAlerts(db).length;

    append(file, [userLine("c", { gitBranch: "dev", isSidechain: true }), userLine("d")]);
    index(obs);
    expect(listDriftEvents(db)).toEqual(before);
    expect(listAlerts(db)).toHaveLength(alertsBefore);
    const classifications = db
      .query<{ classification: string; n: number }, []>("SELECT classification, COUNT(*) AS n FROM shapes GROUP BY classification ORDER BY classification")
      .all();
    expect(classifications).toEqual([
      { classification: "additive", n: 2 },
      { classification: "known", n: 2 },
      { classification: "version", n: 1 },
    ]);
  });

  test("a genuinely new field raises exactly one additive event that names the path and no value", () => {
    setBaselineLearned(db);
    const obs = observers();
    let file = archive(db, rawDir, { source: "claude-code", path: "p/s.jsonl" }, jsonl([userLine("a")]));
    index(obs);
    const known = listDriftEvents(db).length;
    // The second line mixes the new field with a known field removed: still the same new path, so no second event.
    const { promptSource: _, ...withoutSource } = JSON.parse(userLine("c", { newField: "SECRET-VALUE-2" }));
    file = append(file, [userLine("b", { newField: "SECRET-VALUE-1" }), JSON.stringify(withoutSource)]);
    index(obs);

    const added = listDriftEvents(db).slice(known);
    expect(added.map((e) => [e.severity, e.discriminator, e.detail, e.count])).toEqual([
      ["additive", "user", "new key paths: newField:string", 1],
    ]);
    const alert = listAlerts(db).find((a) => a.dedupe_key === `drift:claude-code:${added[0]!.fingerprint}`)!;
    expect(alert.severity).toBe("info");
    expect(alert.body).toContain("New key paths: newField:string.");
    expect(JSON.stringify([listDriftEvents(db), listAlerts(db)])).not.toContain("SECRET-VALUE");
    expect(listShapePaths(db, "claude-code", "user")).toContain("newField:string");
  });

  test("before the baseline is learned only breaking drift is raised", () => {
    const obs = observers();
    for (const entry of manifest) archiveFixture(db, rawDir, entry);
    index(obs);
    expect(isBaselineLearned(db)).toBe(false);
    expect(listDriftEvents(db)).toEqual([]);
    expect(listAlerts(db)).toEqual([]);
    const counts = db
      .query<{ classification: string; n: number }, []>("SELECT classification, COUNT(*) AS n FROM shapes GROUP BY classification ORDER BY classification")
      .all();
    expect(counts.map((c) => c.classification)).toEqual(["known", "version"]);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM shape_paths").get()!.n).toBeGreaterThan(50);

    const strange = JSON.stringify({ type: "hologram", sessionId: "s-1", body: "secret body" });
    archive(db, rawDir, { source: "claude-code", path: "p/strange.jsonl" }, jsonl([userLine("hi"), strange]));
    index(obs);
    expect(listDriftEvents(db).map((e) => [e.severity, e.discriminator])).toEqual([["breaking", "hologram"]]);
    expect(listAlerts(db).map((a) => a.severity)).toEqual(["breaking"]);
    expect(listQuarantine(db)).toHaveLength(1);
    expect(listShapePaths(db, "claude-code", "hologram")).toEqual([]);
  });

  test("the detector notices a baseline learned elsewhere at the next batch", () => {
    const obs = observers();
    let file = archive(db, rawDir, { source: "claude-code", path: "p/s.jsonl" }, jsonl([userLine("a")]));
    index(obs);
    expect(listDriftEvents(db)).toEqual([]);
    setBaselineLearned(db);
    file = append(file, [userLine("b", { brandNewField: 1 })]);
    index(obs);
    expect(listDriftEvents(db).map((e) => [e.severity, e.detail])).toEqual([["additive", "new key paths: brandNewField:number"]]);
  });

  test("acking a breaking shape adds its key paths, recovered from the scrubbed sample", () => {
    setBaselineLearned(db);
    const obs = observers();
    const json = { type: "hologram", sessionId: "s-1", body: "secret", frames: [{ at: 1, "/odd/key": "x" }], meta: { deep: { deeper: { deepest: 1 } } } };
    archive(db, rawDir, { source: "claude-code", path: "p/s.jsonl" }, jsonl([JSON.stringify(json)]));
    index(obs);
    const [event] = listDriftEvents(db).filter((e) => e.severity === "breaking");
    expect(listShapePaths(db, "claude-code", "hologram")).toEqual([]);
    expect(ackDriftEvent(db, event!.id)).toBe("acked");
    expect(listShapePaths(db, "claude-code", "hologram")).toEqual(keyPaths(json));
  });

  test("a new content block type is breaking even though the rest of the record parsed", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "a-1",
      parentUuid: null,
      sessionId: "s-1",
      timestamp: "2026-11-16T10:00:00.000Z",
      cwd: "/w",
      version: "2.1.325",
      message: { role: "assistant", content: [{ type: "text", text: "kept" }, { type: "chart", data: "lost" }] },
    });
    archive(db, rawDir, { source: "claude-code", path: "p/s.jsonl" }, jsonl([line]));
    index(observers());
    const breaking = listDriftEvents(db).filter((e) => e.severity === "breaking");
    expect(breaking.map((e) => [e.discriminator, e.detail])).toEqual([["assistant[chart,text]", "unknown content blocks: chart"]]);
    expect(listQuarantine(db).map((q) => q.reason)).toEqual(["unknown-blocks"]);
    expect(countMessages(db)).toBe(1);
  });
});

describe("yield monitor", () => {
  const meta = (n: number) => Array.from({ length: n }, () => userLine("injected", { isMeta: true }));
  const typed = (n: number) => Array.from({ length: n }, (_, i) => userLine(`typed ${i}`));

  function yieldEvents() {
    return listDriftEvents(db).filter((e) => e.severity === "yield");
  }

  test("a file of conversation records that yields nothing raises one warning", () => {
    const obs = observers(5);
    let file = archive(db, rawDir, { source: "claude-code", path: "p/s.jsonl" }, jsonl(meta(4)));
    index(obs);
    expect(yieldEvents()).toEqual([]);
    file = append(file, meta(3));
    index(obs);

    const events = yieldEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fingerprint: `file:${file.id}`, status: "open" });
    expect(events[0]!.detail).toContain("7 conversation records");
    const alerts = listAlerts(db).filter((a) => a.severity === "warning");
    expect(alerts.map((a) => a.dedupe_key)).toEqual([`drift:claude-code:file:${file.id}`]);
    expect(alerts[0]!.body).not.toContain("p/s.jsonl");
  });

  test("lines the parser ignores do not count as lines expected to yield", () => {
    const snapshot = () => JSON.stringify({ type: "file-history-snapshot", messageId: "m", snapshot: {}, isSnapshotUpdate: false });
    archive(db, rawDir, { source: "claude-code", path: "p/meta.jsonl" }, jsonl(Array.from({ length: 20 }, snapshot)));
    index(observers(5));
    expect(yieldEvents()).toEqual([]);
  });

  test("guardian sessions are excluded", () => {
    const guardian = manifest.find((e) => e.role === "guardian")!;
    const file = archiveFixture(db, rawDir, guardian);
    index(observers(0));
    expect(isGuardianOnlyFile(db, file.id)).toBe(true);
    expect(yieldEvents()).toEqual([]);
  });

  test("a day under half the trailing median warns once there are seven days of history", () => {
    const obs = observers(5);
    const day = (n: number) => new Date(Date.UTC(2026, 10, n, 12));
    for (let d = 1; d <= 6; d++) {
      clock = day(d);
      archive(db, rawDir, { source: "claude-code", path: `p/day${d}.jsonl` }, jsonl(typed(6)));
      index(obs);
    }
    const lowDay = () => jsonl([...typed(1), ...meta(9)]);
    clock = day(7);
    archive(db, rawDir, { source: "claude-code", path: "p/day7.jsonl" }, lowDay());
    index(obs);
    expect(yieldEvents()).toEqual([]);

    clock = day(8);
    archive(db, rawDir, { source: "claude-code", path: "p/day8.jsonl" }, lowDay());
    index(obs);
    expect(yieldEvents().map((e) => e.fingerprint)).toEqual(["day:2026-11-08"]);
    expect(trailingMedianRatio(db, "claude-code", "2026-11-08")).toEqual({ median: 1, days: 7 });
    expect(listAlerts(db).filter((a) => a.severity === "warning")).toHaveLength(1);
  });

  test("the trailing median covers the fourteen days before the day", () => {
    for (const [d, lines, messages] of [
      ["2026-10-01", 10, 10],
      ["2026-11-01", 10, 2],
      ["2026-11-02", 10, 4],
      ["2026-11-03", 0, 0],
      ["2026-11-14", 10, 8],
      ["2026-11-15", 10, 6],
    ] as const) {
      addYieldStats(db, "codex", d, { lines, messages, chars: 0 });
    }
    expect(trailingMedianRatio(db, "codex", "2026-11-15")).toEqual({ median: 0.4, days: 3 });
    expect(trailingMedianRatio(db, "codex", "2026-11-16")).toEqual({ median: 0.6, days: 3 });
    expect(trailingMedianRatio(db, "claude-code", "2026-11-16")).toEqual({ median: null, days: 0 });
  });
});
