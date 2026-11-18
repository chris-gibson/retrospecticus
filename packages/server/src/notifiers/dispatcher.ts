import { listPendingAlerts, markAlertsSent, recordAlertAttempt, toAlert, type OutboxRow } from "../db/alerts.ts";
import type { Db } from "../db/index.ts";
import type { Alert, Notifier } from "./types.ts";

export interface DispatcherOptions {
  db: Db;
  /** A function is asked on every send, so notifiers rebuilt after a config change are used at once. */
  notifiers: Notifier[] | (() => Notifier[]);
  digestHour: number | (() => number);
  now?: () => Date;
  retryDelaysMs?: number[];
  intervalMs?: number;
}

export interface TestResult {
  name: string;
  ok: boolean;
  error?: string;
}

export interface Dispatcher {
  tick(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  sendTest(): Promise<TestResult[]>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const localDay = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

export function createDispatcher(options: DispatcherOptions): Dispatcher {
  const { db } = options;
  const notifiers = (): Notifier[] => (typeof options.notifiers === "function" ? options.notifiers() : options.notifiers);
  const digestHour = (): number => (typeof options.digestHour === "function" ? options.digestHour() : options.digestHour);
  const now = options.now ?? (() => new Date());
  const retryDelaysMs = options.retryDelaysMs ?? [1000, 5000, 30000];
  const intervalMs = options.intervalMs ?? 30_000;

  let lastDigestDay: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;

  async function sendWithRetry(notifier: Notifier, alerts: Alert[]): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await notifier.send(alerts);
        return;
      } catch (err) {
        if (attempt >= retryDelaysMs.length) throw err;
        await sleep(retryDelaysMs[attempt]!);
      }
    }
  }

  /** Returns whether at least one adapter delivered. */
  async function deliver(rows: OutboxRow[]): Promise<boolean> {
    const alerts = rows.map(toAlert);
    const results = await Promise.allSettled(notifiers().map((n) => sendWithRetry(n, alerts)));
    const ids = rows.map((r) => r.id);
    recordAlertAttempt(db, ids);
    const delivered = results.some((r) => r.status === "fulfilled");
    if (delivered) markAlertsSent(db, ids);
    return delivered;
  }

  async function tick(): Promise<void> {
    const urgent = listPendingAlerts(db, ["breaking", "warning"]);
    if (urgent.length > 0) await deliver(urgent);

    const current = now();
    if (current.getHours() !== digestHour() || lastDigestDay === localDay(current)) return;
    const info = listPendingAlerts(db, ["info"]);
    if (info.length === 0) return;
    if (await deliver(info)) lastDigestDay = localDay(current);
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (running) return;
        running = tick()
          .catch((err) => console.error("alert dispatcher tick failed:", err))
          .finally(() => {
            running = undefined;
          });
      }, intervalMs);
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await running;
    },
    async sendTest() {
      const sample: Alert = {
        kind: "drift",
        severity: "info",
        title: "Retrospecticus test alert",
        body: "This is a sample alert sent by `retrospecticus notify test`.",
        dedupeKey: "test",
      };
      return Promise.all(
        notifiers().map(async (n): Promise<TestResult> => {
          try {
            await n.send([sample]);
            return { name: n.name, ok: true };
          } catch (err) {
            return { name: n.name, ok: false, error: (err as Error).message };
          }
        }),
      );
    },
  };
}
