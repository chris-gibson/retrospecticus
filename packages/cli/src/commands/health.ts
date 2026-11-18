import { configFor, UsageError, type Command } from "../command.ts";

const usage = [
  "Usage: retrospecticus health [--url <server-url>]",
  "",
  "Exits 0 when the running server answers /healthz, 1 otherwise. Without --url it",
  "asks the address in the config. Used as the container's health check.",
].join("\n");

const TIMEOUT_MS = 3000;

/** A server listening on every interface is reached locally through loopback. */
function localHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  return host.includes(":") ? `[${host}]` : host;
}

const command: Command = {
  summary: "Check that the running server answers",
  usage,
  async run(ctx) {
    let base: string | undefined;
    const args = [...ctx.args];
    while (args.length > 0) {
      const arg = args.shift()!;
      if (arg === "--url") base = args.shift();
      else throw new UsageError(`Unexpected argument: ${arg}`);
      if (base === undefined) throw new UsageError("--url needs a value");
    }
    if (base === undefined) {
      const config = configFor(ctx);
      base = `http://${localHost(config.listen_host)}:${config.listen_port}`;
    }
    const url = `${base.replace(/\/+$/, "")}/healthz`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (response.ok) {
        ctx.out(`ok ${url}`);
        return 0;
      }
      ctx.err(`${url} returned ${response.status}`);
    } catch (err) {
      ctx.err(`${url} did not answer: ${(err as Error).message}`);
    }
    return 1;
  },
};

export default command;
