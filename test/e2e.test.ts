import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MCP_PATH } from "../packages/shared/src/index.ts";
import { issueToken } from "../packages/server/src/auth.ts";
import { parseCollectorConfig } from "../packages/collector/src/config.ts";
import { createCollector, type Collector } from "../packages/collector/src/main.ts";
import { defaultConfig } from "../packages/server/src/config.ts";
import { countOpenDriftEvents } from "../packages/server/src/db/drift.ts";
import { listFiles } from "../packages/server/src/db/files.ts";
import { startServer, type RunningServer } from "../packages/server/src/main.ts";
import { RECALLED_OPEN } from "../packages/server/src/search/format.ts";

const MACHINE = "e2e-box";
const FIXTURES = join(import.meta.dir, "../fixtures");
const CLAUDE_FIXTURE_SESSION = "claude-code/2.1.325/00000000-0000-4000-8000-00000000018f";
const CODEX_FIXTURE = "codex/0.153.4/rollout-2001-01-10T00-00-00-00000000-0000-4000-8000-000000000081.jsonl";
const CODEX_DEST = "2001/01/10/rollout-2001-01-10T00-00-00-00000000-0000-4000-8000-000000000081.jsonl";
const PROJECT_DIR = "-home-e2e-code-zeppelin";
const SYNTH_ID = "e2e00000-0000-4000-8000-000000000001";
const SYNTH_REL = `${PROJECT_DIR}/${SYNTH_ID}.jsonl`;
const USER_TEXT = "Where is the zeppelin calibration checklist for the mooring mast?";
const ASSISTANT_TEXT = "You should calibrate the altimeter before the ballast is released from the mooring mast.";
const DRIFT_WARNING_PREFIX = "Warning: ";

let root: string;
let claudeRoot: string;
let codexRoot: string;
let server: RunningServer;
let collector: Collector;
let client: Client | null = null;
let synthPath: string;
let searchToken: string;

function readLines(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter((line) => line !== "");
}

function copyFile(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}

/** Builds the synthetic session from real fixture records so every field the parser requires is present. */
function buildSynthetic(): string {
  const lines = readLines(join(FIXTURES, "claude-code/2.1.325/00000000-0000-4000-8000-0000000002d0.jsonl")).map(
    (line) => JSON.parse(line) as Record<string, any>,
  );
  const userTemplate = lines.find((r) => r.type === "user" && typeof r.message?.content === "string");
  const assistantTemplate = lines.find(
    (r) => r.type === "assistant" && Array.isArray(r.message?.content) && r.message.content.every((c: any) => c.type === "text"),
  );
  if (!userTemplate || !assistantTemplate) throw new Error("fixture lacks a plain user or assistant text record");

  const user = structuredClone(userTemplate);
  user.parentUuid = null;
  user.uuid = "e2e00000-0000-4000-8000-0000000000a1";
  user.sessionId = SYNTH_ID;
  user.timestamp = "2026-11-16T10:00:00.000Z";
  user.message.content = USER_TEXT;

  const assistant = structuredClone(assistantTemplate);
  assistant.parentUuid = user.uuid;
  assistant.uuid = "e2e00000-0000-4000-8000-0000000000a2";
  assistant.sessionId = SYNTH_ID;
  assistant.timestamp = "2026-11-16T10:00:05.000Z";
  assistant.message.content = [{ type: "text", text: ASSISTANT_TEXT }];

  return `${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`;
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

async function syncCollector(): Promise<void> {
  for (let pass = 0; pass < 20; pass++) {
    const result = await collector.scanOnce();
    expect(result.ok).toBe(true);
    if (result.uploadedBytes === 0) return;
  }
  throw new Error("collector never ran out of bytes to upload");
}

function allParsed(): boolean {
  const files = listFiles(server.db);
  return files.length > 0 && files.every((f) => f.parsed_offset === f.size);
}

function chunkCount(): number {
  return server.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM chunks").get()?.n ?? 0;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const result = (await client!.callTool({ name, arguments: args })) as CallToolResult;
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error(`unexpected content from ${name}`);
  return { text: first.text, isError: result.isError === true };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "retrospecticus-e2e-"));
  const home = join(root, "home");
  claudeRoot = join(home, ".claude", "projects");
  codexRoot = join(home, ".codex", "sessions");
  mkdirSync(claudeRoot, { recursive: true });
  mkdirSync(codexRoot, { recursive: true });

  server = startServer(
    defaultConfig({
      data_dir: join(root, "server-data"),
      listen_host: "127.0.0.1",
      listen_port: 0,
      indexer: { poll_seconds: 0.05 },
      embedding: { provider: "fake", model: "e2e" },
    }),
  );
  const ingest = issueToken(server.db, { scope: "ingest", machine: MACHINE }).token;
  searchToken = issueToken(server.db, { scope: "search", name: "e2e-search" }).token;

  const tokenFile = join(root, "ingest-token");
  writeFileSync(tokenFile, `${ingest}\n`, { mode: 0o600 });
  collector = createCollector(
    parseCollectorConfig({
      server_url: server.url,
      token_file: tokenFile,
      machine: MACHINE,
      state_file: join(root, "state", "collector-state.json"),
      poll_seconds: 0.05,
      watch: false,
      backoff_min_ms: 5,
      backoff_max_ms: 50,
      sources: [
        { name: "claude-code", root: claudeRoot, glob: "**/*.jsonl" },
        { name: "codex", root: codexRoot, glob: "**/*.jsonl" },
      ],
    }),
    { log: { info: () => {}, warn: () => {}, error: () => {} } },
  );

  const fixtureDest = `${PROJECT_DIR}/00000000-0000-4000-8000-00000000018f`;
  copyFile(join(FIXTURES, `${CLAUDE_FIXTURE_SESSION}.jsonl`), join(claudeRoot, `${fixtureDest}.jsonl`));
  copyFile(
    join(FIXTURES, `${CLAUDE_FIXTURE_SESSION}/subagents/agent-fake000565.jsonl`),
    join(claudeRoot, fixtureDest, "subagents", "agent-fake000565.jsonl"),
  );
  copyFile(join(FIXTURES, CODEX_FIXTURE), join(codexRoot, CODEX_DEST));
  synthPath = join(claudeRoot, SYNTH_REL);
  writeFileSync(synthPath, buildSynthetic());

  client = new Client({ name: "retrospecticus-e2e", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url + MCP_PATH), {
      requestInit: { headers: { Authorization: `Bearer ${searchToken}` } },
    }),
  );
});

