export interface ShapeCandidate {
  hash: string;
  /** `path:type` entries as returned by `keyPaths`. */
  paths: readonly string[];
}

export interface RetypedPath {
  path: string;
  from: string[];
  to: string[];
}

export interface ShapeDiff {
  /** Hash of the closest known shape, or null when there was nothing to compare with. */
  nearest: string | null;
  added: string[];
  removed: string[];
  retyped: RetypedPath[];
}

function typesByPath(paths: readonly string[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const entry of paths) {
    // Keys in a key path are plain identifiers, so the last colon always starts the type.
    const colon = entry.lastIndexOf(":");
    const path = entry.slice(0, colon);
    const type = entry.slice(colon + 1);
    let types = map.get(path);
    if (types === undefined) map.set(path, (types = new Set()));
    types.add(type);
  }
  return map;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

function compare(target: Map<string, Set<string>>, known: Map<string, Set<string>>): Omit<ShapeDiff, "nearest"> {
  const added: string[] = [];
  const removed: string[] = [];
  const retyped: RetypedPath[] = [];
  for (const [path, types] of target) {
    const before = known.get(path);
    if (before === undefined) added.push(`${path}:${[...types].sort().join("|")}`);
    else if (!sameSet(types, before)) retyped.push({ path, from: [...before].sort(), to: [...types].sort() });
  }
  for (const [path, types] of known) {
    if (!target.has(path)) removed.push(`${path}:${[...types].sort().join("|")}`);
  }
  return { added: added.sort(), removed: removed.sort(), retyped: retyped.sort((a, b) => a.path.localeCompare(b.path)) };
}

/** Compares a record's key paths with the closest of the candidate shapes, closeness being the number of differing paths. */
export function diffAgainstNearest(target: readonly string[], candidates: readonly ShapeCandidate[]): ShapeDiff {
  const mine = typesByPath(target);
  let best: ShapeDiff | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const result = compare(mine, typesByPath(candidate.paths));
    const distance = result.added.length + result.removed.length + result.retyped.length;
    if (distance < bestDistance) {
      best = { nearest: candidate.hash, ...result };
      bestDistance = distance;
    }
  }
  return best ?? { nearest: null, added: [], removed: [], retyped: [] };
}

export function formatDiff(diff: ShapeDiff): string[] {
  if (diff.nearest === null) return ["No known shape with this discriminator to compare with."];
  const lines = [`Nearest known shape: ${diff.nearest.slice(0, 16)}`];
  if (diff.added.length + diff.removed.length + diff.retyped.length === 0) lines.push("  (same key paths)");
  for (const path of diff.added) lines.push(`  + ${path}`);
  for (const path of diff.removed) lines.push(`  - ${path}`);
  for (const r of diff.retyped) lines.push(`  ~ ${r.path}: ${r.from.join("|")} -> ${r.to.join("|")}`);
  return lines;
}
