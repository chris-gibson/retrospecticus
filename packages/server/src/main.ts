import { existsSync, mkdirSync } from "node:fs";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { ADMIN_PAGE_PATH, MAX_APPEND_BODY_BYTES } from "@retrospecticus/shared";
import { createSetupState } from "./admin/setup.ts";
import { createApp, type AppDeps } from "./app.ts";
import { dbPath, rawDir, type ServerConfig } from "./config.ts";
import { isConfigView, openConfigStore, toConfigView, type ConfigStore, type ConfigView } from "./config-store.ts";
import { openDb, type Db } from "./db/index.ts";
import { createProvider, providerForSlug } from "./embeddings/registry.ts";
import { createVectorSearch, registerProvider } from "./indexer/embed.ts";
import { startIndexer, type Indexer, type IndexerDeps } from "./indexer/loop.ts";
import { reconcileArchive } from "./ingest/archive.ts";
import type { SecretName } from "./secrets.ts";
import { events } from "./events.ts";
import { buildWiring } from "./wiring.ts";
import { setupHosts } from "./setup-hosts.ts";

export interface RunningServer {
  db: Db;
  /** What the server reads settings through; the file-backed store when it was started with one. */
  config: ConfigView;
  hostname: string;
  port: number;
  url: string;
  /** Null when the server was started with `indexer: false`. */
  indexer: Indexer | null;
  stop(): Promise<void>;
}

export interface StartServerOptions {
  /** Called after the indexer has been woken. */
  onIngest?: AppDeps["onIngest"];
  /**
   * `false` runs the server without an indexer. Otherwise these are passed to
   * `startIndexer`; this is where the drift observer and the chunk and embed
   * stages are registered.
   */
  indexer?: false | Pick<IndexerDeps, "parsers" | "observers" | "stages" | "pollSeconds" | "parse" | "onError">;
  /** Where the first-run setup link is written when no admin token exists. Defaults to console.log. */
  log?: (line: string) => void;
  /** Overrides for choosing the setup link's address; tests set them, the server reads its own environment. */
  env?: Record<string, string | undefined>;
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
  inContainer?: boolean;
}

/**
 * Given a ConfigStore (or any view), settings that can change at run time are
 * read through it on each use; only RESTART_REQUIRED_KEYS are fixed here.
 */
export function startServer(source: ServerConfig | ConfigView, options: StartServerOptions = {}): RunningServer {
  const view = toConfigView(source);
  const config = view.current();
  const secrets = (name: SecretName) => view.getSecret(name);
  mkdirSync(rawDir(config), { recursive: true });
  const db = openDb(dbPath(config));

  for (const { file, diskSize } of reconcileArchive(db, rawDir(config))) {
    const what = diskSize < file.size ? "archive is SHORTER than recorded" : "recovered unrecorded bytes";
    console.warn(
      `reconcile: ${file.machine}/${file.source}/${file.path} generation ${file.generation}: ${what} (${file.size} -> ${diskSize})`,
    );
  }

  // Fails here, before listening, if the configured model's prefixes no longer match its stored vectors.
  const configured = createProvider(config.embedding, secrets);
  if (configured) registerProvider(db, configured);

  const wiring = buildWiring(db, view);
  const indexer =
    options.indexer === false
      ? null
      : startIndexer({
          pollSeconds: () => view.current().indexer.poll_seconds,
          parsers: wiring.parsers,
          observers: wiring.observers,
          stages: wiring.stages,
          ...options.indexer,
          db,
          rawDir: rawDir(config),
        });
  const stopBackground = options.indexer === false ? null : wiring.startBackground();
  const onIngest = (): void => {
    indexer?.wake();
    options.onIngest?.();
  };

  const vectorSearch = createVectorSearch(
    db,
    (model) => providerForSlug(model.slug, view.current().embedding, model.dimensions, secrets),
    {
      enabled: () => view.current().embedding.provider !== "none",
      cacheKey: () => JSON.stringify(view.current().embedding),
    },
  );
  const configStore = isConfigStore(source) ? source : undefined;
  const setup = createSetupState(db);
  const setupCode = setup.issue();
  const app = createApp({ db, config: view, configStore, onIngest, vectorSearch, setup, wiring });
  // Edits to the config files made outside the admin page arrive here through the store's watcher.
  const stopWatchingConfig = view.onChange(() => events.publish("settings"));
  const server = Bun.serve({
    hostname: config.listen_host,
    port: config.listen_port,
    // Slack over the append cap so the handler, not the socket layer, words the refusal.
    maxRequestBodySize: MAX_APPEND_BODY_BYTES + 1024 * 1024,
    fetch: app.fetch,
  });
  const port = server.port ?? config.listen_port;
  if (setupCode !== null) {
    const log = options.log ?? ((line: string) => console.log(line));
    const hosts = setupHosts({
      listenHost: config.listen_host,
      bind: options.env?.RETROSPECTICUS_BIND ?? process.env.RETROSPECTICUS_BIND,
      interfaces: options.interfaces ?? networkInterfaces(),
      inContainer: options.inContainer ?? existsSync("/.dockerenv"),
    });
    const url = (host: string) => `http://${host}:${port}${ADMIN_PAGE_PATH}/setup?code=${setupCode}`;
    // Deferred so it follows the caller's own "listening on" line rather than preceding it.
    queueMicrotask(() => {
      log(`First-time setup: open ${url(hosts[0]!)}`);
      for (const host of hosts.slice(1)) log(`  or ${url(host)}`);
      log(setupCode);
    });
  }

  return {
    db,
    config: view,
    hostname: config.listen_host,
    port,
    url: `http://${config.listen_host.includes(":") ? `[${config.listen_host}]` : config.listen_host}:${port}`,
    indexer,
    async stop() {
      stopWatchingConfig();
      await server.stop(true);
      await indexer?.stop();
      await stopBackground?.();
      db.close();
    },
  };
}

function isConfigStore(source: ServerConfig | ConfigView): source is ConfigStore {
  return isConfigView(source) && typeof (source as ConfigStore).update === "function";
}

/** Opens the store, follows its files and serves; the store is closed when the server stops. */
export function startServerFromFiles(configPath?: string, options: StartServerOptions = {}): RunningServer {
  const store = openConfigStore({ configPath });
  store.watch();
  try {
    const server = startServer(store, options);
    const stop = server.stop.bind(server);
    return {
      ...server,
      async stop() {
        store.close();
        await stop();
      },
    };
  } catch (err) {
    store.close();
    throw err;
  }
}

if (import.meta.main) {
  const server = startServerFromFiles();
  console.log(`retrospecticus listening on ${server.url}`);
  const shutdown = () => void server.stop().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
