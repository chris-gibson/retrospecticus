import type { Db } from "../db/index.ts";
import { ftsQuery, type RankedChunkHit } from "../db/search.ts";
import type { SearchFilters } from "./filters.ts";

/** Keeps a pasted wall of text from becoming a pathological MATCH expression. */
export const MAX_QUERY_TERMS = 64;

/**
 * Turns free text into an FTS5 expression that cannot be a syntax error:
 * every term is a quoted string made only of letters and digits, so FTS
 * operators, quotes and column filters in the input are inert.
 */
export function buildFtsQuery(input: string): string | null {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const token of input.match(/[\p{L}\p{N}]+/gu) ?? []) {
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(`"${token}"`);
    if (terms.length === MAX_QUERY_TERMS) break;
  }
  return terms.length > 0 ? terms.join(" OR ") : null;
}

/** Best first. Empty when the query has no searchable terms. */
export function ftsSearch(db: Db, query: string, filters: SearchFilters, limit: number): RankedChunkHit[] {
  const match = buildFtsQuery(query);
  if (match === null) return [];
  return ftsQuery(db, match, filters, limit);
}
