import { parseArgs } from "node:util";
import { getActiveModel, getModel } from "@retrospecticus/server/db/vectors.ts";
import { providerForSlug } from "@retrospecticus/server/embeddings/registry.ts";
import { EMBED_BATCH_SIZE, embedAll, registerProvider } from "@retrospecticus/server/indexer/embed.ts";
import { UsageError, withDb, type Command } from "../command.ts";

const usage = [
  "Usage:",
  "  retrospecticus reembed --model <slug> [--dimensions <n>] [--batch-size <n>]",
  "",
  "Fills the vector table of <slug> (e.g. openai-text-embedding-3-large, fake-alt) for every chunk",
  "that lacks one, while the active model keeps serving search. Switch over afterwards with",
  "`retrospecticus embedding activate <slug>`. --dimensions is only needed for a new model whose",
  "size the provider does not know.",
].join("\n");

function positiveInt(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${name} must be a positive whole number`);
  return n;
}

const command: Command = {
  summary: "Embed every chunk with another model, alongside the active one",
  usage,
  async run(ctx) {
    let values;
    try {
      ({ values } = parseArgs({
        args: ctx.args,
        options: { model: { type: "string" }, dimensions: { type: "string" }, "batch-size": { type: "string" } },
        allowPositionals: false,
        strict: true,
      }));
    } catch (err) {
      throw new UsageError((err as Error).message);
    }
    const slug = values.model;
    if (slug === undefined || slug === "") throw new UsageError("reembed needs --model <slug>");
    const dimensions = positiveInt("--dimensions", values.dimensions);
    const batchSize = positiveInt("--batch-size", values["batch-size"]) ?? EMBED_BATCH_SIZE;

    return withDb(ctx, async (db, config, store) => {
      const registered = getModel(db, slug);
      if (registered && dimensions !== undefined && dimensions !== registered.dimensions) {
        ctx.err(`${slug} is registered with ${registered.dimensions} dimensions, not ${dimensions}.`);
        return 1;
      }
      let provider;
      try {
        provider = providerForSlug(slug, config.embedding, registered?.dimensions ?? dimensions, (name) =>
          store.getSecret(name),
        );
        registerProvider(db, provider);
      } catch (err) {
        ctx.err((err as Error).message);
        return 1;
      }

      ctx.out(`Embedding chunks with ${slug} (${provider.dimensions} dimensions)...`);
      let embedded: number;
      try {
        embedded = await embedAll(db, provider, {
          batchSize,
          onProgress: (p) => ctx.out(`  ${p.embedded} embedded, ${p.missing} remaining`),
        });
      } catch (err) {
        ctx.err(`reembed stopped: ${(err as Error).message}`);
        ctx.err("Vectors stored so far are kept; run the command again to continue.");
        return 1;
      }
      const active = getActiveModel(db);
      ctx.out(`Done: ${embedded} chunks embedded with ${slug}.`);
      if (active?.slug === slug) {
        ctx.out(`${slug} is the active model.`);
      } else {
        ctx.out(`Active model unchanged (${active?.slug ?? "none"}). Switch with: retrospecticus embedding activate ${slug}`);
      }
      return 0;
    });
  },
};

export default command;
