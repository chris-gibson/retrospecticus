import { describe, expect, test } from "bun:test";
import { diffAgainstNearest, formatDiff } from "../src/drift/diff.ts";
import {
  baseDiscriminator,
  contentBlockTypes,
  extendDiscriminator,
  fingerprint,
  isPlainKey,
  keyPaths,
} from "../src/drift/fingerprint.ts";
import { scrubSample } from "../src/drift/scrub-sample.ts";
import { fixtureLines, manifest } from "./fixture-helpers.ts";

const fp = (json: unknown, discriminator = "user") => fingerprint("claude-code", discriminator, json);

describe("keyPaths and fingerprint", () => {
  test("ignore key order and string values, but not types or key names", () => {
    const a = { type: "user", message: { role: "user", content: "hello" }, n: 1 };
    const b = { n: 99, message: { content: "a much longer text", role: "user" }, type: "user" };
    expect(fp(a)).toBe(fp(b));
    expect(keyPaths(a)).toEqual(["message.content:string", "message.role:string", "message:object", "n:number", "type:string"]);

    expect(fp({ ...a, n: "1" })).not.toBe(fp(a));
    expect(fp({ ...a, extra: true })).not.toBe(fp(a));
    expect(fp({ type: "user", msg: a.message, n: 1 })).not.toBe(fp(a));
  });

  test("source and discriminator are part of the hash", () => {
    const json = { type: "x" };
    expect(fingerprint("claude-code", "x", json)).not.toBe(fingerprint("codex", "x", json));
    expect(fp(json, "x")).not.toBe(fp(json, "x[text]"));
    expect(fp(json)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("stop at depth 3", () => {
    const shallow = { a: { b: { c: { d: 1 } } } };
    const deeper = { a: { b: { c: { d: "x", e: [1, 2] } } } };
    expect(keyPaths(shallow)).toEqual(["a.b.c:object", "a.b:object", "a:object"]);
    expect(fp(shallow)).toBe(fp(deeper));
    expect(fp({ a: { b: { c: [] } } })).not.toBe(fp(shallow));
  });

  test("collapse arrays to the union of their element shapes", () => {
    const text = { type: "text", text: "hi" };
    const tool = { type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } };
    const one = { content: [text, tool] };
    expect(fp(one)).toBe(fp({ content: [tool, text] }));
    expect(fp(one)).toBe(fp({ content: [text, tool, text, tool, text] }));
    expect(fp(one)).not.toBe(fp({ content: [text] }));
    expect(fp({ content: [] })).not.toBe(fp({ content: [text] }));
    expect(keyPaths({ content: [text, tool] })).toEqual([
      "content:array",
      "content[].id:string",
      "content[].input:object",
      "content[].name:string",
      "content[].text:string",
      "content[].type:string",
      "content[]:object",
    ]);
    expect(keyPaths({ m: [1, "a", null, [true]] })).toEqual([
      "m:array",
      "m[]:array",
      "m[]:null",
      "m[]:number",
      "m[]:string",
      "m[][]:boolean",
    ]);
  });

  test("collapse keys that are data, and do not look inside free-form subtrees", () => {
    const one = { snapshot: { "/home/me/a.ts": { v: 1 }, "src/b.ts": { v: 2 } } };
    const other = { snapshot: { "/srv/x.py": { v: 3 } } };
    expect(fp(one)).toBe(fp(other));
    expect(keyPaths(one)).toEqual(["snapshot.*.v:number", "snapshot.*:object", "snapshot:object"]);
    // Scrubbed fixtures name such keys key_N, which must mean the same thing.
    expect(fp({ snapshot: { key_0: { v: 1 }, key_1: { v: 2 } } })).toBe(fp(one));

    expect(fp({ toolUseResult: { stdout: "", stderr: "" } })).toBe(fp({ toolUseResult: { filePath: "", oldString: "" } }));
    expect(fp({ toolUseResult: "error text" })).not.toBe(fp({ toolUseResult: {} }));

    for (const key of ["toolu_01ABCDEFGHJK", "call_abc12345XYZ", "mcp__server__tool", "abc1234", "deadbeef0123ab", "a.b", "x-y"]) {
      expect(isPlainKey(key)).toBe(false);
    }
    for (const key of ["type", "parentUuid", "tool_use_id", "cli_version", "_meta"]) expect(isPlainKey(key)).toBe(true);
  });

  test("a non-object line still has a shape", () => {
    expect(keyPaths([1, { a: 1 }])).toEqual(["$:array", "$[].a:number", "$[]:number", "$[]:object"]);
    expect(keyPaths("x")).toEqual(["$:string"]);
  });

  test("the discriminator carries the record's content block types", () => {
    const assistant = { type: "assistant", message: { content: [{ type: "tool_use" }, { type: "text" }, { type: "text" }] } };
    expect(extendDiscriminator("claude-code", "assistant", assistant)).toBe("assistant[text,tool_use]");
    const toolResult = {
      type: "user",
      message: { content: [{ type: "tool_result", content: [{ type: "text" }, { type: "image" }] }] },
    };
    expect(contentBlockTypes("claude-code", toolResult)).toEqual(["tool_result", "tool_result/image", "tool_result/text"]);
    expect(extendDiscriminator("claude-code", "user", { type: "user", message: { content: "plain" } })).toBe("user");
    expect(
      extendDiscriminator("codex", "response_item/message", {
        type: "response_item",
        payload: { type: "message", content: [{ type: "output_text" }, { type: "input_text" }] },
      }),
    ).toBe("response_item/message[input_text,output_text]");
    expect(contentBlockTypes("codex", { payload: { output: [{ type: "input_image" }] } })).toEqual(["output/input_image"]);
    expect(baseDiscriminator("assistant[text,tool_use]")).toBe("assistant");
    expect(baseDiscriminator("event_msg/token_count")).toBe("event_msg/token_count");
  });
});

function walk(value: unknown, visit: (kind: "string" | "key", text: string) => void): void {
  if (typeof value === "string") visit("string", value);
  else if (Array.isArray(value)) value.forEach((v) => walk(v, visit));
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      visit("key", k);
      walk(v, visit);
    }
  }
}

