import type { MessageRole, SessionKind, Source } from "@retrospecticus/shared";

/**
 * Per-file state a parser carries from line to line. It is persisted in
 * `files.parser_state` so parsing can resume mid-file and so a reparse of a
 * byte range sees the same session-level facts as the first pass. Keep only
 * values that are constant for the file once set.
 */
export interface ParseContext {
  source: Source;
  machine: string;
  /** Path relative to the source root, as archived. */
  path: string;
  state: Record<string, unknown>;
}

export interface NormalisedMessage {
  sessionId: string;
  role: MessageRole;
  text: string;
  toolName?: string;
  timestamp?: string;
}

/** Fields are merged into the `sessions` row; undefined means "leave as is". */
export interface SessionPatch {
  id: string;
  kind?: SessionKind;
  projectPath?: string;
  gitBranch?: string;
  /** Higher rank wins, so a user-set title beats a generated one. */
  title?: { text: string; rank: number };
  parentSessionId?: string;
  harnessVersion?: string;
  timestamp?: string;
}

export interface RecordInfo {
  type: string;
  nativeId?: string;
  parentNativeId?: string;
  timestamp?: string;
}

export type ParseResult =
  | {
      kind: "messages";
      record: RecordInfo;
      messages: NormalisedMessage[];
      session?: SessionPatch;
      /** Content block types the parser met but could not read; drift treats these as breaking. */
      unknownBlocks?: string[];
    }
  | { kind: "ignored"; recordType: string; session?: SessionPatch }
  | {
      kind: "unknown";
      reason: "unknown-type" | "validation" | "malformed-json";
      recordType?: string;
      detail: string;
    };

export interface Parser {
  source: Source;
  /** Record discriminators that yield messages or session metadata. */
  handledTypes: readonly string[];
  /** Record discriminators deliberately skipped. */
  ignoredTypes: readonly string[];
  /** The discriminator the parser would use for this record, e.g. `user` or `response_item/message`. */
  discriminator(record: unknown): string;
  parse(line: string, ctx: ParseContext): ParseResult;
}
