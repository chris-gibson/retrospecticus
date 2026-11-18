import { createDispatcher } from "@retrospecticus/server/notifiers/dispatcher.ts";
import { buildNotifiers } from "@retrospecticus/server/notifiers/registry.ts";
import { UsageError, storeFor, type Command } from "../command.ts";
import { ConfigError } from "@retrospecticus/server/config.ts";
import { openDb } from "@retrospecticus/server/db/index.ts";

const usage = "Usage:\n  retrospecticus notify test";

const command: Command = {
  summary: "Send a sample alert through every enabled notifier",
  usage,
  async run(ctx) {
    const [sub, ...rest] = ctx.args;
    if (sub !== "test" || rest.length > 0) {
      throw new UsageError(sub === undefined ? "notify needs a subcommand" : `Unknown notify arguments: ${ctx.args.join(" ")}`);
    }
    const store = storeFor(ctx);
    const config = store.current();
    let notifiers;
    try {
      notifiers = buildNotifiers(config.notifiers, (name) => store.getSecret(name));
    } catch (err) {
      throw new ConfigError((err as Error).message);
    }
    // The test bypasses the outbox, so the dispatcher never reads this in-memory database.
    const db = openDb(":memory:");
    try {
      const results = await createDispatcher({ db, notifiers, digestHour: config.alerts.digest_hour, retryDelaysMs: [] }).sendTest();
      for (const r of results) ctx.out(r.ok ? `${r.name}: ok` : `${r.name}: FAILED ${r.error}`);
      return results.every((r) => r.ok) ? 0 : 1;
    } finally {
      db.close();
    }
  },
};

export default command;
