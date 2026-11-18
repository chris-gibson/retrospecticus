import { z } from "zod";
import { noSecrets, requireSecret } from "../secrets.ts";
import type { Alert, Notifier, NotifierFactory } from "./types.ts";

const DISCORD_LIMIT = 2000;

const DiscordConfigSchema = z.strictObject({});

function truncate(text: string): string {
  return text.length <= DISCORD_LIMIT ? text : `${text.slice(0, DISCORD_LIMIT - 1)}…`;
}

function render(alerts: Alert[]): string {
  if (alerts.length === 1) {
    const alert = alerts[0]!;
    return `**[${alert.severity}] ${alert.title}**\n${alert.body}`;
  }
  const lines = alerts.map((a) => `- [${a.severity}] **${a.title}**: ${a.body}`);
  return `**Retrospecticus digest (${alerts.length} alerts)**\n${lines.join("\n")}`;
}

export const discordNotifier: NotifierFactory = (config, secrets = noSecrets): Notifier => {
  DiscordConfigSchema.parse(config ?? {});
  return {
    name: "discord",
    async send(alerts) {
      if (alerts.length === 0) return;
      const url = requireSecret(secrets, "discord_webhook_url", "notifiers.discord");
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: truncate(render(alerts)) }),
      });
      if (!response.ok) throw new Error(`Discord webhook responded ${response.status}`);
    },
  };
};
