import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { auditRecord, forEachString } from "../../../scripts/scrub.ts";
import { parsers } from "../src/parsers/index.ts";
import type { Parser } from "../src/parsers/types.ts";
import { archivedPath, FIXTURE_ROOT, fixtureLines, manifest } from "./fixture-helpers.ts";

const BUDGET_BYTES = 3 * 1024 * 1024;

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

/** Discriminators in `lines` that the parser neither handles nor deliberately ignores. */
function undecided(parser: Parser, lines: string[]): string[] {
  const decided = new Set([...parser.handledTypes, ...parser.ignoredTypes]);
  const found = new Set<string>();
  for (const line of lines) {
    const discriminator = parser.discriminator(JSON.parse(line));
    if (!decided.has(discriminator)) found.add(discriminator);
  }
  return [...found].sort();
}

describe("fixture inventory", () => {
  test("the manifest lists exactly the files on disk", () => {
    const onDisk = filesUnder(FIXTURE_ROOT)
      .map((f) => relative(FIXTURE_ROOT, f))
      .filter((f) => f !== "manifest.json")
      .sort();
    expect(manifest.map((m) => m.path).sort()).toEqual(onDisk);
  });

  test("stays inside the size budget", () => {
    const total = filesUnder(FIXTURE_ROOT).reduce((n, f) => n + statSync(f).size, 0);
    expect(total).toBeLessThanOrEqual(BUDGET_BYTES);
  });

  test("covers the oldest and newest version of each source with the required session kinds", () => {
    for (const source of ["claude-code", "codex"] as const) {
      const versions = new Set(manifest.filter((m) => m.source === source).map((m) => m.version));
      expect(versions.size).toBe(2);
      for (const version of versions) {
        const roles = manifest.filter((m) => m.source === source && m.version === version).map((m) => m.role);
        expect(roles).toContain("coverage");
        expect(roles).toContain("main");
      }
    }
    const roles = (source: string) => manifest.filter((m) => m.source === source).map((m) => m.role);
    expect(roles("claude-code")).toContain("subagent");
    expect(roles("codex")).toContain("guardian");
    expect(roles("codex")).toContain("spawned");
  });
});

describe("fixture privacy", () => {
  for (const entry of manifest) {
    test(`every string in ${entry.path} is allowlisted or filler`, () => {
      const violations = fixtureLines(entry).flatMap((line, i) =>
        auditRecord(entry.source, JSON.parse(line)).map((v) => `line ${i + 1} ${v.path}: ${v.reason}`),
      );
      expect(violations).toEqual([]);
    });
  }

  test("no string or key looks like a path, a URL, an address or the owner's name", () => {
    const suspicious = /\/home\/|\/Users\/|https?:|@|chrisgibson|\\\\/i;
    const hits: string[] = [];
    for (const entry of manifest) {
      for (const line of fixtureLines(entry)) {
        forEachString(JSON.parse(line), (s) => {
          if (suspicious.test(s)) hits.push(`${entry.path}: string of length ${s.length}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });

  test("file names carry only fake ids", () => {
    for (const entry of manifest) {
      const name = entry.path.split("/").slice(2).join("/");
      expect(name).toMatch(
        /^(?:coverage(?:-intermediate)?|(?:rollout-[\dT-]+-)?00000000-0000-4000-8000-[0-9a-f]{12}(?:\/subagents\/agent-fake\d{6})?)\.jsonl$/,
      );
    }
  });
});

describe("discriminator guard", () => {
  for (const entry of manifest) {
    test(`${entry.path} holds only discriminators the parser handles or explicitly ignores`, () => {
      expect(undecided(parsers[entry.source], fixtureLines(entry))).toEqual([]);
    });
  }

  test("the guard notices a record type nobody decided about", () => {
    expect(undecided(parsers["claude-code"], ['{"type":"brand-new-record"}', '{"type":"attachment","attachment":{"type":"novel"}}'])).toEqual([
      "attachment/novel",
      "brand-new-record",
    ]);
    expect(undecided(parsers.codex, ['{"type":"response_item","payload":{"type":"hologram"}}'])).toEqual(["response_item/hologram"]);
  });

  test("handled and ignored lists do not overlap", () => {
    for (const parser of Object.values(parsers)) {
      const ignored = new Set(parser.ignoredTypes);
      expect(parser.handledTypes.filter((t) => ignored.has(t))).toEqual([]);
    }
  });

  test("every listed discriminator is exercised by a fixture, so the lists hold nothing speculative", () => {
    for (const source of ["claude-code", "codex"] as const) {
      const parser = parsers[source];
      const seen = new Set<string>();
      for (const entry of manifest.filter((m) => m.source === source)) {
        for (const line of fixtureLines(entry)) seen.add(parser.discriminator(JSON.parse(line)));
      }
      const unseen = [...parser.handledTypes, ...parser.ignoredTypes].filter((t) => !seen.has(t)).sort();
      expect(unseen).toEqual([]);
    }
  });

  test("no fixture line is unknown to its parser or holds a block it cannot read", () => {
    for (const entry of manifest) {
      const ctx = { source: entry.source, machine: "laptop", path: archivedPath(entry), state: {} };
      for (const line of fixtureLines(entry)) {
        const result = parsers[entry.source].parse(line, ctx);
        expect(result.kind).not.toBe("unknown");
        if (result.kind === "messages") expect(result.unknownBlocks).toBeUndefined();
      }
    }
  });
});
