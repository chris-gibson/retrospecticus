import { z } from "zod";
import { noSecrets, type SecretReader } from "../secrets.ts";
import { discordNotifier } from "./discord.ts";
import { emailNotifier } from "./email.ts";
import { logNotifier } from "./log.ts";
import type { Notifier, NotifierFactory } from "./types.ts";

export const registry: Map<string, NotifierFactory> = new Map([
  ["discord", discordNotifier],
  ["email", (config, secrets) => emailNotifier(config, secrets)],
  ["log", logNotifier],
]);

export function registerNotifier(name: string, factory: NotifierFactory): void {
  registry.set(name, factory);
}

export function buildNotifiers(notifiersConfig: Record<string, unknown>, secrets: SecretReader = noSecrets): Notifier[] {
  const notifiers: Notifier[] = [logNotifier()];
  for (const [key, config] of Object.entries(notifiersConfig)) {
    if (key === "log") continue;
    const factory = registry.get(key);
    if (!factory) throw new Error(`Unknown notifier "${key}" in notifiers.${key}`);
    try {
      notifiers.push(factory(config, secrets));
    } catch (err) {
      const detail = err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message;
      throw new Error(`Invalid config for notifier "${key}": ${detail}`);
    }
  }
  return notifiers;
}
