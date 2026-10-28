import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { loadAdapters, type Adapters } from "./adapters.ts";
import { setupAuth, type AuthSetup } from "./api/index.ts";
import type { Config, Role } from "./config.ts";
import { DEFAULT_WORKSPACE, one, openDb, tx, type DB } from "./db.ts";
import { Intake } from "./intake.ts";
import { errMsg, log } from "./log.ts";
import { Secrets } from "./secrets.ts";
import { createApp } from "./server.ts";
import { singleWorkspace as onlyOneWorkspace, Trainer } from "./training.ts";
import { BUILTIN_MODEL, Models, Triage, type TriageOptions } from "./triage/runtime.ts";
import type { ActionAdapter, DeciderAdapter } from "./types.ts";
import { Worker } from "./worker.ts";

export interface cloudfriend {
  /** What this process runs (CLOUDFRIEND_ROLE): `all`, `web` (HTTP and intake) or `worker` (the worker and /healthz). */
  role: Role;
  /** The HTTP app: every route for `all` and `web`, only /healthz for `worker`. */
  app: Hono;
  db: DB;
  intake: Intake;
  secrets: Secrets;
  /** The worker. With role `web` it never claims a workspace or runs anything. */
  worker: Worker;
  decider: { name: string; adapter: DeciderAdapter } | null;
  /** Actions enabled by environment variables (CLOUDFRIEND_ACTIONS, or every one whose `enabled()` says yes). */
  actions: Map<string, ActionAdapter>;
  /** The classifier and the candidate in shadow, shared by every workspace. null when CLOUDFRIEND_TRIAGE=off. */
  models: Models | null;
  /** The default workspace's triage state. null when CLOUDFRIEND_TRIAGE=off. */
  triage: Triage | null;
  /**
   * A workspace's triage state if this process holds it (the default workspace's always), so a
   * person's feedback changes its routing at once. Otherwise null: the owner applies people's
   * labels within seconds (worker.ts).
   */
  triageFor(workspace: string): Triage | null;
  trainer: Trainer | null;
  /** Start what the role runs: the worker loop (not for `web`), model reloading and retraining. `main.ts` calls it. */
  start(): void;
  /** Start the model reload and scheduled retraining (CLOUDFRIEND_RETRAIN_INTERVAL). `start()` calls it. */
  startRetraining(): void;
  /** Set on first boot only: the generated ingest secret, to print once. */
  bootSecret: string | null;
  /** Sign-in: the bootstrap admin, and its generated password on first boot (print it once). */
  auth: AuthSetup;
  /**
   * Shut down: stop the worker at once (no new decides or deliveries), give in-flight work
   * `graceMs` and requests already being read `drainMs` to reach the queue, commit, save each
   * held workspace's history and release its lease, close.
   */
  close(graceMs?: number, drainMs?: number): Promise<void>;
}

