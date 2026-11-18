import { createHash } from "node:crypto";
import type { MessageRole } from "@retrospecticus/shared";
import {
  deleteChunks,
  deleteChunksForSession,
  getLastChunkedTurn,
  insertChunk,
  listChunkKeys,
  listMessagesWithRoles,
  messageIsAt,
  updateChunkPosition,
  type ChunkKey,
} from "../db/chunks.ts";
import { getMeta, setMeta, type Db } from "../db/index.ts";
import type { MessageRow } from "../db/messages.ts";
import {
  CHUNK_DIRTY_APPENDED,
  clearChunkDirty,
  listChunkDirtySessions,
  markAllChunkDirty,
  type SessionRow,
} from "../db/sessions.ts";
import { redact } from "../redact.ts";
import type { IndexerStage } from "./types.ts";

export interface SplitOptions {
  maxTokens?: number;
  overlapTokens?: number;
  leadChars?: number;
}

/** The sizes chunks are cut to. Part of what every stored chunk means. */
export interface ChunkSettings {
  maxTokens: number;
  overlapTokens: number;
}

export const DEFAULT_CHUNK_SETTINGS: ChunkSettings = { maxTokens: 400, overlapTokens: 50 };

const CHUNK_SETTINGS_KEY = "chunk_settings";

/**
 * Records the settings chunks are cut with. When they differ from the ones
 * the stored chunks were cut with, every session is queued for re-chunking;
 * chunks whose text comes out the same keep their ids and vectors. Returns
 * how many sessions were queued.
 */
export function applyChunkSettings(db: Db, settings: ChunkSettings): number {
  const wanted = JSON.stringify({ maxTokens: settings.maxTokens, overlapTokens: settings.overlapTokens });
  return db.transaction(() => {
    // A database from before this setting existed was cut with the defaults.
    const stored = getMeta(db, CHUNK_SETTINGS_KEY) ?? JSON.stringify(DEFAULT_CHUNK_SETTINGS);
    setMeta(db, CHUNK_SETTINGS_KEY, wanted);
    return stored === wanted ? 0 : markAllChunkDirty(db);
  })();
}

export interface ChunkResult {
  inserted: number;
  deleted: number;
  kept: number;
}

const SESSIONS_PER_RUN = 50;

/** The single decision about which messages are searchable. */
export function isSearchable(role: MessageRole): boolean {
  return role === "user" || role === "assistant";
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface Unit {
  /** What joins this unit to the one before it, so reassembly keeps the original spacing. */
  sep: string;
  text: string;
}

function hardCut(text: string, limit: number, sep: string): Unit[] {
  const out: Unit[] = [];
  for (let i = 0; i < text.length; i += limit) out.push({ sep: i === 0 ? sep : "", text: text.slice(i, i + limit) });
  return out;
}

function toUnits(text: string, limit: number): Unit[] {
  const units: Unit[] = [];
  const paragraphs = text.split(/\n[ \t]*\n/).filter((p) => p.trim() !== "");
  paragraphs.forEach((paragraph, p) => {
    const paragraphSep = p === 0 ? "" : "\n\n";
    if (paragraph.length <= limit) {
      units.push({ sep: paragraphSep, text: paragraph });
      return;
    }
    const sentences = paragraph.split(/(?<=[.!?])\s+/).filter((s) => s !== "");
    sentences.forEach((sentence, s) => {
      const sep = s === 0 ? paragraphSep : " ";
      if (sentence.length <= limit) units.push({ sep, text: sentence });
      else units.push(...hardCut(sentence, limit, sep));
    });
  });
  return units;
}

/** Splits one turn into chunk texts, none over `maxTokens`, with later parts overlapping and led by the user text. */
export function splitTurn(userText: string | null, assistantText: string, opts: SplitOptions = {}): string[] {
  const maxChars = Math.max(1, opts.maxTokens ?? DEFAULT_CHUNK_SETTINGS.maxTokens) * 4;
  const overlapChars = Math.max(0, opts.overlapTokens ?? DEFAULT_CHUNK_SETTINGS.overlapTokens) * 4;
  // A quarter of the chunk at most, so small chunks are not mostly repeated user text.
  const leadChars = opts.leadChars ?? Math.min(200, Math.floor(maxChars / 4));

  const sections: string[] = [];
  if (userText !== null) sections.push(`User: ${userText}`);
  if (assistantText !== "") sections.push(`Assistant: ${assistantText}`);
  const full = sections.join("\n\n");
  if (full.length <= maxChars) return [full];

  const lead =
    userText === null ? "" : `User: ${userText.replace(/\s+/g, " ").trim().slice(0, leadChars)}\n\n`;
  const unitLimit = Math.max(1, maxChars - lead.length - overlapChars - 2);
  const units = toUnits(full, unitLimit);

  const parts: string[] = [];
  let body = "";
  let tail = "";
  for (const unit of units) {
    const prefix = parts.length === 0 ? "" : lead;
    const candidate = body === "" ? unit.text : body + unit.sep + unit.text;
    const fresh = tail + (tail === "" ? "" : unit.sep) + unit.text;
    if (body !== "" && prefix.length + candidate.length > maxChars) {
      parts.push(prefix + body);
      tail = overlapChars > 0 ? body.slice(-overlapChars).trimStart() : "";
      body = fresh;
    } else {
      body = candidate;
    }
  }
  if (body !== "") parts.push((parts.length === 0 ? "" : lead) + body);
  return parts;
}

interface Turn {
  startMessage: MessageRow;
  endMessage: MessageRow;
  user: string | null;
  assistant: string[];
}

function buildTurns(messages: readonly MessageRow[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      current = { startMessage: message, endMessage: message, user: message.text, assistant: [] };
      turns.push(current);
    } else {
      if (current === null) {
        current = { startMessage: message, endMessage: message, user: null, assistant: [] };
        turns.push(current);
      }
      current.assistant.push(message.text);
      current.endMessage = message;
    }
  }
  return turns;
}

