// Triage inside the server: the shared classifier (Models), and per workspace one featurizer
// and its routing state (Triage). The worker that holds a workspace's lease calls `score` while
// parsing (in arrival order) and plans and applies verdicts while deciding.
import fs from "node:fs";
import path from "node:path";
import { all, DEFAULT_WORKSPACE, one, type DB, type Queryable } from "../db.ts";
import { Leases } from "../leases.ts";
import { errMsg, log } from "../log.ts";
import { severityBucket, type FullRoute, type RouteOptions } from "./cascade.ts";
import { Classifier, type ClassifierFile } from "./classifier.ts";
import { extractEntities, Featurizer, FEATURIZER_VERSION, type FeaturizerSnapshot } from "./features.ts";
import { RoutingState, type LabelFact } from "./routing.ts";

export const BUILTIN_MODEL = path.join(import.meta.dirname, "..", "..", "models", "base.json");

export interface TriageOptions {
  /** Share of dropped events still sent to Jev, to find missed escalations. */
  auditRate: number;
  /** How long a Jev verdict on a template is reused. */
  verdictTtlMs: number;
  /** Examples of one template sent to Jev per batch; the rest share their verdict. */
  perTemplate: number;
  /** Error-like events of a never-seen template always go to Jev once. */
  novelGuard: boolean;
  /** How long a template Jev or a person escalated keeps going to Jev whatever its score. 0 = off. */
  knownTtlMs?: number;
  /** After that, until this long, its next event goes to Jev once for review. */
  escalatedMemoryMs?: number;
  /** How long a benign judgment lets the classifier drop its kind of event. 0 = no earned suppression. */
  suppressionTtlMs?: number;
  /** The decider is there to ask; false means the classifier decides alone. */
  hasJev: boolean;
}

export interface Scored {
  score: number | null;
  /** The shadow model's score and route (without audit sampling), when one is running. */
  shadowScore: number | null;
  shadowRoute: FullRoute | null;
  /** The shadow model's trained_at, so its routes are never mixed with another's. */
  shadowModel: string | null;
  route: FullRoute;
  template: string;
  severity: string;
  /** Context the event was routed with: its template's 1-minute rate, its service's 10-minute errors. */
  rate?: number;
  serviceErrors?: number;
  features: Uint8Array;
  user: string | null;
}

/**
 * The classifier and the candidate in shadow. One model file serves every workspace, so one
 * instance is shared by all of a process's Triage objects; each of those keeps its own
 * featurizer history and routing state, and follows a change of feature version on its own.
 */
export class Models {
  classifier: Classifier | null = null;
  modelPath: string | null = null;
  /** A candidate being tried out: it scores every event, but its score decides nothing. */
  shadow: Classifier | null = null;
  #loadedMtime = 0;
  #shadowMtime = 0;

  /** Read a model file. Returns false (keeping the current model) if it can't be used. */
  load(file: string): boolean {
    try {
      const mtime = fs.statSync(file).mtimeMs;
      const c = new Classifier(JSON.parse(fs.readFileSync(file, "utf8")) as ClassifierFile);
      if (this.shadow && this.shadow.file.featurizer_version !== c.file.featurizer_version) this.shadow = null;
      this.classifier = c;
      this.modelPath = file;
      this.#loadedMtime = mtime;
      log.info("classifier loaded", { path: file, trees: c.gbdt.numTrees, drop_below: round(c.file.drop_below), trained_at: c.file.trained_at });
      return true;
    } catch (err) {
      log.warn("classifier not loaded", { path: file, error: errMsg(err) });
      return false;
    }
  }

