import { UsageError } from "./env.ts";

export interface FlagSpec {
  values?: readonly string[];
  bools?: readonly string[];
}

export interface ParsedFlags {
  values: Record<string, string>;
  bools: Set<string>;
}

/** `--name value` and `--name=value` for value flags; bare `--name` for booleans. No positionals are accepted. */
export function parseFlags(args: readonly string[], spec: FlagSpec): ParsedFlags {
  const values: Record<string, string> = {};
  const bools = new Set<string>();
  const valueFlags = new Set(spec.values ?? []);
  const boolFlags = new Set([...(spec.bools ?? []), "help"]);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-h") {
      bools.add("help");
      continue;
    }
    if (!arg.startsWith("--")) throw new UsageError(`unexpected argument "${arg}"`);
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (valueFlags.has(name)) {
      let value: string | undefined;
      if (eq !== -1) value = arg.slice(eq + 1);
      else value = args[++i];
      if (value === undefined || value === "") throw new UsageError(`--${name} needs a value`);
      values[name] = value;
    } else if (boolFlags.has(name) && eq === -1) {
      bools.add(name);
    } else {
      throw new UsageError(`unknown option "${arg}"`);
    }
  }
  return { values, bools };
}