afterAll(async () => {
  await collector?.stop();
  await client?.close();
  await server?.stop();
  rmSync(root, { recursive: true, force: true });
});

test("collected sessions are archived, indexed and recalled over MCP", async () => {
  await syncCollector();
  await waitFor(() => allParsed() && chunkCount() > 0, "files parsed and chunks created");

  const files = listFiles(server.db);
  expect(files.some((f) => f.source === "codex")).toBe(true);
  expect(files.some((f) => f.path.includes("/subagents/"))).toBe(true);
  const localFiles: [string, string, string][] = [
    ["claude-code", SYNTH_REL, synthPath],
    ["claude-code", `${PROJECT_DIR}/00000000-0000-4000-8000-00000000018f.jsonl`, join(claudeRoot, PROJECT_DIR, "00000000-0000-4000-8000-00000000018f.jsonl")],
    ["codex", CODEX_DEST, join(codexRoot, CODEX_DEST)],
  ];
  for (const [source, rel, local] of localFiles) {
    const archived = join(root, "server-data", "raw", MACHINE, source, rel);
    expect(existsSync(archived)).toBe(true);
    expect(readFileSync(archived).equals(readFileSync(local))).toBe(true);
  }

  await waitFor(
    () => server.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM chunks WHERE session_id = ?").get(SYNTH_ID)!.n > 0,
    "synthetic session chunks",
  );

  const search = await call("search_memory", { query: "calibrate the altimeter before the ballast" });
  expect(search.isError).toBe(false);
  expect(search.text).toContain(RECALLED_OPEN);
  expect(search.text).toContain(ASSISTANT_TEXT);
  expect(search.text).toContain(SYNTH_ID);
  expect(search.text.trimEnd().endsWith("</recalled-history>")).toBe(true);
  expect(search.text).not.toContain(DRIFT_WARNING_PREFIX);

  const session = await call("get_session", { session_id: SYNTH_ID });
  expect(session.isError).toBe(false);
  expect(session.text).toContain(USER_TEXT);
  expect(session.text).toContain(ASSISTANT_TEXT);

  const list = await call("list_sessions", {});
  expect(list.text).toContain(`session_id: ${SYNTH_ID}`);

  const status = await call("memory_status");
  expect(status.text).toContain(`${MACHINE}: last ingest`);
  expect(countOpenDriftEvents(server.db, ["breaking"])).toBe(0);
}, 30_000);

test("an unknown record type raises a breaking drift alert", async () => {
  const before = (await call("memory_status")).text;
  expect(before).not.toMatch(/#\d+ breaking/);

  appendFileSync(synthPath, `${JSON.stringify({ type: "hologram-frame", sessionId: SYNTH_ID, payload: { k: 1 } })}\n`);
  await syncCollector();
  await waitFor(() => allParsed() && countOpenDriftEvents(server.db, ["breaking"]) > 0, "breaking drift event");

  const status = await call("memory_status");
  expect(status.text).toMatch(/Open drift alerts: [1-9]/);
  expect(status.text).toMatch(/#\d+ breaking claude-code hologram-frame/);

  const search = await call("search_memory", { query: "calibrate the altimeter before the ballast" });
  expect(search.text).toContain(ASSISTANT_TEXT);
  expect(search.text).toContain(`${DRIFT_WARNING_PREFIX}`);
  expect(search.text).toContain("open format-drift alert(s)");
}, 30_000);
