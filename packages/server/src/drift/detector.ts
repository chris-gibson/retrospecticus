import type { Source } from "@retrospecticus/shared";
import { enqueueAlert, forgetAlert } from "../db/alerts.ts";
import {
  addShapePaths,
  getShape,
  insertQuarantine,
  insertShape,
  isBaselineLearned,
  recordHarnessVersion,
  setDriftEventSample,
  setShapeClassification,
  touchShape,
  unknownShapePaths,
  upsertDriftEvent,
  type DriftSeverity,
  type ShapeClassification,
} from "../db/drift.ts";
import type { Db } from "../db/index.ts";
import type { LineObserver, ParsedLine } from "../indexer/types.ts";
import { parsers as defaultParsers, type ParserRegistry } from "../parsers/index.ts";
import type { ParseResult, Parser } from "../parsers/types.ts";
import { extendDiscriminator, fingerprintOfPaths, keyPaths, MALFORMED_DISCRIMINATOR } from "./fingerprint.ts";
import { scrubSample } from "./scrub-sample.ts";

const DETAIL_LIMIT = 500;
/** How long a "baseline not learned" reading is trusted when no batch boundary comes along to refresh it. */
const BASELINE_RECHECK_MS = 1000;

export interface DriftDetectorOptions {
  parsers?: ParserRegistry;
  now?: () => Date;
}

export interface LineShape {
  discriminator: string;
  fingerprint: string;
  /** The `path:type` entries the fingerprint hashes. */
  paths: string[];
}

export interface Outcome {
  breaking: boolean;
  /** Why the line is breaking: the parser's `unknown` reason, or `unknown-blocks`. */
  reason: string | null;
  /** Safe to store and send: never contains the line's text. */
  detail: string | null;
}

export function lineShape(parser: Parser, json: unknown): LineShape {
  const discriminator =
    json === undefined ? MALFORMED_DISCRIMINATOR : extendDiscriminator(parser.source, parser.discriminator(json), json);
  const paths = json === undefined ? [] : keyPaths(json);
  return { discriminator, fingerprint: fingerprintOfPaths(parser.source, discriminator, paths), paths };
}

/**
 * Plan section 9: anything the parser could not fully read is breaking (an
 * unknown type, a failed validation, unreadable JSON, a content block it does
 * not know); a record it read completely is at most additive.
 */
export function classifyOutcome(result: ParseResult): Outcome {
  if (result.kind === "unknown") {
    // A JSON parse error quotes the text around the failure, so it is never kept.
    const detail = result.reason === "malformed-json" ? "line is not valid JSON" : result.detail.slice(0, DETAIL_LIMIT);
    return { breaking: true, reason: result.reason, detail };
  }
  if (result.kind === "messages" && result.unknownBlocks !== undefined && result.unknownBlocks.length > 0) {
    return { breaking: true, reason: "unknown-blocks", detail: `unknown content blocks: ${result.unknownBlocks.join(", ")}` };
  }
  return { breaking: false, reason: null, detail: null };
}

export function driftDedupeKey(source: Source, fingerprint: string): string {
  return `drift:${source}:${fingerprint}`;
}

/** Names key paths only, which are plain identifiers and types, so it is safe to store and send. */
function newPathsDetail(paths: readonly string[], newType: boolean): string {
  const head = newType ? "first record of this type; key paths" : "new key paths";
  if (paths.length === 0) return `${head}: none`;
  let detail = `${head}: `;
  let listed = 0;
  for (const path of paths) {
    const next = `${listed === 0 ? "" : ", "}${path}`;
    if (detail.length + next.length > DETAIL_LIMIT - 20) break;
    detail += next;
    listed++;
  }
  return listed < paths.length ? `${detail} (and ${paths.length - listed} more)` : detail;
}

function sampleOf(json: unknown): string | null {
  return json === undefined ? null : JSON.stringify(scrubSample(json));
}

interface Raise {
  source: Source;
  severity: Exclude<DriftSeverity, "yield">;
  fingerprint: string;
  discriminator: string | null;
  harnessVersion: string | null;
  detail: string | null;
  /** The parser's reason for a breaking record. */
  reason?: string | null;
  json: unknown;
  /** Whether to compute the sample up front; repeats skip the cost unless the event turns out to be new. */
  withSample: boolean;
  at: string;
}

