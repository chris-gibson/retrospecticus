import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ENROLL_MAX_PENDING,
  ENROLL_POLL_INTERVAL_SECONDS,
  ENROLL_START_PATH,
  ENROLL_TTL_SECONDS,
  EnrollStartResponseSchema,
  USER_CODE_PATTERN,
} from "@retrospecticus/shared";
import { hashToken } from "../src/auth.ts";
import type { EnrollRequestRow } from "../src/db/enroll.ts";
import { generateUserCode } from "../src/enroll.ts";
import { clockedApp, poll, postJson, startEnroll, type Clocked } from "./enroll-helpers.ts";
import { createHarness, type Harness } from "./harness.ts";

let h: Harness;
let clock: Clocked;

beforeEach(() => {
  h = createHarness();
  clock = clockedApp(h);
});
afterEach(() => h.cleanup());

function requests(): EnrollRequestRow[] {
  return h.db.query<EnrollRequestRow, []>("SELECT * FROM enroll_requests ORDER BY id").all();
}

describe("start", () => {
  test("returns the contract shape and stores only the device code's hash", async () => {
    const res = await postJson(clock.app, ENROLL_START_PATH, {
      machine: "laptop",
      hostname: "laptop.local",
      platform: "linux-x64",
      collector_version: "0.1.0",
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = EnrollStartResponseSchema.parse(await res.json());
    expect(body.device_code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.user_code).toMatch(USER_CODE_PATTERN);
    expect(body.verification_url).toBe("http://localhost/admin");
    expect(body.expires_in).toBe(ENROLL_TTL_SECONDS);
    expect(body.interval).toBe(ENROLL_POLL_INTERVAL_SECONDS);

    const [row] = requests();
    expect(row).toMatchObject({
      device_code_hash: hashToken(body.device_code),
      user_code: body.user_code,
      machine: "laptop",
      hostname: "laptop.local",
      platform: "linux-x64",
      collector_version: "0.1.0",
      ip: null,
      status: "pending",
      created_at: "2026-11-16T12:00:00.000Z",
      expires_at: "2026-11-16T12:10:00.000Z",
    });
    expect(JSON.stringify(requests())).not.toContain(body.device_code);
  });

  test("the verification URL follows the host the collector reached", async () => {
    const res = await clock.app.request("http://100.64.0.7:7878" + ENROLL_START_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machine: "laptop" }),
    });
    expect(((await res.json()) as { verification_url: string }).verification_url).toBe("http://100.64.0.7:7878/admin");
  });

  test.each([
    ["no machine", {}],
    ["an invalid machine name", { machine: "../etc" }],
    ["a machine name with spaces", { machine: "my laptop" }],
    ["an overlong hostname", { machine: "laptop", hostname: "x".repeat(256) }],
    ["a non-string platform", { machine: "laptop", platform: 3 }],
  ])("refuses %s with 400", async (_label, body) => {
    expect((await postJson(clock.app, ENROLL_START_PATH, body)).status).toBe(400);
    expect(requests()).toEqual([]);
  });

  test("refuses a body that is not JSON", async () => {
    const res = await clock.app.request(ENROLL_START_PATH, { method: "POST", body: "machine=laptop" });
    expect(res.status).toBe(400);
  });

  test("user codes have the documented format and are unique among live requests", async () => {
    for (let i = 0; i < 2000; i++) expect(generateUserCode()).toMatch(USER_CODE_PATTERN);
    const codes = new Set<string>();
    for (let i = 0; i < ENROLL_MAX_PENDING; i++) codes.add((await startEnroll(clock.app, `m${i}`)).user_code);
    expect(codes.size).toBe(ENROLL_MAX_PENDING);
  });

  test("refuses with 429 once the pending cap is reached, until requests expire", async () => {
    for (let i = 0; i < ENROLL_MAX_PENDING; i++) await startEnroll(clock.app, `m${i}`);
    const refused = await postJson(clock.app, ENROLL_START_PATH, { machine: "one-more" });
    expect(refused.status).toBe(429);
    expect(requests()).toHaveLength(ENROLL_MAX_PENDING);

    clock.advance(ENROLL_TTL_SECONDS);
    expect((await postJson(clock.app, ENROLL_START_PATH, { machine: "one-more" })).status).toBe(201);
    expect(requests().map((r) => r.machine)).toEqual(["one-more"]);
  });
});

describe("poll", () => {
  test("reports pending while the request waits", async () => {
    const { device_code } = await startEnroll(clock.app);
    const res = await poll(clock.app, device_code);
    expect(res).toEqual({ status: 200, body: { status: "pending" } });
    clock.advance(ENROLL_TTL_SECONDS - 1);
    expect((await poll(clock.app, device_code)).body).toEqual({ status: "pending" });
  });

  test("reports expired once the request times out, and forgets it", async () => {
    const { device_code } = await startEnroll(clock.app);
    clock.advance(ENROLL_TTL_SECONDS);
    expect((await poll(clock.app, device_code)).body).toEqual({ status: "expired" });
    expect(requests()).toEqual([]);
  });

  test("reports expired for an unknown device code", async () => {
    await startEnroll(clock.app);
    expect((await poll(clock.app, "not-a-real-code")).body).toEqual({ status: "expired" });
    expect(requests()).toHaveLength(1);
  });

  test("reports a denial once, then expired", async () => {
    const { device_code } = await startEnroll(clock.app);
    h.db.run("UPDATE enroll_requests SET status = 'denied'");
    expect((await poll(clock.app, device_code)).body).toEqual({ status: "denied" });
    expect(requests()).toEqual([]);
    expect((await poll(clock.app, device_code)).body).toEqual({ status: "expired" });
  });

  test("refuses a malformed body with 400", async () => {
    for (const body of [{}, { device_code: "" }, { device_code: 5 }]) {
      expect((await postJson(clock.app, "/v1/enroll/poll", body)).status).toBe(400);
    }
  });
});
