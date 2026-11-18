import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/main.ts";

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let hits: number;
let status: number;
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "retrospecticus-notify-"));
  hits = 0;
  status = 204;
  server = Bun.serve({
    port: 0,
    fetch() {
      hits++;
      return new Response(null, { status });
    },
  });
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

async function notifyTest(): Promise<{ code: number; out: string[]; err: string[] }> {
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ data_dir: join(dir, "data"), notifiers: { discord: {} } }));
  writeFileSync(
    join(dir, "secrets.json"),
    JSON.stringify({ discord_webhook_url: { value: `${server.url}hook`, updated_at: new Date().toISOString() } }),
    { mode: 0o600 },
  );
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(["--config", configPath, "notify", "test"], { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

describe("notify test", () => {
  test("reaches every enabled adapter and exits 0", async () => {
    const { code, out } = await notifyTest();
    expect(code).toBe(0);
    expect(hits).toBe(1);
    expect(out).toEqual(["log: ok", "discord: ok"]);
  });

  test("exits 1 when an adapter fails", async () => {
    status = 500;
    const { code, out } = await notifyTest();
    expect(code).toBe(1);
    expect(out[0]).toBe("log: ok");
    expect(out[1]).toContain("discord: FAILED");
  });
});
