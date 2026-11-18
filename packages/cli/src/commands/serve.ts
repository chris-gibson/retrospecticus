import { startServerFromFiles } from "@retrospecticus/server/main.ts";
import { UsageError, type Command } from "../command.ts";

const usage = "Usage: retrospecticus serve";

const command: Command = {
  summary: "Run the server (ingest API) in the foreground",
  usage,
  async run(ctx) {
    if (ctx.args.length > 0) throw new UsageError(`Unexpected argument: ${ctx.args[0]}`);
    const server = startServerFromFiles(ctx.configPath);
    ctx.out(`retrospecticus listening on ${server.url}`);

    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await server.stop();
    return 0;
  },
};

export default command;
