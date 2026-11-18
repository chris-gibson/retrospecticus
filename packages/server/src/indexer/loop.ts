import { events, type Topic } from "../events.ts";
import type { Db } from "../db/index.ts";
import { parsers as defaultParsers, type ParserRegistry } from "../parsers/index.ts";
import { runParse, type ParseOptions } from "./parse.ts";
import type { IndexerStage, LineObserver } from "./types.ts";

export interface IndexerDeps {
  db: Db;
  rawDir: string;
  parsers?: ParserRegistry;
  observers?: readonly LineObserver[];
  /** Run in order after parsing on every tick. */
  stages?: readonly IndexerStage[];
  /** A function is asked before every sleep, so a changed interval applies from the next one. */
  pollSeconds?: number | (() => number);
  parse?: ParseOptions;
  /** Receives failures of the parse step (`stage` is "parse") or of a stage. Defaults to logging. */
  onError?: (error: unknown, stage: string) => void;
}

export interface Indexer {
  /** Ends the current sleep so new bytes are picked up without waiting for the poll. */
  wake(): void;
  /** Resolves once the tick in progress, if any, has finished. */
  stop(): Promise<void>;
}

type ErrorHandler = (error: unknown, stage: string) => void;

const logError: ErrorHandler = (error, stage) => console.error(`indexer: ${stage} failed:`, error);

/**
 * One pass: parse, then every stage. A failing step is reported and the rest
 * still run, so an unreachable embedding provider cannot hold up parsing or
 * chunking. Returns true when anything did work.
 */
async function tick(deps: IndexerDeps, onError: ErrorHandler): Promise<boolean> {
  let worked = false;
  try {
    worked = runParse(deps.db, deps.rawDir, deps.parsers ?? defaultParsers, deps.observers ?? [], deps.parse).didWork;
    // Parsing is also where drift events are raised and records quarantined.
    if (worked) for (const topic of ["stats", "drift"] as const) events.publish(topic);
  } catch (error) {
    onError(error, "parse");
  }
  for (const stage of deps.stages ?? []) {
    try {
      if (await stage.run(deps.db)) {
        worked = true;
        const topics: Topic[] = stage.name === "embed" ? ["stats", "embedding"] : ["stats"];
        for (const topic of topics) events.publish(topic);
      }
    } catch (error) {
      onError(error, stage.name);
    }
  }
  return worked;
}

/**
 * Ticks until a pass does no work, for tests and one-shot CLI commands.
 * Unlike the background loop it throws on the first failure, unless
 * `deps.onError` is given.
 */
export async function runUntilIdle(deps: IndexerDeps): Promise<void> {
  const onError: ErrorHandler =
    deps.onError ??
    ((error) => {
      throw error;
    });
  while (await tick(deps, onError)) {
    // keep going until a whole pass is idle
  }
}

export function startIndexer(deps: IndexerDeps): Indexer {
  const pollMs = (): number => (typeof deps.pollSeconds === "function" ? deps.pollSeconds() : (deps.pollSeconds ?? 2)) * 1000;
  const onError = deps.onError ?? logError;
  let stopped = false;
  let pending = false;
  let wakeSleeper: (() => void) | null = null;

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        wakeSleeper = null;
        resolve();
      }
      wakeSleeper = done;
    });

  const wake = (): void => {
    pending = true;
    wakeSleeper?.();
  };

  const loop = (async () => {
    while (!stopped) {
      pending = false;
      const worked = await tick(deps, onError);
      if (stopped) break;
      // A busy pass yields to the event loop instead of sleeping, so requests are served between windows.
      if (worked || pending) await new Promise<void>((resolve) => setImmediate(resolve));
      else await sleep(pollMs());
    }
  })();

  return {
    wake,
    async stop() {
      stopped = true;
      wakeSleeper?.();
      await loop;
    },
  };
}
