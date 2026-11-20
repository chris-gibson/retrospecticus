import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadCollectorConfig } from "../src/config.ts";
import { runCli } from "../src/cli/index.ts";
import { defaultMachineName } from "../src/cli/enroll.ts";
import { servicePaths } from "../src/cli/service.ts";
import { COLLECTOR_VERSION } from "../src/heartbeat.ts";
import { createCli, fakeServer, type FakeServer, type TestCli } from "./cli-harness.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup(overrides: Parameters<typeof createCli>[0] = {}): { cli: TestCli; server: FakeServer } {
  const cli = createCli(overrides);
  const server = fakeServer();
  cleanups.push(cli.cleanup, server.stop);
  return { cli, server };
}

const mode = (path: string) => statSync(path).mode & 0o777;
const text = (lines: string[]) => lines.join("\n");

describe("enroll", () => {
  test("happy path writes token and config, verifies, prints instructions without a flag on non-TTY", async () => {
    const { cli, server } = setup();
    const code = await runCli(["enroll", "--server", server.url], cli.env);
    expect(code).toBe(0);

    const tokenFile = join(cli.home, ".config/retrospecticus/ingest-token");
    expect(readFileSync(tokenFile, "utf8")).toBe("rt_faketoken123\n");
    expect(mode(tokenFile)).toBe(0o600);
    expect(mode(dirname(tokenFile))).toBe(0o700);

    const config = loadCollectorConfig(cli.configPath, { home: cli.home, env: {} });
    expect(config.server_url).toBe(server.url);
    expect(config.machine).toBe("testbox");
    expect(config.token_file).toBe(tokenFile);

    expect(server.starts[0]).toEqual({
      machine: "my-box",
      hostname: "my-box.local",
      platform: "linux-x64",
      collector_version: COLLECTOR_VERSION,
    });
    expect(server.heartbeats).toEqual([{ authorization: "Bearer rt_faketoken123", machine: "testbox" }]);

    const out = text(cli.out);
    expect(out).toContain(`Approve this machine at ${server.url}/admin`);
    expect(out).toContain("Code: WDJB-MJHT   (expires in 10 minutes)");
    expect(out).toContain("Waiting for approval...");
    expect(out).toContain("the server accepted a heartbeat");
    expect(out).toContain("systemctl --user restart retrospecticus-collector");
    expect(cli.commands).toEqual([]);
    expect(existsSync(servicePaths(cli.home).unit)).toBe(false);
  });

  test("--install installs the service", async () => {
    const { cli, server } = setup();
    expect(await runCli(["enroll", "--server", server.url, "--machine", "testbox", "--install"], cli.env)).toBe(0);
    expect(existsSync(servicePaths(cli.home).unit)).toBe(true);
    expect(cli.commands).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "retrospecticus-collector"],
      ["systemctl", "--user", "restart", "retrospecticus-collector"],
    ]);
  });

  test("--no-install on a TTY prints instructions and does not ask", async () => {
    const { cli, server } = setup({ isTTY: true });
    cli.answers.push("testbox");
    expect(await runCli(["enroll", "--server", server.url, "--no-install"], cli.env)).toBe(0);
    expect(cli.prompts).toEqual(["Machine name [my-box]: "]);
    expect(cli.commands).toEqual([]);
    expect(text(cli.out)).toContain("do this by hand");
  });

  test("TTY prompts for the machine name and the service", async () => {
    const { cli, server } = setup({ isTTY: true });
    cli.answers.push("", "y");
    expect(await runCli(["enroll", "--server", server.url], cli.env)).toBe(0);
    expect(cli.prompts).toEqual(["Machine name [my-box]: ", "Install as a background service that starts at login? [Y/n] "]);
    expect(server.starts[0]!.machine).toBe("my-box");
    expect(cli.commands.length).toBe(3);
  });

  test("declining the service prompt installs nothing", async () => {
    const { cli, server } = setup({ isTTY: true });
    cli.answers.push("testbox", "n");
    expect(await runCli(["enroll", "--server", server.url], cli.env)).toBe(0);
    expect(cli.commands).toEqual([]);
  });

  test("Ctrl-D at the service prompt declines instead of installing or failing", async () => {
    const { cli, server } = setup({ isTTY: true });
    cli.answers.push("testbox", null);
    expect(await runCli(["enroll", "--server", server.url], cli.env)).toBe(0);
    expect(cli.commands).toEqual([]);
    expect(existsSync(cli.configPath)).toBe(true);
  });

  test("Ctrl-D at the machine name prompt cancels before anything is written", async () => {
    const { cli, server } = setup({ isTTY: true });
    cli.answers.push(null);
    expect(await runCli(["enroll", "--server", server.url], cli.env)).toBe(1);
    expect(server.starts).toEqual([]);
    expect(existsSync(cli.configPath)).toBe(false);
  });

  test("denied writes nothing", async () => {
    const { cli, server } = setup();
    server.pollScript = [{ status: "denied" }];
    expect(await runCli(["enroll", "--server", server.url, "--machine", "testbox"], cli.env)).toBe(1);
    expect(text(cli.err)).toContain("denied");
    expect(existsSync(join(cli.home, ".config"))).toBe(false);
  });

  test("expired", async () => {
    const { cli, server } = setup();
    server.pollScript = [{ status: "pending" }, { status: "expired" }];
    expect(await runCli(["enroll", "--server", server.url, "--machine", "testbox"], cli.env)).toBe(1);
    expect(text(cli.err)).toContain("expired");
  });

  test("times out when the request never resolves", async () => {
    const { cli, server } = setup();
    server.pollScript = [{ status: "pending" }];
    expect(await runCli(["enroll", "--server", server.url, "--machine", "testbox"], cli.env)).toBe(1);
    expect(text(cli.err)).toContain("Timed out");
    expect(server.polls).toBe(200);
  });

  test("tolerates transient poll failures", async () => {
    const { cli, server } = setup();
    server.pollScript = [
      { garbage: true },
      { http: 503 },
      { http: 429 },
      { status: "pending" },
      { status: "approved", token: "rt_faketoken123", machine: "testbox" },
    ];
    expect(await runCli(["enroll", "--server", server.url, "--machine", "testbox"], cli.env)).toBe(0);
    expect(server.polls).toBe(5);
    expect(cli.err.filter((line) => line.includes("still trying")).length).toBe(1);
  });

  test("server unreachable", async () => {
    const { cli, server } = setup();
    server.stop();
    expect(await runCli(["enroll", "--server", server.url, "--machine", "testbox"], cli.env)).toBe(1);
    expect(cli.err[0]).toContain("Cannot reach");
    expect(cli.err.length).toBe(1);
  });

  test("429 and 400 get friendly messages", async () => {
    const { cli, server } = setup();
    server.startStatus = 429;
    expect(await runCli(["enroll", "--server", server.url, "--machine", "testbox"], cli.env)).toBe(1);
    expect(cli.err[0]).toContain("too many pending");
    server.startStatus = 400;
    server.startBody = JSON.stringify({ error: "machine already enrolled" });
    cli.err.length = 0;
    expect(await runCli(["enroll", "--server", server.url, "--machine", "testbox"], cli.env)).toBe(1);
    expect(cli.err[0]).toContain("machine already enrolled");
  });

  test("Ctrl-C while waiting exits cleanly", async () => {
    const { cli, server } = setup();
    server.pollScript = [{ status: "pending" }];
    const env = { ...cli.env, sleep: async () => cli.abort() };
    expect(await runCli(["enroll", "--server", server.url, "--machine", "testbox"], env)).toBe(1);
    expect(text(cli.out)).toContain("Cancelled.");
    expect(cli.err).toEqual([]);
  });

  test("an existing config keeps its other settings", async () => {
    const { cli, server } = setup();
    mkdirSync(dirname(cli.configPath), { recursive: true });
    writeFileSync(
      cli.configPath,
      JSON.stringify({
        server_url: "http://old:1",
        machine: "old",
        poll_seconds: 5,
        token_file: "/elsewhere/token",
        sources: [{ name: "codex", root: "/data/codex" }],
      }),
    );
    expect(await runCli(["enroll", "--server", server.url, "--machine", "testbox"], cli.env)).toBe(0);
    const raw = JSON.parse(readFileSync(cli.configPath, "utf8"));
    expect(raw.poll_seconds).toBe(5);
    expect(raw.sources).toEqual([{ name: "codex", root: "/data/codex" }]);
    expect(raw.machine).toBe("testbox");
    expect(statSync(cli.configPath).mode & 0o777).toBe(0o600);
    const config = loadCollectorConfig(cli.configPath, { home: cli.home, env: {} });
    expect(config.server_url).toBe(server.url);
    expect(config.poll_seconds).toBe(5);
    expect(config.sources.map((s) => s.root)).toEqual(["/data/codex"]);
    expect(readdirSync(dirname(cli.configPath)).filter((f) => f.includes(".bak-") || f.includes(".tmp-"))).toEqual([]);
  });

  test("a fresh config has the four keys, no sources, 2-space indent and a trailing newline", async () => {
    const { cli, server } = setup();
    expect(await runCli(["enroll", "--server", server.url, "--machine", "testbox"], cli.env)).toBe(0);
    const text = readFileSync(cli.configPath, "utf8");
    expect(Object.keys(JSON.parse(text))).toEqual(["server_url", "machine", "token_file", "state_file"]);
    expect(text).toContain('\n  "machine"');
    expect(text.endsWith("}\n")).toBe(true);
    expect(statSync(cli.configPath).mode & 0o777).toBe(0o600);
  });

  test("--force backs up and writes fresh", async () => {
    const { cli, server } = setup();
    mkdirSync(dirname(cli.configPath), { recursive: true });
    writeFileSync(cli.configPath, JSON.stringify({ poll_seconds: 5, server_url: "http://old:1" }));
    expect(await runCli(["enroll", "--server", server.url, "--machine", "testbox", "--force"], cli.env)).toBe(0);
    const backups = readdirSync(dirname(cli.configPath)).filter((f) => f.startsWith("collector.json.bak-"));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(dirname(cli.configPath), backups[0]!), "utf8")).toContain('"poll_seconds":5');
    expect(loadCollectorConfig(cli.configPath, { home: cli.home, env: {} }).poll_seconds).toBe(30);
  });

  test("invalid JSON in the existing config is backed up even without --force", async () => {
    const { cli, server } = setup();
    mkdirSync(dirname(cli.configPath), { recursive: true });
    writeFileSync(cli.configPath, "{ not json");
    expect(await runCli(["enroll", "--server", server.url, "--machine", "testbox"], cli.env)).toBe(0);
    const backups = readdirSync(dirname(cli.configPath)).filter((f) => f.startsWith("collector.json.bak-"));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(dirname(cli.configPath), backups[0]!), "utf8")).toBe("{ not json");
    expect(loadCollectorConfig(cli.configPath, { home: cli.home, env: {} }).machine).toBe("testbox");
  });

  test("honours --config and the environment variable", async () => {
    const { cli, server } = setup();
    const custom = join(cli.home, "custom", "c.json");
    expect(await runCli(["enroll", "--server", server.url, "--machine", "testbox", "--config", custom], cli.env)).toBe(0);
    expect(existsSync(custom)).toBe(true);

    const viaEnv = join(cli.home, "env", "c.json");
    const second = { ...cli.env, env: { RETROSPECTICUS_COLLECTOR_CONFIG: viaEnv } };
    server.pollScript = [{ status: "approved", token: "rt_faketoken123", machine: "testbox" }];
    expect(await runCli(["enroll", "--server", server.url, "--machine", "testbox"], second)).toBe(0);
    expect(existsSync(viaEnv)).toBe(true);
  });

  test("usage errors", async () => {
    const { cli } = setup();
    expect(await runCli(["enroll"], cli.env)).toBe(2);
    expect(await runCli(["enroll", "--server", "not a url"], cli.env)).toBe(2);
    expect(await runCli(["enroll", "--server", "ftp://x"], cli.env)).toBe(2);
    expect(await runCli(["enroll", "--server", "http://x", "--machine", "bad name"], cli.env)).toBe(2);
    expect(await runCli(["enroll", "--server", "http://x", "--install", "--no-install"], cli.env)).toBe(2);
    expect(await runCli(["enroll", "--server"], cli.env)).toBe(2);
  });

  test("default machine names are sanitised", () => {
    expect(defaultMachineName("Chris's MacBook Pro.local")).toBe("Chris-s-MacBook-Pro");
    expect(defaultMachineName("---")).toBe("machine");
    expect(defaultMachineName("a".repeat(100)).length).toBe(63);
  });
});

