import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DRAFT_MARKER, bumpVersion, currentVersion, draftNotes } from "../scripts/release.ts";

const ROOT = resolve(import.meta.dir, "..");
const FILES = [
  "packages/shared/src/index.ts",
  "packages/server/src/mcp/server.ts",
  "packages/shared/package.json",
  "packages/server/package.json",
  "packages/cli/package.json",
  "packages/collector/package.json",
  "README.md",
];
let dir: string;

function copyOfRepo(): string {
  dir = mkdtempSync(join(tmpdir(), "retrospecticus-release-"));
  for (const file of FILES) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(join(ROOT, file), join(dir, file));
  }
  return dir;
}

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("release script", () => {
  test("bumps every version line and nothing else", () => {
    const root = copyOfRepo();
    const from = currentVersion(root);
    const before = Object.fromEntries(FILES.map((f) => [f, readFileSync(join(root, f), "utf8")]));
    expect(bumpVersion(root, from, "9.8.7")).toEqual(FILES);
    expect(currentVersion(root)).toBe("9.8.7");
    for (const file of FILES) {
      const after = readFileSync(join(root, file), "utf8");
      const changed = after.split("\n").filter((line, i) => line !== before[file]!.split("\n")[i]);
      expect(changed).toHaveLength(1);
      expect(changed[0]).toContain("9.8.7");
    }
  });

  test("writes nothing when any version line is missing", () => {
    const root = copyOfRepo();
    const from = currentVersion(root);
    writeFileSync(join(root, "README.md"), "no install example here\n");
    expect(() => bumpVersion(root, from, "9.8.7")).toThrow("README.md");
    expect(currentVersion(root)).toBe(from);
  });

  test("the draft notes list the commits and carry the marker the checks refuse", () => {
    const notes = draftNotes("0.3.0", "v0.2.0", ["Add a thing (#11)", "Fix another"], "https://github.com/o/r");
    expect(notes.startsWith(DRAFT_MARKER)).toBe(true);
    expect(notes).toContain("- Add a thing (#11)\n- Fix another");
    expect(notes).toContain("https://github.com/o/r/compare/v0.2.0...v0.3.0");
  });

  test("the notes check refuses a missing file and a draft, and passes finished notes", () => {
    const root = copyOfRepo();
    mkdirSync(join(root, "docs/releases"), { recursive: true });
    cpSync(join(ROOT, "scripts/check-release-notes.sh"), join(root, "check.sh"));
    const check = (tag: string) => Bun.spawnSync(["sh", "check.sh", tag], { cwd: root, stderr: "pipe" });
    expect(check("v0.3.0").exitCode).toBe(1);
    writeFileSync(join(root, "docs/releases/v0.3.0.md"), draftNotes("0.3.0", "v0.2.0", ["x"], "https://github.com/o/r"));
    const draft = check("v0.3.0");
    expect(draft.exitCode).toBe(1);
    expect(draft.stderr.toString()).toContain("still the draft");
    writeFileSync(join(root, "docs/releases/v0.3.0.md"), "## Highlights\n\n- A thing.\n");
    expect(check("v0.3.0").exitCode).toBe(0);
  });
});
