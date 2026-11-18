import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Source } from "@retrospecticus/shared";
import { dbPath, loadConfig, rawDir as rawDirOf, type ServerConfig } from "@retrospecticus/server/config.ts";
import { enqueueAlert, listAlerts, markAlertsSent } from "@retrospecticus/server/db/alerts.ts";
import {
  getShape,
  isBaselineLearned,
  listDriftEvents,
  listQuarantine,
  listShapePaths,
  upsertDriftEvent,
} from "@retrospecticus/server/db/drift.ts";
import { listFiles, rawRelativePath, upsertFileSize, type FileRow } from "@retrospecticus/server/db/files.ts";
import { openDb, type Db } from "@retrospecticus/server/db/index.ts";
import { countMessages } from "@retrospecticus/server/db/messages.ts";
import { runUntilIdle } from "@retrospecticus/server/indexer/loop.ts";
import type { LineObserver } from "@retrospecticus/server/indexer/types.ts";
import { claudeCodeParser, codexParser, parsers, type ParserRegistry } from "@retrospecticus/server/parsers/index.ts";
import type { ParseContext, ParseResult } from "@retrospecticus/server/parsers/types.ts";
import { driftDedupeKey } from "@retrospecticus/server/drift/detector.ts";
import { keyPaths } from "@retrospecticus/server/drift/fingerprint.ts";
import { buildWiring } from "@retrospecticus/server/wiring.ts";
import {
  archiveFixture,
  archivedPath,
  fixtureLines,
  manifest,
  type FixtureEntry,
} from "../../server/test/fixture-helpers.ts";
import { reparseFiles, reparseQuarantined } from "../src/commands/reparse.ts";
import { run } from "../src/main.ts";

type Json = Record<string, any>;

let dir: string;
let configPath: string;
let config: ServerConfig;
let db: Db;
let raw: string;
let observers: LineObserver[];

