import type { Context, Hono } from "hono";
import { ADMIN_PAGE_PATH } from "@retrospecticus/shared";
import type { AppEnv } from "../auth.ts";
import type { Db } from "../db/index.ts";
import { events as defaultBus, TOPICS, type EventBus, type Topic } from "../events.ts";

export const EVENTS_PATH = `${ADMIN_PAGE_PATH}/api/events`;

export interface EventStreamOptions {
  /** Topics changed within this window go out as one `change` event. */
  coalesceMs: number;
  /** Comment lines at this interval keep proxies from closing an idle stream. */
  keepaliveMs: number;
  /**
   * How often to ask SQLite whether another connection committed. Changes made by another
   * process, such as the CLI, never reach the bus, so this is how the page learns of them.
   */
  dataVersionPollMs: number;
  maxConnections: number;
}

export const DEFAULT_EVENT_STREAM_OPTIONS: EventStreamOptions = {
  coalesceMs: 500,
  keepaliveMs: 25_000,
  dataVersionPollMs: 1000,
  maxConnections: 20,
};

/** What the stream needs to know about the session that opened it. */
export interface SessionWatch {
  /** False once the session has expired or its token was revoked. */
  alive(): boolean;
  /** Calls back when the session ends; returns the function that cancels the watch. */
  onEnd(callback: () => void): () => void;
}

export interface EventsRouteDeps {
  db: Db;
  watchSession(c: Context<AppEnv>): SessionWatch;
  bus?: EventBus;
  options?: Partial<EventStreamOptions>;
}

interface TimeoutCapable {
  timeout?(request: Request, seconds: number): void;
}

const DB_TOPICS = TOPICS.filter((t) => t !== "settings");

export function registerEventsRoute(app: Hono<AppEnv>, deps: EventsRouteDeps): void {
  const bus = deps.bus ?? defaultBus;
  const options = { ...DEFAULT_EVENT_STREAM_OPTIONS, ...deps.options };
  const encoder = new TextEncoder();
  let open = 0;

  app.get(EVENTS_PATH, (c) => {
    if (open >= options.maxConnections) return c.json({ error: "too many live connections" }, 503);
    const watch = deps.watchSession(c);
    // Bun closes a connection that has been silent for its idle timeout, which the keepalive interval exceeds.
    (c.env as TimeoutCapable | undefined)?.timeout?.(c.req.raw, 0);
    open++;

    let teardown = (): void => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const pending = new Set<Topic>();
        let flushTimer: ReturnType<typeof setTimeout> | null = null;
        let closed = false;

        const close = (): void => {
          if (closed) return;
          closed = true;
          open--;
          if (flushTimer) clearTimeout(flushTimer);
          clearInterval(keepalive);
          clearInterval(poll);
          unsubscribe();
          stopWatching();
          c.req.raw.signal.removeEventListener("abort", close);
          try {
            controller.close();
          } catch {}
        };
        teardown = close;

        const send = (text: string): void => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            return close();
          }
          // A client that stopped reading would otherwise make this queue grow without bound.
          if (controller.desiredSize !== null && controller.desiredSize < -64) close();
        };

        const note = (topic: Topic): void => {
          pending.add(topic);
          flushTimer ??= setTimeout(() => {
            flushTimer = null;
            const topics = [...pending];
            pending.clear();
            send(`event: change\ndata: ${JSON.stringify({ topics })}\n\n`);
          }, options.coalesceMs);
        };

        const unsubscribe = bus.subscribe(({ topic }) => note(topic));
        const stopWatching = watch.onEnd(close);
        const keepalive = setInterval(() => {
          if (!watch.alive()) return close();
          send(": keepalive\n\n");
        }, options.keepaliveMs);
        // data_version moves only when a different connection commits, so this server's own writes do not echo.
        const dataVersion = (): number | null =>
          deps.db.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version ?? null;
        let seen = dataVersion();
        const poll = setInterval(() => {
          const current = dataVersion();
          if (current === seen) return;
          seen = current;
          for (const topic of DB_TOPICS) note(topic);
        }, options.dataVersionPollMs);
        c.req.raw.signal.addEventListener("abort", close);

        send("retry: 3000\n\n: connected\n\n");
      },
      cancel() {
        teardown();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  });
}
