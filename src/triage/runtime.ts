// Triage inside the server: one featurizer, the active classifier, and the verdict cache.
// The worker calls `score` while parsing (in arrival order) and `plan`/`apply` while deciding.
import fs from "node:fs";
import path from "node:path";
import { all, DEFAULT_WORKSPACE, one, type DB } from "../db.ts";
import { errMsg, log } from "../log.ts";
import { severityBucket, type FullRoute, type RouteOptions } from "./cascade.ts";
import { Classifier, type ClassifierFile } from "./classifier.ts";
import { extractEntities, Featurizer, type FeaturizerSnapshot } from "./features.ts";
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

export class Triage {
  /** Computes the feature version of the loaded model (it changes when a model of another version loads). */
  featurizer = new Featurizer();
  /** Verdict cache, escalation memory and earned suppression (routing.ts). */
  routing: RoutingState;
  readonly opts: TriageOptions;
  classifier: Classifier | null = null;
  modelPath: string | null = null;
  /** A candidate being tried out: it scores every event, but its score decides nothing. */
  shadow: Classifier | null = null;
  #shadowMtime = 0;
  #db: DB;
  #ws: string;

  private constructor(db: DB, ws: string, opts: TriageOptions) {
    this.#db = db;
    this.#ws = ws;
    this.opts = opts;
    this.routing = this.#newRouting();
  }

  /** Triage for a workspace, with its routing state rebuilt from labels and its featurizer history restored. */
  static async open(db: DB, opts: TriageOptions, workspace = DEFAULT_WORKSPACE): Promise<Triage> {
    const t = new Triage(db, workspace, opts);
    await t.#rebuildRouting(t.routing, t.featurizer.version);
    await t.#restoreFeaturizer(t.featurizer);
    return t;
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
      if (!featurizer.restore(JSON.parse(row.featurizer) as FeaturizerSnapshot)) log.info("featurizer history is from another version; starting fresh");
    } catch (err) {
      log.warn("could not restore featurizer history", { error: errMsg(err) });
    }
  }

  /**
   * A model of another feature version is being loaded: compute that version from now on. Its
   * history starts fresh unless a snapshot of that version exists, and routing is rebuilt so
   * that benign judgments made under the other version no longer earn suppression (the
   * severity they were keyed by may read differently). Escalations are kept. Both are built
   * aside and swapped in by `load` in one step, so events are never scored half-switched.
   */
  async #prepareSwitch(version: number): Promise<{ featurizer: Featurizer; routing: RoutingState }> {
    log.info("featurizer version changes with the model", { from: this.featurizer.version, to: version });
    const featurizer = new Featurizer({ version });
    await this.#restoreFeaturizer(featurizer);
    const routing = this.#newRouting();
    await this.#rebuildRouting(routing, version);
    return { featurizer, routing };
  }

  #loadedMtime = 0;

  /** Load a model file. Returns false (keeping the current model) if it can't be used. */
  async load(file: string): Promise<boolean> {
    try {
      const mtime = fs.statSync(file).mtimeMs;
      const c = new Classifier(JSON.parse(fs.readFileSync(file, "utf8")) as ClassifierFile);
      if (c.file.featurizer_version !== this.featurizer.version) {
        const next = await this.#prepareSwitch(c.file.featurizer_version);
        this.featurizer = next.featurizer;
        this.routing = next.routing;
        if (this.shadow && this.shadow.file.featurizer_version !== c.file.featurizer_version) this.shadow = null;
      }
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

  /**
   * Switch to `file` if it appeared or changed since it was loaded, e.g. after
   * `cloudfriend train` promoted a model in another process.
   */
  async reloadIfChanged(file: string): Promise<void> {
    let mtime: number;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      return;
    }
    if (this.modelPath === file && mtime === this.#loadedMtime) return;
    await this.load(file);
  }

  /** Load a candidate to run in shadow. */
  loadShadow(file: string): boolean {
    try {
      this.#shadowMtime = fs.statSync(file).mtimeMs;
      const candidate = new Classifier(JSON.parse(fs.readFileSync(file, "utf8")) as ClassifierFile);
      if (candidate.file.featurizer_version !== this.featurizer.version) {
        throw new Error(`a shadow model must use the active feature version v${this.featurizer.version}, not v${candidate.file.featurizer_version}`);
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

  score(source: string, receivedAt: number, data: unknown, rand = Math.random): Scored {
    const f = this.featurizer.featurize({ source, received_at: receivedAt, data });
    const score = this.classifier ? this.classifier.score(f.values) : null;
    const c = this.classifier?.file;
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
    const shadowScore = this.shadow ? this.shadow.score(f.values) : null;
    const shadowRoute = this.shadow ? this.routing.route(shadowScore, opts(this.shadow.file, 0), facts, now) : null;
    return {
      score,
      shadowScore,
      shadowRoute,
      shadowModel: this.shadow?.file.trained_at ?? null,
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

  /** The verdict cache (routing.ts), for callers that only need it. */
  get cache() {
    return this.routing.cache;
  }

  /** Escalated templates (routing.ts), for callers that only need them. */
  get escalated() {
    return this.routing.escalated;
  }

  async saveState(): Promise<void> {
    await this.#db.query(
      `INSERT INTO snapshots (workspace_id, featurizer, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id) DO UPDATE SET featurizer = excluded.featurizer, updated_at = excluded.updated_at`,
      [this.#ws, JSON.stringify(this.featurizer.snapshot()), Date.now()],
    );
  }
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
