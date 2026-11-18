import { parseArgs } from "node:util";
import { MACHINE_NAME_PATTERN, TOKEN_SCOPES } from "@retrospecticus/shared";
import { isTokenScope, issueToken } from "@retrospecticus/server/auth.ts";
import { listTokens, revokeToken, type TokenRow } from "@retrospecticus/server/db/tokens.ts";
import { UsageError, withDb, type Command, type CommandContext } from "../command.ts";

const usage = [
  "Usage:",
  `  retrospecticus token create --scope <${TOKEN_SCOPES.join("|")}> [--machine <m>] [--name <n>]`,
  "  retrospecticus token list",
  "  retrospecticus token revoke <id>",
].join("\n");

function parse<T extends NonNullable<Parameters<typeof parseArgs>[0]>["options"]>(args: string[], options: T, positionals: boolean) {
  try {
    return parseArgs({ args, options, allowPositionals: positionals, strict: true });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

async function create(ctx: CommandContext, args: string[]): Promise<number> {
  const { values } = parse(
    args,
    { scope: { type: "string" }, machine: { type: "string" }, name: { type: "string" } },
    false,
  );
  const { scope, machine, name } = values;
  if (typeof scope !== "string" || !isTokenScope(scope)) {
    throw new UsageError(`--scope must be one of: ${TOKEN_SCOPES.join(", ")}`);
  }
  if (typeof machine === "string" && !MACHINE_NAME_PATTERN.test(machine)) {
    throw new UsageError(`--machine is not a valid machine name: ${machine}`);
  }
  if (scope === "ingest" && typeof machine !== "string") {
    throw new UsageError("An ingest token needs --machine");
  }

  return withDb(ctx, (db) => {
    const { token, row } = issueToken(db, {
      scope,
      machine: typeof machine === "string" ? machine : undefined,
      name: typeof name === "string" ? name : undefined,
    });
    const binding = row.machine ? `, machine ${row.machine}` : "";
    ctx.err(`Created token ${row.id} "${row.name}" (${row.scope}${binding}). It is shown once; store it now.`);
    // The token is the only thing on stdout so it can be redirected straight into a 0600 file.
    ctx.out(token);
    return 0;
  });
}

function status(row: TokenRow): string {
  return row.revoked_at ? `revoked ${row.revoked_at}` : "active";
}

async function list(ctx: CommandContext, args: string[]): Promise<number> {
  parse(args, {}, false);
  return withDb(ctx, (db) => {
    const rows = listTokens(db);
    if (rows.length === 0) {
      ctx.out("No tokens.");
      return 0;
    }
    const table = [
      ["ID", "SCOPE", "MACHINE", "NAME", "CREATED", "LAST USED", "STATUS"],
      ...rows.map((r) => [
        String(r.id),
        r.scope,
        r.machine ?? "-",
        r.name,
        r.created_at,
        r.last_used_at ?? "never",
        status(r),
      ]),
    ];
    const widths = table[0]!.map((_, col) => Math.max(...table.map((line) => line[col]!.length)));
    for (const line of table) ctx.out(line.map((cell, col) => cell.padEnd(widths[col]!)).join("  ").trimEnd());
    return 0;
  });
}

async function revoke(ctx: CommandContext, args: string[]): Promise<number> {
  const { positionals } = parse(args, {}, true);
  const raw = positionals[0];
  if (positionals.length !== 1 || raw === undefined || !/^\d+$/.test(raw)) {
    throw new UsageError("revoke needs one numeric token id (see `token list`)");
  }
  const id = Number(raw);
  return withDb(ctx, (db) => {
    const result = revokeToken(db, id);
    if (result === "not-found") {
      ctx.err(`No token with id ${id}.`);
      return 1;
    }
    ctx.out(result === "revoked" ? `Revoked token ${id}.` : `Token ${id} was already revoked.`);
    return 0;
  });
}

const command: Command = {
  summary: "Create, list and revoke API tokens",
  usage,
  async run(ctx) {
    const [sub, ...rest] = ctx.args;
    switch (sub) {
      case "create":
        return create(ctx, rest);
      case "list":
        return list(ctx, rest);
      case "revoke":
        return revoke(ctx, rest);
      default:
        throw new UsageError(sub === undefined ? "token needs a subcommand" : `Unknown token subcommand: ${sub}`);
    }
  },
};

export default command;
