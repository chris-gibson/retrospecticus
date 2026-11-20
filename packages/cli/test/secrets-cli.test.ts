import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/main.ts";

let dir: string;
let configPath: string;
let secretsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "retrospecticus-secrets-"));
  configPath = join(dir, "config.json");
  secretsPath = join(dir, "secrets.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function cli(args: string[], stdin = ""): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(["--config", configPath, "secrets", ...args], {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    stdin: async () => stdin,
  });
  return { code, out, err };
}

describe("secrets", () => {
  test("list shows every name as unset with no config or secrets file", async () => {
    const { code, out } = await cli(["list"]);
    expect(code).toBe(0);
    expect(out).toEqual([
      "embedding_api_key    unset",
      "omlx_api_key         unset",
      "discord_webhook_url  unset",
      "smtp_url             unset",
      "github_token         unset",
    ]);
  });

  test("set reads the value from stdin, drops one trailing newline and writes mode 0600; list never shows it", async () => {
    const set = await cli(["set", "embedding_api_key"], "sk-from-stdin\n");
    expect(set.code).toBe(0);
    expect(set.out.join("\n")).not.toContain("sk-from-stdin");
    expect(statSync(secretsPath).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(secretsPath, "utf8")) as Record<string, { value: string }>;
    expect(stored.embedding_api_key!.value).toBe("sk-from-stdin");

    const list = await cli(["list"]);
    expect(list.out[0]).toMatch(/^embedding_api_key {4}set {4}updated \d{4}-\d\d-\d\dT/);
    expect([...list.out, ...list.err].join("\n")).not.toContain("sk-from-stdin");
  });

  test("unset removes the secret", async () => {
    await cli(["set", "smtp_url"], "smtp://u:p@example.com");
    const unset = await cli(["unset", "smtp_url"]);
    expect(unset.code).toBe(0);
    expect(JSON.parse(readFileSync(secretsPath, "utf8"))).toEqual({});
    expect((await cli(["list"])).out[3]).toBe("smtp_url             unset");
  });

  test("an empty value is refused and changes nothing", async () => {
    const { code, err } = await cli(["set", "smtp_url"], "\n");
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("No value");
    expect(() => statSync(secretsPath)).toThrow();
  });

  test("an unknown name or a missing one is a usage error", async () => {
    expect((await cli(["set", "openai_key"], "x")).code).toBe(2);
    expect((await cli(["set"], "x")).code).toBe(2);
    expect((await cli(["rotate", "smtp_url"])).code).toBe(2);
    expect((await cli([])).code).toBe(2);
  });

  test("$RETROSPECTICUS_SECRETS moves the secrets file", async () => {
    const elsewhere = join(dir, "elsewhere.json");
    const saved = process.env.RETROSPECTICUS_SECRETS;
    process.env.RETROSPECTICUS_SECRETS = elsewhere;
    try {
      expect((await cli(["set", "smtp_url"], "smtp://x")).code).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.RETROSPECTICUS_SECRETS;
      else process.env.RETROSPECTICUS_SECRETS = saved;
    }
    expect(statSync(elsewhere).mode & 0o777).toBe(0o600);
    expect(() => statSync(secretsPath)).toThrow();
  });
});

describe("secrets set through the real process", () => {
  test("reads a piped value, as `docker exec -i` would deliver it", async () => {
    const main = join(import.meta.dir, "../src/main.ts");
    const proc = Bun.spawn(["bun", main, "--config", configPath, "secrets", "set", "discord_webhook_url"], {
      stdin: new TextEncoder().encode("https://discord.example/hook"),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    const stored = JSON.parse(readFileSync(secretsPath, "utf8")) as Record<string, { value: string }>;
    expect(stored.discord_webhook_url!.value).toBe("https://discord.example/hook");
  });
});