async function configured(cli: TestCli, server: FakeServer): Promise<void> {
  expect(await runCli(["enroll", "--server", server.url, "--machine", "testbox", "--no-install"], cli.env)).toBe(0);
  cli.out.length = 0;
  cli.err.length = 0;
}

describe("install", () => {
  test("linux: copies the binary, writes the unit, runs systemctl", async () => {
    const { cli, server } = setup();
    await configured(cli, server);
    expect(await runCli(["install"], cli.env)).toBe(0);

    const paths = servicePaths(cli.home);
    expect(readFileSync(paths.binary, "utf8")).toContain("echo fake");
    expect(mode(paths.binary)).toBe(0o755);
    const unit = readFileSync(paths.unit, "utf8");
    expect(unit).toContain(`ExecStart=${paths.binary} run --config ${cli.configPath}`);
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("RestartSec=10");
    expect(unit).toContain("WantedBy=default.target");
    expect(cli.commands).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "retrospecticus-collector"],
      ["systemctl", "--user", "restart", "retrospecticus-collector"],
    ]);
    expect(text(cli.out)).toContain("loginctl enable-linger $USER");
  });

  test("skips the copy when already running from the install path", async () => {
    const { cli, server } = setup();
    const target = servicePaths(cli.home).binary;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "installed");
    const env = { ...cli.env, execPath: target };
    await configured({ ...cli, env } as TestCli, server);
    expect(await runCli(["install"], env)).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("installed");
    expect(text(cli.out)).not.toContain("Installed ");
  });

  test("from source it points the service at bun and main.ts without copying", async () => {
    const { cli, server } = setup({ isCompiled: false, execPath: "/usr/bin/bun", mainPath: "/work/main.ts" });
    await configured(cli, server);
    expect(await runCli(["install"], cli.env)).toBe(0);
    expect(existsSync(servicePaths(cli.home).binary)).toBe(false);
    expect(readFileSync(servicePaths(cli.home).unit, "utf8")).toContain(
      `ExecStart=/usr/bin/bun /work/main.ts run --config ${cli.configPath}`,
    );
    expect(text(cli.out)).toContain("Running from source");
  });

  test("darwin: writes the plist and bootstraps", async () => {
    const { cli, server } = setup({ platform: "darwin", uid: 501 });
    await configured(cli, server);
    cli.commands.length = 0;
    expect(await runCli(["install"], cli.env)).toBe(0);
    const paths = servicePaths(cli.home);
    const plist = readFileSync(paths.plist, "utf8");
    expect(plist).toContain("<string>com.retrospecticus.collector</string>");
    expect(plist).toContain(`<string>${paths.binary}</string>`);
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain(`<string>${cli.configPath}</string>`);
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain(`<string>${join(cli.home, "Library/Logs/retrospecticus-collector.log")}</string>`);
    expect(existsSync(join(cli.home, "Library/Logs"))).toBe(true);
    expect(cli.commands).toEqual([
      ["launchctl", "bootout", "gui/501/com.retrospecticus.collector"],
      ["launchctl", "bootstrap", "gui/501", paths.plist],
    ]);
  });

  test("darwin: a failing bootout is ignored but a failing bootstrap is not", async () => {
    const { cli, server } = setup({ platform: "darwin", uid: 501 });
    await configured(cli, server);
    cli.results.set("launchctl bootout", { code: 3, stdout: "", stderr: "not loaded" });
    expect(await runCli(["install"], cli.env)).toBe(0);
    cli.results.set("launchctl bootstrap", { code: 5, stdout: "", stderr: "Bootstrap failed: 5" });
    expect(await runCli(["install"], cli.env)).toBe(1);
    expect(cli.err.at(-1)).toContain("Bootstrap failed");
  });

  test("a failing systemctl is a one-line error", async () => {
    const { cli, server } = setup();
    await configured(cli, server);
    cli.results.set("systemctl --user", { code: 1, stdout: "", stderr: "Failed to connect to bus\nmore" });
    expect(await runCli(["install"], cli.env)).toBe(1);
    expect(cli.err).toEqual([expect.stringContaining("Failed to connect to bus")]);
  });

  test("other platforms get manual instructions", async () => {
    const { cli, server } = setup();
    await configured(cli, server);
    const env = { ...cli.env, platform: "win32" };
    expect(await runCli(["install"], env)).toBe(1);
    expect(text(cli.out)).toContain("only supported on Linux and macOS");
    expect(text(cli.out)).toContain(`run --config ${cli.configPath}`);
    expect(cli.commands).toEqual([]);
  });

  test("requires an existing config", async () => {
    const { cli } = setup();
    expect(await runCli(["install"], cli.env)).toBe(1);
    expect(cli.err[0]).toContain("enroll");
  });
});

