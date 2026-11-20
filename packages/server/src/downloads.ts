import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { VERSION } from "@retrospecticus/shared";
import type { AppEnv } from "./auth.ts";
import type { ConfigView } from "./config-store.ts";

/**
 * Collector executables for new machines, plus a script that fetches the right
 * one and starts enrollment. Public on purpose: the binaries hold nothing
 * secret, and a machine only gets a token once an admin approves it.
 *
 * The executables come from the GitHub release matching this server's
 * version, checked against that release's SHA256SUMS before they are cached
 * or handed on. A local directory (a development build) takes precedence.
 */
export const DOWNLOADS_DIR_ENV_VAR = "RETROSPECTICUS_DOWNLOADS_DIR";
export const CACHE_DIR_ENV_VAR = "RETROSPECTICUS_CACHE_DIR";
export const COLLECTOR_DOWNLOAD_PLATFORMS = ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"] as const;
const SUMS = "SHA256SUMS";
const GITHUB_TIMEOUT_MS = 120_000;

export interface DownloadDeps {
  config: ConfigView;
  /** A local build to serve instead of GitHub; defaults to $RETROSPECTICUS_DOWNLOADS_DIR. */
  dir?: string;
  /** Where verified downloads are kept; defaults to $RETROSPECTICUS_CACHE_DIR, then the temp directory. */
  cacheDir?: string;
  /** For tests. */
  githubApi?: string;
  version?: string;
  fetch?: typeof fetch;
}

export class DownloadError extends Error {
  override name = "DownloadError";
  constructor(
    message: string,
    readonly status: 404 | 502,
  ) {
    super(message);
  }
}

export function binaryName(platform: string): string {
  return `retrospecticus-collector-${platform}`;
}

export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (match) sums.set(match[2]!, match[1]!);
  }
  return sums;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

interface Source {
  sums(): Promise<string>;
  binary(platform: string): Promise<Uint8Array>;
}

/** A development build: plain or gzipped executables beside a SHA256SUMS file. */
function localSource(dir: string): Source {
  return {
    async sums() {
      return readFileSync(join(dir, SUMS), "utf8");
    },
    async binary(platform) {
      const plain = join(dir, binaryName(platform));
      if (existsSync(`${plain}.gz`)) return Bun.gunzipSync(readFileSync(`${plain}.gz`));
      if (existsSync(plain)) return readFileSync(plain);
      throw new DownloadError(`No collector for ${platform} in ${dir}`, 404);
    },
  };
}

interface ReleaseAsset {
  name: string;
  url: string;
}

