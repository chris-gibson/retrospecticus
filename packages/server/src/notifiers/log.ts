import type { Notifier } from "./types.ts";

export function logNotifier(_config?: unknown): Notifier {
  return {
    name: "log",
    async send(alerts) {
      for (const alert of alerts) {
        console.log(`[alert] ${alert.severity} ${alert.title}: ${alert.body.replace(/\s*\n\s*/g, " ")}`);
      }
    },
  };
}