describe("uninstall", () => {
  test("removes the unit and keeps everything else", async () => {
    const { cli, server } = setup();
    await configured(cli, server);
    await runCli(["install"], cli.env);
    cli.commands.length = 0;
    expect(await runCli(["uninstall"], cli.env)).toBe(0);
    expect(cli.commands).toEqual([
      ["systemctl", "--user", "disable", "--now", "retrospecticus-collector"],
      ["systemctl", "--user", "daemon-reload"],
    ]);
    const paths = servicePaths(cli.home);
    expect(existsSync(paths.unit)).toBe(false);
    expect(existsSync(cli.configPath)).toBe(true);
    expect(existsSync(paths.binary)).toBe(true);
  });

  test("--purge also removes config, token, state and the installed binary", async () => {
    const { cli, server } = setup();
    await configured(cli, server);
    await runCli(["install"], cli.env);
    const config = loadCollectorConfig(cli.configPath, { home: cli.home, env: {} });
    mkdirSync(dirname(config.state_file), { recursive: true });
    writeFileSync(config.state_file, "{}");
    expect(await runCli(["uninstall", "--purge"], cli.env)).toBe(0);
    for (const path of [config.token_file, config.state_file, cli.configPath, servicePaths(cli.home).binary]) {
      expect(existsSync(path)).toBe(false);
    }
  });

  test("darwin removes the plist", async () => {
    const { cli, server } = setup({ platform: "darwin", uid: 501 });
    await configured(cli, server);
    await runCli(["install"], cli.env);
    cli.commands.length = 0;
    expect(await runCli(["uninstall"], cli.env)).toBe(0);
    expect(cli.commands).toEqual([["launchctl", "bootout", "gui/501/com.retrospecticus.collector"]]);
    expect(existsSync(servicePaths(cli.home).plist)).toBe(false);
  });

  test("when nothing is installed it says so", async () => {
    const { cli } = setup();
    expect(await runCli(["uninstall"], cli.env)).toBe(0);
    expect(text(cli.out)).toContain("No systemd service installed");
    expect(cli.commands).toEqual([]);
  });
});

