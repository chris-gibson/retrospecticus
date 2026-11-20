import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Hono } from "hono";
import type { AppEnv } from "../src/auth.ts";
import { defaultConfig } from "../src/config.ts";
import { staticConfig } from "../src/config-store.ts";
import { registerDownloadRoutes } from "../src/downloads.ts";

const NATIVE = `${process.platform}-${process.arch === "x64" ? "x64" : "arm64"}`;
let dir: string;
let home: string;
let app: Hono<AppEnv>;
let fakeBinary: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "retrospecticus-downloads-"));
  home = mkdtempSync(join(tmpdir(), "retrospecticus-install-home-"));
  // A stand-in executable that records how it was invoked instead of enrolling.
  fakeBinary = `#!/bin/sh\necho "fake collector: $*" >> "$HOME/invoked"\nif [ "$1" = status ]; then [ -e "$HOME/status-code" ] && exit "$(cat "$HOME/status-code")"; [ -e "$HOME/enrolled" ]; exit; fi\n`;
  const sums: string[] = [];
  for (const platform of ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"]) {
    const name = `retrospecticus-collector-${platform}`;
    const bytes = Buffer.from(platform === NATIVE ? fakeBinary : `binary for ${platform}\n`);
    writeFileSync(join(dir, `${name}.gz`), gzipSync(bytes));
    sums.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
  }
  writeFileSync(join(dir, "SHA256SUMS"), `${sums.join("\n")}\n`);
  app = new Hono<AppEnv>();
  registerDownloadRoutes(app, { config: staticConfig(defaultConfig()), dir, cacheDir: join(dir, "cache") });
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** Async, because the server answering the script's downloads runs on this same event loop. */
async function sh(script: string, homeDir: string) {
  const proc = Bun.spawn(["sh", script], { env: { ...process.env, HOME: homeDir }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

describe("collector downloads", () => {
  test("serves each platform's executable uncompressed, with checksums", async () => {
    const res = await app.request("/downloads/collector/darwin-arm64");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("retrospecticus-collector-darwin-arm64");
    expect(await res.text()).toBe("binary for darwin-arm64\n");
    const sums = await (await app.request("/downloads/SHA256SUMS")).text();
    expect(sums).toContain("retrospecticus-collector-linux-arm64");
  });

  test("refuses unknown platforms", async () => {
    expect((await app.request("/downloads/collector/windows-x64")).status).toBe(404);
    expect((await app.request("/downloads/collector/..%2F..%2Fetc")).status).toBe(404);
  });

  test("install.sh fetches, verifies and installs the binary, then starts enrollment", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const script = await (await fetch(`${origin}/install.sh`)).text();
      expect(script).toContain(`server='${origin}'`);
      const scriptFile = join(home, "install.sh");
      writeFileSync(scriptFile, script);
      // No terminal here, so the script prints the enroll command instead of running it.
      const run = await sh(scriptFile, home);
      const output = run.stdout;
      expect(run.exitCode).toBe(0);
      const installed = join(home, ".local/bin/retrospecticus-collector");
      expect(readFileSync(installed, "utf8")).toBe(fakeBinary);
      expect(statSync(installed).mode & 0o777).toBe(0o755);
      expect(output).toContain(`enroll --server ${origin}`);
    } finally {
      server.stop(true);
    }
  });

  test("install.sh on an already enrolled machine updates and restarts without enrolling", async () => {
    const enrolledHome = mkdtempSync(join(tmpdir(), "retrospecticus-install-enrolled-"));
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      writeFileSync(join(enrolledHome, "enrolled"), "");
      writeFileSync(join(enrolledHome, "install.sh"), await (await fetch(`${origin}/install.sh`)).text());
      const run = await sh(join(enrolledHome, "install.sh"), enrolledHome);
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain("already enrolled");
      expect(run.stdout).not.toContain("enroll --server");
      expect(readFileSync(join(enrolledHome, "invoked"), "utf8").trim().split("\n")).toEqual([
        `fake collector: status --enrolled-with ${origin}`,
        "fake collector: update --restart-only",
      ]);
      expect(readFileSync(join(enrolledHome, ".local/bin/retrospecticus-collector"), "utf8")).toBe(fakeBinary);
    } finally {
      server.stop(true);
      rmSync(enrolledHome, { recursive: true, force: true });
    }
  });

  test("install.sh enrolls when the machine is not enrolled with this server", async () => {
    const freshHome = mkdtempSync(join(tmpdir(), "retrospecticus-install-fresh-"));
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      writeFileSync(join(freshHome, "install.sh"), await (await fetch(`${origin}/install.sh`)).text());
      const run = await sh(join(freshHome, "install.sh"), freshHome);
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain(`enroll --server ${origin}`);
      expect(readFileSync(join(freshHome, "invoked"), "utf8")).not.toContain("update");
    } finally {
      server.stop(true);
      rmSync(freshHome, { recursive: true, force: true });
    }
  });

  test("install.sh enrolls as before when the collector is too old to know the enrolled check", async () => {
    const legacyHome = mkdtempSync(join(tmpdir(), "retrospecticus-install-legacy-"));
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      writeFileSync(join(legacyHome, "status-code"), "2");
      writeFileSync(join(legacyHome, "install.sh"), await (await fetch(`${origin}/install.sh`)).text());
      const run = await sh(join(legacyHome, "install.sh"), legacyHome);
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain(`enroll --server ${origin}`);
      expect(readdirSync(join(legacyHome, ".local/bin"))).toEqual(["retrospecticus-collector"]);
    } finally {
      server.stop(true);
      rmSync(legacyHome, { recursive: true, force: true });
    }
  });

  test("install.sh stops instead of enrolling again when it cannot tell whether the machine is enrolled", async () => {
    const unsureHome = mkdtempSync(join(tmpdir(), "retrospecticus-install-unsure-"));
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      writeFileSync(join(unsureHome, "status-code"), "3");
      writeFileSync(join(unsureHome, "install.sh"), await (await fetch(`${origin}/install.sh`)).text());
      const run = await sh(join(unsureHome, "install.sh"), unsureHome);
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("Could not check whether this machine is already enrolled");
      expect(readFileSync(join(unsureHome, "invoked"), "utf8").trim().split("\n")).toEqual([`fake collector: status --enrolled-with ${origin}`]);
    } finally {
      server.stop(true);
      rmSync(unsureHome, { recursive: true, force: true });
    }
  });

  test("install.sh refuses a binary whose checksum does not match", async () => {
    const tampered = mkdtempSync(join(tmpdir(), "retrospecticus-downloads-bad-"));
    try {
      writeFileSync(join(tampered, `retrospecticus-collector-${NATIVE}.gz`), gzipSync(Buffer.from("evil")));
      writeFileSync(join(tampered, "SHA256SUMS"), readFileSync(join(dir, "SHA256SUMS")));
      const bad = new Hono<AppEnv>();
      registerDownloadRoutes(bad, { config: staticConfig(defaultConfig()), dir: tampered });
      const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: bad.fetch });
      const badHome = mkdtempSync(join(tmpdir(), "retrospecticus-install-bad-"));
      try {
        const script = await (await fetch(`http://127.0.0.1:${server.port}/install.sh`)).text();
        writeFileSync(join(badHome, "install.sh"), script);
        const run = await sh(join(badHome, "install.sh"), badHome);
        expect(run.exitCode).toBe(1);
        expect(run.stderr).toContain("Checksum mismatch");
        expect(Bun.file(join(badHome, ".local/bin/retrospecticus-collector")).size).toBe(0);
      } finally {
        server.stop(true);
        rmSync(badHome, { recursive: true, force: true });
      }
    } finally {
      rmSync(tampered, { recursive: true, force: true });
    }
  });
});

