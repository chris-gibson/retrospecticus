import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { SourceConfig } from "./config.ts";
import { stateKey, type FileState, type StateStore } from "./state.ts";
import type { Uploader } from "./uploader.ts";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface SourceFile {
  source: SourceConfig;
  /** Relative to the source root, forward slashes. */
  relPath: string;
  absPath: string;
  key: string;
  size: number;
  /** Changes whenever the file is replaced, resized or rewritten, so an unchanged file need not be reopened. */
  signature: string;
}

function errorCode(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? "";
}

/** Lists the regular files a source matches. A missing root yields nothing. */
export async function listSourceFiles(source: SourceConfig): Promise<SourceFile[]> {
  try {
    if (!(await lstat(source.root)).isDirectory()) return [];
  } catch (err) {
    if (errorCode(err) === "ENOENT" || errorCode(err) === "ENOTDIR") return [];
    throw err;
  }

  const files: SourceFile[] = [];
  const glob = new Bun.Glob(source.glob);
  for await (const match of glob.scan({ cwd: source.root, onlyFiles: true, dot: true, followSymlinks: false })) {
    const absPath = join(source.root, match);
    let stats;
    try {
      stats = await lstat(absPath, { bigint: true });
    } catch {
      // Gone between the listing and the stat; the next scan sees whatever replaced it.
      continue;
    }
    // A symlink could point anywhere on the machine; only real files under the root are session data.
    if (!stats.isFile()) continue;
    files.push({
      source,
      relPath: match,
      absPath,
      key: stateKey(source.name, match),
      size: Number(stats.size),
      signature: `${stats.ino}:${stats.size}:${stats.mtimeNs}`,
    });
  }
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return files;
}

const TAIL_BLOCK_BYTES = 64 * 1024;

async function readExactly(handle: FileHandle, position: number, length: number): Promise<Buffer | null> {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) return null;
    filled += bytesRead;
  }
  return buffer;
}

/**
 * The offset just past the last newline in `[from, size)`, or `from` when
 * there is none. Reads backwards so a long settled prefix is never touched.
 */
export async function findEligibleEnd(handle: FileHandle, from: number, size: number): Promise<number> {
  let end = size;
  while (end > from) {
    const start = Math.max(from, end - TAIL_BLOCK_BYTES);
    const block = await readExactly(handle, start, end - start);
    if (block === null) return from;
    const newline = block.lastIndexOf(0x0a);
    if (newline !== -1) return start + newline + 1;
    end = start;
  }
  return from;
}

/**
 * Where to resume after the server refused an offset. `held` is the newest
 * generation the server has and its size.
 */
export function resumePoint(
  current: FileState,
  held: { size: number; generation: number },
  localSize: number,
): FileState {
  const { inode } = current;
  if (held.generation === current.generation) {
    // If this is past the end of the local file, the next look at the file sees a truncation and moves on a generation.
    return { inode, generation: held.generation, bytes_sent: held.size };
  }
  if (held.generation > current.generation) {
    // The server is ahead of what we remember. Its newest generation can only be a prefix of this file if the file is at least as long.
    if (localSize >= held.size) return { inode, generation: held.generation, bytes_sent: held.size };
    return { inode, generation: held.generation + 1, bytes_sent: 0 };
  }
  // The server never saw our generation. An empty newest generation can be continued; a non-empty one must be left intact.
  if (held.size === 0) return { inode, generation: held.generation, bytes_sent: 0 };
  return { inode, generation: held.generation + 1, bytes_sent: 0 };
}

export type SyncStatus =
  /** Everything up to the last newline is on the server. */
  | "settled"
  /** This file cannot be uploaded as it is; leave it until it changes. */
  | "skipped"
  /** The server could not be reached or is refusing everything. */
  | "unavailable"
  /** The file moved under us; look again on the next scan. */
  | "retry";

export interface SyncResult {
  status: SyncStatus;
  uploadedBytes: number;
  requests: number;
  reason?: string;
}

export interface SyncContext {
  state: StateStore;
  uploader: Uploader;
  maxBodyBytes: number;
  stop: AbortSignal;
  log: Logger;
}

const MAX_CONFLICTS_PER_PASS = 4;

/** Brings one file's server copy up to its last newline. Opens the file read-only and never writes to it. */
export async function syncFile(ctx: SyncContext, file: SourceFile): Promise<SyncResult> {
  const result: SyncResult = { status: "settled", uploadedBytes: 0, requests: 0 };
  const finish = (status: SyncStatus, reason?: string): SyncResult => ({ ...result, status, reason });
  const label = `${file.source.name}/${file.relPath}`;

  let handle: FileHandle;
  try {
    handle = await open(file.absPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return finish("retry", "file disappeared");
    return finish("skipped", `cannot open: ${(err as Error).message}`);
  }

  try {
    let conflicts = 0;
    for (;;) {
      if (ctx.stop.aborted) return finish("unavailable", "stopping");

      // Stat through the handle so the inode and the bytes read below belong to the same file even if the path is replaced meanwhile.
      const stats = await handle.stat({ bigint: true });
      if (!stats.isFile()) return finish("skipped", "not a regular file");
      const inode = stats.ino.toString();
      const size = Number(stats.size);

      let entry = ctx.state.get(file.key);
      if (entry && (entry.inode !== inode || size < entry.bytes_sent)) {
        // A generation the server has seen nothing of can be reused; otherwise each rewrite while offline would skip a number the server insists on.
        const generation = entry.bytes_sent > 0 ? entry.generation + 1 : entry.generation;
        entry = { inode, generation, bytes_sent: 0 };
        ctx.state.set(file.key, entry);
        await ctx.state.save();
        ctx.log.info(`${label}: replaced or truncated, continuing as generation ${generation}`);
      }
      // Nothing is recorded for a file until the server has answered for it, so "no state" keeps meaning "the server's view is unknown".
      const current: FileState = entry ?? { inode, generation: 0, bytes_sent: 0 };

      const end = await findEligibleEnd(handle, current.bytes_sent, size);
      if (end <= current.bytes_sent) return finish("settled");

      const length = Math.min(ctx.maxBodyBytes, end - current.bytes_sent);
      const body = await readExactly(handle, current.bytes_sent, length);
      if (body === null || Number((await handle.stat({ bigint: true })).size) < current.bytes_sent + length) {
        return finish("retry", "file shrank while being read");
      }

      result.requests++;
      const outcome = await ctx.uploader.append(
        { source: file.source.name, path: file.relPath, generation: current.generation, offset: current.bytes_sent, body },
        ctx.stop,
      );

      switch (outcome.kind) {
        case "accepted":
          ctx.state.set(file.key, { inode, generation: current.generation, bytes_sent: outcome.size });
          await ctx.state.save();
          result.uploadedBytes += length;
          break;
        case "conflict": {
          const resumed = resumePoint(current, outcome, size);
          ctx.state.set(file.key, resumed);
          await ctx.state.save();
          ctx.log.info(
            `${label}: server holds ${outcome.size} bytes of generation ${outcome.generation}; resuming at generation ${resumed.generation} offset ${resumed.bytes_sent}`,
          );
          if (++conflicts > MAX_CONFLICTS_PER_PASS) return finish("retry", "server kept refusing the offset");
          break;
        }
        case "rejected":
          return finish("skipped", `server refused it (HTTP ${outcome.status}): ${outcome.message}`);
        case "unavailable":
          return finish("unavailable", outcome.reason);
      }
    }
  } finally {
    await handle.close();
  }
}
