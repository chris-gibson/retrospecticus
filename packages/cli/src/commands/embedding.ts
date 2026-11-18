import { parseArgs } from "node:util";
import { activateModel, dropModel, getModel, listModels } from "@retrospecticus/server/db/vectors.ts";
import { UsageError, withDb, type Command, type CommandContext } from "../command.ts";

const usage = [
  "Usage:",
  "  retrospecticus embedding list",
  "  retrospecticus embedding activate <slug> [--force]",
  "  retrospecticus embedding drop <slug>",
  "",
  "activate switches search to <slug>. It refuses a model with no vectors unless --force is given;",
  "fill one first with `retrospecticus reembed --model <slug>`.",
  "drop deletes a model's vectors, e.g. after changing its document_prefix; a running server",
  "re-embeds its configured model from scratch. Search uses keywords alone until vectors return.",
].join("\n");

function list(ctx: CommandContext): Promise<number> {
  return withDb(ctx, (db) => {
    const models = listModels(db);
    if (models.length === 0) {
      ctx.out("No embedding models registered.");
      return 0;
    }
    const header = ["slug", "dimensions", "active", "vectors", "missing"];
    const rows = models.map((m) => [m.slug, String(m.dimensions), m.active ? "yes" : "", String(m.vectors), String(m.missing)]);
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
    for (const row of [header, ...rows]) ctx.out(row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd());
    return 0;
  });
}

function drop(ctx: CommandContext, slug: string): Promise<number> {
  return withDb(ctx, (db) => {
    const model = getModel(db, slug);
    if (!model) {
      ctx.err(`Unknown embedding model: ${slug}. See \`retrospecticus embedding list\`.`);
      return 1;
    }
    dropModel(db, slug);
    ctx.out(`Dropped ${slug} and its vectors.`);
    if (model.active) ctx.out("It was active: search uses keywords alone until a model is active again.");
    return 0;
  });
}

function activate(ctx: CommandContext, slug: string, force: boolean): Promise<number> {
  return withDb(ctx, (db) => {
    if (!getModel(db, slug)) {
      ctx.err(`Unknown embedding model: ${slug}. See \`retrospecticus embedding list\`.`);
      return 1;
    }
    const summary = listModels(db).find((m) => m.slug === slug)!;
    if (summary.vectors === 0 && !force) {
      ctx.err(`${slug} has no vectors yet; run \`retrospecticus reembed --model ${slug}\` first, or pass --force.`);
      return 1;
    }
    activateModel(db, slug);
    ctx.out(`Search now uses ${slug}.`);
    if (summary.missing > 0) {
      ctx.out(`${summary.missing} chunks have no ${slug} vector yet; keyword search still finds them.`);
    }
    return 0;
  });
}

const command: Command = {
  summary: "List embedding models or switch search to another one",
  usage,
  async run(ctx) {
    let parsed;
    try {
      parsed = parseArgs({
        args: ctx.args,
        options: { force: { type: "boolean" } },
        allowPositionals: true,
        strict: true,
      });
    } catch (err) {
      throw new UsageError((err as Error).message);
    }
    const [sub, ...rest] = parsed.positionals;
    const force = parsed.values.force === true;
    if (sub === "list") {
      if (rest.length > 0 || force) throw new UsageError("embedding list takes no arguments");
      return list(ctx);
    }
    if (sub === "activate") {
      if (rest.length !== 1) throw new UsageError("embedding activate needs exactly one <slug>");
      return activate(ctx, rest[0]!, force);
    }
    if (sub === "drop") {
      if (rest.length !== 1 || force) throw new UsageError("embedding drop needs exactly one <slug>");
      return drop(ctx, rest[0]!);
    }
    throw new UsageError(sub === undefined ? "embedding needs a subcommand" : `Unknown subcommand: ${sub}`);
  },
};

export default command;