/** Build a cloudfriend instance without listening on a port. `main.ts` adds the HTTP server. */
export async function createCloudfriend(config: Config, env: NodeJS.ProcessEnv = process.env, adapters?: Adapters): Promise<cloudfriend> {
  adapters ??= await loadAdapters(config.adapterDir);
  const role: Role = config.role ?? "all";

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
  const bootSecret = role === "worker" ? null : ((await secrets.createFirst("default"))?.secret ?? null);
  const intake = await Intake.open(db, { windowMs: config.commitWindowMs, maxQueue: config.maxQueue });
  const envDestinations = await seedEnvDestinations(db, env, actions);
  // Env-configured actions still run by name for the default workspace, except the ones that
  // became destinations (they are delivered through those rows now).
  const legacyActions = [...actions.keys()].filter((name) => !envDestinations.has(name));

  let models: Models | null = null;
  let triage: Triage | null = null;
  let trainer: Trainer | null = null;
  let triageOpts: TriageOptions | null = null;
  if (config.triage) {
    triageOpts = {
      auditRate: config.auditRate,
      verdictTtlMs: config.verdictTtlMs,
      perTemplate: config.perTemplate,
      novelGuard: config.novelGuard,
      knownTtlMs: config.knownTtlMs,
      escalatedMemoryMs: config.escalatedMemoryMs,
      suppressionTtlMs: config.suppressionTtlMs,
      hasJev: decider !== null,
    };
    models = new Models();
    // The first model that loads: an explicit file, the last promoted one, the built-in one.
    const active = path.join(config.dataDir, "models", "active.json");
    for (const file of [config.modelPath, active, BUILTIN_MODEL]) {
      if (file && fs.existsSync(file) && models.load(file)) break;
    }
    if (!models.classifier) log.warn("no classifier loaded; every event goes to the decider until one is trained");
    triage = await Triage.open(db, triageOpts, workspace, models);
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
    intake,
    sources: adapters.sources,
    decider,
    actions,
    actionKinds: adapters.actions,
    legacyActions,
    openTriage: triageOpts ? (ws) => Triage.open(db, triageOpts!, ws, models!) : null,
    defaultTriage: triage,
    env,
    batchSize: config.batchSize,
    batchWaitMs: config.batchWaitMs,
    auditWaitMs: config.auditWaitMs,
    deciderConcurrency: config.deciderConcurrency,
    retentionMs: config.retentionMs,
    cleanupIntervalMs: config.cleanupIntervalMs,
    pollMs: config.pollMs,
    leaseTtlMs: config.leaseTtlMs,
    leaseRenewMs: config.leaseRenewMs,
    maxWorkspaces: config.maxWorkspacesPerWorker,
    idleUnloadMs: config.idleUnloadMs,
    jevDailyBudgetUsd: config.jevDailyBudgetUsd,
    enabled: role !== "web",
  });
  const triageFor = (ws: string) => worker.triageFor(ws) ?? (ws === workspace ? triage : null);

  let app: Hono;
  if (role === "worker") {
    app = new Hono();
    app.get("/healthz", (c) => c.json({ ok: true, queued: intake.backlog, workspaces: worker.owned.length }));
    app.notFound((c) => c.json({ error: "not found (CLOUDFRIEND_ROLE=worker serves only /healthz)" }, 404));
  } else {
    app = createApp({
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
      triageFor,
      jevDailyBudgetUsd: config.jevDailyBudgetUsd,
    });
  }

  let retrainTimer: NodeJS.Timeout | null = null;
  let reloadTimer: NodeJS.Timeout | null = null;
  // The trainer learns from the default workspace's labels, and the model it promotes serves
  // every workspace: scheduled training and shadow promotion only run while that is the only one.
  const singleWorkspace = () => onlyOneWorkspace(db);
  let warnedMulti = false;
  const startRetraining = () => {
    if (reloadTimer || retrainTimer) return;
    if (triage && !config.modelPath) {
      const active = path.join(config.dataDir, "models", "active.json");
      let reloading = false;
      reloadTimer = setInterval(() => {
        if (reloading) return;
        reloading = true;
        void (async () => {
          await triage!.reloadIfChanged(active);
          triage!.reloadShadowIfChanged(path.join(config.dataDir, "models", "shadow.json"));
          if (role !== "web" && (await singleWorkspace())) await trainer?.checkShadow();
        })()
          .catch((err) => log.warn("model reload failed", { error: errMsg(err) }))
          .finally(() => (reloading = false));
      }, 30_000);
      reloadTimer.unref();
    }
    if (!trainer || !config.retrainIntervalMs || role === "web") return;
    retrainTimer = setInterval(() => {
      void (async () => {
        if (await singleWorkspace()) return trainer!.maybeTrain();
        if (!warnedMulti) log.warn("scheduled retraining is off while there is more than one workspace (the model is shared by all of them)");
        warnedMulti = true;
      })().catch(() => {});
    }, config.retrainIntervalMs);
    retrainTimer.unref();
  };

  return {
    role,
    app,
    db,
    intake,
    secrets,
    worker,
    decider,
    actions,
    models,
    triage,
    triageFor,
    trainer,
    bootSecret,
    auth,
    start() {
      if (role !== "web") worker.start();
      startRetraining();
    },
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

/**
 * Self-hosted setups configure Slack and the webhook with environment variables. The first time
 * the default workspace has no destinations at all, those become destination rows, so flags
 * reach them the way they reach any destination. Returns the action names delivered that way.
 */
async function seedEnvDestinations(db: DB, env: NodeJS.ProcessEnv, actions: Map<string, ActionAdapter>): Promise<Set<string>> {
  const seeds: { kind: string; name: string; config: Record<string, unknown> }[] = [];
  if (env.SLACK_WEBHOOK_URL && actions.has("slack")) {
    const min = env.SLACK_MIN_SEVERITY?.trim().toLowerCase();
    seeds.push({ kind: "slack", name: "Slack (SLACK_WEBHOOK_URL)", config: { url: env.SLACK_WEBHOOK_URL, ...(min ? { min_severity: min } : {}) } });
  }
  if (env.WEBHOOK_URL && actions.has("webhook")) {
    seeds.push({ kind: "webhook", name: "Webhook (WEBHOOK_URL)", config: { url: env.WEBHOOK_URL, ...(env.WEBHOOK_SECRET ? { signing_secret: env.WEBHOOK_SECRET } : {}) } });
  }
  if (!seeds.length) return new Set();
  const created = await tx(db, async (c) => {
    // Locked, so two processes booting at once don't both seed.
    await c.query("SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE", [DEFAULT_WORKSPACE]);
    if (await one(c, "SELECT 1 FROM destinations WHERE workspace_id = $1 LIMIT 1", [DEFAULT_WORKSPACE])) return false;
    const now = Date.now();
    for (const s of seeds) {
      await c.query("INSERT INTO destinations (id, workspace_id, name, kind, config, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [
        "dst_" + randomBytes(8).toString("hex"), DEFAULT_WORKSPACE, s.name, s.kind, JSON.stringify(s.config), now,
      ]);
    }
    return true;
  });
  const kinds = seeds.map((s) => s.kind);
  if (created) log.info("created destinations for the default workspace from environment variables", { kinds: kinds.join(",") });
  else if (!(await one(db, "SELECT 1 FROM destinations WHERE workspace_id = $1 AND kind = ANY($2::text[]) LIMIT 1", [DEFAULT_WORKSPACE, kinds]))) {
    log.warn("SLACK_WEBHOOK_URL / WEBHOOK_URL are set but the default workspace already has other destinations, so they are not used; add them as destinations", { kinds: kinds.join(",") });
  }
  return new Set(kinds);
}
