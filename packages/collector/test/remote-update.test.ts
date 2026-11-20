import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { HEARTBEAT_PATH } from "@retrospecticus/shared";
import { createUpdateCommand } from "../../server/src/db/commands.ts";
import { getMachine } from "../../server/src/db/machines.ts";
import { sendHeartbeat } from "../src/heartbeat.ts";
import { createRemoteUpdater, lastUsefulLine, type RemoteUpdaterOptions, type UpdateRunResult } from "../src/remote-update.ts";
import { Uploader } from "../src/uploader.ts";
import { createEnv, MACHINE, waitFor, type TestEnv } from "./harness.ts";

const command = { id: "c1", command: "update" as const, version: "9.9.9" };
const quiet = { info() {}, warn() {}, error() {} };

function updater(overrides: Partial<RemoteUpdaterOptions> & { result?: UpdateRunResult } = {}) {
  const calls: string[] = [];
  const { result, ...rest } = overrides;
  const remote = createRemoteUpdater({
    enabled: () => true,
    compiled: true,
    configPath: "/cfg/collector.json",
    graceMs: 1,
    log: quiet,
    sleep: async () => {},
    run: async (configPath) => {
      calls.push(configPath);
      return result ?? { code: 0, output: "Restarted the service.\n" };
    },
    ...rest,
  });
  return { remote, calls };
}

describe("lastUsefulLine", () => {
  test("takes the last non-empty line and drops the program prefix", () => {
    expect(lastUsefulLine("Updating 1 -> 2\nretrospecticus-collector: Checksum mismatch; not installing.\n\n")).toBe("Checksum mismatch; not installing.");
    expect(lastUsefulLine("\n  \n")).toBe("");
  });
});

describe("remote updater decisions", () => {
  test("runs update with this collector's config and, when this process survives it, reports that", async () => {
    const { remote, calls } = updater({ result: { code: 0, output: "No service is installed; restart the collector yourself.\n" } });
    remote.handle(command);
    await remote.idle();
    expect(calls).toEqual(["/cfg/collector.json"]);
    expect(remote.pendingResult()).toEqual({ id: "c1", ok: false, message: "No service is installed; restart the collector yourself." });
  });

  test("a non-zero exit reports the last useful line", async () => {
    const { remote } = updater({ result: { code: 1, output: "Updating\nretrospecticus-collector: Checksum mismatch for x; not installing.\n" } });
    remote.handle(command);
    await remote.idle();
    expect(remote.pendingResult()).toEqual({ id: "c1", ok: false, message: "Checksum mismatch for x; not installing." });
  });

  test("a runner that cannot start is a failure, not a crash", async () => {
    const { remote } = updater({
      run: async () => {
        throw new Error("ENOENT");
      },
    });
    remote.handle(command);
    await remote.idle();
    expect(remote.pendingResult()?.message).toContain("ENOENT");
  });

  test("a clean exit is not reported while the grace period is still running", async () => {
    let release!: () => void;
    const { remote } = updater({ sleep: () => new Promise<void>((resolve) => (release = resolve)) });
    remote.handle(command);
    await Promise.resolve();
    await Promise.resolve();
    expect(remote.pendingResult()).toBeNull();
    release();
    await remote.idle();
    expect(remote.pendingResult()).not.toBeNull();
  });

  test("refuses commands when remote updates are off, and says so once", async () => {
    const { remote, calls } = updater({ enabled: () => false });
    remote.handle(command);
    remote.handle(command);
    await remote.idle();
    expect(calls).toEqual([]);
    expect(remote.pendingResult()).toEqual({ id: "c1", ok: false, message: "remote updates are turned off on this machine" });
  });

  test("a command handed out again is not run twice", async () => {
    const { remote, calls } = updater({ result: { code: 1, output: "boom" } });
    remote.handle(command);
    await remote.idle();
    remote.handle(command);
    await remote.idle();
    expect(calls).toHaveLength(1);
  });

  test("from source it reports instead of running", async () => {
    const { remote, calls } = updater({ compiled: false });
    remote.handle(command);
    await remote.idle();
    expect(calls).toEqual([]);
    expect(remote.pendingResult()).toEqual({ id: "c1", ok: false, message: "running from source" });
  });

  test("never runs two updates at once", async () => {
    let release!: (r: UpdateRunResult) => void;
    const calls: string[] = [];
    const { remote } = updater({
      run: (path) => {
        calls.push(path);
        return new Promise<UpdateRunResult>((resolve) => (release = resolve));
      },
    });
    remote.handle(command);
    remote.handle({ ...command, id: "c2" });
    expect(calls.length).toBe(1);
    release({ code: 1, output: "boom" });
    await remote.idle();
    expect(remote.pendingResult()?.id).toBe("c1");
  });

  test("acknowledging the reported result clears it, and another command's result stays", async () => {
    const { remote } = updater({ result: { code: 1, output: "boom" } });
    remote.handle(command);
    await remote.idle();
    remote.acknowledge({ id: "other", ok: false, message: "x" });
    expect(remote.pendingResult()).not.toBeNull();
    remote.acknowledge(remote.pendingResult()!);
    expect(remote.pendingResult()).toBeNull();
  });
});