interface DesiredChunk {
  startMessageId: number;
  endMessageId: number;
  ordinal: number;
  part: number;
  text: string;
  textHash: string;
  timestamp: string | null;
}

function desiredChunks(turns: readonly Turn[], settings: ChunkSettings): DesiredChunk[] {
  const out: DesiredChunk[] = [];
  for (const turn of turns) {
    const user = turn.user === null ? null : redact(turn.user);
    const assistant = redact(turn.assistant.filter((t) => t.trim() !== "").join("\n\n"));
    if ((user === null || user.trim() === "") && assistant.trim() === "") continue;
    splitTurn(user, assistant, settings).forEach((raw, part) => {
      const text = redact(raw);
      out.push({
        startMessageId: turn.startMessage.id,
        endMessageId: turn.endMessage.id,
        ordinal: turn.startMessage.ordinal,
        part,
        text,
        textHash: createHash("sha256").update(text).digest("hex"),
        timestamp: turn.startMessage.timestamp,
      });
    });
  }
  return out;
}

const keyOf = (start: number, part: number, hash: string) => `${start}:${part}:${hash}`;

export function chunkSession(db: Db, session: SessionRow, settings: ChunkSettings = DEFAULT_CHUNK_SETTINGS): ChunkResult {
  return db.transaction((): ChunkResult => {
    if (session.kind === "guardian") {
      const deleted = deleteChunksForSession(db, session.id);
      clearChunkDirty(db, session.id);
      return { inserted: 0, deleted, kept: 0 };
    }

    let fromOrdinal = 0;
    if (session.chunk_dirty === CHUNK_DIRTY_APPENDED) {
      const last = getLastChunkedTurn(db, session.id);
      if (last !== null && messageIsAt(db, last.start_message_id, session.id, last.ordinal)) fromOrdinal = last.ordinal;
    }

    const messages = listMessagesWithRoles(
      db,
      session.id,
      (["user", "assistant"] as const).filter(isSearchable),
      fromOrdinal,
    );
    const desired = desiredChunks(buildTurns(messages), settings);

    const existing = new Map<string, ChunkKey[]>();
    for (const key of listChunkKeys(db, session.id, fromOrdinal)) {
      const k = keyOf(key.start_message_id, key.part, key.text_hash);
      const list = existing.get(k);
      if (list) list.push(key);
      else existing.set(k, [key]);
    }

    let kept = 0;
    let inserted = 0;
    for (const chunk of desired) {
      const match = existing.get(keyOf(chunk.startMessageId, chunk.part, chunk.textHash))?.shift();
      if (match) {
        kept++;
        if (
          match.end_message_id !== chunk.endMessageId ||
          match.ordinal !== chunk.ordinal ||
          match.timestamp !== chunk.timestamp
        ) {
          updateChunkPosition(db, match.id, {
            startMessageId: chunk.startMessageId,
            endMessageId: chunk.endMessageId,
            ordinal: chunk.ordinal,
            timestamp: chunk.timestamp,
          });
        }
        continue;
      }
      insertChunk(db, {
        sessionId: session.id,
        startMessageId: chunk.startMessageId,
        endMessageId: chunk.endMessageId,
        ordinal: chunk.ordinal,
        part: chunk.part,
        text: chunk.text,
        textHash: chunk.textHash,
        tokenEstimate: estimateTokens(chunk.text),
        timestamp: chunk.timestamp,
      });
      inserted++;
    }

    const stale = [...existing.values()].flat().map((key) => key.id);
    const deleted = deleteChunks(db, stale);
    clearChunkDirty(db, session.id);
    return { inserted, deleted, kept };
  })();
}

/** A function is asked on every run, so changed settings re-chunk without a restart. */
export function createChunkStage(settings: ChunkSettings | (() => ChunkSettings) = DEFAULT_CHUNK_SETTINGS): IndexerStage {
  let applied: string | undefined;
  return {
    name: "chunk",
    run(db) {
      const current = typeof settings === "function" ? settings() : settings;
      const key = JSON.stringify([current.maxTokens, current.overlapTokens]);
      if (applied !== key) {
        const queued = applyChunkSettings(db, current);
        if (queued > 0) console.log(`chunk: settings changed, re-chunking ${queued} sessions`);
        applied = key;
      }
      const sessions = listChunkDirtySessions(db, SESSIONS_PER_RUN);
      for (const session of sessions) chunkSession(db, session, current);
      return sessions.length > 0;
    },
  };
}
