import type { Hono } from "hono";
import { loadAdapters, type Adapters } from "./adapters.ts";
import type { Config } from "./config.ts";
import { dbPath, openDb, type DB } from "./db.ts";
import { Intake } from "./intake.ts";
import { log } from "./log.ts";
import { Secrets } from "./secrets.ts";
import { createApp } from "./server.ts";
import { Trainer } from "./training.ts";
import { BUILTIN_MODEL, Triage } from "./triage/runtime.ts";
import type { ActionAdapter, DeciderAdapter } from "./types.ts";
import { Worker } from "./worker.ts";
import fs from "node:fs";
import path from "node:path";

export interface cloudfriend {
  app: Hono;
  db: DB;
  intake: Intake;
  secrets: Secrets;
  worker: Worker;
  decider: { name: string; adapter: DeciderAdapter } | null;
  actions: Map<string, ActionAdapter>;
  /** null when CLOUDFRIEND_TRIAGE=off. */
  triage: Triage | null;
  trainer: Trainer | null;
  /** Start the scheduled retraining (CLOUDFRIEND_RETRAIN_INTERVAL). `main.ts` calls it. */
  startRetraining(): void;
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

  let triage: Triage | null = null;
  let trainer: Trainer | null = null;
  if (config.triage) {
    triage = new Triage(db, {
      auditRate: config.auditRate,
      verdictTtlMs: config.verdictTtlMs,
      perTemplate: config.perTemplate,
      novelGuard: config.novelGuard,
      hasJev: decider !== null,
    });
    // The first model that loads: an explicit file, the last promoted one, the built-in one.
    const active = path.join(config.dataDir, "models", "active.json");
    for (const file of [config.modelPath, active, BUILTIN_MODEL]) {
      if (file && fs.existsSync(file) && triage.load(file)) break;
    }
    if (!triage.classifier) log.warn("no classifier loaded; every event goes to the decider until one is trained");
    trainer = new Trainer(db, triage, {
      dataDir: config.dataDir,
      python: config.python,
      minLabels: config.retrainMinLabels,
      humanWeight: config.humanLabelWeight,
      recall: config.recallTarget,
    });
  }
  const worker = new Worker({
    db,
    intake,
    sources: adapters.sources,
    decider,
    actions,
    triage,
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
    triage,
    trainer,
    counters: () => ({ ...worker.counters }),
  });

  let retrainTimer: NodeJS.Timeout | null = null;
  let reloadTimer: NodeJS.Timeout | null = null;
  const startRetraining = () => {
    if (triage && !config.modelPath) {
      const active = path.join(config.dataDir, "models", "active.json");
      reloadTimer = setInterval(() => triage!.reloadIfChanged(active), 30_000);
      reloadTimer.unref();
    }
    if (!trainer || !config.retrainIntervalMs) return;
    retrainTimer = setInterval(() => void trainer!.maybeTrain().catch(() => {}), config.retrainIntervalMs);
    retrainTimer.unref();
  };

  return {
    app,
    db,
    intake,
    secrets,
    worker,
    decider,
    actions,
    triage,
    trainer,
    bootSecret,
    startRetraining,
    async close(graceMs, drainMs = config.commitWindowMs + 50) {
      if (retrainTimer) clearInterval(retrainTimer);
      if (reloadTimer) clearInterval(reloadTimer);
      await Promise.all([worker.stop(graceMs), new Promise((r) => setTimeout(r, drainMs))]);
      intake.flush();
      db.close();
    },
  };
}
