import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/main.ts";

let server: ReturnType<typeof Bun.serve>;
let dir: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => (new URL(req.url).pathname === "/healthz" ? Response.json({ ok: true }) : new Response("no", { status: 404 })),
  });
  dir = mkdtempSync(join(tmpdir(), "retrospecticus-health-"));
});
afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

async function cli(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

describe("health", () => {
  test("answers 0 for a live server and 1 for a dead or failing one", async () => {
    expect((await cli("health", "--url", `http://127.0.0.1:${server.port}`)).code).toBe(0);
    expect((await cli("health", "--url", `http://127.0.0.1:${server.port}/nothing-here/`)).code).toBe(1);
    const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = dead.port;
    dead.stop(true);
    const result = await cli("health", "--url", `http://127.0.0.1:${port}`);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain("did not answer");
  });

  test("reaches a server listening on every interface through loopback", async () => {
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ data_dir: join(dir, "data"), listen_host: "0.0.0.0", listen_port: server.port }));
    const result = await cli("--config", config, "health");
    expect(result.code).toBe(0);
    expect(result.out).toEqual([`ok http://127.0.0.1:${server.port}/healthz`]);
  });

  test("usage errors", async () => {
    expect((await cli("health", "--url")).code).toBe(2);
    expect((await cli("health", "extra")).code).toBe(2);
  });
});
