import nodemailer from "nodemailer";
import { z } from "zod";
import { noSecrets, requireSecret, type SecretReader } from "../secrets.ts";
import type { Alert, Notifier } from "./types.ts";

const EmailConfigSchema = z.strictObject({
  from: z.string().min(1),
  to: z.array(z.string().min(1)).min(1),
});

export interface MailTransport {
  sendMail(message: { from: string; to: string[]; subject: string; text: string }): Promise<unknown>;
}

function render(alerts: Alert[]): { subject: string; text: string } {
  if (alerts.length === 1) {
    const alert = alerts[0]!;
    return { subject: alert.title, text: `[${alert.severity}] ${alert.title}\n\n${alert.body}\n` };
  }
  return {
    subject: `Retrospecticus digest (${alerts.length} alerts)`,
    text: alerts.map((a) => `[${a.severity}] ${a.title}\n${a.body}`).join("\n\n") + "\n",
  };
}

export function emailNotifier(config: unknown, secrets: SecretReader = noSecrets, transport?: MailTransport): Notifier {
  const { from, to } = EmailConfigSchema.parse(config);
  return {
    name: "email",
    async send(alerts) {
      if (alerts.length === 0) return;
      const mailer = transport ?? nodemailer.createTransport(requireSecret(secrets, "smtp_url", "notifiers.email"));
      await mailer.sendMail({ from, to, ...render(alerts) });
    },
  };
}