function setup(yieldMinLines = 200): void {
  writeFileSync(
    configPath,
    JSON.stringify({ data_dir: join(dir, "data"), listen_host: "127.0.0.1", listen_port: 0, indexer: { yield_min_lines: yieldMinLines } }),
  );
  config = loadConfig(configPath);
  db = openDb(dbPath(config));
  raw = rawDirOf(config);
  observers = buildWiring(db, config).observers;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "retrospecticus-drift-"));
  configPath = join(dir, "config.json");
});
afterEach(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function cli(...args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(["--config", configPath, ...args], { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

async function index(registry: ParserRegistry = parsers): Promise<void> {
  await runUntilIdle({ db, rawDir: raw, parsers: registry, observers });
}

function archiveAll(): void {
  for (const entry of manifest) archiveFixture(db, raw, entry);
}

/** Learns the archived fixtures through the CLI, then indexes them: the quiet starting point of every scenario. */
async function baseline(): Promise<void> {
  archiveAll();
  const learned = await cli("shapes", "learn");
  expect(learned.code).toBe(0);
  expect(learned.out.join("\n")).toContain("The parsers read every shape in the archive.");
  expect(isBaselineLearned(db)).toBe(true);
  await index();
  expect(listDriftEvents(db)).toEqual([]);
  expect(listAlerts(db)).toEqual([]);
}

function fileFor(source: Source, path: string): FileRow {
  return listFiles(db).find((f) => f.source === source && f.path === path)!;
}

function appendLines(file: FileRow, lines: string[]): FileRow {
  const content = lines.map((l) => `${l}\n`).join("");
  appendFileSync(join(raw, rawRelativePath(file)), content);
  return upsertFileSize(db, file, file.generation, file.size + Buffer.byteLength(content));
}

function newFile(source: Source, path: string, lines: string[]): FileRow {
  const file = upsertFileSize(db, { machine: "laptop", source, path }, 0, 0);
  writeFileSync(join(raw, rawRelativePath(file)), "", { flag: "a" });
  return appendLines(file, lines);
}

interface Template {
  entry: FixtureEntry;
  json: Json;
}

/** The first fixture line that satisfies `match`, given what the real parser made of it in file order. */
function findTemplate(source: Source, match: (json: Json, result: ParseResult) => boolean): Template {
  for (const entry of manifest.filter((e) => e.source === source && e.role !== "coverage")) {
    const ctx: ParseContext = { source, machine: "laptop", path: archivedPath(entry), state: {} };
    for (const line of fixtureLines(entry)) {
      const result = parsers[source].parse(line, ctx);
      const json = JSON.parse(line);
      if (match(json, result)) return { entry, json };
    }
  }
  throw new Error(`no ${source} template line`);
}

const yields = (result: ParseResult, role: string) =>
  result.kind === "messages" && result.messages.some((m) => m.role === role) && result.unknownBlocks === undefined;

function markerCount(): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM messages WHERE text LIKE '%SECRET-TEXT%'").get()!.n;
}

function withParse(base: typeof claudeCodeParser, rewrite: (json: Json) => Json): ParserRegistry {
  const parser = {
    ...base,
    parse: (line: string, ctx: ParseContext) => {
      let json: Json;
      try {
        json = JSON.parse(line);
      } catch {
        return base.parse(line, ctx);
      }
      return base.parse(JSON.stringify(rewrite(json)), ctx);
    },
  };
  return { ...parsers, [base.source]: parser };
}

interface Scenario {
  name: string;
  source: Source;
  severity: "breaking" | "additive" | "yield";
  alertSeverity: "breaking" | "info" | "warning";
  yieldMinLines?: number;
  /** Mutated copies of one fixture line; every copy has the same shape. */
  mutate(): { lines: string[]; target: (lines: string[]) => FileRow; append: (file: FileRow, lines: string[]) => FileRow };
  /** Messages carrying the marker that exist before recovery. */
  markersBefore: number;
  markersAfter: number;
  standIn: ParserRegistry;
  showContains?: string[];
  detail?: string;
}

const COPIES = 3;

function copies(template: Json, n: number, change: (json: Json, i: number) => Json): string[] {
  return Array.from({ length: n }, (_, i) => JSON.stringify(change(structuredClone(template), i)));
}

function inFixture(t: Template) {
  return {
    target: (lines: string[]) => appendLines(fileFor(t.entry.source, archivedPath(t.entry)), lines),
    append: (file: FileRow, lines: string[]) => appendLines(file, lines),
  };
}

const scenarios: Scenario[] = [
  {
    name: "(a) an unknown record type",
    source: "claude-code",
    severity: "breaking",
    alertSeverity: "breaking",
    mutate() {
      const t = findTemplate("claude-code", (j, r) => j.type === "user" && typeof j.message.content === "string" && yields(r, "user"));
      const lines = copies(t.json, COPIES, (j, i) => ({
        ...j,
        type: "prompt",
        uuid: `00000000-0000-4000-8000-a0000000000${i}`,
        message: { role: "user", content: `SECRET-TEXT-a${i}` },
      }));
      return { lines, ...inFixture(t) };
    },
    markersBefore: 0,
    markersAfter: COPIES,
    standIn: withParse(claudeCodeParser, (j) => (j.type === "prompt" ? { ...j, type: "user" } : j)),
    showContains: ["No known shape with this discriminator to compare with."],
  },
  {
    name: "(b) a renamed required field",
    source: "codex",
    severity: "breaking",
    alertSeverity: "breaking",
    mutate() {
      const t = findTemplate("codex", (j, r) => j.payload?.type === "function_call" && yields(r, "tool_call"));
      const lines = copies(t.json, COPIES, (j, i) => {
        const { call_id, ...payload } = j.payload;
        return { ...j, payload: { ...payload, callId: `${call_id}-${i}`, arguments: `SECRET-TEXT-b${i}` } };
      });
      return { lines, ...inFixture(t) };
    },
    markersBefore: 0,
    markersAfter: COPIES,
    standIn: withParse(codexParser, (j) => {
      if (j.payload?.callId === undefined) return j;
      const { callId, ...payload } = j.payload;
      return { ...j, payload: { ...payload, call_id: callId } };
    }),
    showContains: ["  + payload.callId:string", "  - payload.call_id:string"],
  },
  {
    name: "(c) an added optional field",
    source: "claude-code",
    severity: "additive",
    alertSeverity: "info",
    mutate() {
      const t = findTemplate("claude-code", (j, r) => j.type === "user" && typeof j.message.content === "string" && yields(r, "user"));
      const lines = copies(t.json, COPIES, (j, i) => ({
        ...j,
        uuid: `00000000-0000-4000-8000-c0000000000${i}`,
        message: { ...j.message, content: `SECRET-TEXT-c${i}` },
        newOptionalField: { enabled: true },
      }));
      return { lines, ...inFixture(t) };
    },
    markersBefore: COPIES,
    markersAfter: COPIES,
    standIn: parsers,
    showContains: ["  + newOptionalField.enabled:boolean", "  + newOptionalField:object"],
    detail: "new key paths: newOptionalField.enabled:boolean, newOptionalField:object",
  },
  {
    name: "(d) a new content block type",
    source: "claude-code",
    severity: "breaking",
    alertSeverity: "breaking",
    mutate() {
      const t = findTemplate(
        "claude-code",
        (j, r) => j.type === "assistant" && j.message.content.length === 1 && j.message.content[0].type === "text" && yields(r, "assistant"),
      );
      const lines = copies(t.json, COPIES, (j, i) => ({
        ...j,
        uuid: `00000000-0000-4000-8000-d0000000000${i}`,
        message: { ...j.message, content: [...j.message.content, { type: "diagram", text: `SECRET-TEXT-d${i}` }] },
      }));
      return { lines, ...inFixture(t) };
    },
    markersBefore: 0,
    markersAfter: COPIES,
    standIn: withParse(claudeCodeParser, (j) =>
      j.type === "assistant"
        ? { ...j, message: { ...j.message, content: j.message.content.map((b: Json) => (b.type === "diagram" ? { ...b, type: "text" } : b)) } }
        : j,
    ),
    showContains: ["Nearest known shape:"],
  },
  {
    name: "(e) content moved so yield drops",
    source: "claude-code",
    severity: "yield",
    alertSeverity: "warning",
    yieldMinLines: 5,
    mutate() {
      // The text moves into a sibling string field, so the shape is one the baseline already knows.
      const t = findTemplate(
        "claude-code",
        (j, r) =>
          j.type === "assistant" &&
          j.message.content.length === 1 &&
          j.message.content[0].type === "thinking" &&
          typeof j.message.content[0].signature === "string" &&
          yields(r, "reasoning"),
      );
      const lines = copies(t.json, 8, (j, i) => ({
        ...j,
        uuid: `00000000-0000-4000-8000-e0000000000${i}`,
        message: { ...j.message, content: [{ ...j.message.content[0], thinking: "", signature: `SECRET-TEXT-e${i}` }] },
      }));
      const path = `${t.entry.version}/moved-thinking.jsonl`;
      return {
        lines,
        target: (first: string[]) => newFile("claude-code", path, first),
        append: (file: FileRow, more: string[]) => appendLines(file, more),
      };
    },
    markersBefore: 0,
    markersAfter: 8,
    standIn: withParse(claudeCodeParser, (j) =>
      j.type === "assistant"
        ? {
            ...j,
            message: {
              ...j.message,
              content: j.message.content.map((b: Json) =>
                b.type === "thinking" && b.thinking === "" && String(b.signature).startsWith("SECRET") ? { ...b, thinking: b.signature } : b,
              ),
            },
          }
        : j,
    ),
  },
];

describe("shapes learn", () => {
  test("learning the fixtures makes a full index of them raise no drift at all", async () => {
    setup();
    await baseline();
    expect(listQuarantine(db)).toEqual([]);
    const shapes = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM shapes WHERE classification = 'known'").get()!.n;
    expect(shapes).toBeGreaterThan(20);
    const versions = db.query<{ hash: string }, []>("SELECT hash FROM shapes WHERE classification = 'version' ORDER BY hash").all();
    for (const version of new Set(manifest.map((e) => e.version))) expect(versions.map((v) => v.hash)).toContain(`version:${version}`);
  });

  test("an index before the baseline records shapes and versions silently, and learning twice changes nothing", async () => {
    setup();
    archiveAll();
    await index();
    expect(listDriftEvents(db)).toEqual([]);
    expect(listAlerts(db)).toEqual([]);
    const versions = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM shapes WHERE classification = 'version'").get()!.n;
    expect(versions).toBeGreaterThanOrEqual(new Set(manifest.map((e) => e.version)).size);
    const pathRows = () => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM shape_paths").get()!.n;
    const pathsBefore = pathRows();
    expect(pathsBefore).toBeGreaterThan(50);

    const first = await cli("shapes", "learn");
    expect(first.out[0]).toMatch(/^Learned 0 new shapes \(0 promoted from additive\) and 0 harness versions/);
    expect(first.out[1]).toBe("Baseline recorded. Closed 0 additive and 0 version drift events and withdrew 0 unsent digest alerts.");
    expect(isBaselineLearned(db)).toBe(true);
    expect(pathRows()).toBe(pathsBefore);
    const second = await cli("shapes", "learn");
    expect(second.out[0]).toMatch(/^Learned 0 new shapes \(0 promoted from additive\) and 0 harness versions/);
  });

  test("learning closes open additive and version events and their unsent alerts, but never breaking ones", async () => {
    setup();
    archiveAll();
    const file = fileFor("claude-code", archivedPath(manifest.find((e) => e.source === "claude-code")!));
    appendLines(file, [JSON.stringify({ type: "hologram", sessionId: "s", body: "SECRET-TEXT" })]);
    await index();
    const [breaking] = listDriftEvents(db);
    expect(breaking).toMatchObject({ severity: "breaking", status: "open" });

    // Left over from before the baseline existed: two shapes and a version announced, one of them already in a sent digest.
    const leftovers = [
      { severity: "additive" as const, fingerprint: "a".repeat(64) },
      { severity: "additive" as const, fingerprint: "b".repeat(64) },
      { severity: "version" as const, fingerprint: "9.9.9" },
    ];
    for (const l of leftovers) {
      upsertDriftEvent(db, { source: "claude-code", discriminator: l.severity === "additive" ? "user" : null, ...l });
      enqueueAlert(db, { kind: "drift", severity: "info", title: "t", body: "b", dedupeKey: driftDedupeKey("claude-code", l.fingerprint) });
    }
    db.run(
      "INSERT INTO shapes (source, hash, discriminator, classification, first_seen, last_seen) VALUES ('claude-code', ?, 'user', 'additive', '2026-11-01', '2026-11-01')",
      ["a".repeat(64)],
    );
    const sent = listAlerts(db).find((a) => a.dedupe_key === driftDedupeKey("claude-code", "b".repeat(64)))!;
    markAlertsSent(db, [sent.id]);

    const learned = await cli("shapes", "learn");
    expect(learned.code).toBe(0);
    expect(learned.out[1]).toBe("Baseline recorded. Closed 2 additive and 1 version drift events and withdrew 2 unsent digest alerts.");
    expect(isBaselineLearned(db)).toBe(true);
    expect(listDriftEvents(db).map((e) => [e.severity, e.fingerprint.slice(0, 5), e.status])).toEqual([
      ["breaking", breaking!.fingerprint.slice(0, 5), "open"],
      ["additive", "aaaaa", "acked"],
      ["additive", "bbbbb", "acked"],
      ["version", "9.9.9", "acked"],
    ]);
    expect(getShape(db, "claude-code", "a".repeat(64))!.classification).toBe("known");
    expect(listAlerts(db).map((a) => [a.severity, a.dedupe_key])).toEqual([
      ["breaking", driftDedupeKey("claude-code", breaking!.fingerprint)],
      ["info", driftDedupeKey("claude-code", "b".repeat(64))],
    ]);
    expect(listQuarantine(db)).toHaveLength(1);
  });

  test("after learning, a rebuild from the raw archive raises no drift", async () => {
    setup();
    await baseline();
    const shapes = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM shapes").get()!.n;
    const rebuilt = await cli("reindex", "--from-raw");
    expect(rebuilt.code).toBe(0);
    expect(listDriftEvents(db)).toEqual([]);
    expect(listAlerts(db)).toEqual([]);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM shapes").get()!.n).toBe(shapes);
    expect(isBaselineLearned(db)).toBe(true);
  });

  test("shapes the parser cannot read are reported and not learned", async () => {
    setup();
    archiveAll();
    const file = fileFor("claude-code", archivedPath(manifest.find((e) => e.source === "claude-code")!));
    appendLines(file, [JSON.stringify({ type: "hologram", sessionId: "s", body: "SECRET-TEXT" })]);
    const { code, out } = await cli("shapes", "learn");
    expect(code).toBe(0);
    const report = out.join("\n");
    expect(report).toContain("Not learned: 1 shapes");
    expect(report).toMatch(/claude-code {2}hologram {2}unknown-type {2}x1/);
    expect(report).not.toContain("SECRET-TEXT");

    await index();
    expect(listDriftEvents(db).map((e) => [e.severity, e.discriminator])).toEqual([["breaking", "hologram"]]);
  });
});

describe("drift scenarios from the plan", () => {
  for (const scenario of scenarios) {
    test(`${scenario.name}: ${scenario.severity}, one event, one alert, full recovery`, async () => {
      setup(scenario.yieldMinLines);
      await baseline();
      const messagesBefore = countMessages(db);

      const { lines, target, append } = scenario.mutate();
      const split = Math.ceil(lines.length / 2);
      const file = target(lines.slice(0, split));
      await index();
      append(fileFor(file.source, file.path), lines.slice(split));
      await index();

      const events = listDriftEvents(db);
      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.severity).toBe(scenario.severity);
      expect(event.status).toBe("open");
      if (scenario.severity === "breaking") expect(event.count).toBe(lines.length);
      if (scenario.severity === "additive") expect(event.count).toBe(1);
      if (scenario.detail !== undefined) expect(event.detail).toBe(scenario.detail);
      const alerts = listAlerts(db);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ kind: "drift", severity: scenario.alertSeverity, dedupe_key: `drift:${scenario.source}:${event.fingerprint}` });

      const quarantine = listQuarantine(db);
      if (scenario.severity === "breaking") {
        expect(quarantine).toHaveLength(lines.length);
        expect(quarantine.every((q) => q.fingerprint === event.fingerprint)).toBe(true);
      } else {
        expect(quarantine).toEqual([]);
      }
      expect(markerCount()).toBe(scenario.markersBefore);
      if (scenario.severity === "yield") expect(countMessages(db)).toBe(messagesBefore);

      const listed = await cli("drift", "list");
      expect(listed.code).toBe(0);
      expect(listed.out[1]).toMatch(new RegExp(`^${event.id}\\s+${scenario.severity}\\s+${scenario.source}\\s+open\\s+`));

      const shown = await cli("drift", "show", String(event.id));
      expect(shown.code).toBe(0);
      const showText = shown.out.join("\n");
      expect(showText).not.toContain("SECRET-TEXT");
      if (scenario.severity !== "yield") expect(showText).toContain("Scrubbed sample");
      for (const expected of scenario.showContains ?? []) expect(showText).toContain(expected);

      expect((await cli("drift", "ack", String(event.id))).code).toBe(0);
      if (scenario.severity !== "yield") expect(getShape(db, scenario.source, event.fingerprint)!.classification).toBe("known");
      if (scenario.severity === "breaking") {
        const known = listShapePaths(db, scenario.source, event.discriminator!);
        for (const path of keyPaths(JSON.parse(lines[0]!))) expect(known).toContain(path);
      }

      if (scenario.severity === "breaking") reparseQuarantined(db, raw, scenario.standIn, observers);
      else if (scenario.standIn === parsers) {
        expect((await cli("reparse", "--quarantined")).code).toBe(0);
        const reparsed = await cli("reparse", "--source", scenario.source, "--since", "2000-01-01");
        expect(reparsed.code).toBe(0);
        expect(reparsed.out[0]).toMatch(/^Reparsed \d+ files/);
      } else reparseFiles(db, raw, scenario.standIn, observers, { source: scenario.source, since: "2000-01-01T00:00:00.000Z" });

      expect(listQuarantine(db)).toEqual([]);
      expect(markerCount()).toBe(scenario.markersAfter);
      const after = listDriftEvents(db);
      expect(after).toHaveLength(1);
      expect(after[0]!.status).toBe("acked");
      expect(listAlerts(db)).toHaveLength(1);
      expect((await cli("drift", "list")).out).toEqual(["No open drift events."]);
    });
  }
});

describe("drift and reparse commands", () => {
  test("refuse bad invocations", async () => {
    setup();
    expect((await cli("drift")).code).toBe(2);
    expect((await cli("drift", "show")).code).toBe(2);
    expect((await cli("drift", "ack", "x")).code).toBe(2);
    expect((await cli("drift", "show", "99")).code).toBe(1);
    expect((await cli("drift", "ack", "99")).code).toBe(1);
    expect((await cli("shapes")).code).toBe(2);
    expect((await cli("shapes", "forget")).code).toBe(2);
    expect((await cli("reparse")).code).toBe(2);
    expect((await cli("reparse", "--source", "cursor")).code).toBe(2);
    expect((await cli("reparse", "--since", "yesterday-ish")).code).toBe(2);
    expect((await cli("reparse", "--quarantined", "--source", "codex")).code).toBe(2);
    expect((await cli("drift", "list", "--all")).out).toEqual(["No drift events."]);
  });

  test("help lists the new commands", async () => {
    setup();
    const help = (await cli("help")).out.join("\n");
    for (const name of ["drift", "reparse", "shapes"]) expect(help).toMatch(new RegExp(`^  ${name}\\b`, "m"));
  });
});
