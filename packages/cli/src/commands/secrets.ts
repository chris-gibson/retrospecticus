import { SECRET_NAMES, isSecretName, type SecretName } from "@retrospecticus/server/secrets.ts";
import { UsageError, storeFor, type Command, type CommandContext } from "../command.ts";

const usage = [
  "Usage:",
  "  retrospecticus secrets list",
  "  retrospecticus secrets set <name>      (reads the value from standard input)",
  "  retrospecticus secrets unset <name>",
  "",
  `Names: ${SECRET_NAMES.join(", ")}.`,
  "Values are never printed. Example: echo -n \"$KEY\" | retrospecticus secrets set embedding_api_key",
  "In Docker: docker exec -i retrospecticus retrospecticus secrets set embedding_api_key < key.txt",
].join("\n");

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write("Enter the value, then press Ctrl-D:\n");
  return Bun.stdin.text();
}

function secretName(raw: string | undefined): SecretName {
  if (raw === undefined) throw new UsageError("Missing <name>");
  if (!isSecretName(raw)) throw new UsageError(`Unknown secret "${raw}"; expected one of ${SECRET_NAMES.join(", ")}`);
  return raw;
}

function list(ctx: CommandContext): number {
  const store = storeFor(ctx);
  const status = store.secretStatus();
  const width = Math.max(...SECRET_NAMES.map((n) => n.length));
  for (const name of SECRET_NAMES) {
    const s = status[name];
    ctx.out(`${name.padEnd(width)}  ${s.set ? `set    updated ${s.updated_at}` : "unset"}`);
  }
  const problem = store.secretsPermissionProblem();
  if (problem !== null) ctx.err(`warning: ${problem}`);
  return 0;
}

async function set(ctx: CommandContext, name: SecretName): Promise<number> {
  const raw = await (ctx.stdin ?? readStdin)();
  // `echo` without -n adds one newline; anything beyond that is part of the value.
  const value = raw.replace(/\r?\n$/, "");
  if (value === "") {
    ctx.err(`No value on standard input; ${name} left unchanged.`);
    return 1;
  }
  const status = storeFor(ctx).setSecret(name, value);
  ctx.out(`${name} set (updated ${status.updated_at}).`);
  return 0;
}

function unset(ctx: CommandContext, name: SecretName): number {
  storeFor(ctx).setSecret(name, null);
  ctx.out(`${name} unset.`);
  return 0;
}

const command: Command = {
  summary: "List, set or unset the server's secrets",
  usage,
  async run(ctx) {
    const [sub, ...rest] = ctx.args;
    if (sub === "list") {
      if (rest.length > 0) throw new UsageError("secrets list takes no arguments");
      return list(ctx);
    }
    if (sub === "set" || sub === "unset") {
      if (rest.length !== 1) throw new UsageError(`secrets ${sub} needs exactly one <name>`);
      const name = secretName(rest[0]);
      return sub === "set" ? set(ctx, name) : unset(ctx, name);
    }
    throw new UsageError(sub === undefined ? "secrets needs a subcommand" : `Unknown subcommand: ${sub}`);
  },
};

export default command;
