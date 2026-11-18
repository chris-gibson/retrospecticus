import type { Hono } from "hono";
import { z } from "zod";
import { ADMIN_PAGE_PATH } from "@retrospecticus/shared";
import type { AppEnv } from "../auth.ts";
import { parseConfig, type ConfigError } from "../config.ts";
import type { ConfigView } from "../config-store.ts";
import { OPENAI_BASE_URL, OPENAI_KNOWN_DIMENSIONS } from "../embeddings/openai.ts";
import { OLLAMA_BASE_URL, createProvider, type EmbeddingConfig } from "../embeddings/registry.ts";
import { readJsonBody } from "../enroll.ts";
import { buildNotifiers } from "../notifiers/registry.ts";
import type { Alert } from "../notifiers/types.ts";
import type { SecretName } from "../secrets.ts";

const API = `${ADMIN_PAGE_PATH}/api`;
const SAMPLE_TEXT = "Retrospecticus checks that this sentence can be embedded.";
const ERROR_SNIPPET_CHARS = 240;

export interface ProbeDeps {
  view: ConfigView;
  maxBodyBytes: number;
  /** Defaults: 5 s to list Ollama models, 15 s for an embedding or a test alert. */
  timeoutsMs?: { tags?: number; embed?: number; notify?: number };
}

export interface OllamaModel {
  name: string;
  /** Whether it looks like an embedding model: from Ollama's capabilities when listed, else from the name. */
  embedding: boolean;
  capabilities: string[] | null;
}

/** Only http(s), so an admin-supplied address cannot make the server read files or speak other protocols. */
export function httpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Ollama's native API sits beside the OpenAI-compatible one at /v1. */
export function ollamaTagsUrl(base: string): URL | null {
  const url = httpUrl(base);
  if (!url) return null;
  const root = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  url.pathname = `${root}/api/tags`;
  url.search = "";
  url.hash = "";
  return url;
}

const EMBEDDING_NAME = /embed|bge|minilm|mxbai|nomic|arctic|e5|gte|paraphrase/i;

export function toOllamaModels(body: unknown): OllamaModel[] {
  const list = (body as { models?: unknown })?.models;
  if (!Array.isArray(list)) return [];
  const models: OllamaModel[] = [];
  for (const item of list as Array<Record<string, unknown>>) {
    const name = typeof item?.name === "string" ? item.name : typeof item?.model === "string" ? item.model : null;
    if (!name) continue;
    const capabilities = Array.isArray(item.capabilities)
      ? item.capabilities.filter((c): c is string => typeof c === "string")
      : null;
    const embedding = capabilities ? capabilities.includes("embedding") : EMBEDDING_NAME.test(name);
    models.push({ name, embedding, capabilities });
  }
  return models.sort((a, b) => Number(b.embedding) - Number(a.embedding) || a.name.localeCompare(b.name));
}

/** Short, single-line, and with any secret that might have been echoed back removed. */
export function errorSnippet(message: string, secrets: readonly (string | undefined)[] = []): string {
  let text = message;
  for (const secret of secrets) if (secret && secret.length >= 4) text = text.split(secret).join("[redacted]");
  text = text.replace(/\s+/g, " ").trim();
  return text.length > ERROR_SNIPPET_CHARS ? `${text.slice(0, ERROR_SNIPPET_CHARS - 1)}…` : text;
}

