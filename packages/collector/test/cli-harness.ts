import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENROLL_POLL_PATH,
  ENROLL_START_PATH,
  EnrollStartRequestSchema,
  HEARTBEAT_PATH,
  TOKEN_REVOKE_SELF_PATH,
  TOKEN_WHOAMI_PATH,
  type EnrollStartRequest,
} from "@retrospecticus/shared";
import { PromptClosed, type CliEnv, type RunResult } from "../src/cli/env.ts";

export type PollStep =
  | { status: "pending" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "approved"; token: string; machine: string }
  | { http: number }
  | { garbage: true };

export interface FakeServer {
  url: string;
  token: string;
  starts: EnrollStartRequest[];
  polls: number;
  heartbeats: { authorization: string | null; machine: string | null }[];
  /** What /healthz reports. */
  version: string;
  /** Served at /downloads/SHA256SUMS and /downloads/collector/<platform>; unset answers 404. */
  sums: string | null;
  binary: Uint8Array | null;
  revokes: { authorization: string | null; machine: string | null }[];
  revokeStatus: number;
  /** Overrides the whoami answer for a valid token, to stand in for a failing server. */
  whoamiStatus: number;
  /** Answer the token routes with a proxy's HTML page and 200, as a misrouted reverse proxy would. */
  proxyPage: boolean;
  /** When set, /status.json answers as a running collector of this version would. */
  runningVersion: string | null;
  /** The machine the fake status page claims to be; defaults to the enrolled one. */
  runningMachine: string | null;
  startStatus: number;
  startBody: string | null;
  pollScript: PollStep[];
  stop(): void;
}

export function fakeServer(machine = "testbox"): FakeServer {
  const state: FakeServer = {
    url: "",
    token: "rt_faketoken123",
    starts: [],
    polls: 0,
    heartbeats: [],
    version: "0.0.0-server",
    sums: null,
    binary: null,
    revokes: [],
    revokeStatus: 200,
    whoamiStatus: 200,
    proxyPage: false,
    runningVersion: null,
    runningMachine: null,
    startStatus: 200,
    startBody: null,
    pollScript: [{ status: "pending" }, { status: "approved", token: "rt_faketoken123", machine }],
    stop: () => void server.stop(true),
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/healthz") return Response.json({ ok: true, version: state.version });
      if (path === "/downloads/SHA256SUMS") return state.sums === null ? new Response("no", { status: 404 }) : new Response(state.sums);
      if (path.startsWith("/downloads/collector/")) return state.binary === null ? new Response("no", { status: 404 }) : new Response(state.binary);
      if (path === "/status.json") {
        if (state.runningVersion === null) return new Response("not found", { status: 404 });
        return Response.json({
          collector_version: state.runningVersion,
          machine: state.runningMachine ?? machine,
          server_url: state.url,
          uptime_seconds: 60,
          sources: [],
          last_upload_at: null,
          last_error: null,
        });
      }
      if (state.proxyPage && (path === TOKEN_WHOAMI_PATH || path === TOKEN_REVOKE_SELF_PATH)) {
        return new Response("<html>Welcome to nginx</html>", { status: 200, headers: { "Content-Type": "text/html" } });
      }
      if (path === TOKEN_REVOKE_SELF_PATH) {
        state.revokes.push({ authorization: req.headers.get("authorization"), machine: req.headers.get("x-machine") });
        return state.revokeStatus === 200 ? Response.json({ result: "revoked" }) : new Response("{}", { status: state.revokeStatus });
      }
      if (path === ENROLL_START_PATH) {
        const parsed = EnrollStartRequestSchema.safeParse(await req.json());
        if (!parsed.success) return Response.json({ error: "bad machine" }, { status: 400 });
        state.starts.push(parsed.data);
        if (state.startStatus !== 200) return new Response(state.startBody ?? "", { status: state.startStatus });
        return Response.json({
          device_code: "dev-code",
          user_code: "WDJB-MJHT",
          verification_url: `${state.url}/admin`,
          expires_in: 600,
          interval: 3,
        });
      }
      if (path === ENROLL_POLL_PATH) {
        state.polls++;
        const step = state.pollScript.length > 1 ? state.pollScript.shift()! : state.pollScript[0]!;
        if ("garbage" in step) return new Response("<html>", { status: 200 });
        if ("http" in step) return new Response("nope", { status: step.http });
        return Response.json(step);
      }
      if (path === TOKEN_WHOAMI_PATH) {
        if (req.headers.get("authorization") !== `Bearer ${state.token}`) return new Response("no", { status: 401 });
        if (req.headers.get("x-machine") !== machine) return new Response("wrong machine", { status: 403 });
        return state.whoamiStatus === 200 ? Response.json({ machine }) : new Response("down", { status: state.whoamiStatus });
      }
      if (path === HEARTBEAT_PATH) {
        const authorization = req.headers.get("authorization");
        state.heartbeats.push({ authorization, machine: req.headers.get("x-machine") });
        return authorization === `Bearer ${state.token}` ? Response.json({ ok: true }) : new Response("no", { status: 401 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  state.url = `http://127.0.0.1:${server.port}`;
  return state;
}

export interface TestCli {
  env: CliEnv;
  home: string;
  configPath: string;
  out: string[];
  err: string[];
  prompts: string[];
  commands: string[][];
  /** null stands for end of input (Ctrl-D). */
  answers: (string | null)[];
  /** Results for run(), matched by the command's first two words; default is success. */
  results: Map<string, RunResult>;
  abort(): void;
  cleanup(): void;
}

export function createCli(overrides: Partial<CliEnv> = {}): TestCli {
  const home = mkdtempSync(join(tmpdir(), "retrospecticus-cli-test-"));
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const commands: string[][] = [];
  const answers: (string | null)[] = [];
  const results = new Map<string, RunResult>();
  const controller = new AbortController();
  let clock = 1_700_000_000_000;

  const env: CliEnv = {
    home,
    env: {},
    platform: "linux",
    arch: "x64",
    hostname: "my-box.local",
    uid: 1000,
    isTTY: false,
    execPath: join(home, "dl", "retrospecticus-collector"),
    mainPath: "/src/main.ts",
    isCompiled: true,
    async prompt(question) {
      prompts.push(question);
      const answer = answers.shift();
      if (answer === null) throw new PromptClosed("cancelled: no answer (end of input)");
      return answer ?? "";
    },
    async run(cmd) {
      commands.push(cmd);
      return results.get(cmd.slice(0, 2).join(" ")) ?? { code: 0, stdout: "", stderr: "" };
    },
    fetch: (input, init) => fetch(input, init),
    out: (line) => void out.push(line),
    err: (line) => void err.push(line),
    now: () => clock,
    async sleep(ms, signal) {
      if (signal?.aborted) throw new Error("aborted");
      clock += ms;
    },
    signal: controller.signal,
    runCollector: async () => 0,
    ...overrides,
  };
  if (env.execPath.startsWith(home)) mkdirSync(join(home, "dl"), { recursive: true });
  if (env.execPath.startsWith(home)) writeFileSync(env.execPath, "#!/bin/sh\necho fake\n");
  if (env.execPath.startsWith(home)) chmodSync(env.execPath, 0o755);

  return {
    env,
    home,
    configPath: join(home, ".config", "retrospecticus", "collector.json"),
    out,
    err,
    prompts,
    commands,
    answers,
    results,
    abort: () => controller.abort(),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}
