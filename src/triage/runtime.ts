// Triage inside the server: one featurizer, the active classifier, and the verdict cache.
// The worker calls `score` while parsing (in arrival order) and `plan`/`apply` while deciding.
import fs from "node:fs";
import path from "node:path";
import type { DB } from "../db.ts";
import { errMsg, log } from "../log.ts";
import { EscalatedTemplates, routeEvent, severityBucket, VerdictCache, type FullRoute } from "./cascade.ts";
import { Classifier, type ClassifierFile } from "./classifier.ts";
import { extractEntities, Featurizer, FEATURIZER_VERSION, type FeaturizerSnapshot } from "./features.ts";

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
  /** The decider is there to ask; false means the classifier decides alone. */
  hasJev: boolean;
}

export interface Scored {
  score: number | null;
  /** The shadow model's score and route (without audit sampling), when one is running. */
  shadowScore: number | null;
  shadowRoute: FullRoute | null;
  route: FullRoute;
  template: string;
  severity: string;
  features: Uint8Array;
  user: string | null;
}

export class Triage {
  readonly featurizer = new Featurizer();
  readonly cache: VerdictCache;
  readonly escalated: EscalatedTemplates;
  readonly opts: TriageOptions;
  classifier: Classifier | null = null;
  modelPath: string | null = null;
  /** A candidate being tried out: it scores every event, but its score decides nothing. */
  shadow: Classifier | null = null;
  #shadowMtime = 0;
  #db: DB;

  constructor(db: DB, opts: TriageOptions) {
    this.#db = db;
    this.opts = opts;
    this.cache = new VerdictCache(opts.verdictTtlMs);
    this.escalated = new EscalatedTemplates(opts.knownTtlMs ?? 7 * 86_400_000);
    this.#loadEscalated(db);
    const row = db.prepare("SELECT value FROM kv WHERE key = 'featurizer'").get() as { value: string } | undefined;
    if (row) {
      try {
        if (!this.featurizer.restore(JSON.parse(row.value) as FeaturizerSnapshot)) log.info("featurizer history is from another version; starting fresh");
      } catch (err) {
        log.warn("could not restore featurizer history", { error: errMsg(err) });
      }
    }
  }

  #loadedMtime = 0;

  /** Load a model file. Returns false (keeping the current model) if it can't be used. */
  load(file: string): boolean {
    try {
      const mtime = fs.statSync(file).mtimeMs;
      const c = new Classifier(JSON.parse(fs.readFileSync(file, "utf8")) as ClassifierFile);
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
  reloadIfChanged(file: string): void {
    let mtime: number;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      return;
    }
    if (this.modelPath === file && mtime === this.#loadedMtime) return;
    this.load(file);
  }

  /** Load a candidate to run in shadow. */
  loadShadow(file: string): boolean {
    try {
      this.#shadowMtime = fs.statSync(file).mtimeMs;
      this.shadow = new Classifier(JSON.parse(fs.readFileSync(file, "utf8")) as ClassifierFile);
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
    const known = this.escalated.has(f.template.slice(0, 300), Date.now());
    const route = routeEvent(score, {
      dropBelow: c?.drop_below ?? 0,
      escalateAbove: c?.escalate_above ?? 2,
      threshold: c?.threshold ?? 0.5,
      hasJev: this.opts.hasJev,
      auditRate: this.opts.auditRate,
      novelGuard: this.opts.novelGuard,
      rand,
    }, f.novel, known);
    const shadowScore = this.shadow ? this.shadow.score(f.values) : null;
    const s = this.shadow?.file;
    const shadowRoute = s
      ? routeEvent(shadowScore, { dropBelow: s.drop_below, escalateAbove: s.escalate_above, threshold: s.threshold, hasJev: this.opts.hasJev, auditRate: 0, novelGuard: this.opts.novelGuard }, f.novel, known)
      : null;
    return {
      score,
      shadowScore,
      shadowRoute,
      route,
      template: f.template.slice(0, 300),
      severity: severityBucket(f.level, f.status),
      features: encodeFeatures(f.values),
      user: extractEntities(data, f.text).user?.slice(0, 128) ?? null,
    };
  }

  /**
   * Templates whose latest label says "escalate", within the window. A person's label wins
   * over Jev's: a template a person marked as a false positive is not loaded.
   */
  #loadEscalated(db: DB): void {
    if (!this.escalated.ttlMs) return;
    const since = Date.now() - this.escalated.ttlMs;
    const rows = db
      .prepare(
        `SELECT template, y, source, created_at FROM labels WHERE template IS NOT NULL AND created_at >= ?
         ORDER BY template, (source = 'human') DESC, created_at DESC`,
      )
      .all(since) as { template: string; y: number; created_at: number }[];
    let last = "";
    for (const r of rows) {
      if (r.template === last) continue;
      last = r.template;
      if (r.y) this.escalated.add(r.template, r.created_at);
    }
  }

  saveState(): void {
    this.#db
      .prepare("INSERT INTO kv (key, value, updated_at) VALUES ('featurizer', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(JSON.stringify(this.featurizer.snapshot()), Date.now());
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

export const FEATURIZER = FEATURIZER_VERSION;

const round = (n: number) => Math.round(n * 1e4) / 1e4;
