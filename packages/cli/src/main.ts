#!/usr/bin/env bun
import { ConfigError } from "@retrospecticus/server/config.ts";
import { UsageError, type Command, type CommandContext } from "./command.ts";

/** One line per command. Modules load lazily so a command only pays for what it imports. */
const commands: Record<string, () => Promise<{ default: Command }>> = {
  doctor: () => import("./commands/doctor.ts"),
  drift: () => import("./commands/drift.ts"),
  embedding: () => import("./commands/embedding.ts"),
  health: () => import("./commands/health.ts"),
  licenses: () => import("./commands/licenses.ts"),
  notify: () => import("./commands/notify.ts"),
  reembed: () => import("./commands/reembed.ts"),
  reindex: () => import("./commands/reindex.ts"),
  reparse: () => import("./commands/reparse.ts"),
  secrets: () => import("./commands/secrets.ts"),
  serve: () => import("./commands/serve.ts"),
  shapes: () => import("./commands/shapes.ts"),
  token: () => import("./commands/token.ts"),
};

export interface Io {
  out(line: string): void;
  err(line: string): void;
  stdin?: () => Promise<string>;
}

const processIo: Io = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

async function usage(): Promise<string> {
  const lines = ["Usage: retrospecticus [--config <path>] <command> [options]", "", "Commands:"];
  for (const name of Object.keys(commands).sort()) {
    const { default: command } = await commands[name]!();
    lines.push(`  ${name.padEnd(10)} ${command.summary}`);
  }
  lines.push(
    "",
    "The config path defaults to $RETROSPECTICUS_CONFIG, then /etc/retrospecticus/config.json; a missing file means",
    "every default. Secrets live in secrets.json beside it ($RETROSPECTICUS_SECRETS overrides).",
  );
  return lines.join("\n");
}

export async function run(argv: string[], io: Io = processIo): Promise<number> {
  const args = [...argv];
  let configPath: string | undefined;

  const first = args[0];
  if (first === "--config" || first === "-c") {
    configPath = args[1];
    if (configPath === undefined) {
      io.err("--config needs a path");
      return 2;
    }
    args.splice(0, 2);
  } else if (first?.startsWith("--config=")) {
    configPath = first.slice("--config=".length);
    args.shift();
  }

  const name = args.shift();
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    io.out(await usage());
    return name === undefined ? 2 : 0;
  }
  if (!Object.hasOwn(commands, name)) {
    io.err(`Unknown command: ${name}\n\n${await usage()}`);
    return 2;
  }

  const { default: command } = await commands[name]!();
  const ctx: CommandContext = { args, configPath, out: io.out, err: io.err, stdin: io.stdin };
  try {
    return await command.run(ctx);
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`${err.message}\n\n${command.usage}`);
      return 2;
    }
    if (err instanceof ConfigError) {
      io.err(err.message);
      return 1;
    }
    throw err;
  }
}

if (import.meta.main) {
  process.exit(await run(process.argv.slice(2)));
}
