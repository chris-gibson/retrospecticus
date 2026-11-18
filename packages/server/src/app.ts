import { Hono } from "hono";
import { HEARTBEAT_PATH, INGEST_APPEND_PATH, MCP_PATH, SEARCH_PATH, VERSION } from "@retrospecticus/shared";
import { registerAdminRoutes } from "./admin/routes.ts";
import type { AdminDeps } from "./admin/routes.ts";
import type { SetupState } from "./admin/setup.ts";
import { requireScope, type AppEnv } from "./auth.ts";
import type { ServerConfig } from "./config.ts";
import { toConfigView, type ConfigStore, type ConfigView } from "./config-store.ts";
import type { Db } from "./db/index.ts";
import { registerDownloadRoutes } from "./downloads.ts";
import { registerEnrollRoutes } from "./enroll.ts";
import { appendHandler } from "./ingest/append.ts";
import { heartbeatHandler } from "./ingest/heartbeat.ts";
import { handleMcpRequest } from "./mcp/server.ts";
import { HttpSearchInputSchema, runSearch } from "./mcp/tools.ts";
import type { VectorSearch } from "./search/index.ts";

export interface AppDeps {
  db: Db;
  /** A view is read on every request, so search weights follow config changes without a restart. */
  config: ServerConfig | ConfigView;
  /** The file-backed store, when there is one, for routes that edit settings and secrets. */
  configStore?: ConfigStore;
  /** Called after every accepted append so the indexer can wake without waiting for its poll. */
  onIngest?: () => void;
  /** Absent when embedding is turned off, in which case search is keyword only. */
  vectorSearch?: VectorSearch;
  /** Clock for enrollment expiry and admin sessions; tests move it to skip ahead. */
  now?: () => Date;
  /** Defaults to 500 ms. */
  adminLoginFailureDelayMs?: number;
  /** First-run setup; without it no setup code exists and the admin page only offers sign-in. */
  setup?: SetupState;
  /** The indexer's parsers and observers; the admin drift routes reparse with them. */
  wiring?: AdminDeps["wiring"];
  /** Overrides for the admin live event stream. */
  eventStream?: AdminDeps["eventStream"];
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const view = toConfigView(deps.config);
  const weights = () => {
    const { keyword_weight, vector_weight } = view.current().search;
    return { keyword: keyword_weight, vector: vector_weight };
  };

  app.use(async (c, next) => {
    c.set("db", deps.db);
    await next();
  });

  app.get("/healthz", (c) => c.json({ ok: true, version: VERSION }));
  const now = deps.now ?? (() => new Date());
  registerEnrollRoutes(app, { db: deps.db, now });
  registerDownloadRoutes(app, { config: view });
  registerAdminRoutes(app, {
    db: deps.db,
    now,
    loginFailureDelayMs: deps.adminLoginFailureDelayMs ?? 500,
    config: view,
    configStore: deps.configStore,
    setup: deps.setup,
    wiring: deps.wiring,
    eventStream: deps.eventStream,
  });
  app.put(INGEST_APPEND_PATH, requireScope("ingest"), appendHandler(deps));
  app.post(HEARTBEAT_PATH, requireScope("ingest"), heartbeatHandler(deps));
  app.all(MCP_PATH, requireScope("search"), (c) =>
    handleMcpRequest(c.req.raw, { db: deps.db, tokenId: c.get("token").id, vectorSearch: deps.vectorSearch, weights: weights() }),
  );
  app.post(SEARCH_PATH, requireScope("search"), async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const parsed = HttpSearchInputSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid search request", issues: parsed.error.issues }, 400);
    const ctx = { db: deps.db, tokenId: c.get("token").id, vectorSearch: deps.vectorSearch, weights: weights() };
    return c.json(await runSearch(ctx, parsed.data, "http_search"));
  });

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    console.error(`${c.req.method} ${c.req.path} failed:`, err);
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}
