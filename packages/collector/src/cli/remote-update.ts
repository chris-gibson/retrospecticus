import { readFileSync } from "node:fs";
import { parseCollectorConfig, resolveCollectorConfigPath } from "../config.ts";
import { setConfigKey, writeConfigAtomic } from "./configfile.ts";
import { CliError, type CliEnv } from "./env.ts";

/** Turns the server's right to update this collector on or off, in the config file. */
export async function remoteUpdate(env: CliEnv, setting: boolean, configOption: string | undefined): Promise<number> {
  const configPath = resolveCollectorConfigPath(configOption, { env: env.env, home: env.home });
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (err) {
    throw new CliError(`Cannot read ${configPath}: ${(err as Error).message} (run \`retrospecticus-collector enroll\` first)`);
  }

  let current: boolean;
  let updated: string;
  try {
    const before = parseCollectorConfig(JSON.parse(text), "config", { env: env.env, home: env.home });
    current = before.remote_update;
    updated = setConfigKey(text, "remote_update", setting);
    parseCollectorConfig(JSON.parse(updated), "config", { env: env.env, home: env.home });
  } catch (err) {
    throw new CliError(`${configPath} cannot be edited safely: ${(err as Error).message.split("\n").slice(0, 2).join(" ")}`);
  }

  const word = setting ? "on" : "off";
  if (current === setting) {
    env.out(`Remote updates are already ${word} in ${configPath}.`);
    return 0;
  }
  writeConfigAtomic(configPath, updated);
  // The running collector rereads the setting for each command and heartbeat, so no restart is needed.
  env.out(`Remote updates are now ${word} in ${configPath}; the running collector follows it from its next heartbeat.`);
  return 0;
}