function raise(db: Db, r: Raise): void {
  const sample = r.withSample ? sampleOf(r.json) : null;
  const { id, created } = upsertDriftEvent(db, {
    source: r.source,
    severity: r.severity,
    fingerprint: r.fingerprint,
    discriminator: r.discriminator,
    harnessVersion: r.harnessVersion,
    sample,
    detail: r.detail,
    seenAt: r.at,
  });
  if (created && !r.withSample) {
    const late = sampleOf(r.json);
    if (late !== null) setDriftEventSample(db, id, late);
  }
  const version = r.harnessVersion === null ? "unknown" : r.harnessVersion;
  const show = `Inspect with: retrospecticus drift show ${id}`;
  const alert = (() => {
    switch (r.severity) {
      case "breaking":
        return {
          severity: "breaking" as const,
          title: `Breaking format drift in ${r.source}: ${r.discriminator}`,
          body: [
            `The ${r.source} parser could not fully read a ${r.discriminator} record (${r.detail ?? "no detail"}).`,
            `Harness version: ${version}. Fingerprint: ${r.fingerprint}.`,
            "The raw archive still has every line; affected lines are quarantined until the parser is fixed and they are reparsed.",
            show,
            ...(r.reason === "unknown-type"
              ? ['If it is bookkeeping rather than conversation, choose "Ignore this type" for it on the admin page.']
              : []),
          ].join("\n"),
        };
      case "additive":
        return {
          severity: "info" as const,
          title: `New ${r.source} record shape: ${r.discriminator}`,
          body: [
            `A ${r.discriminator} record with a structure not seen before was parsed without loss.`,
            ...(r.detail === null ? [] : [`${r.detail[0]!.toUpperCase()}${r.detail.slice(1)}.`]),
            `Harness version: ${version}. Fingerprint: ${r.fingerprint}.`,
            show,
          ].join("\n"),
        };
      case "version":
        return {
          severity: "info" as const,
          title: `New ${r.source} version: ${r.fingerprint}`,
          body: `First record written by ${r.source} ${r.fingerprint}.`,
        };
    }
  })();
  enqueueAlert(db, { kind: "drift", ...alert, dedupeKey: driftDedupeKey(r.source, r.fingerprint) });
}

/**
 * The shape detector. A structure the parser cannot read is quarantined on
 * every sighting, and stays so until its event is acked. A new structure the
 * parser reads is announced only when the baseline is learned and it carries
 * a key path never seen for its discriminator; a new mix of known optional
 * fields is recorded silently. A known structure whose lines start failing (a
 * value the parser rejects, which no key path shows) is escalated to
 * breaking, because otherwise the content would drop out of the index
 * without a word.
 */
export function createDriftDetector(options: DriftDetectorOptions = {}): LineObserver {
  const registry = options.parsers ?? defaultParsers;
  const now = options.now ?? (() => new Date());

  // `shapes learn` sets the flag from another process, so a "not learned" reading is refreshed after every batch.
  let baselineDb: Db | null = null;
  let baselineLearned = false;
  let baselineCheckedAt = Number.NEGATIVE_INFINITY;
  const learned = (db: Db): boolean => {
    const fresh = db === baselineDb && (baselineLearned || performance.now() - baselineCheckedAt < BASELINE_RECHECK_MS);
    if (!fresh) {
      baselineDb = db;
      baselineLearned = isBaselineLearned(db);
      baselineCheckedAt = performance.now();
    }
    return baselineLearned;
  };

  return {
    onLine(db: Db, parsed: ParsedLine): void {
      const { file, json } = parsed;
      const source = file.source;
      const at = now().toISOString();
      const { discriminator, fingerprint: hash, paths } = lineShape(registry[source], json);
      const outcome = classifyOutcome(parsed.result);
      const base = { source, fingerprint: hash, discriminator, harnessVersion: parsed.harnessVersion, json, at };

      const shape = getShape(db, source, hash);
      if (shape === null) {
        const record = (classification: ShapeClassification): void => {
          insertShape(db, {
            source,
            hash,
            discriminator,
            classification,
            harnessVersion: parsed.harnessVersion,
            sampleRef: `${file.id}:${parsed.byteOffset}`,
            seenAt: at,
          });
        };
        if (outcome.breaking) {
          record("breaking");
          raise(db, { ...base, severity: "breaking", detail: outcome.detail, reason: outcome.reason, withSample: true });
        } else if (!learned(db)) {
          record("known");
          addShapePaths(db, source, discriminator, paths);
        } else {
          const fresh = unknownShapePaths(db, source, discriminator, paths);
          if (fresh !== null && fresh.length === 0) {
            record("known");
          } else {
            record("additive");
            addShapePaths(db, source, discriminator, paths);
            const detail = newPathsDetail(fresh ?? paths, fresh === null);
            raise(db, { ...base, severity: "additive", detail, withSample: true });
          }
        }
      } else {
        // Minute precision keeps a large batch of familiar lines from rewriting the row on every line.
        if (shape.last_seen.slice(0, 16) < at.slice(0, 16)) touchShape(db, source, hash, at);
        if (outcome.breaking) {
          const escalated = shape.classification !== "breaking";
          if (escalated) {
            setShapeClassification(db, source, hash, "breaking");
            // The key may hold this shape's earlier info alert, which would swallow the breaking one.
            forgetAlert(db, driftDedupeKey(source, hash));
          }
          raise(db, { ...base, severity: "breaking", detail: outcome.detail, reason: outcome.reason, withSample: escalated });
        }
      }

      if (outcome.breaking) {
        insertQuarantine(db, {
          fileId: file.id,
          byteOffset: parsed.byteOffset,
          byteLength: parsed.byteLength,
          reason: outcome.reason ?? "unknown",
          fingerprint: hash,
        });
      }

      const version = parsed.harnessVersion;
      if (version !== null && recordHarnessVersion(db, source, version, at) && learned(db)) {
        raise(db, {
          source,
          severity: "version",
          fingerprint: version,
          discriminator: null,
          harnessVersion: version,
          detail: null,
          json: undefined,
          withSample: false,
          at,
        });
      }
    },

    onBatchEnd(): void {
      if (!baselineLearned) baselineCheckedAt = Number.NEGATIVE_INFINITY;
    },
  };
}
