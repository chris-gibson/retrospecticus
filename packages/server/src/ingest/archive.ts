import { constants, statSync } from "node:fs";
import { mkdir, open, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Source } from "@retrospecticus/shared";
import {
  getLatestGeneration,
  listFiles,
  rawRelativePath,
  upsertFileSize,
  type FileKey,
  type FileRow,
} from "../db/files.ts";
import type { Db } from "../db/index.ts";
import { recordIngest } from "../db/machines.ts";

export const MAX_INGEST_PATH_BYTES = 1024;

export class ArchivePathError extends Error {
  override name = "ArchivePathError";
}

/**
 * Returns the path as it will be stored, or throws ArchivePathError. Nothing is
 * rewritten: a path that is not already in canonical form is refused, so two
 * spellings can never name the same archived file.
 */
export function normalizeIngestPath(raw: string): string {
  if (raw.length === 0) throw new ArchivePathError("path is empty");
  if (Buffer.byteLength(raw, "utf8") > MAX_INGEST_PATH_BYTES) throw new ArchivePathError("path is too long");
  if (raw.includes("\0")) throw new ArchivePathError("path contains a NUL byte");
  if (raw.includes("\\")) throw new ArchivePathError("path must use forward slashes");
  if (raw.startsWith("/")) throw new ArchivePathError("path must be relative");
  const segments = raw.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new ArchivePathError("path has an empty, '.' or '..' segment");
    }
  }
  // Generation N of `x` is stored as `x.gN`, so a path ending that way could alias another file's generation.
  if (/\.g\d+$/.test(segments[segments.length - 1]!)) {
    throw new ArchivePathError("path ends in a reserved generation suffix");
  }
  return raw;
}

type FileLocation = Pick<FileRow, "machine" | "source" | "path" | "generation">;

function sourceRoot(rawDir: string, file: Pick<FileRow, "machine" | "source">): string {
  const root = resolve(rawDir, file.machine, file.source);
  // A machine or source that is not a single plain segment would move the root itself.
  if (root !== [resolve(rawDir), file.machine, file.source].join(sep)) {
    throw new ArchivePathError("machine or source escapes the archive");
  }
  return root;
}

export function archiveTarget(rawDir: string, file: FileLocation): string {
  const root = sourceRoot(rawDir, file);
  const target = resolve(rawDir, rawRelativePath(file));
  if (!target.startsWith(root + sep)) throw new ArchivePathError("path escapes the archive");
  return target;
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

export async function archivedSize(target: string): Promise<number> {
  try {
    return (await stat(target)).size;
  } catch (err) {
    if (isMissing(err)) return 0;
    throw err;
  }
}

async function fsyncDir(dir: string): Promise<void> {
  const handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Appends and fsyncs, returning the size on disk afterwards. */
async function appendBytes(rawDir: string, file: FileLocation, bytes: Uint8Array): Promise<number> {
  const target = archiveTarget(rawDir, file);
  const parent = dirname(target);
  const root = sourceRoot(rawDir, file);
  await mkdir(parent, { recursive: true });
  // The lexical check in archiveTarget cannot see a symlink planted inside the archive.
  const [realRoot, realParent] = await Promise.all([realpath(root), realpath(parent)]);
  if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) {
    throw new ArchivePathError("path escapes the archive");
  }
  const existed = (await archivedSize(target)) > 0;
  const handle = await open(
    target,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o640,
  );
  try {
    if (bytes.byteLength > 0) await handle.writeFile(bytes);
    await handle.sync();
    const size = (await handle.stat()).size;
    if (!existed) await fsyncDir(parent);
    return size;
  } finally {
    await handle.close();
  }
}

const pathLocks = new Map<string, Promise<unknown>>();

async function withPathLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = pathLocks.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.catch(() => undefined);
  pathLocks.set(key, settled);
  try {
    return await run;
  } finally {
    if (pathLocks.get(key) === settled) pathLocks.delete(key);
  }
}

export interface ArchiveAppend {
  machine: string;
  source: Source;
  /** Already passed through normalizeIngestPath. */
  path: string;
  generation: number;
  offset: number;
  body: Uint8Array;
}

export interface ArchiveAppendResult {
  /** False means nothing was written and the caller should resume from `size` in `generation`. */
  accepted: boolean;
  size: number;
  generation: number;
}

/**
 * Applies the generation rule and appends. The size on disk decides, never
 * `files.size`: a crash between the write and the row update leaves a stale
 * row, and trusting it would duplicate the bytes on the collector's retry.
 */
export async function appendToArchive(db: Db, rawDir: string, req: ArchiveAppend): Promise<ArchiveAppendResult> {
  const key: FileKey = { machine: req.machine, source: req.source, path: req.path };
  const lockKey = [resolve(rawDir), key.machine, key.source, key.path].join("\0");

  return withPathLock(lockKey, async () => {
    const latest = getLatestGeneration(db, key);
    const held = { size: 0, generation: 0 };
    if (latest) {
      held.generation = latest.generation;
      held.size = await archivedSize(archiveTarget(rawDir, latest));
      if (held.size !== latest.size) upsertFileSize(db, key, latest.generation, held.size);
    }
    const refused: ArchiveAppendResult = { accepted: false, ...held };

    const continuesLatest = latest !== null && req.generation === latest.generation;
    const startsNext = req.generation === (latest ? latest.generation + 1 : 0);

    if (continuesLatest) {
      if (req.offset !== held.size) return refused;
    } else if (startsNext) {
      // Bytes with no row: the row was lost after an earlier upload of this generation. Adopt them rather than append a second copy.
      const orphaned = await archivedSize(archiveTarget(rawDir, { ...key, generation: req.generation }));
      if (orphaned > 0) {
        upsertFileSize(db, key, req.generation, orphaned);
        return { accepted: false, size: orphaned, generation: req.generation };
      }
      if (req.offset !== 0) return refused;
    } else {
      return refused;
    }

    const size = await appendBytes(rawDir, { ...key, generation: req.generation }, req.body);
    upsertFileSize(db, key, req.generation, size);
    recordIngest(db, req.machine);
    return { accepted: true, size, generation: req.generation };
  });
}

export interface ReconciledFile {
  file: FileRow;
  diskSize: number;
}

/**
 * Makes `files.size` agree with the archive. Run at start-up, before the
 * indexer, so it never reads past bytes that are really there.
 */
export function reconcileArchive(db: Db, rawDir: string): ReconciledFile[] {
  const changed: ReconciledFile[] = [];
  for (const file of listFiles(db)) {
    let diskSize = 0;
    try {
      diskSize = statSync(join(rawDir, rawRelativePath(file))).size;
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
    if (diskSize === file.size) continue;
    upsertFileSize(db, file, file.generation, diskSize);
    changed.push({ file, diskSize });
  }
  return changed;
}
