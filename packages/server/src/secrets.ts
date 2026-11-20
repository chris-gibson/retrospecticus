import { z } from "zod";

export const SECRET_NAMES = ["embedding_api_key", "omlx_api_key", "discord_webhook_url", "smtp_url", "github_token"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export function isSecretName(name: string): name is SecretName {
  return (SECRET_NAMES as readonly string[]).includes(name);
}

const SecretEntrySchema = z.strictObject({
  value: z.string().min(1),
  updated_at: z.iso.datetime({ offset: true }),
});

export const SecretsFileSchema = z.strictObject(
  Object.fromEntries(SECRET_NAMES.map((name) => [name, SecretEntrySchema.optional()])) as Record<
    SecretName,
    z.ZodOptional<typeof SecretEntrySchema>
  >,
);

export type SecretsFile = z.infer<typeof SecretsFileSchema>;
export type SecretEntry = z.infer<typeof SecretEntrySchema>;

/** Looks a secret up at call time, so a rotated value applies without a restart. */
export type SecretReader = (name: SecretName) => string | undefined;

export const noSecrets: SecretReader = () => undefined;

export class MissingSecretError extends Error {
  override name = "MissingSecretError";
  constructor(
    readonly secret: SecretName,
    what: string,
  ) {
    super(`${what} needs the secret ${secret}, which is not set; run \`retrospecticus secrets set ${secret}\``);
  }
}

export function requireSecret(secrets: SecretReader, name: SecretName, what: string): string {
  const value = secrets(name);
  if (value === undefined || value === "") throw new MissingSecretError(name, what);
  return value;
}
