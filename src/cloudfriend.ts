import type { Hono } from "hono";
import { loadAdapters, type Adapters } from "./adapters.ts";
import { setupAuth, type AuthSetup } from "./api/index.ts";
import type { Config } from "./config.ts";
import { DEFAULT_WORKSPACE, openDb, type DB } from "./db.ts";
import { Intake } from "./intake.ts";
import { errMsg, log } from "./log.ts";
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
  /** Sign-in: the bootstrap admin, and its generated password on first boot (print it once). */
  auth: AuthSetup;
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

  const db = await openDb(config.databaseUrl, { max: config.dbPool });
  let auth: AuthSetup;
  try {
    auth = await setupAuth(db, env);
  } catch (err) {
    await db.end().catch(() => {});
    throw err;
  }
  const workspace = DEFAULT_WORKSPACE;
  const secrets = new Secrets(db, workspace);
  const bootSecret = (await secrets.createFirst("default"))?.secret ?? null;
  const intake = await Intake.open(db, { windowMs: config.commitWindowMs, maxQueue: config.maxQueue });

  let triage: Triage | null = null;
  let trainer: Trainer | null = null;
  if (config.triage) {
    triage = await Triage.open(db, {
      auditRate: config.auditRate,
      verdictTtlMs: config.verdictTtlMs,
      perTemplate: config.perTemplate,
      novelGuard: config.novelGuard,
      knownTtlMs: config.knownTtlMs,
      escalatedMemoryMs: config.escalatedMemoryMs,
      suppressionTtlMs: config.suppressionTtlMs,
      hasJev: decider !== null,
    }, workspace);
    // The first model that loads: an explicit file, the last promoted one, the built-in one.
    const active = path.join(config.dataDir, "models", "active.json");
    for (const file of [config.modelPath, active, BUILTIN_MODEL]) {
      if (file && fs.existsSync(file) && (await triage.load(file))) break;
    }
    if (!triage.classifier) log.warn("no classifier loaded; every event goes to the decider until one is trained");
    trainer = new Trainer(db, triage, {
      dataDir: config.dataDir,
      python: config.python,
      minLabels: config.retrainMinLabels,
      humanWeight: config.humanLabelWeight,
      recall: config.recallTarget,
      shadowPeriodMs: config.shadowPeriodMs,
      shadowMinEvidence: config.shadowMinEvidence,
      shadowMaxMs: config.shadowMaxMs,
      safetySet: config.safetySet,
      regressionSuite: config.regressionSuite,
      verdictTtlMs: config.verdictTtlMs,
      novelGuard: config.novelGuard,
      incidentWindowMs: config.incidentWindowMs,
      knownTtlMs: config.knownTtlMs,
      escalatedMemoryMs: config.escalatedMemoryMs,
      suppressionTtlMs: config.suppressionTtlMs,
    }, workspace);
    const shadowPath = path.join(config.dataDir, "models", "shadow.json");
    if (fs.existsSync(shadowPath)) triage.loadShadow(shadowPath);
  }
  const worker = new Worker({
    db,
    workspace,
    intake,
    sources: adapters.sources,
    decider,
    actions,
    triage,
    env,
    batchSize: config.batchSize,
    batchWaitMs: config.batchWaitMs,
    auditWaitMs: config.auditWaitMs,
    deciderConcurrency: config.deciderConcurrency,
    retentionMs: config.retentionMs,
    cleanupIntervalMs: config.cleanupIntervalMs,
    pollMs: config.pollMs,
  });
  const app = createApp({
    db,
    workspace,
    intake,
    secrets,
    sources: adapters.sources,
    adminKey: config.adminKey,
    maxBodyBytes: config.maxBodyBytes,
    triage,
    trainer,
    counters: () => ({ ...worker.counters }),
    auth,
    actionAdapters: adapters.actions,
    decider: decider?.name ?? null,
    env,
  });

  let retrainTimer: NodeJS.Timeout | null = null;
  let reloadTimer: NodeJS.Timeout | null = null;
  const startRetraining = () => {
    if (triage && !config.modelPath) {
      const active = path.join(config.dataDir, "models", "active.json");
      let reloading = false;
      reloadTimer = setInterval(() => {
        if (reloading) return;
        reloading = true;
        void (async () => {
          await triage!.reloadIfChanged(active);
          triage!.reloadShadowIfChanged(path.join(config.dataDir, "models", "shadow.json"));
          await trainer?.checkShadow();
        })()
          .catch((err) => log.warn("model reload failed", { error: errMsg(err) }))
          .finally(() => (reloading = false));
      }, 30_000);
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
    auth,
    startRetraining,
    async close(graceMs, drainMs = config.commitWindowMs + 50) {
      if (retrainTimer) clearInterval(retrainTimer);
      if (reloadTimer) clearInterval(reloadTimer);
      auth.stop();
      await Promise.all([worker.stop(graceMs), new Promise((r) => setTimeout(r, drainMs))]);
      await intake.flush();
      await db.end();
    },
  };
}
