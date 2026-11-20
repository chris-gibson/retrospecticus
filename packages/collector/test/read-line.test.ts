import { describe, expect, test } from "bun:test";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readLineSync } from "../src/cli/read-line.ts";

function fdWith(text: string): number {
  const path = join(tmpdir(), `retrospecticus-read-line-${process.pid}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(path, text);
  return openSync(path, "r");
}

describe("readLineSync", () => {
  test("returns one line at a time without its line ending", () => {
    const fd = fdWith("first\r\nsecond\n");
    try {
      expect(readLineSync(fd)).toBe("first");
      expect(readLineSync(fd)).toBe("second");
    } finally {
      closeSync(fd);
    }
  });

  test("a blank line is an answer, but end of input before any byte is not", () => {
    const fd = fdWith("\n");
    try {
      expect(readLineSync(fd)).toBe("");
      expect(readLineSync(fd)).toBeNull();
    } finally {
      closeSync(fd);
    }
  });

  test("a last line without a newline is still returned", () => {
    const fd = fdWith("tail");
    try {
      expect(readLineSync(fd)).toBe("tail");
    } finally {
      closeSync(fd);
    }
  });
});
