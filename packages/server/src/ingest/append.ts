import type { Context } from "hono";
import {
  HEADER_GENERATION,
  HEADER_MACHINE,
  HEADER_OFFSET,
  HEADER_PATH,
  HEADER_SOURCE,
  MACHINE_NAME_PATTERN,
  MAX_APPEND_BODY_BYTES,
  SourceSchema,
  type AppendResponse,
} from "@retrospecticus/shared";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth.ts";
import { rawDir } from "../config.ts";
import { events } from "../events.ts";
import { toConfigView } from "../config-store.ts";
import { appendToArchive, ArchivePathError, normalizeIngestPath } from "./archive.ts";

function parseCount(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/** Returns null once the body exceeds `limit`, without buffering the rest. */
export async function readBodyCapped(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, total);
}

/**
 * Headers cannot carry non-ASCII bytes reliably, so collectors percent-encode
 * each path segment. Decoding happens before normalisation so an encoded
 * separator or dot segment is judged like a literal one.
 */
export function decodeIngestPath(header: string): string {
  try {
    return decodeURIComponent(header);
  } catch {
    throw new ArchivePathError("path is not valid percent-encoding");
  }
}

// Paths the filesystem cannot hold (a segment over 255 bytes, a file where a directory is needed) are the client's error, not ours.
const UNSTORABLE_PATH_CODES = new Set(["ENAMETOOLONG", "ENOTDIR", "EISDIR", "EEXIST", "ELOOP"]);

export function appendHandler(deps: AppDeps): (c: Context<AppEnv>) => Promise<Response> {
  // data_dir needs a restart, so the archive stays where the server started.
  const archiveRoot = rawDir(toConfigView(deps.config).current());

  return async (c) => {
    const bad = (error: string) => c.json({ error }, 400);
    const tooLarge = () => c.json({ error: `body exceeds ${MAX_APPEND_BODY_BYTES} bytes` }, 413);

    const machine = c.req.header(HEADER_MACHINE);
    if (machine === undefined || !MACHINE_NAME_PATTERN.test(machine)) return bad(`invalid ${HEADER_MACHINE}`);
    // requireScope has already checked the header against the token when it is present.
    if (machine !== c.get("token").machine) return c.json({ error: "token is not bound to this machine" }, 403);

    const source = SourceSchema.safeParse(c.req.header(HEADER_SOURCE));
    if (!source.success) return bad(`unknown ${HEADER_SOURCE}`);

    const offset = parseCount(c.req.header(HEADER_OFFSET));
    if (offset === null) return bad(`invalid ${HEADER_OFFSET}`);
    const generation = parseCount(c.req.header(HEADER_GENERATION));
    if (generation === null) return bad(`invalid ${HEADER_GENERATION}`);

    let path: string;
    try {
      path = normalizeIngestPath(decodeIngestPath(c.req.header(HEADER_PATH) ?? ""));
    } catch (err) {
      if (err instanceof ArchivePathError) return bad(`invalid ${HEADER_PATH}: ${err.message}`);
      throw err;
    }

    const declared = parseCount(c.req.header("Content-Length"));
    if (declared !== null && declared > MAX_APPEND_BODY_BYTES) return tooLarge();
    const body = await readBodyCapped(c.req.raw, MAX_APPEND_BODY_BYTES);
    if (body === null) return tooLarge();

    let result;
    try {
      result = await appendToArchive(deps.db, archiveRoot, { machine, source: source.data, path, generation, offset, body });
    } catch (err) {
      if (err instanceof ArchivePathError) return bad(`invalid ${HEADER_PATH}: ${err.message}`);
      if (UNSTORABLE_PATH_CODES.has((err as NodeJS.ErrnoException).code ?? "")) {
        return bad(`invalid ${HEADER_PATH}: cannot be stored`);
      }
      throw err;
    }

    const reply: AppendResponse = { size: result.size, generation: result.generation };
    if (!result.accepted) return c.json(reply, 409);
    events.publish("machines");
    events.publish("stats");
    deps.onIngest?.();
    return c.json(reply, 200);
  };
}