  /** Whether `file` appeared or changed since it was loaded. */
  changed(file: string): boolean {
    try {
      return !(this.modelPath === file && fs.statSync(file).mtimeMs === this.#loadedMtime);
    } catch {
      return false;
    }
  }

  /** The feature version events must be computed in: the active model's. */
  get version(): number {
    return this.classifier?.file.featurizer_version ?? FEATURIZER_VERSION;
  }

  /** Load a candidate to run in shadow. It must use the active model's feature version. */
  loadShadow(file: string, version = this.version): boolean {
    try {
      this.#shadowMtime = fs.statSync(file).mtimeMs;
      const candidate = new Classifier(JSON.parse(fs.readFileSync(file, "utf8")) as ClassifierFile);
      if (candidate.file.featurizer_version !== version) {
        throw new Error(`a shadow model must use the active feature version v${version}, not v${candidate.file.featurizer_version}`);
      }
      this.shadow = candidate;
      log.info("shadow classifier loaded", { path: file, trees: this.shadow.gbdt.numTrees });
      return true;
    } catch (err) {
      log.warn("shadow classifier not loaded", { path: file, error: errMsg(err) });
      return false;
    }
  }

  /** Pick up (or drop) a shadow model written by `cloudfriend train` in another process. */
  reloadShadowIfChanged(file: string): void {
    let mtime: number;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      this.shadow = null;
      return;
    }
    if (!this.shadow || mtime !== this.#shadowMtime) this.loadShadow(file);
  }

  clearShadow(): void {
    this.shadow = null;
  }
}

/**
 * Triage for one workspace: its featurizer history and routing state (verdict cache, earned
 * suppression, escalation memory), with the process's shared models. Only the worker holding
 * the workspace's lease scores and decides with it (worker.ts).
 */
export class Triage {
  /** Computes the feature version of the loaded model (it changes when a model of another version loads). */
  featurizer = new Featurizer();
  /** Verdict cache, escalation memory and earned suppression (routing.ts). */
  routing: RoutingState;
  readonly opts: TriageOptions;
  readonly models: Models;
  readonly workspace: string;
  /**
   * The lease epoch whose final state this was loaded from, or null when that isn't known (the
   * lease was held while loading). A worker that claims epoch `settledEpoch + 1` can use it as is.
   */
  settledEpoch: number | null = null;
  /** Human labels created after this (epoch ms) are applied by `applyHumanLabels`. */
  humanSince = 0;
  #humanSeen = new Map<string, number>();
  #db: DB;
  #ws: string;

  private constructor(db: DB, ws: string, opts: TriageOptions, models: Models) {
    this.#db = db;
    this.#ws = ws;
    this.workspace = ws;
    this.opts = opts;
    this.models = models;
    this.routing = this.#newRouting();
    this.featurizer = new Featurizer({ version: models.version });
  }

  /** Triage for a workspace, with its routing state rebuilt from labels and its featurizer history restored. */
  static async open(db: DB, opts: TriageOptions, workspace = DEFAULT_WORKSPACE, models = new Models()): Promise<Triage> {
    const t = new Triage(db, workspace, opts, models);
    await t.reload();
    return t;
  }

  /** Load the workspace's state from the database again, discarding what is in memory. */
  async reload(): Promise<void> {
    const epoch = await Leases.settledEpoch(this.#db, this.#ws);
    const started = Date.now();
    const featurizer = new Featurizer({ version: this.models.version });
    const routing = this.#newRouting();
    await this.#rebuildRouting(routing, featurizer.version);
    await this.#restoreFeaturizer(featurizer);
    this.featurizer = featurizer;
    this.routing = routing;
    this.settledEpoch = epoch;
    this.humanSince = started - HUMAN_OVERLAP_MS;
    this.#humanSeen.clear();
  }

  get classifier(): Classifier | null {
    return this.models.classifier;
  }

  get modelPath(): string | null {
    return this.models.modelPath;
  }

  get shadow(): Classifier | null {
    return this.models.shadow;
  }

  #newRouting(): RoutingState {
    return new RoutingState({
      verdictTtlMs: this.opts.verdictTtlMs,
      escalatedTtlMs: this.opts.knownTtlMs ?? 7 * 86_400_000,
      escalatedMemoryMs: this.opts.escalatedMemoryMs,
      suppressionTtlMs: this.opts.suppressionTtlMs ?? 0,
    });
  }

