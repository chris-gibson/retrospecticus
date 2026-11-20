import type { Hono } from "hono";
import { ADMIN_PAGE_PATH, VERSION, compareVersions } from "@retrospecticus/shared";
import type { AppEnv } from "../auth.ts";
import { createUpdateCommand, latestCommands } from "../db/commands.ts";
import type { Db } from "../db/index.ts";
import { listMachineSummaries, type MachineSummary } from "../db/machines.ts";
import { events } from "../events.ts";

const API = `${ADMIN_PAGE_PATH}/api`;

// Only older collectors are outdated: `update` will not downgrade a newer one.
const isOutdated = (m: MachineSummary): boolean =>
  m.collector_version !== null && (compareVersions(m.collector_version, VERSION) ?? 0) < 0;

/** Registered after the admin session guard and the CSRF check, so the POSTs inherit both. */
export function registerMachineRoutes(app: Hono<AppEnv>, deps: { db: Db; now: () => Date }): void {
  const { db, now } = deps;

  app.get(`${API}/machines`, (c) => {
    const commands = latestCommands(db, now());
    return c.json({
      machines: listMachineSummaries(db).map((m) => {
        const command = commands.get(m.machine);
        return {
          ...m,
          remote_update: m.remote_update === 1,
          outdated: isOutdated(m),
          // Collectors that report where they run from also have the update command; older ones need the installer.
          install_dir: m.exec_path ? m.exec_path.slice(0, m.exec_path.lastIndexOf("/")) || "/" : null,
          command: command
            ? {
                status: command.status,
                message: command.message,
                target_version: command.target_version,
                created_at: command.created_at,
                finished_at: command.finished_at,
              }
            : null,
        };
      }),
      server_version: VERSION,
    });
  });

  // The command carries no version choice: it always means the server's own.
  const request = (m: MachineSummary): "ok" | "not-outdated" | "retired" | "remote-off" | "busy" => {
    if (!isOutdated(m)) return "not-outdated";
    // A retired machine sends no heartbeats, so a command for it could only ever expire.
    if (m.active_ingest_tokens === 0) return "retired";
    if (m.remote_update !== 1) return "remote-off";
    return createUpdateCommand(db, m.machine, VERSION, now()) ? "ok" : "busy";
  };

  app.post(`${API}/machines/update-outdated`, (c) => {
    let count = 0;
    for (const m of listMachineSummaries(db)) if (request(m) === "ok") count++;
    if (count > 0) events.publish("machines");
    return c.json({ ok: true, count });
  });

  app.post(`${API}/machines/:machine/update`, (c) => {
    const m = listMachineSummaries(db).find((row) => row.machine === c.req.param("machine"));
    if (!m) return c.json({ error: "no such machine" }, 404);
    const outcome = request(m);
    if (outcome === "not-outdated") return c.json({ error: "this machine is not older than the server" }, 409);
    if (outcome === "retired") return c.json({ error: "this machine has no active token, so it cannot be reached" }, 409);
    if (outcome === "remote-off") return c.json({ error: "remote updates are not turned on for this machine" }, 409);
    if (outcome === "busy") return c.json({ error: "an update is already in progress for this machine" }, 409);
    events.publish("machines");
    return c.json({ ok: true });
  });
}
