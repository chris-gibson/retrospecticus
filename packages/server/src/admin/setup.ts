import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { ADMIN_PAGE_PATH, USER_CODE_ALPHABET } from "@retrospecticus/shared";
import { issueToken, type AppEnv } from "../auth.ts";
import type { Db } from "../db/index.ts";
import { listTokens } from "../db/tokens.ts";
import { readJsonBody } from "../enroll.ts";

const API = `${ADMIN_PAGE_PATH}/api`;
export const SETUP_PATH = `${API}/setup`;
export const SETUP_CLAIM_PATH = `${API}/setup/claim`;

/** 16 characters from a 28-letter alphabet: about 77 bits, shown as four groups of four. */
const SETUP_CODE_LENGTH = 16;

export type ClaimResult = { status: "ok"; token: string; tokenId: number; name: string } | { status: "wrong" }
  | { status: "gone" };

export interface SetupState {
  /** True while no admin token is live and a setup code is outstanding. */
  needed(): boolean;
  /**
   * Issues a fresh code when no live admin token exists, replacing any earlier
   * one, and returns it; null when an admin token already exists.
   */
  issue(): string | null;
  /** Checks the code in constant time and, on a match, consumes it and creates the "setup" admin token. */
  claim(presented: string): ClaimResult;
}

export function hasLiveAdminToken(db: Db): boolean {
  return listTokens(db).some((t) => t.scope === "admin" && !t.revoked_at);
}

/** Unbiased: bytes past the largest multiple of the alphabet size are rejected rather than wrapped. */
export function generateSetupCode(): string {
  const n = USER_CODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let code = "";
  while (code.length < SETUP_CODE_LENGTH) {
    for (const byte of randomBytes(32)) {
      if (byte >= limit) continue;
      code += USER_CODE_ALPHABET[byte % n];
      if (code.length === SETUP_CODE_LENGTH) break;
    }
  }
  return code.match(/.{4}/g)!.join("-");
}

/** Accepts the code however it was typed: any case, with or without dashes or spaces. */
export function normalizeSetupCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

export function createSetupState(db: Db): SetupState {
  let code: string | null = null;
  return {
    needed: () => code !== null && !hasLiveAdminToken(db),
    issue() {
      if (hasLiveAdminToken(db)) {
        code = null;
        return null;
      }
      code = generateSetupCode();
      return code;
    },
    claim(presented) {
      if (code === null || hasLiveAdminToken(db)) {
        code = null;
        return { status: "gone" };
      }
      // Comparing digests keeps the comparison length-independent as well as constant-time.
      if (!timingSafeEqual(digest(normalizeSetupCode(presented)), digest(normalizeSetupCode(code)))) {
        return { status: "wrong" };
      }
      code = null;
      const { token, row } = issueToken(db, { scope: "admin", name: "setup" });
      return { status: "ok", token, tokenId: row.id, name: row.name };
    },
  };
}

const ClaimSchema = z.object({ code: z.string().max(64) });

export interface SetupRouteDeps {
  setup: SetupState;
  failureDelayMs: number;
  /** Starts an admin session for the token, setting the same cookie as a login. */
  startSession(c: Context<AppEnv>, tokenId: number): void;
  maxBodyBytes: number;
}

/** Registered where the session guard lets these two paths through; the CSRF guard still applies. */
export function registerSetupRoutes(app: Hono<AppEnv>, deps: SetupRouteDeps): void {
  app.get(SETUP_PATH, (c) => c.json({ needed: deps.setup.needed() }));

  app.post(SETUP_CLAIM_PATH, async (c) => {
    const parsed = ClaimSchema.safeParse(await readJsonBody(c, deps.maxBodyBytes));
    const result = deps.setup.claim(parsed.success ? parsed.data.code : "");
    if (result.status === "gone") return c.json({ error: "setup is already done; sign in with an admin token" }, 410);
    if (result.status === "wrong") {
      await Bun.sleep(deps.failureDelayMs);
      return c.json({ error: "that setup code is not right; copy it from the server log" }, 400);
    }
    deps.startSession(c, result.tokenId);
    return c.json({ ok: true, token: result.token, row: { id: result.tokenId, name: result.name } });
  });
}