  async #restoreFeaturizer(featurizer: Featurizer): Promise<void> {
    const row = await one<{ featurizer: string }>(this.#db, "SELECT featurizer FROM snapshots WHERE workspace_id = $1", [this.#ws]);
    if (!row) return;
    try {
      if (!featurizer.restore(JSON.parse(row.featurizer) as FeaturizerSnapshot)) log.info("featurizer history is from another version; starting fresh", { workspace: this.#ws });
    } catch (err) {
      log.warn("could not restore featurizer history", { workspace: this.#ws, error: errMsg(err) });
    }
  }

  /**
   * Follow the shared model's feature version. When it changed, history starts fresh unless a
   * snapshot of that version exists, and routing is rebuilt so that benign judgments made under
   * the other version no longer earn suppression (the severity they were keyed by may read
   * differently). Escalations are kept. Both are built aside and swapped in one step, so events
   * are never scored half-switched. The worker calls this before every parse and decide pass.
   */
  async sync(): Promise<void> {
    const version = this.models.version;
    if (version === this.featurizer.version) return;
    log.info("featurizer version changes with the model", { workspace: this.#ws, from: this.featurizer.version, to: version });
    const featurizer = new Featurizer({ version });
    await this.#restoreFeaturizer(featurizer);
    const routing = this.#newRouting();
    await this.#rebuildRouting(routing, version);
    if (this.models.version !== version) return; // changed again meanwhile; the next sync follows
    this.featurizer = featurizer;
    this.routing = routing;
  }

  /** Load a model file for every workspace, and switch this one to its feature version now. */
  async load(file: string): Promise<boolean> {
    if (!this.models.load(file)) return false;
    await this.sync();
    return true;
  }

  /** Switch to `file` if it appeared or changed since it was loaded, e.g. after `cloudfriend train` promoted a model in another process. */
  async reloadIfChanged(file: string): Promise<void> {
    if (this.models.changed(file)) await this.load(file);
  }

  /** Load a candidate to run in shadow. */
  loadShadow(file: string): boolean {
    return this.models.loadShadow(file, this.featurizer.version);
  }

  reloadShadowIfChanged(file: string): void {
    this.models.reloadShadowIfChanged(file);
  }

  clearShadow(): void {
    this.models.clearShadow();
  }

  score(source: string, receivedAt: number, data: unknown, rand = Math.random): Scored {
    const f = this.featurizer.featurize({ source, received_at: receivedAt, data });
    // A model of another feature version can't read these features (sync() hasn't run yet):
    // without a score, the event goes to Jev.
    const usable = (m: Classifier | null) => (m && m.file.featurizer_version === this.featurizer.version ? m : null);
    const active = usable(this.models.classifier);
    const shadow = usable(this.models.shadow);
    const score = active ? active.score(f.values) : null;
    const c = active?.file;
    const now = Date.now();
    const template = f.template.slice(0, 300);
    const severity = severityBucket(f.level, f.status);
    const ctx = this.featurizer.context(f.template);
    const facts = { template, severity, novel: f.novel, rate: ctx?.last_1m, serviceErrors: ctx?.service_errors_10m };
    const opts = (m: ClassifierFile | undefined, auditRate: number): RouteOptions => ({
      dropBelow: m?.drop_below ?? 0,
      escalateAbove: m?.escalate_above ?? 2,
      threshold: m?.threshold ?? 0.5,
      hasJev: this.opts.hasJev,
      auditRate,
      novelGuard: this.opts.novelGuard,
      rand,
    });
    const route = this.routing.route(score, opts(c, this.opts.auditRate), facts, now);
    const shadowScore = shadow ? shadow.score(f.values) : null;
    const shadowRoute = shadow ? this.routing.route(shadowScore, opts(shadow.file, 0), facts, now) : null;
    return {
      score,
      shadowScore,
      shadowRoute,
      shadowModel: shadow?.file.trained_at ?? null,
      route,
      template,
      severity,
      rate: ctx?.last_1m,
      serviceErrors: ctx?.service_errors_10m,
      features: encodeFeatures(f.values),
      user: extractEntities(data, f.text).user?.slice(0, 128) ?? null,
    };
  }

  /** Rebuild escalations and earned suppression from the labels table, so a restart forgets nothing. */
  async #rebuildRouting(routing: RoutingState, version: number): Promise<void> {
    const since = Date.now() - routing.horizonMs;
    const rows = await all<LabelFact>(
      this.#db,
      `SELECT template, severity, y, source, provenance, created_at AS at, ctx_rate AS rate, ctx_service_errors AS "serviceErrors",
              featurizer_version AS "featurizerVersion"
       FROM labels WHERE workspace_id = $1 AND template IS NOT NULL AND created_at >= $2 ORDER BY created_at, event_id`,
      [this.#ws, since],
    );
    routing.rebuild(rows, version);
  }

  /**
   * Apply people's labels written since the last call, possibly by another process (the API runs
   * apart from the worker): a person's verdict changes routing at once, as feedback.ts does when
   * it runs in the process that owns the workspace. Labels are read with an overlap and applied
   * once each; applying one twice would be harmless.
   */
  applyHumanLabels(rows: HumanLabel[]): void {
    const now = Date.now();
    for (const [k, at] of this.#humanSeen) if (at < now - 2 * HUMAN_OVERLAP_MS) this.#humanSeen.delete(k);
    for (const r of rows) {
      const key = `${r.event_id}:${r.created_at}`;
      if (this.#humanSeen.has(key) || !r.template) continue;
      this.#humanSeen.set(key, r.created_at);
      if (r.provenance === "import") {
        this.routing.rebuild([{ template: r.template, severity: r.severity, y: r.y, source: "human", provenance: "import", at: r.created_at, rate: null, serviceErrors: null }]);
        continue;
      }
      const ctx = this.featurizer.context(r.template);
      this.routing.personSaid(r.template, r.severity ?? undefined, r.y === 1, r.created_at, { rate: ctx?.last_1m, serviceErrors: ctx?.service_errors_10m }, r.false_positive);
    }
    this.humanSince = Math.max(this.humanSince, now - HUMAN_OVERLAP_MS);
  }

  /** The verdict cache (routing.ts), for callers that only need it. */
  get cache() {
    return this.routing.cache;
  }

  /** Escalated templates (routing.ts), for callers that only need them. */
  get escalated() {
    return this.routing.escalated;
  }

  /** Save the featurizer history. The worker passes a transaction fenced on the workspace's lease. */
  async saveState(q: Queryable = this.#db): Promise<void> {
    await q.query(
      `INSERT INTO snapshots (workspace_id, featurizer, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id) DO UPDATE SET featurizer = excluded.featurizer, updated_at = excluded.updated_at`,
      [this.#ws, JSON.stringify(this.featurizer.snapshot()), Date.now()],
    );
  }
}

/** How far back human labels are read again, for writes that committed out of time order. */
export const HUMAN_OVERLAP_MS = 60_000;

/** A person's label as `applyHumanLabels` reads it. */
export interface HumanLabel {
  workspace_id: string;
  event_id: number;
  template: string | null;
  severity: string | null;
  y: number;
  provenance: string | null;
  created_at: number;
  /** The label came from marking a flag false_positive: its kind also gets a cached "no". */
  false_positive: boolean;
}

/** People's labels in these workspaces created after `since`. */
export async function humanLabelsSince(q: Queryable, workspaces: string[], since: number): Promise<HumanLabel[]> {
  if (!workspaces.length) return [];
  return all<HumanLabel>(
    q,
    `SELECT l.workspace_id, l.event_id, l.template, l.severity, l.y, l.provenance, l.created_at,
            (l.y = 0 AND EXISTS (SELECT 1 FROM flags f WHERE f.workspace_id = l.workspace_id AND f.status = 'false_positive' AND f.event_ids ? l.event_id::text)) AS false_positive
     FROM labels l WHERE l.workspace_id = ANY($1::text[]) AND l.source = 'human' AND l.created_at > $2 ORDER BY l.created_at, l.event_id`,
    [workspaces, since],
  );
}

/** Feature vectors are stored as little-endian float32 (NaN for missing). */
export function encodeFeatures(values: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(values).buffer);
}

export function decodeFeatures(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob); // aligned copy
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}


const round = (n: number) => Math.round(n * 1e4) / 1e4;
