import { enqueueAlert, forgetAlert } from "../db/alerts.ts";
import type { Db } from "../db/index.ts";
import {
  activateModel,
  countMissing,
  ensureModel,
  getActiveModel,
  getModel,
  insertVectors,
  knn,
  listChunksWithoutVector,
  type ModelRow,
} from "../db/vectors.ts";
import { events } from "../events.ts";
import type { EmbeddingProvider } from "../embeddings/types.ts";
import type { VectorSearch } from "../search/index.ts";
import type { IndexerStage } from "./types.ts";

export const EMBED_BATCH_SIZE = 96;

export interface EmbedStageOptions {
  provider: EmbeddingProvider;
  batchSize?: number;
  /** Chunks waiting for a vector beyond which an `embedding-backlog` alert is raised; a function is asked each run. */
  backlogThreshold: number | (() => number);
  /** Receives each failed provider call; when set, the default one-line log is skipped. */
  onError?: (error: unknown) => void;
  /** Injectable for tests. */
  now?: () => number;
}

export type EmbedErrorKind = "quota" | "auth" | "rate_limit" | "server" | "other";

export interface EmbedErrorStatus {
  slug: string;
  kind: EmbedErrorKind;
  message: string;
  since: string;
  last_failure_at: string;
  next_attempt_at: string;
  consecutive_failures: number;
  status?: number;
}

const TRANSIENT_BACKOFF_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000, 600_000];
const PERSISTENT_BACKOFF_MS = 15 * 60_000;
/** Transient failures alert only once they have lasted this long. */
export const TRANSIENT_ALERT_AFTER_MS = 30 * 60_000;

export function embedBackoffMs(kind: EmbedErrorKind, consecutiveFailures: number): number {
  if (kind === "quota" || kind === "auth") return PERSISTENT_BACKOFF_MS;
  return TRANSIENT_BACKOFF_MS[Math.min(consecutiveFailures, TRANSIENT_BACKOFF_MS.length) - 1]!;
}

const errorStatuses = new WeakMap<Db, Map<string, EmbedErrorStatus>>();

/** Why embedding with this model is failing right now, or null when it is healthy. */
export function getEmbedError(db: Db, slug: string): EmbedErrorStatus | null {
  return errorStatuses.get(db)?.get(slug) ?? null;
}

export function clearEmbedErrors(db: Db): void {
  if (errorStatuses.delete(db)) events.publish("embedding");
}

function setEmbedError(db: Db, status: EmbedErrorStatus | null, slug: string): void {
  let map = errorStatuses.get(db);
  if (!map) errorStatuses.set(db, (map = new Map()));
  if (status) {
    map.set(slug, status);
    events.publish("embedding");
  } else if (map.delete(slug)) events.publish("embedding");
}

export function embedErrorAlertKey(slug: string, kind: EmbedErrorKind): string {
  return `embedding-error:${slug}:${kind}`;
}

const ERROR_KINDS: readonly EmbedErrorKind[] = ["quota", "auth", "rate_limit", "server", "other"];

function errorKindOf(error: unknown): EmbedErrorKind {
  const kind = (error as { kind?: unknown } | null)?.kind;
  return ERROR_KINDS.includes(kind as EmbedErrorKind) ? (kind as EmbedErrorKind) : "other";
}

function providerLabel(slug: string): string {
  const { provider } = splitSlug(slug);
  return provider === "openai" ? "OpenAI" : provider;
}

/** One plain sentence for logs and alerts. */
function describeFailure(slug: string, kind: EmbedErrorKind, status: number | undefined): string {
  const name = providerLabel(slug);
  const code = status === undefined ? "" : ` (${status})`;
  switch (kind) {
    case "quota":
      return `${name} has no credits remaining (quota)`;
    case "auth":
      return `${name} rejected the API key${code}`;
    case "rate_limit":
      return `${name} is rate limiting requests${code}`;
    case "server":
      return `${name} is unavailable${code}`;
    default:
      return `embedding with ${slug} failed`;
  }
}

function minutesText(ms: number): string {
  const minutes = ms / 60_000;
  return minutes >= 1 ? `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} min` : `${Math.round(ms / 1000)} s`;
}

function utcClock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

function advice(slug: string, kind: EmbedErrorKind): string {
  const name = providerLabel(slug);
  switch (kind) {
    case "quota":
      return `Add credit with ${name} (for OpenAI: platform.openai.com, Settings, Billing).`;
    case "auth":
      return "Check the provider's API key under Settings, Secrets (omlx_api_key for oMLX, embedding_api_key otherwise), or the provider's account.";
    default:
      return `Check ${name}'s status page and the embedding settings if this does not clear.`;
  }
}

export function backlogAlertKey(slug: string): string {
  return `embedding-backlog:${slug}`;
}

