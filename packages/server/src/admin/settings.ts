import type { Hono } from "hono";
import { z } from "zod";
import { ADMIN_PAGE_PATH } from "@retrospecticus/shared";
import type { AppEnv } from "../auth.ts";
import { ConfigError, ServerConfigSchema, type ServerConfig } from "../config.ts";
import {
  ConfigConflictError,
  RESTART_REQUIRED_KEYS,
  validateConfig,
  type ConfigStore,
  type ConfigView,
} from "../config-store.ts";
import type { Db } from "../db/index.ts";
import { activateModel, getModel, listModels } from "../db/vectors.ts";
import { getEmbedError } from "../indexer/embed.ts";
import { readJsonBody } from "../enroll.ts";
import { events } from "../events.ts";
import { OMLX_KEY_REQUIRED } from "../embeddings/registry.ts";
import { isSecretName } from "../secrets.ts";

const API = `${ADMIN_PAGE_PATH}/api`;

export interface SettingsDeps {
  db: Db;
  view: ConfigView;
  /** Absent when the server was started from a fixed config rather than files; settings are then read-only. */
  store?: ConfigStore;
  maxBodyBytes: number;
}

export interface FieldIssue {
  /** Dotted path into the config, e.g. "indexer.chunk_tokens". */
  path: string;
  message: string;
}

const UpdateSchema = z.object({ config: z.unknown(), version: z.string() });
const SecretValueSchema = z.object({ value: z.string().min(1).max(8192) });
const ActivateSchema = z.object({ slug: z.string().min(1).max(200), force: z.boolean().optional() });

const NO_STORE = "settings can only be changed when the server runs from a config file";

/** Checks the schema first so each issue can be shown beside its field, then the cross-field checks. */
export function settingsIssues(candidate: unknown): FieldIssue[] {
  const parsed = ServerConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
  }
  try {
    validateConfig(parsed.data);
  } catch (err) {
    const message = (err as Error).message;
    const notifier = /notifier "([^"]+)"/.exec(message)?.[1];
    const path = notifier ? `notifiers.${notifier}` : message.startsWith("Invalid embedding") ? "embedding" : "";
    return [{ path, message }];
  }
  return [];
}

export function configuredSlug(config: ServerConfig): string | null {
  const { provider, model } = config.embedding;
  return provider === "none" ? null : `${provider}-${model}`;
}

export function registerSettingsRoutes(app: Hono<AppEnv>, deps: SettingsDeps): void {
  const { db, view, store } = deps;

  app.get(`${API}/settings`, (c) => {
    if (!store) return c.json({ error: NO_STORE }, 404);
    return c.json({
      config: store.current(),
      version: store.version(),
      secrets: store.secretStatus(),
      pending_restart: store.pendingRestart(),
      last_error: store.lastError(),
      restart_required_keys: RESTART_REQUIRED_KEYS,
      paths: { config: store.configPath, secrets: store.secretsPath },
      secrets_permission_problem: store.secretsPermissionProblem(),
    });
  });

  app.post(`${API}/settings`, async (c) => {
    if (!store) return c.json({ error: NO_STORE }, 404);
    const body = UpdateSchema.safeParse(await readJsonBody(c, deps.maxBodyBytes));
    if (!body.success) return c.json({ error: "send { config, version }" }, 400);
    const issues = settingsIssues(body.data.config);
    if (issues.length > 0) return c.json({ error: "some settings are not valid", issues }, 400);
    const embedding = (body.data.config as { embedding?: { provider?: unknown } } | null)?.embedding;
    if (embedding?.provider === "omlx" && !view.getSecret("omlx_api_key")) {
      return c.json({ error: "some settings are not valid", issues: [{ path: "embedding.provider", message: OMLX_KEY_REQUIRED }] }, 400);
    }
    try {
      const version = store.update(body.data.config as z.input<typeof ServerConfigSchema>, body.data.version);
      events.publish("settings");
      return c.json({ ok: true, version, pending_restart: store.pendingRestart() });
    } catch (err) {
      if (err instanceof ConfigConflictError) {
        return c.json(
          { error: err.message, expected_version: err.expectedVersion, actual_version: err.actualVersion },
          409,
        );
      }
      if (err instanceof ConfigError) return c.json({ error: err.message }, 400);
      return c.json({ error: `could not write the config file: ${(err as Error).message}` }, 500);
    }
  });

  app.post(`${API}/secrets/:name`, async (c) => {
    if (!store) return c.json({ error: NO_STORE }, 404);
    const name = c.req.param("name");
    if (!isSecretName(name)) return c.json({ error: `unknown secret "${name}"` }, 404);
    const body = SecretValueSchema.safeParse(await readJsonBody(c, deps.maxBodyBytes));
    if (!body.success) return c.json({ error: "send { value } with a non-empty value" }, 400);
    try {
      const status = store.setSecret(name, body.data.value);
      events.publish("settings");
      return c.json({ ok: true, status });
    } catch (err) {
      return c.json({ error: (err as Error).message }, err instanceof ConfigError ? 409 : 500);
    }
  });

  app.post(`${API}/secrets/:name/unset`, (c) => {
    if (!store) return c.json({ error: NO_STORE }, 404);
    const name = c.req.param("name");
    if (!isSecretName(name)) return c.json({ error: `unknown secret "${name}"` }, 404);
    try {
      const status = store.setSecret(name, null);
      events.publish("settings");
      return c.json({ ok: true, status });
    } catch (err) {
      return c.json({ error: (err as Error).message }, err instanceof ConfigError ? 409 : 500);
    }
  });

  app.get(`${API}/embedding`, (c) => {
    const models = listModels(db).map((m) => ({
      slug: m.slug,
      provider: m.provider,
      model: m.model,
      dimensions: m.dimensions,
      active: m.active,
      vectors: m.vectors,
      missing: m.missing,
    }));
    return c.json({
      models,
      configured: configuredSlug(view.current()),
      active: models.find((m) => m.active)?.slug ?? null,
      error: (() => {
        const slug = configuredSlug(view.current());
        return slug ? getEmbedError(db, slug) : null;
      })(),
    });
  });

  app.post(`${API}/embedding/activate`, async (c) => {
    const body = ActivateSchema.safeParse(await readJsonBody(c, deps.maxBodyBytes));
    if (!body.success) return c.json({ error: "send { slug }" }, 400);
    const { slug, force } = body.data;
    if (!getModel(db, slug)) return c.json({ error: `unknown embedding model ${slug}` }, 404);
    const summary = listModels(db).find((m) => m.slug === slug)!;
    if (summary.missing > 0 && !force) {
      return c.json(
        { error: `${slug} is still missing ${summary.missing} vectors; wait for it to finish or force it`, missing: summary.missing },
        409,
      );
    }
    activateModel(db, slug);
    events.publish("embedding");
    events.publish("stats");
    return c.json({ ok: true, active: slug, missing: summary.missing });
  });
}
