import type { Source } from "@retrospecticus/shared";
import { claudeCodeParser } from "./claude-code.ts";
import { codexParser } from "./codex.ts";
import type { Parser } from "./types.ts";

export type ParserRegistry = Readonly<Record<Source, Parser>>;

export const parsers: ParserRegistry = {
  "claude-code": claudeCodeParser,
  codex: codexParser,
};

export function getParser(source: Source): Parser {
  return parsers[source];
}

export { claudeCodeParser, codexParser };
export type * from "./types.ts";

/**
 * Lets an operator mark record types as bookkeeping without a release: a line
 * the parser reports as an unknown type, and whose discriminator is listed,
 * becomes `ignored`. Everything else the parser says is left as it is.
 */
export function withIgnoredTypes(registry: ParserRegistry, ignored: (source: Source) => readonly string[]): ParserRegistry {
  const wrap = (parser: Parser): Parser => ({
    source: parser.source,
    handledTypes: parser.handledTypes,
    ignoredTypes: parser.ignoredTypes,
    discriminator: (record) => parser.discriminator(record),
    parse(line, ctx) {
      const result = parser.parse(line, ctx);
      if (result.kind !== "unknown" || result.reason !== "unknown-type") return result;
      const list = ignored(parser.source);
      if (list.length === 0) return result;
      let discriminator: string;
      try {
        discriminator = parser.discriminator(JSON.parse(line));
      } catch {
        return result;
      }
      return list.includes(discriminator) ? { kind: "ignored", recordType: discriminator } : result;
    },
  });
  return { "claude-code": wrap(registry["claude-code"]), codex: wrap(registry.codex) };
}
