import type { ServerConfig } from "../config.ts";
import { noSecrets, type SecretReader } from "../secrets.ts";
import { createFakeProvider } from "./fake.ts";
import { createOpenAIProvider } from "./openai.ts";
import type { EmbeddingProvider } from "./types.ts";

export type EmbeddingConfig = ServerConfig["embedding"];

const PROVIDERS = ["openai", "ollama", "fake"] as const;

export const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";

function build(
  provider: string,
  model: string,
  config: EmbeddingConfig,
  secrets: SecretReader,
  dimensions?: number,
): EmbeddingProvider {
  const apiKey = () => secrets("embedding_api_key");
  switch (provider) {
    case "openai":
      return createOpenAIProvider({ model, apiKey, dimensions, baseUrl: config.base_url });
    case "ollama":
      // Ollama serves the OpenAI embeddings API, so only the address and the lack of a key differ.
      return createOpenAIProvider({
        model,
        provider: "ollama",
        apiKey,
        keyOptional: true,
        dimensions,
        baseUrl: config.base_url ?? OLLAMA_BASE_URL,
      });
    case "fake":
      return createFakeProvider({ model, dimensions });
    default:
      throw new Error(`Unknown embedding provider "${provider}"; expected "none", ${PROVIDERS.map((p) => `"${p}"`).join(" or ")}`);
  }
}

/**
 * Task prompts for models trained with them, matched on the model name.
 * EmbeddingGemma's are from its model card: retrieval queries and documents
 * are embedded differently, and plain text loses accuracy.
 */
const PREFIX_PRESETS: readonly { match: RegExp; query: string; document: string }[] = [
  { match: /^embeddinggemma/i, query: "task: search result | query: ", document: "title: none | text: " },
];

export function presetPrefixes(model: string): { query: string; document: string } {
  const preset = PREFIX_PRESETS.find((p) => p.match.test(model));
  return { query: preset?.query ?? "", document: preset?.document ?? "" };
}

function withPrefixes(provider: EmbeddingProvider, model: string, config?: EmbeddingConfig): EmbeddingProvider {
  const preset = presetPrefixes(model);
  return {
    ...provider,
    queryPrefix: config?.query_prefix ?? preset.query,
    documentPrefix: config?.document_prefix ?? preset.document,
  };
}

/** The provider the indexer embeds with, or null when embedding is turned off. */
export function createProvider(config: EmbeddingConfig, secrets: SecretReader = noSecrets): EmbeddingProvider | null {
  if (config.provider === "none") return null;
  return withPrefixes(build(config.provider, config.model, config, secrets, config.dimensions), config.model, config);
}

/**
 * Resolves a model slug such as `openai-text-embedding-3-large` or `fake-alt`
 * to a provider. Dimensions come from, in order: `dimensions` (the model's
 * registration, or a command-line choice), the config when the slug is the
 * configured model, then the provider's own default.
 */
export function providerForSlug(
  slug: string,
  config: EmbeddingConfig,
  dimensions?: number,
  secrets: SecretReader = noSecrets,
): EmbeddingProvider {
  const provider = PROVIDERS.find((p) => slug.startsWith(`${p}-`) && slug.length > p.length + 1);
  if (!provider) {
    throw new Error(`Cannot tell the provider of embedding model "${slug}"; expected ${PROVIDERS.map((p) => `${p}-<model>`).join(" or ")}`);
  }
  const model = slug.slice(provider.length + 1);
  const isConfigured = config.provider === provider && config.model === model;
  // The configured address belongs to the configured provider; another provider's model is reached at its own default.
  const reach = config.provider === provider ? config : { ...config, base_url: undefined };
  const built = build(provider, model, reach, secrets, dimensions ?? (isConfigured ? config.dimensions : undefined));
  return withPrefixes(built, model, isConfigured ? config : undefined);
}
