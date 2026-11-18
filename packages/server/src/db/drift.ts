import type { Source } from "@retrospecticus/shared";
import { keyPaths } from "../drift/fingerprint.ts";
import { nowIso, type Db } from "./index.ts";

/**
 * `known`: learned or acked. `additive`: first seen while the parser coped.
 * `breaking`: the parser could not read it; its lines are quarantined until
 * the event is acked. `version`: a harness version marker, not a shape.
 */
export type ShapeClassification = "known" | "additive" | "breaking" | "version";
export type DriftSeverity = "breaking" | "additive" | "yield" | "version";
export type DriftStatus = "open" | "acked";

export interface ShapeRow {
  source: Source;
  hash: string;
  discriminator: string;
  classification: ShapeClassification;
  first_seen: string;
  last_seen: string;
  harness_version: string | null;
  sample_ref: string | null;
}

export interface NewShape {
  source: Source;
  hash: string;
  discriminator: string;
  classification: ShapeClassification;
  harnessVersion: string | null;
  sampleRef: string | null;
  seenAt?: string;
}

export function getShape(db: Db, source: Source, hash: string): ShapeRow | null {
  return db.query<ShapeRow, [string, string]>("SELECT * FROM shapes WHERE source = ? AND hash = ?").get(source, hash);
}

