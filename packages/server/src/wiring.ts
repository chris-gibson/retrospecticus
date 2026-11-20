import { startMonitors } from "./alerts/monitors.ts";
import type { ServerConfig } from "./config.ts";
import { toConfigView, type ConfigView } from "./config-store.ts";
import type { Db } from "./db/index.ts";
import { createDriftDetector } from "./drift/detector.ts";
import { createYieldMonitor } from "./drift/yield.ts";
import { apiKeySecret, createProvider } from "./embeddings/registry.ts";
import { createChunkStage } from "./indexer/chunk.ts";
import { clearEmbedErrors, createEmbedStage, registerProvider } from "./indexer/embed.ts";
import type { IndexerStage, LineObserver } from "./indexer/types.ts";
import { createDispatcher } from "./notifiers/dispatcher.ts";
import { buildNotifiers } from "./notifiers/registry.ts";
import { parsers as defaultParsers, withIgnoredTypes, type ParserRegistry } from "./parsers/index.ts";
import type { Notifier } from "./notifiers/types.ts";
import type { SecretName } from "./secrets.ts";

/**
 * The one place that decides what the production indexer runs. The server and
 * the CLI commands that replay the archive (reparse, reindex, shapes learn)
 * both build from here so they cannot drift apart.
 *
 * Everything here reads the config through the view on each use, so a store
 * that reloads its file changes behaviour without a restart.
 */
export interface Wiring {
  /** The parsers honouring `drift.ignore_types` as it is now; use these wherever lines are parsed. */
  parsers: ParserRegistry;
  observers: LineObserver[];
  stages: IndexerStage[];
  /** Background work outside the indexer loop, e.g. the alert dispatcher. Returns a stop function. */
  startBackground(): () => Promise<void>;
}

export interface WiringOptions {
  /** How often the alert dispatcher looks at the outbox; defaults to the dispatcher's own. */
  dispatcherIntervalMs?: number;
}

export function buildWiring(db: Db, source: ServerConfig | ConfigView, options: WiringOptions = {}): Wiring {
  const view = toConfigView(source);
  return {
    parsers: withIgnoredTypes(defaultParsers, (s) => view.current().drift.ignore_types[s]),
    observers: buildObservers(view),
    stages: buildStages(view),
    startBackground: () => startBackground(db, view, options),
  };
}

/**
 * Remembers the last value built from a slice of the config and rebuilds only
 * when that slice changes. A rebuild that throws keeps the previous value.
 */
function rebuildOnChange<S, T>(
  slice: () => S,
  build: (slice: S) => T,
  onError: (error: unknown) => void,
): () => T {
  let key: string | undefined;
  let value: T;
  return () => {
    const current = slice();
    const next = JSON.stringify(current);
    if (next !== key) {
      if (key === undefined) {
        value = build(current);
      } else {
        try {
          value = build(current);
        } catch (error) {
          onError(error);
          return value;
        }
      }
      key = next;
    }
    return value;
  };
}

function buildObservers(view: ConfigView): LineObserver[] {
  return [createDriftDetector(), createYieldMonitor({ minLines: () => view.current().indexer.yield_min_lines })];
}

function buildStages(view: ConfigView): IndexerStage[] {
  const chunk = createChunkStage(() => {
    const { chunk_tokens, chunk_overlap_tokens } = view.current().indexer;
    return { maxTokens: chunk_tokens, overlapTokens: chunk_overlap_tokens };
  });
  return [chunk, createLiveEmbedStage(view)];
}

/**
 * Fills the configured model's vectors, following the config: a changed
 * provider or model starts filling the new one, while the active model, and
 * so search, stays where it is until `embedding activate`.
 */
function createLiveEmbedStage(view: ConfigView): IndexerStage {
  const secrets = (name: SecretName) => view.getSecret(name);
  const backlogThreshold = () => view.current().alerts.embedding_backlog_chunks;
  let key: string | undefined;
  let stage: ReturnType<typeof createEmbedStage> | null = null;
  let lastApiKey: string | undefined;
  // Set when the settings cannot be used (e.g. a document prefix that contradicts stored vectors) until they change again.
  let blocked = false;
  return {
    name: "embed",
    async run(db) {
      const embedding = view.current().embedding;
      const next = JSON.stringify(embedding);
      if (next !== key) {
        key = next;
        stage = null;
        blocked = false;
        clearEmbedErrors(db);
        lastApiKey = secrets(apiKeySecret(embedding.provider));
        try {
          const provider = createProvider(embedding, secrets);
          if (provider) {
            registerProvider(db, provider);
            stage = createEmbedStage({ provider, backlogThreshold });
          }
        } catch (error) {
          blocked = true;
          console.error(`embed: cannot use the embedding settings, embedding paused until they change: ${(error as Error).message}`);
        }
      }
      if (blocked || !stage) return false;
      // A new key should be tried at once rather than after a long backoff.
      const apiKey = secrets(apiKeySecret(view.current().embedding.provider));
      if (apiKey !== lastApiKey) {
        lastApiKey = apiKey;
        stage.resetBackoff();
      }
      return stage.run(db);
    },
  };
}

function startBackground(db: Db, view: ConfigView, options: WiringOptions): () => Promise<void> {
  const notifiers = rebuildOnChange(
    () => view.current().notifiers,
    (config): Notifier[] => buildNotifiers(config, (name) => view.getSecret(name)),
    (error) => console.error(`notifiers: keeping the previous set: ${(error as Error).message}`),
  );
  notifiers();
  const dispatcher = createDispatcher({
    db,
    notifiers,
    digestHour: () => view.current().alerts.digest_hour,
    intervalMs: options.dispatcherIntervalMs,
  });
  dispatcher.start();
  const stopMonitors = startMonitors(db, () => view.current());
  return async () => {
    await stopMonitors();
    await dispatcher.stop();
  };
}
