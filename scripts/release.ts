/**
 * Prepares a release: bumps the version everywhere it is written and starts
 * the release notes, which the release workflow publishes as the release text.
 *
 *   bun scripts/release.ts 0.3.0
 *
 * It changes files only; review them, edit the notes, open a pull request, and
 * tag after it is merged.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The release workflow and the pull request check refuse notes that still carry this line. */
export const DRAFT_MARKER = "<!-- draft: rewrite this for people upgrading, then delete this line -->";

/** Each file, and the exact line holding the version in it; nothing else in them is touched. */
function versionLines(from: string, to: string): [string, string, string][] {
  const pkg = (name: string): [string, string, string] => [`packages/${name}/package.json`, `  "version": "${from}",`, `  "version": "${to}",`];
  return [
    ["packages/shared/src/index.ts", `export const VERSION = "${from}";`, `export const VERSION = "${to}";`],
    ["packages/server/src/mcp/server.ts", `export const MCP_SERVER_VERSION = "${from}";`, `export const MCP_SERVER_VERSION = "${to}";`],
    pkg("shared"),
    pkg("server"),
    pkg("cli"),
    pkg("collector"),
    ["README.md", `v=${from} arch=x64`, `v=${to} arch=x64`],
  ];
}

export function currentVersion(root: string): string {
  const text = readFileSync(join(root, "packages/shared/src/index.ts"), "utf8");
  const match = /^export const VERSION = "([^"]+)";$/m.exec(text);
  if (!match) throw new Error("cannot find VERSION in packages/shared/src/index.ts");
  return match[1]!;
}

/** Replaces each version line, refusing before writing anything if one is missing or appears more than once. */
export function bumpVersion(root: string, from: string, to: string): string[] {
  const edits = versionLines(from, to).map(([file, before, after]) => {
    const path = join(root, file);
    const text = readFileSync(path, "utf8");
    const count = text.split(before).length - 1;
    if (count !== 1) throw new Error(`${file}: expected the line ${JSON.stringify(before)} once, found it ${count} times`);
    return { file, path, text: text.replace(before, after) };
  });
  for (const edit of edits) writeFileSync(edit.path, edit.text);
  return edits.map((edit) => edit.file);
}

export function draftNotes(version: string, previousTag: string | null, subjects: string[], repoUrl: string): string {
  const changes = subjects.length > 0 ? subjects.map((s) => `- ${s}`).join("\n") : "- ";
  const changelog = previousTag ? `\n**Full changelog:** ${repoUrl}/compare/${previousTag}...v${version}\n` : "";
  return `${DRAFT_MARKER}
<!-- The commits since ${previousTag ?? "the start"}, as a starting point: -->

## Highlights

${changes}

## Upgrading

- Server: \`docker compose pull && docker compose up -d\`.
- Collectors: \`retrospecticus-collector update\` on each machine, or **Upgrade** on the Machines tab where remote updates are on.
${changelog}`;
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

function main(): void {
  const to = process.argv[2]?.replace(/^v/, "");
  if (!to || !VERSION_PATTERN.test(to)) {
    console.error("Usage: bun scripts/release.ts <version>, for example 0.3.0");
    process.exit(2);
  }
  const from = currentVersion(ROOT);
  if (from === to) {
    console.error(`VERSION is already ${to}.`);
    process.exit(1);
  }
  const notesFile = `docs/releases/v${to}.md`;
  const notesPath = join(ROOT, notesFile);

  const changed = bumpVersion(ROOT, from, to);
  if (existsSync(notesPath)) {
    console.log(`${notesFile} already exists; left as it is.`);
  } else {
    let previousTag: string | null = null;
    try {
      previousTag = git("describe", "--tags", "--abbrev=0");
    } catch {
      previousTag = null;
    }
    const range = previousTag ? `${previousTag}..HEAD` : "HEAD";
    const subjects = git("log", "--format=%s", range).split("\n").filter(Boolean);
    mkdirSync(dirname(notesPath), { recursive: true });
    writeFileSync(notesPath, draftNotes(to, previousTag, subjects, "https://github.com/chris-gibson/retrospecticus"));
    changed.push(notesFile);
  }

  console.log(`Version ${from} -> ${to}. Changed:\n${changed.map((f) => `  ${f}`).join("\n")}

Next:
  1. Rewrite ${notesFile} for people upgrading, and delete its draft line.
  2. Commit on a branch and open a pull request; its check fails while the notes are missing or still a draft.
  3. After it is merged: git checkout main && git pull && git tag v${to} && git push origin v${to}`);
}

if (import.meta.main) main();