describe("collector downloads from a GitHub release", () => {
  const TOKEN = "ghp_test";
  const binaries: Record<string, Buffer> = {};
  let sumsText = "";
  let github: ReturnType<typeof Bun.serve>;
  let hits: { path: string; auth: string | null }[];
  let tamperStorage = false;
  let cache: string;

  beforeAll(() => {
    const sums: string[] = [];
    for (const platform of ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"]) {
      const name = `retrospecticus-collector-${platform}`;
      binaries[name] = Buffer.from(`release binary for ${platform}\n`);
      sums.push(`${createHash("sha256").update(binaries[name]!).digest("hex")}  ${name}`);
    }
    sumsText = `${sums.join("\n")}\n`;
    const names = [...Object.keys(binaries), "SHA256SUMS"];
    // Models a private repository: metadata and assets need the token; storage refuses any Authorization header.
    github = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        const auth = req.headers.get("authorization");
        hits.push({ path: url.pathname, auth });
        const origin = url.origin;
        if (url.pathname === "/repos/acme/retro/releases/tags/v9.9.9") {
          if (auth !== `Bearer ${TOKEN}`) return new Response("Not Found", { status: 404 });
          return Response.json({ assets: names.map((name, i) => ({ name, url: `${origin}/assets/${i}` })) });
        }
        const asset = /^\/assets\/(\d+)$/.exec(url.pathname);
        if (asset) {
          if (auth !== `Bearer ${TOKEN}` || req.headers.get("accept") !== "application/octet-stream") return new Response("no", { status: 404 });
          return new Response(null, { status: 302, headers: { location: `${origin}/storage/${names[Number(asset[1])]}` } });
        }
        const stored = /^\/storage\/(.+)$/.exec(url.pathname);
        if (stored) {
          if (auth) return new Response("Only one auth mechanism allowed", { status: 400 });
          const name = stored[1]!;
          if (name === "SHA256SUMS") return new Response(sumsText);
          return new Response(tamperStorage ? Buffer.from("tampered") : binaries[name]);
        }
        return new Response("Not Found", { status: 404 });
      },
    });
  });
  afterAll(() => github.stop(true));
  beforeEach(() => {
    hits = [];
    tamperStorage = false;
    cache = mkdtempSync(join(tmpdir(), "retrospecticus-dl-cache-"));
  });
  afterEach(() => rmSync(cache, { recursive: true, force: true }));

  function appWith(secrets: Record<string, string>) {
    const config = defaultConfig({ downloads: { github_repo: "acme/retro" } });
    const a = new Hono<AppEnv>();
    registerDownloadRoutes(a, {
      config: staticConfig(config, secrets),
      cacheDir: cache,
      githubApi: `http://127.0.0.1:${github.port}`,
      version: "9.9.9",
    });
    return a;
  }

  test("a private repository without a token gets a 404 that names the missing secret", async () => {
    const res = await appWith({}).request("/downloads/collector/linux-x64");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("github_token");
  });

  test("forwards the verified binary, follows the storage redirect without the token, and caches it", async () => {
    const a = appWith({ github_token: TOKEN });
    const res = await a.request("/downloads/collector/darwin-arm64");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("release binary for darwin-arm64\n");
    expect(hits.filter((h) => h.path.startsWith("/storage/")).every((h) => h.auth === null)).toBe(true);

    hits = [];
    expect(await (await a.request("/downloads/collector/darwin-arm64")).text()).toBe("release binary for darwin-arm64\n");
    expect(hits.some((h) => h.path === "/storage/retrospecticus-collector-darwin-arm64")).toBe(false);
    expect(await (await a.request("/downloads/SHA256SUMS")).text()).toBe(sumsText);
  });

  test("refuses a binary that does not match the release checksums", async () => {
    tamperStorage = true;
    const res = await appWith({ github_token: TOKEN }).request("/downloads/collector/linux-arm64");
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("does not match");
    expect(existsSync(join(cache, "v9.9.9", "retrospecticus-collector-linux-arm64"))).toBe(false);
  });
});
