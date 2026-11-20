import { resolveCollectorConfigPath } from "../config.ts";
import { LICENSE_NOTICES } from "@retrospecticus/shared/notices.ts";
import { COLLECTOR_VERSION } from "../heartbeat.ts";
import { parseFlags } from "./args.ts";
import { enroll } from "./enroll.ts";
import { UsageError, type CliEnv } from "./env.ts";
import { installService, uninstallService } from "./service.ts";
import { status } from "./status.ts";
import { enrolledWith, update } from "./update.ts";

const HELP = `retrospecticus-collector [command] [options]

Commands:
  run                 Upload transcripts until stopped (the default)
  enroll              Register this machine with a server and save its token
  install             Run the collector as a background service
  uninstall           Remove the background service
  update              Replace this binary with the server's version and restart the service
  status              Show the configuration, service and server state
  version             Print the version
  licenses            Print the licenses of this program and the software it contains
  help                Show this help

Options:
  run        --config <path>
  enroll     --server <url> [--machine <name>] [--install | --no-install] [--config <path>] [--force]
  install    [--config <path>]
  uninstall  [--purge] [--config <path>]
  update     [--config <path>] [--force]
  status     [--config <path>]

The config defaults to $RETROSPECTICUS_COLLECTOR_CONFIG or ~/.config/retrospecticus/collector.json.
Exit codes: 0 success, 1 failure, 2 usage error.`;

async function dispatch(argv: readonly string[], env: CliEnv): Promise<number> {
  const [first, ...rest] = argv;
  if (first === undefined || (first.startsWith("-") && !["--help", "-h", "--version", "-v"].includes(first))) {
    return runCommand(argv, env);
  }
  if (first === "--help" || first === "-h" || first === "help") {
    env.out(HELP);
    return 0;
  }
  if (first === "--version" || first === "-v" || first === "version") {
    env.out(`retrospecticus-collector ${COLLECTOR_VERSION}`);
    return 0;
  }
  if (first === "licenses") {
    env.out(LICENSE_NOTICES);
    return 0;
  }

  switch (first) {
    case "run":
      return runCommand(rest, env);
    case "enroll": {
      const { values, bools } = parseFlags(rest, { values: ["server", "machine", "config"], bools: ["install", "no-install", "force"] });
      if (bools.has("help")) return help(env);
      if (bools.has("install") && bools.has("no-install")) throw new UsageError("--install and --no-install cannot be combined");
      return enroll(env, {
        server: values.server,
        machine: values.machine,
        config: values.config,
        install: bools.has("install") ? true : bools.has("no-install") ? false : undefined,
        force: bools.has("force"),
      });
    }
    case "install": {
      const { values, bools } = parseFlags(rest, { values: ["config"] });
      if (bools.has("help")) return help(env);
      return installService(env, resolveCollectorConfigPath(values.config, { env: env.env, home: env.home }));
    }
    case "uninstall": {
      const { values, bools } = parseFlags(rest, { values: ["config"], bools: ["purge"] });
      if (bools.has("help")) return help(env);
      const configPath = resolveCollectorConfigPath(values.config, { env: env.env, home: env.home });
      return uninstallService(env, configPath, { purge: bools.has("purge") });
    }
    case "update": {
      const { values, bools } = parseFlags(rest, { values: ["config"], bools: ["restart-only", "force"] });
      if (bools.has("help")) return help(env);
      return update(env, { config: values.config, restartOnly: bools.has("restart-only"), force: bools.has("force") });
    }
    case "status": {
      const { values, bools } = parseFlags(rest, { values: ["config", "enrolled-with"] });
      if (bools.has("help")) return help(env);
      if (values["enrolled-with"] !== undefined) return enrolledWith(env, values.config, values["enrolled-with"]);
      return status(env, values.config);
    }
    default:
      throw new UsageError(`unknown command "${first}"`);
  }
}

function help(env: CliEnv): number {
  env.out(HELP);
  return 0;
}

function runCommand(args: readonly string[], env: CliEnv): Promise<number> | number {
  const { values, bools } = parseFlags(args, { values: ["config"] });
  if (bools.has("help")) return help(env);
  return env.runCollector(values.config);
}

const oneLine = (message: string) =>
  message
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("; ");

/** Never throws: every failure becomes a one-line message and an exit code. */
export async function runCli(argv: readonly string[], env: CliEnv): Promise<number> {
  try {
    return await dispatch(argv, env);
  } catch (err) {
    const message = oneLine(err instanceof Error ? err.message : String(err));
    env.err(`retrospecticus-collector: ${message}`);
    if (err instanceof UsageError) {
      env.err("Run `retrospecticus-collector help` for usage.");
      return 2;
    }
    return 1;
  }
}
