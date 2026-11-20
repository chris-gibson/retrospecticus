import {
  AppendResponseSchema,
  HEADER_GENERATION,
  HEADER_MACHINE,
  HEADER_OFFSET,
  HEADER_PATH,
  HEADER_SOURCE,
  INGEST_APPEND_PATH,
  type Source,
} from "@retrospecticus/shared";

export interface AppendRequest {
  source: Source;
  /** Relative to the source root, forward slashes, not yet encoded. */
  path: string;
  generation: number;
  offset: number;
  body: Uint8Array;
}

export type AppendOutcome =
  | { kind: "accepted"; size: number; generation: number }
  | { kind: "conflict"; size: number; generation: number }
  /** The server will never take this request as it stands; retrying unchanged is pointless. */
  | { kind: "rejected"; status: number; message: string }
  /** Nothing is known to be wrong with the file; the server or the path to it is. */
  | { kind: "unavailable"; reason: string };

export interface UploaderOptions {
  serverUrl: string;
  token: string;
  machine: string;
  requestTimeoutMs: number;
}

/** Header values must be ASCII, and session paths are not: project directories carry whatever the user named them. */
export function encodeIngestPath(relPath: string): string {
  return relPath.split("/").map(encodeURIComponent).join("/");
}

export type PostResult = { ok: true; body: unknown } | { ok: false; error: string };

const PER_FILE_REFUSALS = new Set([400, 413, 414, 431]);

async function errorText(res: Response): Promise<string> {
  try {
    const text = (await res.text()).slice(0, 300);
    try {
      const json = JSON.parse(text) as { error?: unknown };
      if (typeof json.error === "string") return json.error;
    } catch {
      // Not our server's JSON; the raw text is still the best description.
    }
    return text;
  } catch {
    return "";
  }
}

const MAX_JSON_ANSWER_BYTES = 64 * 1024;

export class Uploader {
  constructor(private readonly options: UploaderOptions) {}

  private signal(stop: AbortSignal): AbortSignal {
    return AbortSignal.any([stop, AbortSignal.timeout(this.options.requestTimeoutMs)]);
  }

  async append(req: AppendRequest, stop: AbortSignal): Promise<AppendOutcome> {
    let res: Response;
    try {
      res = await fetch(this.options.serverUrl + INGEST_APPEND_PATH, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          "Content-Type": "application/octet-stream",
          [HEADER_MACHINE]: this.options.machine,
          [HEADER_SOURCE]: req.source,
          [HEADER_PATH]: encodeIngestPath(req.path),
          [HEADER_OFFSET]: String(req.offset),
          [HEADER_GENERATION]: String(req.generation),
        },
        body: req.body,
        signal: this.signal(stop),
        redirect: "error",
      });
    } catch (err) {
      return { kind: "unavailable", reason: (err as Error).message || String(err) };
    }

    if (res.status === 200 || res.status === 409) {
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        json = undefined;
      }
      const reply = AppendResponseSchema.safeParse(json);
      // A 200 without the protocol body came from something other than the ingest API, so nothing was archived.
      if (!reply.success) return { kind: "unavailable", reason: `HTTP ${res.status} with an unexpected body` };
      return { kind: res.status === 200 ? "accepted" : "conflict", ...reply.data };
    }

    const message = await errorText(res);
    if (PER_FILE_REFUSALS.has(res.status)) return { kind: "rejected", status: res.status, message };
    return { kind: "unavailable", reason: `HTTP ${res.status}${message ? `: ${message}` : ""}` };
  }

  /** The parsed body on success (undefined when it is not JSON), otherwise why it failed. */
  async postJson(path: string, body: unknown, stop: AbortSignal): Promise<PostResult> {
    try {
      const res = await fetch(this.options.serverUrl + path, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          "Content-Type": "application/json",
          [HEADER_MACHINE]: this.options.machine,
        },
        body: JSON.stringify(body),
        signal: this.signal(stop),
        redirect: "error",
      });
      if (res.ok) {
        // The answers expected here are a few hundred bytes; anything far larger is not from the server.
        const declared = Number(res.headers.get("content-length") ?? "0");
        if (declared > MAX_JSON_ANSWER_BYTES) {
          await res.body?.cancel();
          return { ok: false, error: `answer too large (${declared} bytes)` };
        }
        const text = await res.text();
        if (text.length > MAX_JSON_ANSWER_BYTES) return { ok: false, error: `answer too large (${text.length} bytes)` };
        try {
          return { ok: true, body: JSON.parse(text) };
        } catch {
          return { ok: true, body: undefined };
        }
      }
      return { ok: false, error: `HTTP ${res.status}: ${await errorText(res)}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message || String(err) };
    }
  }
}

export class Backoff {
  private failures = 0;

  constructor(
    private readonly minMs: number,
    private readonly maxMs: number,
    private readonly random: () => number = Math.random,
  ) {}

  get active(): boolean {
    return this.failures > 0;
  }

  reset(): void {
    this.failures = 0;
  }

  /** Doubles from `minMs` to `maxMs`; jitter keeps several machines from retrying a restarted server in step. */
  next(): number {
    const ceiling = Math.min(this.maxMs, this.minMs * 2 ** Math.min(this.failures, 30));
    this.failures++;
    return Math.max(this.minMs, ceiling * (0.5 + this.random() / 2));
  }
}
