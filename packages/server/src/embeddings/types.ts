export interface EmbeddingProvider {
  /** e.g. "openai-text-embedding-3-small" */
  slug: string;
  dimensions: number;
  /** Prepended to each search query; models trained with task prompts need it. */
  queryPrefix?: string;
  /** Prepended to each chunk; changing it invalidates every stored vector. */
  documentPrefix?: string;
  /** Embeds the texts exactly as given; callers add the prefixes. */
  embed(texts: string[]): Promise<Float32Array[]>;
}
