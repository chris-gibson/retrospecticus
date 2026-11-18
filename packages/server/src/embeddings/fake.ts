import type { EmbeddingProvider } from "./types.ts";

export const FAKE_DEFAULT_DIMENSIONS = 64;

export interface FakeProviderOptions {
  model?: string;
  dimensions?: number;
  /**
   * Words to treat as another word before hashing, so a test can declare two
   * words related without them sharing a keyword-search term.
   */
  aliases?: Readonly<Record<string, string>>;
}

/** FNV-1a, which is enough to spread words over buckets stably across runs. */
function hash(word: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function fakeEmbedding(
  text: string,
  dimensions = FAKE_DEFAULT_DIMENSIONS,
  aliases: Readonly<Record<string, string>> = {},
): Float32Array {
  const vector = new Float32Array(dimensions);
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const word of words) {
    const bucket = hash(aliases[word] ?? word) % dimensions;
    vector[bucket] = (vector[bucket] ?? 0) + 1;
  }
  // A zero vector has no cosine distance, so wordless text still gets a direction.
  if (words.length === 0) vector[0] = 1;
  let norm = 0;
  for (const v of vector) norm += v * v;
  norm = Math.sqrt(norm);
  for (let i = 0; i < dimensions; i++) vector[i] = (vector[i] ?? 0) / norm;
  return vector;
}

export function createFakeProvider(options: FakeProviderOptions = {}): EmbeddingProvider {
  const model = options.model ?? "test";
  const dimensions = options.dimensions ?? FAKE_DEFAULT_DIMENSIONS;
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`fake embedding dimensions must be a positive whole number, got ${dimensions}`);
  }
  const aliases = Object.fromEntries(
    Object.entries(options.aliases ?? {}).map(([from, to]) => [from.toLowerCase(), to.toLowerCase()]),
  );
  return {
    slug: `fake-${model}`,
    dimensions,
    async embed(texts) {
      return texts.map((text) => fakeEmbedding(text, dimensions, aliases));
    },
  };
}
