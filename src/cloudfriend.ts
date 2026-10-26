import type { Hono } from "hono";
import { loadAdapters, type Adapters } from "./adapters.ts";
import type { Config } from "./config.ts";
import { dbPath, openDb, type DB } from "./db.ts";
import { Intake } from "./intake.ts";
import { log } from "./log.ts";
import { Secrets } from "./secrets.ts";
import { createApp } from "./server.ts";
import type { ActionAdapter, DeciderAdapter } from "./types.ts";
import { Worker } from "./worker.ts";

export interface cloudfriend {
  app: Hono;
  db: DB;
  intake: Intake;
  secrets: Secrets;
  worker: Worker;
  decider: { name: string; adapter: DeciderAdapter } | null;
  actions: Map<string, ActionAdapter>;
  /** Set on first boot only: the generated ingest secret, to print once. */
  bootSecret: string | null;
  /**
   * Shut down: stop the worker at once (no new decides or deliveries), give in-flight work
   * `graceMs` and requests already being read `drainMs` to reach the queue, commit, close.
   */
  close(graceMs?: number, drainMs?: number): Promise<void>;
}

/** Build a cloudfriend instance without listening on a port. `main.ts` adds the HTTP server. */
export async function createCloudfriend(config: Config, env: NodeJS.ProcessEnv = process.env, adapters?: Adapters): Promise<cloudfriend> {
  adapters ??= await loadAdapters(config.adapterDir);

  const deciderAdapter = adapters.deciders.get(config.decider);
  if (!deciderAdapter) {
    throw new Error(`unknown decider '${config.decider}' (available: ${[...adapters.deciders.keys()].join(", ")})`);
  }
  const decider = deciderAdapter.enabled?.(env) === false ? null : { name: config.decider, adapter: deciderAdapter };

  const actions = new Map<string, ActionAdapter>();
  for (const name of config.actions ?? adapters.actions.keys()) {
    const action = adapters.actions.get(name);
    if (!action) throw new Error(`unknown action '${name}' (available: ${[...adapters.actions.keys()].join(", ")})`);
    if (action.enabled?.(env) === false) {
      if (config.actions) log.warn(`action '${name}' is listed in CLOUDFRIEND_ACTIONS but not configured; skipping it`);
      continue;
    }
    actions.set(name, action);
  }

  const db = openDb(dbPath(config.dataDir), { synchronous: config.synchronous });
  const secrets = new Secrets(db);
  const bootSecret = secrets.count() === 0 ? secrets.create("default").secret : null;
  const intake = new Intake(db, secrets, { windowMs: config.commitWindowMs, maxQueue: config.maxQueue });
  const worker = new Worker({
    db,
    intake,
    sources: adapters.sources,
    decider,
    actions,
    env,
    batchSize: config.batchSize,
    batchWaitMs: config.batchWaitMs,
    deciderConcurrency: config.deciderConcurrency,
    retentionMs: config.retentionMs,
    cleanupIntervalMs: config.cleanupIntervalMs,
    pollMs: config.pollMs,
  });
  const app = createApp({
    db,
    intake,
    secrets,
    sources: adapters.sources,
    adminKey: config.adminKey,
    maxBodyBytes: config.maxBodyBytes,
  });

  return {
    app,
    db,
    intake,
    secrets,
    worker,
    decider,
    actions,
    bootSecret,
    async close(graceMs, drainMs = config.commitWindowMs + 50) {
      await Promise.all([worker.stop(graceMs), new Promise((r) => setTimeout(r, drainMs))]);
      intake.flush();
      db.close();
    },
  };
}