describe("status", () => {
  test("reports config, service and reachability", async () => {
    const { cli, server } = setup();
    await configured(cli, server);
    await runCli(["install"], cli.env);
    cli.out.length = 0;
    cli.results.set("systemctl --user", { code: 0, stdout: "active\n", stderr: "" });
    expect(await runCli(["status"], cli.env)).toBe(0);
    const out = text(cli.out);
    expect(out).toContain(cli.configPath);
    expect(out).toContain("active");
    expect(out).toContain(`Server:  ${server.url}`);
    expect(out).toContain("Machine: testbox");
    expect(out).toContain("Reachable: yes");
    expect(out).toContain("Status page: http://127.0.0.1:7879/");
  });

  test("an unreachable server and a missing config", async () => {
    const { cli, server } = setup();
    await configured(cli, server);
    server.stop();
    cli.out.length = 0;
    expect(await runCli(["status"], cli.env)).toBe(0);
    expect(text(cli.out)).toContain("Reachable: no");
    cli.out.length = 0;
    expect(await runCli(["status", "--config", join(cli.home, "missing.json")], cli.env)).toBe(1);
    expect(text(cli.out)).toContain("Config problem");
  });
});

describe("dispatch", () => {
  test("version and help", async () => {
    const { cli } = setup();
    expect(await runCli(["version"], cli.env)).toBe(0);
    expect(cli.out[0]).toBe(`retrospecticus-collector ${COLLECTOR_VERSION}`);
    for (const args of [["help"], ["--help"], ["-h"], ["enroll", "--help"]]) {
      cli.out.length = 0;
      expect(await runCli(args, cli.env)).toBe(0);
      expect(cli.out[0]).toContain("retrospecticus-collector [command]");
    }
  });

  test("unknown command and options are usage errors", async () => {
    const { cli } = setup();
    expect(await runCli(["frobnicate"], cli.env)).toBe(2);
    expect(cli.err[0]).toContain('unknown command "frobnicate"');
    expect(await runCli(["status", "--bogus"], cli.env)).toBe(2);
    expect(await runCli(["status", "extra"], cli.env)).toBe(2);
    expect(await runCli(["uninstall", "--purge=1"], cli.env)).toBe(2);
  });

  test("run is the default, with the legacy --config form", async () => {
    const calls: (string | undefined)[] = [];
    const { cli } = setup({
      runCollector: async (config) => {
        calls.push(config);
        return 0;
      },
    });
    expect(await runCli([], cli.env)).toBe(0);
    expect(await runCli(["--config", "/a.json"], cli.env)).toBe(0);
    expect(await runCli(["--config=/b.json"], cli.env)).toBe(0);
    expect(await runCli(["run", "--config", "/c.json"], cli.env)).toBe(0);
    expect(calls).toEqual([undefined, "/a.json", "/b.json", "/c.json"]);
  });

  test("errors from run become one line", async () => {
    const { cli } = setup({
      runCollector: async () => {
        throw new Error("Cannot read config file /x\n  at stack");
      },
    });
    expect(await runCli(["run"], cli.env)).toBe(1);
    expect(cli.err).toEqual(["retrospecticus-collector: Cannot read config file /x; at stack"]);
  });
});
