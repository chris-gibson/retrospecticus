import { LICENSE_NOTICES } from "@retrospecticus/shared/notices.ts";
import { UsageError, type Command } from "../command.ts";

const command: Command = {
  summary: "Print the licenses of this program and the software it contains",
  usage: "Usage: retrospecticus licenses",
  async run(ctx) {
    if (ctx.args.length > 0) throw new UsageError(`Unexpected argument: ${ctx.args[0]}`);
    ctx.out(LICENSE_NOTICES);
    return 0;
  },
};

export default command;
