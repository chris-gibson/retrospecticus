import { describe, expect, test } from "bun:test";
import { auditRecord, IdMap, isFiller, PLACEHOLDER_BASE64, PLACEHOLDER_ENCRYPTED, scrub, Scrubber } from "../../../scripts/scrub.ts";

type Json = Record<string, any>;

describe("scrub", () => {
  test("keeps structure and non-string values, replaces prose with filler of the same length", () => {
    const input = {
      type: "user",
      isMeta: false,
      count: 3,
      nothing: null,
      message: { role: "user", content: "Deploy the billing service to prod-eu with key sk-live-123" },
    };
    const out = scrub(input, "claude-code") as Json;
    expect(out.type).toBe("user");
    expect(out.isMeta).toBe(false);
    expect(out.count).toBe(3);
    expect(out.nothing).toBeNull();
    expect(out.message.role).toBe("user");
    expect(out.message.content).toHaveLength(input.message.content.length);
    expect(isFiller(out.message.content)).toBe(true);
    expect(JSON.stringify(out)).not.toContain("billing");
  });

  test("maps ids to stable fakes so links survive, across records sharing an IdMap", () => {
    const ids = new IdMap();
    const scrubber = new Scrubber("claude-code", { ids });
    const parent = "3f0c9a52-5c1e-4f0e-9d53-0a6f6d0e7b11";
    const a = scrubber.scrub({ type: "user", uuid: parent, parentUuid: null }) as Json;
    const b = new Scrubber("claude-code", { ids }).scrub({ type: "assistant", uuid: "toolu_abc", parentUuid: parent }) as Json;
    expect(a.uuid).not.toBe(parent);
    expect(b.parentUuid).toBe(a.uuid);
    expect(b.uuid).toMatch(/^toolu_fake\d{6}$/);
  });

  test("keeps timestamps, versions and discriminators but not look-alikes elsewhere", () => {
    const out = scrub(
      { type: "user", version: "2.1.325", timestamp: "2026-11-16T10:00:00.000Z", cwd: "/srv/private/project", note: "user" },
      "claude-code",
    ) as Json;
    expect(out.version).toBe("2.1.325");
    expect(out.timestamp).toBe("2026-11-16T10:00:00.000Z");
    expect(isFiller(out.cwd)).toBe(true);
    expect(out.note).not.toBe("user");
  });

  test("preserves a leading context tag so the parsers' injected-context rule stays testable", () => {
    const codex = scrub(
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd=/srv/private</environment_context>" }] } },
      "codex",
    ) as Json;
    const text: string = codex.payload.content[0].text;
    expect(text.startsWith("<environment_context>")).toBe(true);
    expect(text).not.toContain("private");

    const claude = scrub({ type: "user", message: { role: "user", content: "<command-name>/secret-skill</command-name>" } }, "claude-code") as Json;
    expect(claude.message.content.startsWith("<command-name>")).toBe(true);
    expect(claude.message.content).not.toContain("secret");
  });

  test("replaces binary and encrypted payloads with placeholders", () => {
    const out = scrub(
      {
        type: "response_item",
        payload: { type: "reasoning", encrypted_content: "gAAAAAB" + "x".repeat(400), content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
      },
      "codex",
    ) as Json;
    expect(out.payload.encrypted_content).toBe(PLACEHOLDER_ENCRYPTED);
    expect(out.payload.content[0].image_url).toBe(PLACEHOLDER_BASE64);
  });

  test("renames keys that are data: paths, ids, MCP names, deep or free-form keys", () => {
    const out = scrub(
      {
        type: "assistant",
        snapshot: { trackedFileBackups: { Makefile: { version: 1 }, "src/secret.ts": { version: 2 } } },
        wireToolInputs: { toolu_01AbCdEfGhIjKlMnOpQrStUv: { command: "ls" } },
        mcp__private_server: true,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "mcp__private_server__lookup", input: { customer_name: "Acme" } }],
        },
        a: { b: { c: { customerField: 1, type: "kept" } } },
      },
      "claude-code",
    ) as Json;
    const text = JSON.stringify(out);
    for (const leaked of ["Makefile", "secret", "toolu_01AbCd", "private_server", "customer", "Acme"]) {
      expect(text).not.toContain(leaked);
    }
    expect(Object.keys(out.snapshot.trackedFileBackups)).toEqual(["key_0", "key_1"]);
    expect(out.message.content[0].name).toMatch(/^mcp__fake__tool_\d{4}$/);
    expect(Object.keys(out.a.b.c).sort()).toEqual(["key_0", "type"]);
    expect(auditRecord("claude-code", out)).toEqual([]);
  });

  test("is deterministic", () => {
    const input = { type: "user", message: { role: "user", content: "the same words every time" } };
    expect(scrub(input, "claude-code")).toEqual(scrub(input, "claude-code"));
  });
});

describe("auditRecord", () => {
  test("accepts scrubber output", () => {
    const out = scrub(
      { type: "user", uuid: "u-1", message: { role: "user", content: [{ type: "text", text: "<system-reminder>private words</system-reminder>" }] } },
      "claude-code",
    );
    expect(auditRecord("claude-code", out)).toEqual([]);
  });

  test("flags a string that is neither allowlisted nor filler, and a key that was not renamed", () => {
    expect(auditRecord("claude-code", { type: "user", message: { role: "user", content: "real words here" } })).toHaveLength(1);
    expect(auditRecord("claude-code", { type: "user", cwd: "lorem ipsum", "src/app.ts": 1 })).toHaveLength(1);
    expect(auditRecord("codex", { type: "event_msg", payload: { a: { b: { projectName: 1 } } } })).toHaveLength(1);
    expect(auditRecord("claude-code", { type: "user", uuid: "3f0c9a52-5c1e-4f0e-9d53-0a6f6d0e7b11" })).toHaveLength(1);
  });

  test("does not accept an allowlisted value outside its path", () => {
    expect(auditRecord("claude-code", { type: "user", cwd: "user" })).toHaveLength(1);
  });
});