describe("with a real server", () => {
  let env: TestEnv;
  beforeEach(() => {
    env = createEnv();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  const row = () => env.server.db.query<{ status: string; message: string | null }, []>("SELECT * FROM machine_commands").get();

  test("only the server's own ok answer counts, and an oversized answer is refused", async () => {
    let answer: Response = new Response("<html>gateway</html>", { status: 200 });
    const fake = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => answer });
    try {
      const uploader = new Uploader({ serverUrl: `http://127.0.0.1:${fake.port}`, token: "t", machine: MACHINE, requestTimeoutMs: 2000 });
      const send = () => sendHeartbeat(uploader, [], baseFacts, new AbortController().signal);
      expect((await send()).error).toContain("unexpected answer");
      answer = Response.json({ ok: false });
      expect((await send()).error).toContain("unexpected answer");
      answer = new Response("x".repeat(70 * 1024), { status: 200 });
      expect((await send()).error).toContain("too large");
      answer = Response.json({ ok: true });
      expect(await send()).toEqual({ error: null, command: null });
    } finally {
      fake.stop(true);
    }
  });

  test("postJson returns the parsed body, and an error string otherwise", async () => {
    const config = env.config();
    const uploader = new Uploader({
      serverUrl: config.server_url,
      token: (await Bun.file(config.token_file).text()).trim(),
      machine: MACHINE,
      requestTimeoutMs: 5000,
    });
    const stop = new AbortController().signal;
    expect(await uploader.postJson(HEARTBEAT_PATH, { collector_version: "1.0.0", sources: [] }, stop)).toEqual({ ok: true, body: { ok: true } });
    const bad = await uploader.postJson(HEARTBEAT_PATH, { nope: 1 }, stop);
    expect(bad).toEqual({ ok: false, error: expect.stringContaining("HTTP 400") });
    const wrong = new Uploader({ serverUrl: config.server_url, token: "rt_wrong", machine: MACHINE, requestTimeoutMs: 5000 });
    expect((await wrong.postJson(HEARTBEAT_PATH, {}, stop)).ok).toBe(false);

    const outcome = await sendHeartbeat(uploader, [], { ...baseFacts, remote_update: true }, stop);
    expect(outcome).toEqual({ error: null, command: null });
  });

  const baseFacts = {
    hostname: "h",
    platform: "linux-x64",
    started_at: "2026-01-01T00:00:00.000Z",
    last_upload_at: null,
    last_scan_at: null,
    last_error: null,
    exec_path: null,
    remote_update: false,
  };

  /** The collector rereads remote_update from its config file, so these tests give it a real one. */
  function configFile(remoteUpdate: boolean): string {
    const path = join(env.dir, "collector.json");
    writeFileSync(path, JSON.stringify({ server_url: `http://127.0.0.1:${env.port}`, machine: MACHINE, token_file: join(env.dir, "token"), remote_update: remoteUpdate }));
    return path;
  }

  test("a delivered command runs update with the collector's config, and a failure reaches the server", async () => {
    const calls: string[] = [];
    const configPath = configFile(true);
    env
      .collector(
        { remote_update: true, heartbeat_seconds: 0.03 },
        {
          configPath,
          compiled: true,
          runUpdate: async (path) => {
            calls.push(path);
            return { code: 1, output: "retrospecticus-collector: Checksum mismatch; not installing.\n" };
          },
        },
      )
      .start();
    await waitFor(() => getMachine(env.server.db, MACHINE)?.remote_update === 1, "first heartbeat");
    createUpdateCommand(env.server.db, MACHINE, "99.0.0", new Date());
    await waitFor(() => row()?.status === "failed", "the failure to reach the server");
    expect(calls).toEqual([configPath]);
    expect(row()?.message).toBe("Checksum mismatch; not installing.");
  });

  test("turning remote updates off takes effect in a running collector without a restart", async () => {
    let ran = false;
    const configPath = configFile(true);
    env
      .collector(
        { remote_update: true, heartbeat_seconds: 0.03 },
        { configPath, compiled: true, runUpdate: async () => ((ran = true), { code: 0, output: "" }) },
      )
      .start();
    await waitFor(() => getMachine(env.server.db, MACHINE)?.remote_update === 1, "first heartbeat");
    configFile(false);
    await waitFor(() => getMachine(env.server.db, MACHINE)?.remote_update === 0, "a heartbeat reporting it off");
    createUpdateCommand(env.server.db, MACHINE, "99.0.0", new Date());
    await waitFor(() => row()?.status === "failed", "the server to fail the command");
    expect(ran).toBe(false);
  });

  test("a collector with remote updates off never runs the command; the server fails it", async () => {
    let ran = false;
    env
      .collector({ heartbeat_seconds: 0.03 }, { compiled: true, runUpdate: async () => ((ran = true), { code: 0, output: "" }) })
      .start();
    await waitFor(() => getMachine(env.server.db, MACHINE) !== null, "first heartbeat");
    createUpdateCommand(env.server.db, MACHINE, "99.0.0", new Date());
    await waitFor(() => row()?.status === "failed", "the server to fail the command");
    expect(row()?.message).toBe("remote updates are off on this machine");
    expect(ran).toBe(false);
  });

  test("from source the collector reports that it cannot update", async () => {
    env.collector({ remote_update: true, heartbeat_seconds: 0.03 }, { compiled: false }).start();
    await waitFor(() => getMachine(env.server.db, MACHINE)?.remote_update === 1, "first heartbeat");
    createUpdateCommand(env.server.db, MACHINE, "99.0.0", new Date());
    await waitFor(() => row()?.status === "failed", "the failure to reach the server");
    expect(row()?.message).toBe("running from source");
  });

  test("the heartbeat reports the opt-in", async () => {
    env.collector({ remote_update: true }).start();
    await waitFor(() => getMachine(env.server.db, MACHINE)?.remote_update === 1, "heartbeat with remote_update");
  });
});
