import type { Hono } from "hono";
import { z } from "zod";
import { ADMIN_PAGE_PATH, SOURCES, type Source } from "@retrospecticus/shared";
import type { AppEnv } from "../auth.ts";
import { ConfigError, rawDir, type ServerConfigInput } from "../config.ts";
import { ConfigConflictError, type ConfigStore, type ConfigView } from "../config-store.ts";
import { ackDriftEvent, getDriftEvent, listOpenDriftEvents, type DriftEventRow } from "../db/drift.ts";
import type { Db } from "../db/index.ts";
import { baseDiscriminator } from "../drift/fingerprint.ts";
import { reparseQuarantined } from "../indexer/reparse.ts";
import { parsers as defaultParsers } from "../parsers/index.ts";
import { readJsonBody } from "../enroll.ts";
import { events } from "../events.ts";
import { buildWiring, type Wiring } from "../wiring.ts";

const API = `${ADMIN_PAGE_PATH}/api/drift`;

export interface DriftRouteDeps {
  db: Db;
  view: ConfigView;
  store?: ConfigStore;
  /** The parsers and observers the indexer runs; built from the view when absent. */
  wiring?: Pick<Wiring, "parsers" | "observers">;
  maxBodyBytes: number;
}

const UnignoreSchema = z.object({ source: z.enum(SOURCES), type: z.string().min(1).max(200) });

/** The type an event could be ignored as, or null when it is not an unknown record type. */
function ignorableType(db: Db, event: DriftEventRow): string | null {
  if (event.severity !== "breaking" || event.discriminator === null) return null;
  const quarantined = db
    .query<{ reason: string }, [string]>("SELECT reason FROM quarantine WHERE fingerprint = ? LIMIT 1")
    .get(event.fingerprint);
  const unknownType = quarantined !== null ? quarantined.reason === "unknown-type" : event.detail?.startsWith("unrecognised record type") === true;
  if (!unknownType) return null;
  const type = baseDiscriminator(event.discriminator);
  // A type the parser handles that merely failed to dispatch is a parser bug, not bookkeeping.
  return defaultParsers[event.source].handledTypes.includes(type) ? null : type;
}

export function registerDriftRoutes(app: Hono<AppEnv>, deps: DriftRouteDeps): void {
  const { db, view, store } = deps;
  let built: Pick<Wiring, "parsers" | "observers"> | undefined = deps.wiring;
  const wiring = () => (built ??= buildWiring(db, view));

  const updateIgnored = (change: (list: string[], source: Source) => string[], source: Source) => {
    if (!store) throw new ConfigError("settings can only be changed when the server runs from a config file");
    // Read and written in one step so a concurrent edit is refused rather than overwritten.
    const current = structuredClone(store.current()) as ServerConfigInput;
    const ignore = current.drift!.ignore_types!;
    ignore[source] = change(ignore[source] ?? [], source);
    store.update(current, store.version());
  };

  const failure = (err: unknown) => {
    if (err instanceof ConfigConflictError) return { body: { error: err.message }, status: 409 as const };
    if (err instanceof ConfigError) return { body: { error: err.message }, status: 400 as const };
    return { body: { error: `could not write the config file: ${(err as Error).message}` }, status: 500 as const };
  };

  const eventId = (raw: string): number | null => (/^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : null);

  app.get(API, (c) =>
    c.json({
      events: listOpenDriftEvents(db).map((e) => ({
        id: e.id,
        severity: e.severity,
        source: e.source,
        discriminator: e.discriminator,
        harness_version: e.harness_version,
        count: e.count,
        first_seen: e.first_seen,
        last_seen: e.last_seen,
        detail: e.detail,
        status: e.status,
        ignorable: ignorableType(db, e) !== null,
      })),
      ignore_types: view.current().drift.ignore_types,
    }),
  );

  app.post(`${API}/unignore`, async (c) => {
    const body = UnignoreSchema.safeParse(await readJsonBody(c, deps.maxBodyBytes));
    if (!body.success) return c.json({ error: "send { source, type }" }, 400);
    const { source, type } = body.data;
    try {
      updateIgnored((list) => list.filter((t) => t !== type), source);
    } catch (err) {
      const f = failure(err);
      return c.json(f.body, f.status);
    }
    events.publish("drift");
    events.publish("settings");
    return c.json({ ok: true, ignore_types: view.current().drift.ignore_types });
  });

  app.post(`${API}/:id/ack`, (c) => {
    const id = eventId(c.req.param("id"));
    const result = id === null ? "not-found" : ackDriftEvent(db, id);
    if (result === "not-found") return c.json({ error: "no such drift event" }, 404);
    events.publish("drift");
    return c.json({ ok: true, result });
  });

  app.post(`${API}/:id/ignore`, async (c) => {
    const id = eventId(c.req.param("id"));
    const event = id === null ? null : getDriftEvent(db, id);
    if (!event) return c.json({ error: "no such drift event" }, 404);
    const type = ignorableType(db, event);
    if (type === null) return c.json({ error: "only an unrecognised record type can be ignored" }, 400);
    try {
      updateIgnored((list) => (list.includes(type) ? list : [...list, type]), event.source);
    } catch (err) {
      const f = failure(err);
      return c.json(f.body, f.status);
    }
    const w = wiring();
    const summary = reparseQuarantined(db, rawDir(view.current()), w.parsers, w.observers, { fingerprint: event.fingerprint });
    ackDriftEvent(db, event.id);
    for (const topic of ["drift", "settings", "stats"] as const) events.publish(topic);
    return c.json({
      ok: true,
      type,
      reparsed: { lines: summary.lines, messages: summary.messages, quarantined: summary.quarantined },
    });
  });
}
