import { constants } from "node:fs";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

export const STATE_VERSION = 1;

const FileStateSchema = z.object({
  // A string because inodes are 64-bit and JSON numbers are not.
  inode: z.string(),
  generation: z.number().int().nonnegative(),
  bytes_sent: z.number().int().nonnegative(),
});
export type FileState = z.infer<typeof FileStateSchema>;

const StateFileSchema = z.object({
  version: z.literal(STATE_VERSION),
  files: z.record(z.string(), FileStateSchema),
});

export function stateKey(source: string, relPath: string): string {
  return `${source}\u0000${relPath}`;
}

export interface StateLoad {
  store: StateStore;
  /** Set when a state file existed but could not be used; the collector then starts as if it had none. */
  problem?: string;
}

export class StateStore {
  private files = new Map<string, FileState>();
  private dirty = false;

  private constructor(readonly path: string) {}

  /**
   * An unreadable or foreign state file is not fatal: the server answers a
   * wrong offset with 409 and the true size, so starting empty costs one
   * refused request per file and can never duplicate bytes.
   */
  static async load(path: string): Promise<StateLoad> {
    const store = new StateStore(path);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { store };
      return { store, problem: `cannot read ${path}: ${(err as Error).message}` };
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { store, problem: `${path} is not JSON` };
    }
    const parsed = StateFileSchema.safeParse(json);
    if (!parsed.success) return { store, problem: `${path} is not a version ${STATE_VERSION} state file` };
    store.files = new Map(Object.entries(parsed.data.files));
    return { store };
  }

  get(key: string): FileState | undefined {
    return this.files.get(key);
  }

  set(key: string, value: FileState): void {
    this.files.set(key, value);
    this.dirty = true;
  }

  get size(): number {
    return this.files.size;
  }

  /** Atomic: readers see the old file or the new one, never a torn write. */
  async save(): Promise<void> {
    if (!this.dirty) return;
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const body = JSON.stringify({ version: STATE_VERSION, files: Object.fromEntries(this.files) });
    const tmp = `${this.path}.tmp-${process.pid}`;
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, this.path);
    this.dirty = false;
    try {
      const dirHandle = await open(dir, constants.O_RDONLY);
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      // Not every filesystem lets a directory be fsynced; the rename itself has still happened.
    }
  }
}
