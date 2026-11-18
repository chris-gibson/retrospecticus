import { z } from "zod";
import { SourceSchema } from "@retrospecticus/shared";

const IsoDateOrDatetime = z.union([z.iso.date(), z.iso.datetime({ offset: true, local: true })]);

/**
 * Raw shape rather than an object schema so MCP tool inputs can spread it.
 * No transforms: the MCP SDK has to turn these into JSON Schema.
 */
export const searchFilterShape = {
  source: SourceSchema.optional().describe("Only sessions from this harness."),
  machine: z.string().min(1).optional().describe("Only sessions recorded on this machine."),
  project: z.string().min(1).optional().describe("Substring of the session's project path."),
  after: IsoDateOrDatetime.optional().describe("ISO date or datetime; only text at or after this moment."),
  before: IsoDateOrDatetime.optional().describe("ISO date or datetime; only text before this moment."),
};

export const SearchFiltersSchema = z.object(searchFilterShape);
export type SearchFilters = z.infer<typeof SearchFiltersSchema>;

/**
 * Stored timestamps are UTC `toISOString()` strings, so bounds are brought to
 * the same form for plain string comparison. A datetime without an offset is
 * read as UTC.
 */
export function normalizeInstant(value: string): string {
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(value);
  const date = new Date(value.includes("T") && !hasZone ? `${value}Z` : value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Not an ISO date or datetime: ${value}`);
  return date.toISOString();
}

export function normalizeFilters(filters: SearchFilters): SearchFilters {
  const out: SearchFilters = {};
  if (filters.source !== undefined) out.source = filters.source;
  if (filters.machine !== undefined) out.machine = filters.machine;
  if (filters.project !== undefined) out.project = filters.project;
  if (filters.after !== undefined) out.after = normalizeInstant(filters.after);
  if (filters.before !== undefined) out.before = normalizeInstant(filters.before);
  return out;
}

export function hasFilters(filters: SearchFilters): boolean {
  return Object.values(filters).some((v) => v !== undefined);
}