/** Returns false when the shape was already recorded. */
export function insertShape(db: Db, shape: NewShape): boolean {
  const at = shape.seenAt ?? nowIso();
  return (
    db.run(
      `INSERT OR IGNORE INTO shapes (source, hash, discriminator, classification, first_seen, last_seen, harness_version, sample_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [shape.source, shape.hash, shape.discriminator, shape.classification, at, at, shape.harnessVersion, shape.sampleRef],
    ).changes > 0
  );
}

/**
 * Records a shape the parser handles as known, promoting an additive one, and
 * adds its key paths to those known for its discriminator. A breaking shape is
 * left alone, paths included: only an ack clears it, so a learn run cannot
 * silence lines that are still quarantined.
 */
export function learnShape(
  db: Db,
  shape: Omit<NewShape, "classification">,
  paths: readonly string[],
): "added" | "promoted" | "unchanged" {
  if (insertShape(db, { ...shape, classification: "known" })) {
    addShapePaths(db, shape.source, shape.discriminator, paths);
    return "added";
  }
  const existing = getShape(db, shape.source, shape.hash);
  if (existing === null || existing.classification === "breaking") return "unchanged";
  addShapePaths(db, shape.source, shape.discriminator, paths);
  const promoted = db.run("UPDATE shapes SET classification = 'known' WHERE source = ? AND hash = ? AND classification = 'additive'", [
    shape.source,
    shape.hash,
  ]).changes;
  return promoted > 0 ? "promoted" : "unchanged";
}

export function addShapePaths(db: Db, source: Source, discriminator: string, paths: readonly string[]): void {
  const stmt = db.query("INSERT OR IGNORE INTO shape_paths (source, discriminator, path) VALUES (?, ?, ?)");
  for (const path of paths) stmt.run(source, discriminator, path);
}

export function listShapePaths(db: Db, source: Source, discriminator: string): string[] {
  return db
    .query<{ path: string }, [string, string]>("SELECT path FROM shape_paths WHERE source = ? AND discriminator = ? ORDER BY path")
    .all(source, discriminator)
    .map((r) => r.path);
}

/**
 * The record's key paths not yet known for its discriminator, or null when no
 * shape the parser copes with has been seen for that discriminator at all.
 */
export function unknownShapePaths(db: Db, source: Source, discriminator: string, paths: readonly string[]): string[] | null {
  const known = db
    .query<{ n: number }, [string, string]>(
      "SELECT 1 AS n FROM shapes WHERE source = ? AND discriminator = ? AND classification IN ('known', 'additive') LIMIT 1",
    )
    .get(source, discriminator);
  if (known === null) return null;
  const stmt = db.query<{ n: number }, [string, string, string]>(
    "SELECT 1 AS n FROM shape_paths WHERE source = ? AND discriminator = ? AND path = ?",
  );
  return paths.filter((path) => stmt.get(source, discriminator, path) === null);
}

const BASELINE_KEY = "drift_baseline_learned";

/** Set by `shapes learn`; until then only breaking drift is reported. */
export function isBaselineLearned(db: Db): boolean {
  return db.query<{ n: number }, [string]>("SELECT 1 AS n FROM meta WHERE key = ?").get(BASELINE_KEY) !== null;
}

export function setBaselineLearned(db: Db, at = nowIso()): void {
  db.run("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)", [BASELINE_KEY, at]);
}

export function touchShape(db: Db, source: Source, hash: string, seenAt = nowIso()): void {
  db.run("UPDATE shapes SET last_seen = ? WHERE source = ? AND hash = ? AND last_seen < ?", [seenAt, source, hash, seenAt]);
}

export function setShapeClassification(db: Db, source: Source, hash: string, classification: ShapeClassification): void {
  db.run("UPDATE shapes SET classification = ? WHERE source = ? AND hash = ?", [classification, source, hash]);
}

/**
 * Shapes the parser copes with that share the discriminator, or failing that
 * its base type (the part before the block-type suffix), for the diff in
 * `drift show`.
 */
export function listComparableShapes(db: Db, source: Source, discriminator: string, base: string, excludeHash: string): ShapeRow[] {
  const query = db.query<ShapeRow, [string, string, string]>(
    `SELECT * FROM shapes WHERE source = ? AND discriminator = ? AND hash != ? AND classification IN ('known', 'additive')
     ORDER BY last_seen DESC LIMIT 50`,
  );
  const exact = query.all(source, discriminator, excludeHash);
  if (exact.length > 0) return exact;
  return db
    .query<ShapeRow, [string, string, string, string]>(
      `SELECT * FROM shapes WHERE source = ? AND (discriminator = ? OR substr(discriminator, 1, length(?) + 1) = ? || '[')
       AND classification IN ('known', 'additive') ORDER BY last_seen DESC LIMIT 50`,
    )
    .all(source, base, base, base)
    .filter((s) => s.hash !== excludeHash);
}

const VERSION_DISCRIMINATOR = "(harness-version)";

/**
 * Harness versions live in `shapes` next to the structures, because both must
 * survive `reindex --from-raw`: a rebuild must not announce every version again.
 */
export function recordHarnessVersion(db: Db, source: Source, version: string, seenAt = nowIso()): boolean {
  return insertShape(db, {
    source,
    hash: `version:${version}`,
    discriminator: VERSION_DISCRIMINATOR,
    classification: "version",
    harnessVersion: version,
    sampleRef: null,
    seenAt,
  });
}

export function isKnownHarnessVersion(db: Db, source: Source, version: string): boolean {
  return getShape(db, source, `version:${version}`) !== null;
}

export interface DriftEventRow {
  id: number;
  source: Source;
  severity: DriftSeverity;
  fingerprint: string;
  discriminator: string | null;
  harness_version: string | null;
  first_seen: string;
  last_seen: string;
  count: number;
  sample: string | null;
  detail: string | null;
  status: DriftStatus;
  acked_at: string | null;
}

export interface DriftEventInput {
  source: Source;
  severity: DriftSeverity;
  fingerprint: string;
  discriminator?: string | null;
  harnessVersion?: string | null;
  /** JSON of the scrubbed sample; only the first sighting's is kept. */
  sample?: string | null;
  detail?: string | null;
  seenAt?: string;
}

/**
 * One row per source, severity and fingerprint; a repeat bumps `count` and
 * `last_seen`. A breaking repeat reopens an acked event, because the ack
 * claimed the parser was fixed and the line just proved otherwise.
 */
export function upsertDriftEvent(db: Db, event: DriftEventInput): { id: number; created: boolean } {
  const at = event.seenAt ?? nowIso();
  const row = db
    .query<{ id: number; count: number }, [string, string, string, string | null, string | null, string, string, string | null, string | null]>(
      `INSERT INTO drift_events (source, severity, fingerprint, discriminator, harness_version, first_seen, last_seen, sample, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source, severity, fingerprint) DO UPDATE SET
         count = count + 1,
         last_seen = MAX(last_seen, excluded.last_seen),
         status = CASE WHEN excluded.severity = 'breaking' THEN 'open' ELSE status END,
         acked_at = CASE WHEN excluded.severity = 'breaking' THEN NULL ELSE acked_at END
       RETURNING id, count`,
    )
    .get(
      event.source,
      event.severity,
      event.fingerprint,
      event.discriminator ?? null,
      event.harnessVersion ?? null,
      at,
      at,
      event.sample ?? null,
      event.detail ?? null,
    )!;
  return { id: row.id, created: row.count === 1 };
}

export function setDriftEventSample(db: Db, id: number, sample: string): void {
  db.run("UPDATE drift_events SET sample = ? WHERE id = ? AND sample IS NULL", [sample, id]);
}

export function getDriftEvent(db: Db, id: number): DriftEventRow | null {
  return db.query<DriftEventRow, [number]>("SELECT * FROM drift_events WHERE id = ?").get(id);
}

/** The scrubbed sample stored for a shape, from whichever event first recorded it. */
export function getSampleForShape(db: Db, source: Source, fingerprint: string): string | null {
  return (
    db
      .query<{ sample: string | null }, [string, string]>(
        "SELECT sample FROM drift_events WHERE source = ? AND fingerprint = ? AND sample IS NOT NULL ORDER BY id LIMIT 1",
      )
      .get(source, fingerprint)?.sample ?? null
  );
}

export function listDriftEvents(db: Db, options: { status?: DriftStatus } = {}): DriftEventRow[] {
  if (options.status === undefined) return db.query<DriftEventRow, []>("SELECT * FROM drift_events ORDER BY id").all();
  return db.query<DriftEventRow, [string]>("SELECT * FROM drift_events WHERE status = ? ORDER BY id").all(options.status);
}

export function listOpenDriftEvents(db: Db): DriftEventRow[] {
  return listDriftEvents(db, { status: "open" });
}

/** Open events, optionally only of some severities (search warns only for breaking and yield). */
export function countOpenDriftEvents(db: Db, severities?: readonly DriftSeverity[]): number {
  const rows = db
    .query<{ severity: DriftSeverity; n: number }, []>("SELECT severity, COUNT(*) AS n FROM drift_events WHERE status = 'open' GROUP BY severity")
    .all();
  return rows.filter((r) => severities === undefined || severities.includes(r.severity)).reduce((n, r) => n + r.n, 0);
}

/**
 * Marks the event as handled and, for a shape event, the shape as known, so
 * the next sighting of a fixed shape stays quiet and is no longer quarantined.
 * The shape's key paths join those known for its discriminator; they come
 * from the scrubbed sample, which keeps every key and value type of the line.
 */
export function ackDriftEvent(db: Db, id: number, at = nowIso()): "acked" | "already-acked" | "not-found" {
  return db.transaction(() => {
    const event = getDriftEvent(db, id);
    if (event === null) return "not-found" as const;
    if (event.severity === "breaking" || event.severity === "additive") {
      setShapeClassification(db, event.source, event.fingerprint, "known");
      const sample = event.sample ?? getSampleForShape(db, event.source, event.fingerprint);
      if (event.discriminator !== null && sample !== null) {
        addShapePaths(db, event.source, event.discriminator, keyPaths(JSON.parse(sample)));
      }
    }
    if (event.status === "acked") return "already-acked" as const;
    db.run("UPDATE drift_events SET status = 'acked', acked_at = ? WHERE id = ?", [at, id]);
    return "acked" as const;
  })();
}

export interface ClosedInfoEvents {
  additive: number;
  version: number;
  /** Source and fingerprint of each closed event, to find its alert. */
  events: { source: Source; fingerprint: string }[];
}

/**
 * Acks every open additive and version event, as `shapes learn` does for
 * what was announced before the baseline existed. Breaking and yield events
 * are never touched.
 */
export function closeOpenInfoDriftEvents(db: Db, at = nowIso()): ClosedInfoEvents {
  const rows = db
    .query<{ source: Source; fingerprint: string; severity: "additive" | "version" }, []>(
      "SELECT source, fingerprint, severity FROM drift_events WHERE status = 'open' AND severity IN ('additive', 'version') ORDER BY id",
    )
    .all();
  db.run(
    `UPDATE shapes SET classification = 'known' WHERE classification = 'additive' AND EXISTS (
       SELECT 1 FROM drift_events e WHERE e.status = 'open' AND e.severity = 'additive'
       AND e.source = shapes.source AND e.fingerprint = shapes.hash)`,
  );
  db.run("UPDATE drift_events SET status = 'acked', acked_at = ? WHERE status = 'open' AND severity IN ('additive', 'version')", [at]);
  return {
    additive: rows.filter((r) => r.severity === "additive").length,
    version: rows.filter((r) => r.severity === "version").length,
    events: rows.map(({ source, fingerprint }) => ({ source, fingerprint })),
  };
}

export interface QuarantineRow {
  id: number;
  file_id: number;
  byte_offset: number;
  byte_length: number;
  reason: string;
  fingerprint: string | null;
  created_at: string;
}

export interface NewQuarantine {
  fileId: number;
  byteOffset: number;
  byteLength: number;
  reason: string;
  fingerprint: string;
}

export function insertQuarantine(db: Db, entry: NewQuarantine): void {
  db.run(
    `INSERT INTO quarantine (file_id, byte_offset, byte_length, reason, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (file_id, byte_offset) DO UPDATE SET
       byte_length = excluded.byte_length, reason = excluded.reason, fingerprint = excluded.fingerprint`,
    [entry.fileId, entry.byteOffset, entry.byteLength, entry.reason, entry.fingerprint, nowIso()],
  );
}

export function listQuarantine(db: Db): QuarantineRow[] {
  return db.query<QuarantineRow, []>("SELECT * FROM quarantine ORDER BY file_id, byte_offset").all();
}

export function countQuarantine(db: Db): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM quarantine").get()?.n ?? 0;
}

export function deleteQuarantine(db: Db, id: number): boolean {
  return db.run("DELETE FROM quarantine WHERE id = ?", [id]).changes > 0;
}

export interface YieldStatsRow {
  source: Source;
  day: string;
  lines: number;
  messages: number;
  chars: number;
}

export function addYieldStats(db: Db, source: Source, day: string, delta: { lines: number; messages: number; chars: number }): void {
  db.run(
    `INSERT INTO yield_stats (source, day, lines, messages, chars) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (source, day) DO UPDATE SET
       lines = lines + excluded.lines, messages = messages + excluded.messages, chars = chars + excluded.chars`,
    [source, day, delta.lines, delta.messages, delta.chars],
  );
}

export function getYieldStats(db: Db, source: Source, day: string): YieldStatsRow | null {
  return db.query<YieldStatsRow, [string, string]>("SELECT * FROM yield_stats WHERE source = ? AND day = ?").get(source, day);
}

/** Median messages-per-line ratio over the `window` days before `day` that read any lines. */
export function trailingMedianRatio(db: Db, source: Source, day: string, window = 14): { median: number | null; days: number } {
  const from = new Date(Date.parse(`${day}T00:00:00.000Z`) - window * 86_400_000).toISOString().slice(0, 10);
  const ratios = db
    .query<{ ratio: number }, [string, string, string]>(
      "SELECT CAST(messages AS REAL) / lines AS ratio FROM yield_stats WHERE source = ? AND day >= ? AND day < ? AND lines > 0 ORDER BY ratio",
    )
    .all(source, from, day)
    .map((r) => r.ratio);
  if (ratios.length === 0) return { median: null, days: 0 };
  const mid = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 === 1 ? ratios[mid]! : (ratios[mid - 1]! + ratios[mid]!) / 2;
  return { median, days: ratios.length };
}

/** Lines of a file in `[start, end)` that the parser accepted as conversation records. */
export function countRecordsInRange(db: Db, fileId: number, start: number, end: number): number {
  return (
    db
      .query<{ n: number }, [number, number, number]>(
        "SELECT COUNT(*) AS n FROM records WHERE file_id = ? AND byte_offset >= ? AND byte_offset < ?",
      )
      .get(fileId, start, end)?.n ?? 0
  );
}

/** True when the file owns sessions and every one of them is a guardian review. */
export function isGuardianOnlyFile(db: Db, fileId: number): boolean {
  const row = db
    .query<{ total: number; guardian: number | null }, [number]>(
      "SELECT COUNT(*) AS total, SUM(kind = 'guardian') AS guardian FROM sessions WHERE file_id = ?",
    )
    .get(fileId);
  return row !== null && row.total > 0 && row.guardian === row.total;
}
