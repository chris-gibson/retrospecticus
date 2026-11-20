import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HEARTBEAT_PATH, VERSION } from "@retrospecticus/shared";
import { expireCommands } from "../src/db/commands.ts";
import { events } from "../src/events.ts";
import { adminGet, adminPost, adminSession, clockedApp, type Clocked } from "./enroll-helpers.ts";
import { createHarness, type Harness } from "./harness.ts";

let h: Harness;
let clock: Clocked;
let cookie: string;
let ingest: string;

beforeEach(async () => {
  h = createHarness();
  clock = clockedApp(h);
  cookie = (await adminSession(clock.app, h)).cookie;
  ingest = h.token("ingest", "laptop");
});
afterEach(() => h.cleanup());

type Body = Record<string, unknown>;

async function beat(extra: Body = {}, version = "0.0.1", bearer = ingest): Promise<Body> {
  const res = await clock.app.request(HEARTBEAT_PATH, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify({ collector_version: version, sources: [], ...extra }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Body;
}

const upgrade = (machine = "laptop") => adminPost(clock.app, `/admin/api/machines/${machine}/update`, cookie);

async function machine(name = "laptop"): Promise<Record<string, any>> {
  const { machines } = (await (await adminGet(clock.app, "/admin/api/machines", cookie)).json()) as { machines: Record<string, any>[] };
  return machines.find((m) => m.machine === name)!;
}

const commandRow = () => h.db.query<Record<string, any>, []>("SELECT * FROM machine_commands").get()!;

describe("remote update commands", () => {
  test("a heartbeat reports the setting and the machine list shows it", async () => {
    await beat({ remote_update: true });
    expect((await machine()).remote_update).toBe(true);
    await beat({ remote_update: false });
    expect((await machine()).remote_update).toBe(false);
    await beat();
    expect((await machine()).remote_update).toBe(false);
  });

  test("a heartbeat answers a bare ok when there is nothing to do", async () => {
    expect(await beat({ remote_update: true })).toEqual({ ok: true });
  });

  test("create, deliver on the next heartbeat, and finish when the new version reports", async () => {
    await beat({ remote_update: true });
    expect((await upgrade()).status).toBe(200);
    expect((await machine()).command).toMatchObject({ status: "pending", target_version: VERSION, finished_at: null });

    const answer = await beat({ remote_update: true });
    const row = commandRow();
    expect(answer).toEqual({ ok: true, command: { id: row.id, command: "update", version: VERSION } });
    expect(row.status).toBe("delivered");
    expect(row.delivered_at).not.toBeNull();
    expect((await machine()).command.status).toBe("delivered");

    // The answer carrying it can be lost, so it is handed out again until it settles; the collector ignores repeats.
    expect(await beat({ remote_update: true })).toEqual({ ok: true, command: { id: row.id, command: "update", version: VERSION } });
    expect(commandRow().delivered_at).toBe(row.delivered_at);

    expect(await beat({ remote_update: true }, VERSION)).toEqual({ ok: true });
    expect(commandRow().status).toBe("done");
    expect((await machine()).command).toMatchObject({ status: "done", message: null });
  });

  test("only the token the command went to can settle it or receive it again", async () => {
    // Re-enrolling can leave a second valid token for the same machine name.
    const second = h.token("ingest", "laptop");
    await beat({ remote_update: true });
    expect((await upgrade()).status).toBe(200);
    const delivered = await beat({ remote_update: true });
    expect(delivered.command).toBeDefined();
    expect(await beat({ remote_update: true }, VERSION, second)).toEqual({ ok: true });
    expect(await beat({ remote_update: true, command_result: { id: commandRow().id, ok: false, message: "nope" } }, "0.0.1", second)).toEqual({ ok: true });
    expect(commandRow().status).toBe("delivered");
    expect(await beat({ remote_update: true }, VERSION)).toEqual({ ok: true });
    expect(commandRow().status).toBe("done");
  });

  test("a newer collector than the target also completes the command", async () => {
    await beat({ remote_update: true });
    await upgrade();
    await beat({ remote_update: true }, "99.0.0");
    expect(commandRow().status).toBe("done");
  });

  test("a collector that reports failure fails the command with its message", async () => {
    await beat({ remote_update: true });
    await upgrade();
    const { command } = (await beat({ remote_update: true })) as { command: { id: string } };
    await beat({ remote_update: true, command_result: { id: command.id, ok: false, message: "Checksum mismatch" } });
    expect((await machine()).command).toMatchObject({ status: "failed", message: "Checksum mismatch" });
  });

  test("a failure report for some other command is ignored", async () => {
    await beat({ remote_update: true });
    await upgrade();
    await beat({ remote_update: true });
    await beat({ remote_update: true, command_result: { id: "nope", ok: false, message: "x" } });
    expect(commandRow().status).toBe("delivered");
  });

  test("a machine that turned remote updates off fails the command instead of receiving it", async () => {
    await beat({ remote_update: true });
    await upgrade();
    const answer = await beat({ remote_update: false });
    expect(answer).toEqual({ ok: true });
    expect(commandRow()).toMatchObject({ status: "failed", message: "remote updates are off on this machine" });
  });

  test("a pending command expires after a day, and a delivered one without a report fails after 15 minutes", async () => {
    await beat({ remote_update: true });
    await upgrade();
    clock.advance(24 * 3600 + 1);
    cookie = (await adminSession(clock.app, h)).cookie;
    expect((await machine()).command.status).toBe("expired");
    expect(await beat({ remote_update: true })).toEqual({ ok: true });

    expect((await upgrade()).status).toBe(200);
    await beat({ remote_update: true });
    clock.advance(14 * 60);
    expect((await machine()).command.status).toBe("delivered");
    clock.advance(2 * 60);
    expect((await machine()).command).toMatchObject({ status: "failed", message: "no report from the collector" });
    expect((await upgrade()).status).toBe(200);
  });

  test("expiry is applied when commands are listed directly too", () => {
    h.db.run(
      "INSERT INTO machine_commands (id, machine, command, target_version, status, created_at) VALUES ('a', 'laptop', 'update', '9.9.9', 'pending', '2020-01-01T00:00:00.000Z')",
    );
    expect(expireCommands(h.db, new Date("2020-01-03T00:00:00.000Z"))).toBe(1);
    expect(commandRow().status).toBe("expired");
  });

  test("the database allows one open command per machine", () => {
    const insert = () =>
      h.db.run("INSERT INTO machine_commands (id, machine, command, target_version, created_at) VALUES (?, 'laptop', 'update', '9.9.9', 'now')", [
        crypto.randomUUID(),
      ]);
    insert();
    expect(insert).toThrow();
  });

  test("publishes machines on every change", async () => {
    const seen: string[] = [];
    const stop = events.subscribe((n) => void seen.push(n.topic));
    try {
      await beat({ remote_update: true });
      seen.length = 0;
      await upgrade();
      expect(seen).toContain("machines");
      seen.length = 0;
      await beat({ remote_update: true });
      expect(seen).toContain("machines");
    } finally {
      stop();
    }
  });
});

describe("requesting an update from the admin page", () => {
  test("refuses with 409 when the machine is not outdated, has remote updates off, or already has a command", async () => {
    await beat({ remote_update: true }, VERSION);
    const current = await upgrade();
    expect(current.status).toBe(409);
    expect(((await current.json()) as Body).error).toContain("not older");

    await beat({ remote_update: false });
    const off = await upgrade();
    expect(off.status).toBe(409);
    expect(((await off.json()) as Body).error).toContain("not turned on");

    await beat({ remote_update: true });
    expect((await upgrade()).status).toBe(200);
    const busy = await upgrade();
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as Body).error).toContain("already in progress");
    expect(h.db.query("SELECT 1 FROM machine_commands").all().length).toBe(1);
  });

  test("a retired machine cannot be sent a command it would never pick up", async () => {
    await beat({ remote_update: true });
    h.db.run("UPDATE tokens SET revoked_at = '2001-01-01T00:00:00.000Z' WHERE machine = 'laptop'");
    const retired = await upgrade();
    expect(retired.status).toBe(409);
    expect(((await retired.json()) as Body).error).toContain("no active token");
    expect(h.db.query("SELECT 1 FROM machine_commands").all().length).toBe(0);
  });

  test("an unknown machine is a 404, and signing in and the CSRF header are required", async () => {
    expect((await upgrade("ghost")).status).toBe(404);
    const noSession = await clock.app.request("/admin/api/machines/laptop/update", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Retrospecticus-Admin": "1" },
      body: "{}",
    });
    expect(noSession.status).toBe(401);
    const noHeader = await clock.app.request("/admin/api/machines/laptop/update", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: "{}",
    });
    expect(noHeader.status).toBe(403);
  });

  test("upgrade all outdated requests every eligible machine and counts them", async () => {
    const other = h.token("ingest", "desk");
    const current = h.token("ingest", "fresh");
    const send = (bearer: string, body: Body) =>
      clock.app.request(HEARTBEAT_PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sources: [], ...body }),
      });
    await beat({ remote_update: true });
    await send(other, { collector_version: "0.0.1", remote_update: false });
    await send(current, { collector_version: VERSION, remote_update: true });

    const res = await adminPost(clock.app, "/admin/api/machines/update-outdated", cookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Body).count).toBe(1);
    expect((await machine("laptop")).command.status).toBe("pending");
    expect((await machine("desk")).command).toBeNull();
    expect((await machine("fresh")).command).toBeNull();

    const again = await adminPost(clock.app, "/admin/api/machines/update-outdated", cookie);
    expect(((await again.json()) as Body).count).toBe(0);
  });
});