class TimeoutError extends Error {
  override name = "TimeoutError";
}

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${what} did not answer within ${Math.round(ms / 1000)} s`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const TagsSchema = z.object({ base_url: z.string().min(1).max(2048) });
const EmbeddingTestSchema = z.object({ embedding: z.record(z.string(), z.unknown()), api_key: z.string().max(8192).optional() });
const NotifierTestSchema = z.object({ name: z.string().min(1).max(100) });

/**
 * Learns an unlisted model's size from one request, so the real provider,
 * which needs to know it up front, can then be built.
 */
async function probeDimensions(config: EmbeddingConfig, key: string | undefined, timeoutMs: number): Promise<number> {
  const base = config.base_url ?? (config.provider === "ollama" ? OLLAMA_BASE_URL : OPENAI_BASE_URL);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  const response = await fetch(`${base.replace(/\/+$/, "")}/embeddings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: config.model, input: [SAMPLE_TEXT] }),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`${config.provider} embeddings returned ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  const body = (await response.json()) as { data?: { embedding?: unknown }[] };
  const vector = body.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) throw new Error("the embeddings response held no vector");
  return vector.length;
}

function needsProbe(config: EmbeddingConfig): boolean {
  return (
    (config.provider === "openai" || config.provider === "ollama") &&
    config.dimensions === undefined &&
    OPENAI_KNOWN_DIMENSIONS[config.model] === undefined
  );
}

export function registerProbeRoutes(app: Hono<AppEnv>, deps: ProbeDeps): void {
  const { view } = deps;
  const tagsTimeout = deps.timeoutsMs?.tags ?? 5000;
  const embedTimeout = deps.timeoutsMs?.embed ?? 15000;
  const notifyTimeout = deps.timeoutsMs?.notify ?? 15000;

  app.post(`${API}/ollama/models`, async (c) => {
    const body = TagsSchema.safeParse(await readJsonBody(c, deps.maxBodyBytes));
    const url = body.success ? ollamaTagsUrl(body.data.base_url) : null;
    if (!url) return c.json({ error: "base_url must be an http:// or https:// address" }, 400);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(tagsTimeout), redirect: "error" });
      if (!response.ok) {
        await response.body?.cancel();
        return c.json({ error: `Ollama answered ${response.status} at ${url.origin}` }, 502);
      }
      return c.json({ models: toOllamaModels(await response.json()) });
    } catch (err) {
      const reason = (err as Error).name === "TimeoutError" ? `no answer within ${tagsTimeout / 1000} s` : (err as Error).message;
      return c.json({ error: errorSnippet(`cannot reach Ollama at ${url.origin}: ${reason}`) }, 502);
    }
  });

  app.post(`${API}/test/embedding`, async (c) => {
    const body = EmbeddingTestSchema.safeParse(await readJsonBody(c, deps.maxBodyBytes));
    if (!body.success) return c.json({ error: "send { embedding, api_key? }" }, 400);
    let config: EmbeddingConfig;
    try {
      config = parseConfig({ embedding: body.data.embedding }, "embedding settings").embedding;
    } catch (err) {
      return c.json({ error: (err as ConfigError).message }, 400);
    }
    if (config.provider === "none") return c.json({ error: "choose a provider to test" }, 400);
    if (config.base_url !== undefined && !httpUrl(config.base_url)) {
      return c.json({ error: "base_url must be an http:// or https:// address" }, 400);
    }
    // The candidate key is used for this request only and never stored.
    const candidateKey = body.data.api_key?.trim() || undefined;
    const secrets = (name: SecretName) => (name === "embedding_api_key" ? candidateKey ?? view.getSecret(name) : view.getSecret(name));
    const redact = [candidateKey, view.getSecret("embedding_api_key")];
    const started = performance.now();
    try {
      let probed = false;
      if (needsProbe(config)) {
        const key = secrets("embedding_api_key");
        if (config.provider === "openai" && !key) throw new Error("set an API key to test OpenAI embeddings");
        config = { ...config, dimensions: await probeDimensions(config, key, embedTimeout) };
        probed = true;
      }
      const provider = createProvider(config, secrets);
      if (!provider) return c.json({ error: "choose a provider to test" }, 400);
      const embedStarted = performance.now();
      const [vector] = await withTimeout(
        provider.embed([(provider.documentPrefix ?? "") + SAMPLE_TEXT]),
        embedTimeout,
        `${config.provider} embeddings`,
      );
      return c.json({
        ok: true,
        slug: provider.slug,
        dimensions: vector?.length ?? provider.dimensions,
        probed_dimensions: probed,
        latency_ms: Math.round(performance.now() - embedStarted),
        total_ms: Math.round(performance.now() - started),
        query_prefix: provider.queryPrefix ?? "",
        document_prefix: provider.documentPrefix ?? "",
      });
    } catch (err) {
      const e = err as Error;
      const reason = e.name === "TimeoutError" ? `no answer within ${embedTimeout / 1000} s` : e.message;
      return c.json({ error: errorSnippet(reason, redact) }, 502);
    }
  });

  app.post(`${API}/test/notifier`, async (c) => {
    const body = NotifierTestSchema.safeParse(await readJsonBody(c, deps.maxBodyBytes));
    if (!body.success) return c.json({ error: "send { name }" }, 400);
    const { name } = body.data;
    const config = view.current().notifiers;
    if (name !== "log" && !Object.hasOwn(config, name)) {
      return c.json({ error: `notifiers.${name} is not configured; save it first` }, 400);
    }
    const secrets = (secret: SecretName) => view.getSecret(secret);
    let notifier;
    try {
      notifier = buildNotifiers(config, secrets).find((n) => n.name === name);
    } catch (err) {
      return c.json({ error: errorSnippet((err as Error).message) }, 400);
    }
    if (!notifier) return c.json({ error: `no notifier named ${name}` }, 400);
    const sample: Alert = {
      kind: "drift",
      severity: "info",
      title: "Retrospecticus test alert",
      body: "This is a sample alert sent from the admin page.",
      dedupeKey: "test",
    };
    try {
      await withTimeout(notifier.send([sample]), notifyTimeout, name);
      return c.json({ ok: true, name });
    } catch (err) {
      const redact = [view.getSecret("discord_webhook_url"), view.getSecret("smtp_url")];
      return c.json({ error: errorSnippet((err as Error).message, redact) }, 502);
    }
  });
}

