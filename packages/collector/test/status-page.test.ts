import { afterEach, describe, expect, test } from "bun:test";
import { HeartbeatSchema } from "@retrospecticus/shared";
import { getMachine } from "../../server/src/db/machines.ts";
import { startStatusServer, type StatusServer, type StatusSnapshot } from "../src/status-page.ts";
import { createEnv, MACHINE, waitFor, type TestEnv } from "./harness.ts";

const snapshot: StatusSnapshot = {
  collector_version: "9.9.9",
  machine: "testbox",
  server_url: "http://example.invalid:7878",
  hostname: "host",
  platform: "linux-x64",
  started_at: "2026-01-01T00:00:00.000Z",
  uptime_seconds: 5,
  service_mode: null,
  server_reachable: true,
  last_heartbeat_at: null,
  last_heartbeat_ok: null,
  last_scan_at: null,
  last_upload_at: null,
  last_error: { at: "2026-01-01T00:00:01.000Z", message: "<script>x</script>" },
  sources: [{ name: "codex", root: "/r", files: 2, pending_files: 1, bytes_pending: 2048 }],
};
const quiet = { info() {}, warn() {}, error() {} };

let page: StatusServer | null = null;
let env: TestEnv | null = null;
afterEach(async () => {
  page?.stop();
  page = null;
  await env?.cleanup();
  env = null;
});

describe("status server", () => {
  test("answers /status.json and / on loopback, escaping the HTML", async () => {
    page = startStatusServer(() => snapshot, 0, quiet)!;
    const base = `http://127.0.0.1:${page.port}`;

    const json = (await (await fetch(`${base}/status.json`)).json()) as StatusSnapshot;
    expect(json.collector_version).toBe("9.9.9");
    expect(json.sources[0]!.bytes_pending).toBe(2048);
    expect(JSON.stringify(json)).not.toContain("token");

    const res = await fetch(`${base}/`);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain("http-equiv=\"refresh\"");
    expect(html).toContain("2.0 KB");
    expect(html).not.toContain("<script>x");
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  test("is not reachable on a non-loopback address", async () => {
    page = startStatusServer(() => snapshot, 0, quiet)!;
    const external = Object.values((await import("node:os")).networkInterfaces())
      .flat()
      .find((i) => i && !i.internal && i.family === "IPv4")?.address;
    if (!external) return;
    await expect(fetch(`http://${external}:${page.port}/status.json`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  });

  test("rejects a foreign Host header and anything but GET and HEAD", async () => {
    page = startStatusServer(() => snapshot, 0, quiet)!;
    const url = `http://127.0.0.1:${page.port}/status.json`;
    expect((await fetch(url, { headers: { Host: "evil.example" } })).status).toBe(403);
    expect((await fetch(url, { headers: { Host: `localhost:${page.port}` } })).status).toBe(200);
    expect((await fetch(url, { method: "POST" })).status).toBe(405);
    expect((await fetch(url, { method: "HEAD" })).status).toBe(200);
  });

  test("warns once and returns null when the port is taken", async () => {
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const warnings: string[] = [];
    try {
      const result = startStatusServer(() => snapshot, blocker.port!, { ...quiet, warn: (m) => void warnings.push(m) });
      expect(result).toBeNull();
      expect(warnings).toHaveLength(1);
    } finally {
      blocker.stop(true);
    }
  });
});

describe("heartbeat to the server", () => {
  test("an old-style heartbeat still validates", () => {
    expect(
      HeartbeatSchema.safeParse({ collector_version: "0.0.1", sources: [{ name: "codex", files: 1, bytes_pending: 0 }] }).success,
    ).toBe(true);
  });

  test("the server stores the new fields, truncates the error and returns them", async () => {
    env = createEnv();
    const long = "x".repeat(1000);
    const res = await fetch(`http://127.0.0.1:${env.port}/v1/heartbeat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${(await Bun.file(env.config().token_file).text()).trim()}`,
        "Content-Type": "application/json",
        "X-Machine": MACHINE,
      },
      body: JSON.stringify({
        collector_version: "1.2.3",
        hostname: "box",
        platform: "linux-x64",
        started_at: "2026-01-01T00:00:00.000Z",
        last_upload_at: null,
        last_scan_at: "2026-01-01T00:00:05.000Z",
        last_error: { at: "2026-01-01T00:00:06.000Z", message: long },
        sources: [{ name: "codex", files: 3, bytes_pending: 10, pending_files: 2 }],
      }),
    });
    expect(res.status).toBe(200);

    const row = getMachine(env.server.db, MACHINE)!;
    expect([row.hostname, row.platform, row.started_at, row.last_upload_at]).toEqual(["box", "linux-x64", "2026-01-01T00:00:00.000Z", null]);
    expect(JSON.parse(row.last_error!).message).toHaveLength(300);
    expect(JSON.parse(row.sources!)[0].pending_files).toBe(2);
  });

  test("the daemon's status server reports live values", async () => {
    env = createEnv();
    env.write(env.claudeRoot, "p/a.jsonl", "a1\n");
    const collector = env.collector();
    collector.start();
    await waitFor(() => collector.snapshot().last_upload_at !== null, "first upload");
    page = startStatusServer(() => collector.snapshot(), 0, quiet)!;
    const live = (await (await fetch(`http://127.0.0.1:${page.port}/status.json`)).json()) as StatusSnapshot;
    expect(live.machine).toBe(MACHINE);
    expect(live.server_reachable).toBe(true);
    expect(live.sources.find((s) => s.name === "claude-code")).toMatchObject({ files: 1, pending_files: 0, bytes_pending: 0 });
  });
});
