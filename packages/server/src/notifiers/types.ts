import type { Alert } from "@retrospecticus/shared";
import type { SecretReader } from "../secrets.ts";

export type { Alert };

export interface Notifier {
  /** Matches the config key under `notifiers.<name>`. */
  readonly name: string;
  send(alerts: Alert[]): Promise<void>;
}

/**
 * Validates its own config with zod and throws on a bad one. Secrets are read
 * at send time, so a missing one fails the send, not the build.
 */
export type NotifierFactory = (config: unknown, secrets: SecretReader) => Notifier;
