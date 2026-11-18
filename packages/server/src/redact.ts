export const REDACTED = "[REDACTED]";

type Rule = [pattern: RegExp, replacement: string];

const SECRET_KEY_NAME = String.raw`[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key)`;

/**
 * Applied in order. Whole-block and structural patterns come first so the
 * narrower key formats cannot leave half of a larger secret behind. Erring
 * towards redacting too much is deliberate: chunk text is what leaves the
 * machine for the embedding provider.
 */
const RULES: readonly Rule[] = [
  [/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g, REDACTED],
  // A private key cut off before its END line is still a private key.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:\\n|[A-Za-z0-9+/=\s])*/g, REDACTED],

  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@"'<>]+:[^\s/@"'<>]+@/gi, `$1${REDACTED}@`],

  [
    /\b((?:Proxy-)?Authorization["']?\s*[:=]\s*["']?)(?:(Bearer|Basic|Token|Digest|Negotiate)\s+)?[^\s"',;]+/gi,
    `$1$2 ${REDACTED}`,
  ],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/g, `$1${REDACTED}`],

  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],

  [new RegExp(String.raw`(--(?:${SECRET_KEY_NAME})[ =]+)[^\s"']+`, "gi"), `$1${REDACTED}`],
  // `=` form. The lookahead keeps comparisons and arrow functions out of it.
  [
    new RegExp(String.raw`(\b${SECRET_KEY_NAME}["']?\s*=(?![=>])\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s"'&;,)]+)`, "gi"),
    `$1${REDACTED}`,
  ],
  // `:` form. An unquoted value must be long, because "the token: it expired" is prose.
  [
    new RegExp(String.raw`(\b${SECRET_KEY_NAME}["']?\s*:\s*)(?!\[REDACTED\])(?:"[^"\n]+"|'[^'\n]+'|[^\s"',;)}\]]{8,})`, "gi"),
    `$1${REDACTED}`,
  ],
];

/** Replaces recognisable secrets with `[REDACTED]`. Idempotent. */
export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out.replace(/ {2}\[REDACTED\]/g, ` ${REDACTED}`);
}