/** Slugs are `<provider>-<model>`, e.g. "openai-text-embedding-3-small". */
function splitSlug(slug: string): { provider: string; model: string } {
  const dash = slug.indexOf("-");
  return dash > 0 ? { provider: slug.slice(0, dash), model: slug.slice(dash + 1) } : { provider: slug, model: slug };
}

export function registerProvider(db: Db, provider: EmbeddingProvider): ModelRow {
  events.publish("embedding");
  return ensureModel(db, {
    slug: provider.slug,
    ...splitSlug(provider.slug),
    dimensions: provider.dimensions,
    query_prefix: provider.queryPrefix ?? "",
    document_prefix: provider.documentPrefix ?? "",
  });
}

/** Embeds one batch. Provider errors propagate; returns how many vectors were stored and how many chunks were tried. */
async function embedBatch(db: Db, provider: EmbeddingProvider, batchSize: number): Promise<{ tried: number; stored: number }> {
  const batch = listChunksWithoutVector(db, provider.slug, batchSize);
  if (batch.length === 0) return { tried: 0, stored: 0 };
  const prefix = provider.documentPrefix ?? "";
  const vectors = await provider.embed(batch.map((c) => prefix + c.text));
  if (vectors.length !== batch.length) {
    throw new Error(`${provider.slug} returned ${vectors.length} embeddings for ${batch.length} texts`);
  }
  const stored = insertVectors(
    db,
    provider.slug,
    batch.map((c, i) => ({ chunkId: c.id, textHash: c.text_hash, embedding: vectors[i]! })),
  );
  return { tried: batch.length, stored };
}

/**
 * Fills the provider's own table, whichever model is active, so the server
 * keeps the configured model current while `reembed` prepares another one.
 */
export function createEmbedStage(options: EmbedStageOptions): IndexerStage & { resetBackoff(): void } {
  const { provider } = options;
  const threshold = (): number =>
    typeof options.backlogThreshold === "function" ? options.backlogThreshold() : options.backlogThreshold;
  const batchSize = options.batchSize ?? EMBED_BATCH_SIZE;
  const now = options.now ?? Date.now;
  let failure: { since: number; count: number } | null = null;
  let nextAttemptAt = 0;
  // After a restart the outbox may still hold keys from an earlier incident; the first success clears them.
  let sweptStaleAlerts = false;

  function checkBacklog(db: Db): void {
    const missing = countMissing(db, provider.slug);
    const key = backlogAlertKey(provider.slug);
    const backlogThreshold = threshold();
    if (missing > backlogThreshold) {
      enqueueAlert(db, {
        kind: "embedding-backlog",
        severity: "warning",
        title: `Embedding backlog: ${missing} chunks waiting for ${provider.slug}`,
        body: `${missing} chunks have no ${provider.slug} vector (threshold ${backlogThreshold}). Keyword search still finds them; check the embedding provider and its key.`,
        dedupeKey: key,
      });
    } else if (missing === 0) {
      // Forgetting the key lets a later backlog alert again.
      forgetAlert(db, key);
    }
  }

  const alertKeys = ERROR_KINDS.map((kind) => embedErrorAlertKey(provider.slug, kind));

  function recordFailure(db: Db, error: unknown): void {
    const kind = errorKindOf(error);
    const at = now();
    failure = { since: failure?.since ?? at, count: (failure?.count ?? 0) + 1 };
    const wait = embedBackoffMs(kind, failure.count);
    nextAttemptAt = at + wait;
    const status = (error as { status?: unknown } | null)?.status;
    const message = (error as Error)?.message ?? String(error);
    setEmbedError(
      db,
      {
        slug: provider.slug,
        kind,
        message,
        since: new Date(failure.since).toISOString(),
        last_failure_at: new Date(at).toISOString(),
        next_attempt_at: new Date(nextAttemptAt).toISOString(),
        consecutive_failures: failure.count,
        ...(typeof status === "number" ? { status } : {}),
      },
      provider.slug,
    );
    const summary = describeFailure(provider.slug, kind, typeof status === "number" ? status : undefined);
    const logLine = `embed: ${provider.slug}: ${summary}. Retrying in ${minutesText(wait)}, at ${utcClock(nextAttemptAt)} UTC.`;
    if (options.onError) options.onError(error);
    else console.warn(logLine);
    raiseAlert(db, kind, summary, at - failure.since);
  }

  function raiseAlert(db: Db, kind: EmbedErrorKind, summary: string, lastedMs: number): void {
    const persistent = kind === "quota" || kind === "auth";
    if (!persistent && lastedMs < TRANSIENT_ALERT_AFTER_MS) return;
    const retry = persistent ? "every 15 minutes" : "with increasing delays (up to every 10 minutes)";
    enqueueAlert(db, {
      kind: "embedding-error",
      severity: "warning",
      title: `Embedding stopped: ${summary}`,
      body:
        `${summary}${persistent ? "" : `, and it has been failing for ${Math.round(lastedMs / 60_000)} minutes`}. ` +
        `Embedding with ${provider.slug} is paused and the server will retry ${retry}. ` +
        `Keyword search keeps working, but new sessions are not searchable by meaning until this is fixed. ${advice(provider.slug, kind)}`,
      dedupeKey: embedErrorAlertKey(provider.slug, kind),
    });
  }

  function recordSuccess(db: Db): void {
    const hadFailure = failure !== null;
    failure = null;
    nextAttemptAt = 0;
    setEmbedError(db, null, provider.slug);
    if (!hadFailure && sweptStaleAlerts) return;
    sweptStaleAlerts = true;
    const placeholders = alertKeys.map(() => "?").join(",");
    const raised = db.query(`SELECT 1 FROM alert_outbox WHERE dedupe_key IN (${placeholders}) LIMIT 1`).get(...alertKeys) !== null;
    for (const key of alertKeys) forgetAlert(db, key);
    if (raised) {
      enqueueAlert(db, {
        kind: "embedding-error",
        severity: "info",
        title: `Embedding resumed for ${provider.slug}`,
        body: `Embedding with ${provider.slug} is working again and the backlog is being filled.`,
        dedupeKey: `embedding-resumed:${provider.slug}:${new Date(now()).toISOString()}`,
      });
    }
  }

  return {
    name: "embed",
    resetBackoff() {
      nextAttemptAt = 0;
    },
    async run(db) {
      // Checked every tick so `embedding drop` on a live server is followed by a rebuild.
      if (!getModel(db, provider.slug)) registerProvider(db, provider);
      if (!getActiveModel(db)) activateModel(db, provider.slug);
      if (now() < nextAttemptAt) return false;
      let result;
      try {
        result = await embedBatch(db, provider, batchSize);
      } catch (error) {
        recordFailure(db, error);
        checkBacklog(db);
        return false;
      }
      // An empty queue proves nothing about the provider, so it neither clears nor starts an incident.
      if (result.tried > 0) recordSuccess(db);
      checkBacklog(db);
      return result.stored > 0;
    },
  };
}

