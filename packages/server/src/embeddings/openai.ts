import type { EmbeddingProvider } from "./types.ts";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const OPENAI_BATCH_SIZE = 96;
export const OPENAI_RETRY_DELAYS_MS: readonly number[] = [1000, 4000, 15000];

export const OPENAI_KNOWN_DIMENSIONS: Readonly<Record<string, number>> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
};

export interface OpenAIProviderOptions {
  model: string;
  /** Asked on every call, so a rotated key is picked up without a restart and a missing one fails only when used. */
  apiKey?: () => string | undefined;
  /** Required for models not in `OPENAI_KNOWN_DIMENSIONS`. */
  dimensions?: number;
  baseUrl?: string;
  /** Sends no Authorization header when no key is set, for local OpenAI-compatible servers such as Ollama. */
  keyOptional?: boolean;
  /** The slug prefix and the name used in errors; "openai" unless another service speaks the same API. */
  provider?: string;
  /** One delay per retry; a 429 or 5xx after the last one is an error. */
  retryDelaysMs?: readonly number[];
  batchSize?: number;
  fetch?: typeof fetch;
  /** Injectable for tests; waits between retries. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; used to turn a Retry-After date into a wait. */
  now?: () => number;
}

/** Longest single wait honoured from a provider's headers; the stage backs off for longer on its own. */
export const OPENAI_MAX_WAIT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 60_000;

export type EmbeddingErrorKind = "quota" | "auth" | "rate_limit" | "server" | "other";

export class OpenAIEmbeddingError extends Error {
  override name = "OpenAIEmbeddingError";
  readonly kind: EmbeddingErrorKind;
  readonly status?: number;
  constructor(message: string, info: { kind?: EmbeddingErrorKind; status?: number } = {}) {
    super(message);
    this.kind = info.kind ?? "other";
    if (info.status !== undefined) this.status = info.status;
  }
}

/** Parses OpenAI reset durations such as "1s", "6m0s", "20ms" and "1m30.5s" into milliseconds. */
export function parseResetDuration(value: string | null): number | undefined {
  const text = value?.trim();
  if (!text || !/^(?:\d+(?:\.\d+)?(?:ms|h|m|s))+$/.test(text)) return undefined;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;
  let total = 0;
  for (const [, amount, u] of text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) total += Number(amount) * unit[u as keyof typeof unit];
  return Math.round(total);
}

/** The wait a response asks for: Retry-After (seconds or an HTTP date), else the larger rate-limit reset. */
export function requestedWaitMs(headers: Headers, now: number): number | undefined {
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter) {
    if (/^\d+(?:\.\d+)?$/.test(retryAfter)) return Math.round(Number(retryAfter) * 1000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  const resets = ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]
    .map((name) => parseResetDuration(headers.get(name)))
    .filter((v): v is number => v !== undefined);
  return resets.length ? Math.max(...resets) : undefined;
}

function isQuotaBody(text: string): boolean {
  try {
    const error = (JSON.parse(text) as { error?: { type?: unknown; code?: unknown } }).error;
    return [error?.type, error?.code].some((v) => v === "insufficient_quota" || v === "credit_balance_exhausted");
  } catch {
    return false;
  }
}

function classify(status: number, quota: boolean): EmbeddingErrorKind {
  if (status === 429) return quota ? "quota" : "rate_limit";
  if (status === 401 || status === 403) return "auth";
  return status >= 500 ? "server" : "other";
}

export function openaiDimensions(model: string, configured?: number): number {
  const known = OPENAI_KNOWN_DIMENSIONS[model];
  if (known !== undefined) {
    if (configured !== undefined && configured !== known) {
      throw new OpenAIEmbeddingError(`${model} has ${known} dimensions; embedding.dimensions says ${configured}`);
    }
    return known;
  }
  if (configured === undefined) {
    throw new OpenAIEmbeddingError(`Set embedding.dimensions for model ${model}; its size is not known`);
  }
  return configured;
}

interface EmbeddingsResponse {
  data?: { index?: unknown; embedding?: unknown }[];
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createOpenAIProvider(options: OpenAIProviderOptions): EmbeddingProvider {
  const { model } = options;
  const dimensions = openaiDimensions(model, options.dimensions);
  const url = `${(options.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, "")}/embeddings`;
  const retryDelays = options.retryDelaysMs ?? OPENAI_RETRY_DELAYS_MS;
  const batchSize = options.batchSize ?? OPENAI_BATCH_SIZE;
  const doFetch = options.fetch ?? fetch;
  const provider = options.provider ?? "openai";
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  function readKey(): string | undefined {
    const key = options.apiKey?.()?.trim();
    if (key !== undefined && key !== "") return key;
    if (options.keyOptional) return undefined;
    throw new OpenAIEmbeddingError(
      `${provider} embeddings need the secret embedding_api_key, which is not set; run \`retrospecticus secrets set embedding_api_key\``,
      { kind: "auth" },
    );
  }

  async function request(key: string | undefined, input: string[]): Promise<Float32Array[]> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (key !== undefined) headers.Authorization = `Bearer ${key}`;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ model, input }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        const delay = retryDelays[attempt];
        if (delay !== undefined) {
          await sleep(delay);
          continue;
        }
        throw new OpenAIEmbeddingError(`${provider} embeddings request failed: ${(error as Error)?.message ?? error}`, { kind: "server" });
      }
      if (response.ok) return parse((await response.json()) as EmbeddingsResponse, input.length);
      const text = await response.text().catch(() => "");
      const kind = classify(response.status, response.status === 429 && isQuotaBody(text));
      const delay = retryDelays[attempt];
      if ((kind === "rate_limit" || kind === "server") && delay !== undefined) {
        const asked = requestedWaitMs(response.headers, now());
        await sleep(Math.min(asked ?? delay, OPENAI_MAX_WAIT_MS));
        continue;
      }
      const detail = text.slice(0, 300);
      throw new OpenAIEmbeddingError(`${provider} embeddings returned ${response.status}${detail ? `: ${detail}` : ""}`, {
        kind,
        status: response.status,
      });
    }
  }

  function parse(body: EmbeddingsResponse, expected: number): Float32Array[] {
    const out = Array.from<Float32Array | undefined>({ length: expected });
    for (const item of body.data ?? []) {
      const { index, embedding } = item;
      if (typeof index !== "number" || !Array.isArray(embedding) || index < 0 || index >= expected) {
        throw new OpenAIEmbeddingError("OpenAI embeddings response has an item without a valid index and embedding");
      }
      if (embedding.length !== dimensions) {
        throw new OpenAIEmbeddingError(`${provider} returned ${embedding.length} dimensions for ${model}, expected ${dimensions}`);
      }
      out[index] = Float32Array.from(embedding as number[]);
    }
    if (out.some((v) => v === undefined)) {
      throw new OpenAIEmbeddingError(`OpenAI embeddings response is missing items (expected ${expected})`);
    }
    return out as Float32Array[];
  }

  return {
    slug: `${provider}-${model}`,
    dimensions,
    async embed(texts) {
      if (texts.length === 0) return [];
      const key = readKey();
      const vectors: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        vectors.push(...(await request(key, texts.slice(i, i + batchSize))));
      }
      return vectors;
    },
  };
}
