#!/usr/bin/env bun
/**
 * Builds release executables. Each carries the Bun runtime, so the target
 * machine needs nothing installed.
 *
 *   bun scripts/build.ts [--out dist] [--collectors <platform,...>|none] [--server <platform>|native|none] [--gzip]
 *
 * Writes:
 *   <out>/collectors/retrospecticus-collector-<platform>[.gz] and SHA256SUMS
 *   <out>/server/retrospecticus and vec0.so (sqlite-vec, loaded from beside the executable)
 *
 * The server needs sqlite-vec's library for its platform, which bun install only
 * fetches for the machine it runs on, so the server is built for the native
 * platform unless that package is present for another.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { COLLECTOR_VERSION } from "../packages/collector/src/heartbeat.ts";

const ROOT = resolve(import.meta.dir, "..");
export const COLLECTOR_PLATFORMS = ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"] as const;
const SERVER_PLATFORMS = ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"] as const;
const NATIVE = `${process.platform}-${process.arch}`;

const argv = process.argv.slice(2);
const opt = (flag: string, fallback: string): string => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1]!;
};
const outDir = resolve(ROOT, opt("--out", "dist"));
const gzip = argv.includes("--gzip");
const collectorArg = opt("--collectors", COLLECTOR_PLATFORMS.join(","));
const collectors = collectorArg === "none" ? [] : collectorArg.split(",");
const serverArg = opt("--server", "native");
const server = serverArg === "none" ? null : serverArg === "native" ? NATIVE : serverArg;

for (const p of collectors) if (!(COLLECTOR_PLATFORMS as readonly string[]).includes(p)) fail(`Unknown collector platform ${p}`);
if (server && !(SERVER_PLATFORMS as readonly string[]).includes(server)) fail(`Unknown server platform ${server}`);

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function compile(entry: string, platform: string, outfile: string): void {
  const build = Bun.spawnSync(
    ["bun", "build", "--compile", `--target=bun-${platform}`, "--minify", entry, "--outfile", outfile],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (build.exitCode !== 0) fail(`${platform}: build failed\n${build.stderr.toString()}`);
}

function sqliteVecLibrary(platform: string): string {
  const file = platform.startsWith("darwin") ? "vec0.dylib" : "vec0.so";
  const store = join(ROOT, "node_modules/.bun");
  const candidates = [
    join(ROOT, "node_modules", `sqlite-vec-${platform}`, file),
    ...(existsSync(store)
      ? readdirSync(store)
          .filter((d) => d.startsWith(`sqlite-vec-${platform}@`))
          .map((d) => join(store, d, "node_modules", `sqlite-vec-${platform}`, file))
      : []),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) fail(`No sqlite-vec library for ${platform}; build the server on that platform (or in Docker)`);
  return found;
}

const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(0)} MB`;

if (collectors.length > 0) {
  const dir = join(outDir, "collectors");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  console.log(`Collector ${COLLECTOR_VERSION} -> ${dir}`);
  const sums: string[] = [];
  for (const platform of collectors) {
    const name = `retrospecticus-collector-${platform}`;
    const outfile = join(dir, name);
    compile("packages/collector/src/main.ts", platform, outfile);
    const bytes = readFileSync(outfile);
    // The checksum is of the executable itself, whichever form it is shipped in.
    sums.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
    if (gzip) {
      const packed = gzipSync(bytes, { level: 9 });
      writeFileSync(`${outfile}.gz`, packed);
      rmSync(outfile);
      console.log(`  ${platform.padEnd(13)} ${mb(bytes.length)} (${mb(packed.length)} gzipped)`);
    } else {
      console.log(`  ${platform.padEnd(13)} ${mb(bytes.length)}`);
    }
  }
  writeFileSync(join(dir, "SHA256SUMS"), `${sums.join("\n")}\n`);
}

if (server) {
  const dir = join(outDir, "server");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const library = sqliteVecLibrary(server);
  compile("packages/cli/src/main.ts", server, join(dir, "retrospecticus"));
  copyFileSync(library, join(dir, library.endsWith(".dylib") ? "vec0.dylib" : "vec0.so"));
  console.log(`Server ${server} -> ${dir} (${mb(readFileSync(join(dir, "retrospecticus")).length)})`);
}