export interface EmbedProgress {
  slug: string;
  /** Vectors stored by this run so far. */
  embedded: number;
  /** Chunks still without a vector in this model's table. */
  missing: number;
}

export interface EmbedAllOptions {
  batchSize?: number;
  /** Awaited after every batch. */
  onProgress?: (progress: EmbedProgress) => void | Promise<void>;
}

/** Embeds every chunk the provider's table lacks; provider errors propagate. Does not change the active model. */
export async function embedAll(db: Db, provider: EmbeddingProvider, options: EmbedAllOptions = {}): Promise<number> {
  const batchSize = options.batchSize ?? EMBED_BATCH_SIZE;
  registerProvider(db, provider);
  let embedded = 0;
  let fruitless = 0;
  for (;;) {
    const { tried, stored } = await embedBatch(db, provider, batchSize);
    if (tried === 0) break;
    // A batch can lose its rows to a concurrent writer now and then; a run of such batches means something is stuck.
    fruitless = stored === 0 ? fruitless + 1 : 0;
    if (fruitless >= 5) throw new Error(`embedding with ${provider.slug} is making no progress`);
    embedded += stored;
    await options.onProgress?.({ slug: provider.slug, embedded, missing: countMissing(db, provider.slug) });
  }
  return embedded;
}

export interface VectorSearchOptions {
  /** Checked on every query; when it changes the cached providers are rebuilt, e.g. after base_url changes. */
  cacheKey?: () => string;
  /** Checked on every query; false means keyword search alone, e.g. while embedding is turned off. */
  enabled?: () => boolean;
}

/**
 * Looks the active model up on every query, so `embedding activate` from the
 * CLI moves search over without a restart.
 */
export function createVectorSearch(
  db: Db,
  getProvider: (model: ModelRow) => EmbeddingProvider,
  options: VectorSearchOptions = {},
): VectorSearch {
  const providers = new Map<string, EmbeddingProvider>();
  let cachedFor: string | undefined;
  return async (query, _filters, k) => {
    if (options.enabled && !options.enabled()) return null;
    const key = options.cacheKey?.();
    if (key !== cachedFor) {
      providers.clear();
      cachedFor = key;
    }
    const model = getActiveModel(db);
    if (!model) return null;
    let provider = providers.get(model.slug);
    if (!provider) {
      provider = getProvider(model);
      providers.set(model.slug, provider);
    }
    // The stored prefix, not the provider's, so queries match how this model's chunks were embedded.
    const [vector] = await provider.embed([model.query_prefix + query]);
    if (!vector) return null;
    return knn(db, model.slug, vector, k).map((chunkId) => ({ chunkId }));
  };
}
