import type { Db } from "../db/index.ts";
import { getChunkHits, type ChunkHit } from "../db/search.ts";
import { countRecallAffectingDrift } from "../db/status.ts";
import { hasFilters, normalizeFilters, type SearchFilters } from "./filters.ts";
import { driftWarning } from "./format.ts";
import { ftsSearch } from "./fts.ts";

export const DEFAULT_LIMIT = 8;
export const MAX_LIMIT = 50;
/** Candidates taken from each ranked list before fusion and dedup. */
export const CANDIDATES = 50;
/** vec0 filters after the KNN step, so a filtered query needs a deeper pool to keep enough survivors. */
export const FILTERED_VECTOR_CANDIDATES = 200;
export const RRF_K = 60;
/** About 500 tokens at the indexer's four characters per token. */
export const MAX_RESULT_CHARS = 2000;
export const TRUNCATION_MARKER = " …[truncated]";

export const SEARCH_MODES = ["hybrid", "keyword", "vector"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

/** `mode` exists for diagnosing ranking; agents always get hybrid. */
export type SearchParams = { query: string; limit?: number; mode?: SearchMode } & SearchFilters;

export interface SearchResult {
  chunkId: number;
  text: string;
  sessionId: string;
  sessionTitle: string | null;
  project: string | null;
  source: string;
  machine: string;
  timestamp: string | null;
  /** Ordinal of the turn's first message; pass it to `get_session` as `around_ordinal`. */
  ordinal: number;
}

/**
 * Best first. Returns null when there is no active embedding model, so search
 * falls back to keywords alone. Filters are passed so the implementation can
 * prefilter if it is able; results are filtered again here regardless.
 */
export type VectorSearch = (query: string, filters: SearchFilters, k: number) => Promise<{ chunkId: number }[] | null>;

export interface RankWeights {
  keyword: number;
  vector: number;
}

export interface SearchDeps {
  vectorSearch?: VectorSearch;
  /** Hybrid search only; both default to 1. */
  weights?: RankWeights;
}

export async function search(db: Db, params: SearchParams, deps: SearchDeps = {}): Promise<SearchResult[]> {
  const { query, limit, mode = "hybrid", ...rawFilters } = params;
  const filters = normalizeFilters(rawFilters);
  const n = clampLimit(limit);

  const ftsHits = mode === "vector" ? [] : ftsSearch(db, query, filters, CANDIDATES);
  const hitsById = new Map<number, ChunkHit>(ftsHits.map((h) => [h.chunk_id, h]));
  const ranked: number[][] = mode === "vector" ? [] : [ftsHits.map((h) => h.chunk_id)];
  const weights: number[] = mode === "vector" ? [] : [deps.weights?.keyword ?? 1];

  const vectorIds = mode === "keyword" ? null : await vectorCandidates(query, filters, deps.vectorSearch);
  if (vectorIds) {
    const missing = vectorIds.filter((id) => !hitsById.has(id));
    for (const hit of getChunkHits(db, missing, filters)) hitsById.set(hit.chunk_id, hit);
    ranked.push(vectorIds.filter((id) => hitsById.has(id)));
    weights.push(deps.weights?.vector ?? 1);
  }

  const order = ranked.length === 0 ? [] : ranked.length === 1 ? ranked[0]! : reciprocalRankFusion(ranked, RRF_K, weights);
  const seenHashes = new Set<string>();
  const results: SearchResult[] = [];
  for (const id of order) {
    const hit = hitsById.get(id);
    if (!hit || seenHashes.has(hit.text_hash)) continue;
    seenHashes.add(hit.text_hash);
    results.push(toResult(hit));
    if (results.length === n) break;
  }
  return results;
}

async function vectorCandidates(
  query: string,
  filters: SearchFilters,
  vectorSearch: VectorSearch | undefined,
): Promise<number[] | null> {
  if (!vectorSearch) return null;
  const k = hasFilters(filters) ? FILTERED_VECTOR_CANDIDATES : CANDIDATES;
  try {
    const hits = await vectorSearch(query, filters, k);
    return hits ? hits.map((h) => h.chunkId) : null;
  } catch (err) {
    // A failed query embedding must never take keyword search down with it.
    console.warn(`vector search failed, using keyword search only: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Score is the sum of weight / (k + rank) over the lists an id appears in,
 * rank starting at 1 and weight defaulting to 1. Ties keep the order in which
 * ids were first met, which puts the first list's preference first.
 */
export function reciprocalRankFusion(
  lists: readonly (readonly number[])[],
  k = RRF_K,
  weights: readonly number[] = [],
): number[] {
  const scores = new Map<number, number>();
  for (const [li, list] of lists.entries()) {
    const weight = weights[li] ?? 1;
    const seen = new Set<number>();
    list.forEach((id, index) => {
      if (seen.has(id)) return;
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + index + 1));
    });
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

export function capText(text: string, max = MAX_RESULT_CHARS): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - TRUNCATION_MARKER.length);
  // Never leave half of a surrogate pair at the cut.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut.trimEnd() + TRUNCATION_MARKER;
}

function toResult(hit: ChunkHit): SearchResult {
  return {
    chunkId: hit.chunk_id,
    text: capText(hit.text),
    sessionId: hit.session_id,
    sessionTitle: hit.title,
    project: hit.project_path,
    source: hit.source,
    machine: hit.machine,
    timestamp: hit.timestamp,
    ordinal: hit.ordinal,
  };
}

/** The line search must append while open drift may be hiding recent sessions, or null. */
export function searchWarning(db: Db): string | null {
  return driftWarning(countRecallAffectingDrift(db));
}