describe("scrubSample", () => {
  test("replaces strings with their length and keeps the rest", () => {
    expect(
      scrubSample({ type: "user", n: 3, ok: true, none: null, list: ["ab", 1], "/etc/passwd": "secret", nested: { k: "" } }),
    ).toEqual({ type: "<str:4>", n: 3, ok: true, none: null, list: ["<str:2>", 1], key_0: "<str:6>", nested: { k: "<str:0>" } });
  });

  test("leaks no string from any fixture line and keeps its key paths", () => {
    for (const entry of manifest) {
      for (const line of fixtureLines(entry)) {
        const json = JSON.parse(line);
        const sample = scrubSample(json);
        walk(sample, (kind, text) => {
          if (kind === "string") expect(text).toMatch(/^<str:\d+>$/);
          else expect(isPlainKey(text) || /^key_\d+$/.test(text)).toBe(true);
        });
        const serialised = JSON.stringify(sample);
        walk(json, (kind, text) => {
          if (kind === "string" && text.length >= 8 && !isPlainKey(text)) expect(serialised).not.toContain(text);
        });
        expect(keyPaths(sample)).toEqual(keyPaths(json));
      }
    }
  });
});

describe("diffAgainstNearest", () => {
  test("reports added, removed and retyped paths against the closest shape", () => {
    const target = keyPaths({ type: "user", sessionId: 1, message: { role: "user", text: "x" } });
    const near = { hash: "near", paths: keyPaths({ type: "user", sessionId: "s", message: { role: "user", content: "x" } }) };
    const far = { hash: "far", paths: keyPaths({ type: "user", a: 1, b: 2, c: 3 }) };
    const diff = diffAgainstNearest(target, [far, near]);
    expect(diff).toEqual({
      nearest: "near",
      added: ["message.text:string"],
      removed: ["message.content:string"],
      retyped: [{ path: "sessionId", from: ["string"], to: ["number"] }],
    });
    expect(formatDiff(diff)).toEqual([
      "Nearest known shape: near",
      "  + message.text:string",
      "  - message.content:string",
      "  ~ sessionId: string -> number",
    ]);
  });

  test("without candidates there is nothing to compare", () => {
    const diff = diffAgainstNearest(["a:string"], []);
    expect(diff.nearest).toBeNull();
    expect(formatDiff(diff)).toEqual(["No known shape with this discriminator to compare with."]);
  });
});
