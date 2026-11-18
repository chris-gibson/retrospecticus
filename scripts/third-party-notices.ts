/**
 * Writes THIRD_PARTY_NOTICES.md: the licenses of everything the release
 * executables and the container image carry besides this project's own code.
 * The npm part is read from the installed packages, so it follows the lockfile;
 * the Bun runtime part restates Bun's own license page for the pinned version.
 *
 *   bun scripts/third-party-notices.ts [--check]
 *
 * --check exits non-zero when the committed file is out of date.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "THIRD_PARTY_NOTICES.md");
const BUN_VERSION = "1.4.3";
const WORKSPACES = ["shared", "server", "cli", "collector"].map((p) => join(ROOT, "packages", p));
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;

interface Pkg {
  name: string;
  version: string;
  license: string;
  dir: string;
}

function packageDir(name: string, from: string): string {
  let dir = from;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`cannot find ${name} from ${from}`);
    dir = parent;
  }
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

function licenseOf(meta: Record<string, any>): string {
  if (typeof meta.license === "string") return meta.license;
  if (meta.license?.type) return meta.license.type;
  if (Array.isArray(meta.licenses)) return meta.licenses.map((l: any) => l.type ?? l).join(" OR ");
  return "UNKNOWN";
}

/** Production dependencies of the workspaces, followed transitively; optional ones only when installed. */
function collect(): Pkg[] {
  const found = new Map<string, Pkg>();
  const visit = (dir: string, deps: Record<string, string>, optional: Record<string, string>): void => {
    for (const name of [...Object.keys(deps), ...Object.keys(optional)]) {
      if (deps[name]?.startsWith("workspace:")) continue;
      let pkgDir: string;
      try {
        pkgDir = packageDir(name, dir);
      } catch (err) {
        if (name in optional) continue;
        throw err;
      }
      const meta = readJson(join(pkgDir, "package.json"));
      // Which per-CPU sqlite-vec package is installed depends on the machine; the sqlite-vec entry covers them all.
      if (/^sqlite-vec-/.test(meta.name)) continue;
      const key = `${meta.name}@${meta.version}`;
      if (found.has(key)) continue;
      found.set(key, { name: meta.name, version: meta.version, license: licenseOf(meta), dir: pkgDir });
      visit(pkgDir, meta.dependencies ?? {}, meta.optionalDependencies ?? {});
    }
  };
  for (const ws of WORKSPACES) {
    const meta = readJson(join(ws, "package.json"));
    visit(ws, meta.dependencies ?? {}, meta.optionalDependencies ?? {});
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** sqlite-vec's npm packages ship without license files; this is LICENSE-MIT from its v0.1.9 source (it is MIT OR Apache-2.0). */
const SQLITE_VEC_MIT = `MIT License

Copyright (c) 2024 Alex Garcia

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

function licenseTexts(pkg: Pkg): string[] {
  const texts = readdirSync(pkg.dir)
    .filter((f) => LICENSE_FILE.test(f))
    .sort()
    .map((f) => readFileSync(join(pkg.dir, f), "utf8").trim());
  if (texts.length === 0 && pkg.name.startsWith("sqlite-vec")) {
    return [`${SQLITE_VEC_MIT}\n\n(Licensed MIT OR Apache-2.0; Apache-2.0 text: https://github.com/asg017/sqlite-vec/blob/v0.1.9/LICENSE-APACHE)`];
  }
  return texts;
}

const BUN_SECTION = `## Bun runtime (in every executable and the container image)

The server and collector executables are built with \`bun build --compile\`, which embeds the Bun ${BUN_VERSION} runtime. Bun itself is MIT-licensed (https://github.com/oven-sh/bun/blob/bun-v${BUN_VERSION}/LICENSE.md). Bun's license page, https://bun.com/docs/project/license, lists everything the runtime links or embeds; in summary:

- **JavaScriptCore and WebCore (WebKit), LGPL-2**, statically linked. The source of the WebKit version Bun ${BUN_VERSION} uses is Bun's fork at https://github.com/oven-sh/WebKit, at the commit pinned by \`WEBKIT_VERSION\` in \`scripts/build/deps/webkit.ts\` of the \`bun-v${BUN_VERSION}\` tag of https://github.com/oven-sh/bun.
- **tinycc, LGPL-2.1**, statically linked (source: https://repo.or.cz/tinycc.git).
- boringssl (several licenses), lol-html (BSD-3-Clause), ls-qpack (MIT; bundled xxhash BSD-2-Clause), lsquic (MIT; portions BSD-3-Clause), mimalloc (MIT), zstd (BSD or GPLv2), simdutf (Apache-2.0), uSockets and a fork of uWebSockets (Apache-2.0), zlib-ng (zlib), c-ares (MIT), ICU 78 (ICU license), libbase64 (BSD-2-Clause), highway (Apache-2.0), parts of HdrHistogram_c (CC0-1.0 or BSD-2-Clause), parts of TigerBeetle's IO code (Apache-2.0), and SQLite (public domain), all statically linked.
- Code derived from brotli, libarchive, llhttp, ls-hpack, picohttpparser, libdeflate, libjpeg-turbo, libspng (and libpng), stb_image and libwebp, under their licenses as listed on that page; the transpiler and resolver are a port of esbuild (MIT) and the CSS parser derives from Lightning CSS and Servo.
- Node.js polyfills embedded in the runtime (all MIT): acorn, acorn-walk, assert, browserify-zlib, buffer, constants-browserify, crypto-browserify, domain-browser, events, https-browserify, os-browserify, path-browserify, process, punycode, querystring-es3, stream-browserify, stream-http, string_decoder, timers-browserify, tty-browserify, url, util, vm-browserify.

**Replacing the LGPL components.** This project's complete source is available under the MIT license at https://github.com/chris-gibson/retrospecticus, at the tag matching each release. To run the executables against a modified JavaScriptCore or tinycc, build Bun ${BUN_VERSION} from source with the modified library (Bun's license page gives the steps), then rebuild the executables with that Bun: \`bun install\` and \`bun scripts/build.ts\`.

## Other files in the container image

- \`/usr/local/lib/retrospecticus/vec0.so\` is sqlite-vec, listed with the npm packages below. Its per-platform packages (\`sqlite-vec-linux-x64\`, \`sqlite-vec-linux-arm64\` and so on) carry the same code and license; they are covered by the sqlite-vec entry.
- \`/etc/ssl/certs/ca-certificates.crt\` is the Mozilla CA certificate bundle as packaged by Debian's \`ca-certificates\`, under the Mozilla Public License 2.0 (source: https://salsa.debian.org/debian/ca-certificates and https://hg.mozilla.org/projects/nss).
- The base image is \`debian:bookworm-slim\`; the license of each Debian package in it is in \`/usr/share/doc/<package>/copyright\` inside the image.
`;

function render(pkgs: Pkg[]): string {
  const rows = pkgs.map((p) => `| ${p.name} | ${p.version} | ${p.license} |`).join("\n");
  const texts = pkgs
    .map((p) => {
      const texts = licenseTexts(p);
      const body = texts.length > 0 ? texts.map((t) => "```\n" + t.replace(/```/g, "'''") + "\n```").join("\n\n") : `No license file is shipped in the package; its package.json declares ${p.license}.`;
      return `### ${p.name} ${p.version}\n\n${body}`;
    })
    .join("\n\n");
  return `# Third-party notices

Retrospecticus is MIT-licensed (see LICENSE). Its release executables and container image also contain the third-party software below. This file is generated by \`bun scripts/third-party-notices.ts\`; do not edit it by hand.

${BUN_SECTION}
## npm packages compiled into the executables

| Package | Version | License |
|---|---|---|
${rows}

${texts}
`;
}

const text = render(collect());
if (process.argv.includes("--check")) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== text) {
    console.error("THIRD_PARTY_NOTICES.md is out of date; run bun scripts/third-party-notices.ts");
    process.exit(1);
  }
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}
