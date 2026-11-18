/** What an admin page panel can be stale about; each topic maps to the panels that render it. */
export const TOPICS = ["machines", "enrollments", "stats", "drift", "embedding", "tokens", "settings"] as const;

export type Topic = (typeof TOPICS)[number];

export interface ChangeNotice {
  topic: Topic;
}

export type ChangeListener = (notice: ChangeNotice) => void;

export interface EventBus {
  publish(topic: Topic): void;
  /** Returns the function that removes the listener. */
  subscribe(listener: ChangeListener): () => void;
  listenerCount(): number;
  /** Drops every listener; for tests that share the process-wide bus. */
  reset(): void;
}

export function createEventBus(): EventBus {
  const listeners = new Set<ChangeListener>();
  return {
    publish(topic) {
      for (const listener of [...listeners]) {
        // A broken subscriber must not stop the code that caused the change.
        try {
          listener({ topic });
        } catch {}
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    listenerCount: () => listeners.size,
    reset: () => listeners.clear(),
  };
}

/** Shared so the ingest, indexer and admin code can announce changes without being wired to each other. */
export const events: EventBus = createEventBus();