function githubSource(deps: DownloadDeps, version: string, cacheDir: string): Source {
  const doFetch = deps.fetch ?? fetch;
  const api = (deps.githubApi ?? "https://api.github.com").replace(/\/+$/, "");
  const tag = `v${version}`;
  const inFlight = new Map<string, Promise<Uint8Array>>();

  function headers(accept: string): Record<string, string> {
    const h: Record<string, string> = { Accept: accept, "User-Agent": "retrospecticus-server", "X-GitHub-Api-Version": "2022-11-28" };
    const token = deps.config.getSecret("github_token");
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  function refused(status: number, what: string): DownloadError {
    if (status === 404) {
      return new DownloadError(
        `No GitHub release ${tag} with ${what} in ${deps.config.current().downloads.github_repo}. A private fork also answers 404 without a github_token secret.`,
        404,
      );
    }
    if (status === 401 || status === 403) {
      return new DownloadError(`GitHub refused the download (${status}); check the github_token secret can read the repository`, 502);
    }
    return new DownloadError(`GitHub answered ${status} for ${what}`, 502);
  }

  async function assets(): Promise<ReleaseAsset[]> {
    const repo = deps.config.current().downloads.github_repo;
    const res = await doFetch(`${api}/repos/${repo}/releases/tags/${tag}`, {
      headers: headers("application/vnd.github+json"),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!res.ok) throw refused(res.status, "release metadata");
    const body = (await res.json()) as { assets?: { name?: unknown; url?: unknown }[] };
    return (body.assets ?? []).flatMap((a) => (typeof a.name === "string" && typeof a.url === "string" ? [{ name: a.name, url: a.url }] : []));
  }

  async function asset(name: string): Promise<Uint8Array> {
    const found = (await assets()).find((a) => a.name === name);
    if (!found) throw refused(404, name);
    // Asset downloads redirect to storage that rejects GitHub's Authorization header, so the redirect is followed without it.
    let res = await doFetch(found.url, {
      headers: headers("application/octet-stream"),
      redirect: "manual",
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      res = await doFetch(location, { signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) });
    }
    if (!res.ok) throw refused(res.status, name);
    return new Uint8Array(await res.arrayBuffer());
  }

  function cached(name: string, load: () => Promise<Uint8Array>): Promise<Uint8Array> {
    const path = join(cacheDir, tag, name);
    if (existsSync(path)) return Promise.resolve(readFileSync(path));
    // Concurrent requests for the same file share one download.
    let pending = inFlight.get(name);
    if (!pending) {
      pending = load()
        .then((bytes) => {
          mkdirSync(join(cacheDir, tag), { recursive: true });
          const temp = `${path}.${process.pid}.tmp`;
          writeFileSync(temp, bytes);
          renameSync(temp, path);
          return bytes;
        })
        .finally(() => inFlight.delete(name));
      inFlight.set(name, pending);
    }
    return pending;
  }

  return {
    // Not cached: a release's checksums are small, and refetching them means a cached binary is always rechecked.
    async sums() {
      return new TextDecoder().decode(await asset(SUMS));
    },
    async binary(platform) {
      const name = binaryName(platform);
      const expected = parseSums(await this.sums()).get(name);
      if (!expected) throw refused(404, name);
      const bytes = await cached(name, async () => {
        const fresh = await asset(name);
        if (sha256(fresh) !== expected) throw new DownloadError(`${name} from GitHub does not match the release's ${SUMS}`, 502);
        return fresh;
      });
      if (sha256(bytes) !== expected) throw new DownloadError(`Cached ${name} does not match the release's ${SUMS}`, 502);
      return bytes;
    },
  };
}

export function registerDownloadRoutes(app: Hono<AppEnv>, deps: DownloadDeps): void {
  const version = deps.version ?? VERSION;
  const dir = deps.dir ?? process.env[DOWNLOADS_DIR_ENV_VAR];
  const cacheDir = deps.cacheDir ?? process.env[CACHE_DIR_ENV_VAR] ?? join(tmpdir(), "retrospecticus-cache");
  const github = githubSource(deps, version, cacheDir);
  const pick = (): Source => (dir !== undefined && existsSync(join(dir, SUMS)) ? localSource(dir) : github);

  const fail = (err: unknown): Response => {
    const status = err instanceof DownloadError ? err.status : 502;
    const message = err instanceof DownloadError ? err.message : `Download failed: ${(err as Error).message}`;
    return new Response(`${message}\n`, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  };

  app.get(`/downloads/${SUMS}`, async (c) => {
    try {
      return c.text(await pick().sums());
    } catch (err) {
      return fail(err);
    }
  });

  app.get("/downloads/collector/:platform", async (c) => {
    const platform = c.req.param("platform");
    if (!(COLLECTOR_DOWNLOAD_PLATFORMS as readonly string[]).includes(platform)) {
      return c.text(`Unknown platform; expected one of ${COLLECTOR_DOWNLOAD_PLATFORMS.join(", ")}\n`, 404);
    }
    try {
      const bytes = await pick().binary(platform);
      return new Response(bytes, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${binaryName(platform)}"`,
          "Cache-Control": "no-cache",
        },
      });
    } catch (err) {
      return fail(err);
    }
  });

  app.get("/install.sh", (c) => {
    const origin = new URL(c.req.url).origin;
    return c.body(installScript(origin), 200, {
      "Content-Type": "text/x-shellscript; charset=utf-8",
      "Cache-Control": "no-cache",
    });
  });
}

/** POSIX sh, so it runs from `curl | sh` on Linux and macOS alike. */
export function installScript(origin: string): string {
  return `#!/bin/sh
# Installs the retrospecticus collector from ${origin} and enrolls this machine.
#   curl -fsSL ${origin}/install.sh | sh
set -eu

server=${shellQuote(origin)}
case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "Unsupported system: $(uname -s). Only Linux and macOS are supported." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "Unsupported CPU: $(uname -m)." >&2; exit 1 ;;
esac
name="retrospecticus-collector-$os-$arch"
bindir="$HOME/.local/bin"
target="$bindir/retrospecticus-collector"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

echo "Downloading $name from $server"
if ! curl -fsS "$server/downloads/collector/$os-$arch" -o "$tmp"; then
  echo "The server could not provide the collector:" >&2
  curl -sS "$server/downloads/collector/$os-$arch" >&2 || true
  exit 1
fi
expected=$(curl -fsSL "$server/downloads/SHA256SUMS" | awk -v n="$name" '$2 == n { print $1 }')
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp" | awk '{ print $1 }')
else
  actual=$(shasum -a 256 "$tmp" | awk '{ print $1 }')
fi
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "Checksum mismatch for $name; not installing." >&2
  exit 1
fi

mkdir -p "$bindir"
chmod 755 "$tmp"
mv "$tmp" "$target"
trap - EXIT
echo "Installed $target"
case ":$PATH:" in
  *":$bindir:"*) ;;
  *) echo "Note: $bindir is not on your PATH." ;;
esac

# Standard input is this script when piped from curl, so enrollment reads from the terminal instead.
# The terminal is opened by its device name where possible: on macOS the collector cannot watch
# /dev/tty itself (kqueue rejects it with EINVAL), only the device it stands for.
tty_dev=$(tty 0<&2 2>/dev/null) || tty_dev=$(tty 0<&1 2>/dev/null) || tty_dev=/dev/tty
if { true <"$tty_dev"; } 2>/dev/null; then
  if "$target" enroll --server "$server" <"$tty_dev"; then
    exit 0
  fi
  echo "Enrollment did not finish. To retry: $target enroll --server $server"
  exit 1
fi
echo "Now run: $target enroll --server $server"
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
