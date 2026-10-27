// The training loop: turn the labels Jev and people produced into a better classifier.
//
//   1. export   labels with the current featurizer version, split by time into three parts
//               that never share an incident (`splitLabels`): fit (oldest 60%), calibrate
//               (next 20%: early stopping and drop_below) and accept (newest 20%: only the gate
//               sees it). Each label carries a weight from how it came about (labelProvenance).
//   2. train    ml/train.py boosts new trees on top of the built-in base model (so a few
//               hundred labels refine it rather than replace it) and picks thresholds
//   3. gate     hard requirements, not a comparison (`gate`): the candidate must still send at
//               least the recall target of the accept part's escalations to Jev (by its score,
//               or by the routing rules as they stood at the time), and pass every
//               regression scenario (scenarios.ts). Only then does a lower Jev load
//               count. Labels only exist for events that got past the classifier, so the drop
//               threshold is also checked on recent unlabelled traffic (`limitThreshold`).
//   4. shadow   a candidate that passes runs beside the active model for
//               CLOUDFRIEND_SHADOW_PERIOD, scoring live events without acting on them. It is
//               promoted only if it would have dropped none of the events judged relevant in
//               that time (`checkShadow`).
//   5. promote  the file becomes <data>/models/active.json and the worker swaps it in
//
// Runs on a schedule (CLOUDFRIEND_RETRAIN_INTERVAL) once enough new labels exist, or on
// demand with `cloudfriend train` / `POST /model/train`.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { all, DEFAULT_WORKSPACE, one, tx, type DB } from "./db.ts";
import { errMsg, log } from "./log.ts";
import { Classifier, type ClassifierFile } from "./triage/classifier.ts";
import { FEATURE_NAMES } from "./triage/features.ts";
import { upperBound } from "./stats.ts";
import { verdictKey } from "./triage/cascade.ts";
import { RoutingState, type RoutingOptions } from "./triage/routing.ts";
import { BUILTIN_SCENARIOS, loadScenarios, runSuite } from "./triage/scenarios.ts";
import { BUILTIN_MODEL, decodeFeatures, type Triage } from "./triage/runtime.ts";

export const TRAIN_SCRIPT = path.join(import.meta.dirname, "..", "ml", "train.py");

export interface TrainOptions {
  dataDir: string;
  python: string;
  /** Labels needed before a scheduled run trains (manual runs need 20). */
  minLabels: number;
  /** Weight of a person's label relative to one of Jev's. */
  humanWeight: number;
  /** Share of positives that must still reach Jev (ml/train.py --recall), and the gate's floor. */
  recall: number;
  /** How long a candidate runs in shadow at least. 0 promotes at once. */
  shadowPeriodMs?: number;
  /** Judged events it would newly drop, none relevant, before it is promoted. */
  shadowMinEvidence?: number;
  /** How long it may keep collecting that evidence before it is rejected. */
  shadowMaxMs?: number;
  /** Directory with a labelled safety set (candidates.csv + candidates.features.csv), if any. */
  safetySet?: string | null;
  /** Labels of one template within this window are one incident and stay in one split. */
  incidentWindowMs?: number;
  /** CLOUDFRIEND_ESCALATED_TTL: how long an escalated template goes to Jev whatever its score. */
  knownTtlMs?: number;
  escalatedMemoryMs?: number;
  /** CLOUDFRIEND_SUPPRESSION_TTL: 0 means the classifier may drop without an earned benign judgment. */
  suppressionTtlMs?: number;
  verdictTtlMs?: number;
  novelGuard?: boolean;
  /** CLOUDFRIEND_REGRESSION_SUITE: a directory of extra scenarios, run with the built-in pack. */
  regressionSuite?: string | null;
}

/** One retrain may cut the share of live events sent to Jev to no less than this fraction. */
const MAX_JEV_SHARE_CUT = 0.5;

export interface TrainReport {
  id: string;
  status: "promoted" | "shadow" | "rejected" | "skipped" | "failed";
  reason: string;
  labels?: { total: number; positives: number; human: number; fit: number; calibrate: number; accept: number };
  /** Must-reach events of the human safety set the candidate would still send to Jev by score (a diagnostic). */
  safety?: { must_reach: number; reached: number } | null;
  /** The regression scenarios, run with the candidate through the complete pipeline. */
  regression?: RegressionSummary;
  /** What the shadow period showed (see `shadowEvidence`). */
  shadow?: Awaited<ReturnType<Trainer["shadowEvidence"]>>;
  candidate?: Metrics;
  active?: Metrics | null;
  model?: Pick<ClassifierFile, "drop_below" | "threshold" | "trained_at"> & { path: string; trees: number };
  /** Share of recent events each model would send to Jev, and whether the threshold was lowered. */
  recent?: { events: number; active: number | null; candidate: number; adjusted: boolean };
  ms?: number;
}

export interface Metrics {
  average_precision: number | null;
  /** Share of escalations that reach Jev: scored at or above drop_below, or of a template escalated before. */
  recall_at_drop: number;
  /** The same by score alone, without the escalated-template rule. */
  recall_by_score?: number;
  forwarded_share: number;
  precision_at_threshold: number;
}

export interface LabelRow {
  event_id: number;
  y: number;
  source: string;
  features: Uint8Array;
  received_at: number;
  template: string | null;
  provenance: string | null;
  weight: number | null;
  /** When the label was made: when its verdict could first affect routing. */
  created_at?: number;
  severity?: string | null;
  ctx_rate?: number | null;
  ctx_service_errors?: number | null;
}

/** An incident: labels of one template less than 30 minutes apart (CLOUDFRIEND_INCIDENT_WINDOW). */
export const INCIDENT_WINDOW_MS = 30 * 60_000;
/** A template that never goes quiet still starts a new incident after this many windows. */
const MAX_INCIDENT_WINDOWS = 4;

/**
 * Split labels by time into fit / calibrate / accept (60/20/20 by count), keeping each
 * incident whole, in the part where it began. An incident is a run of labels of one template
 * with gaps under `windowMs`, capped at four windows so a template that never goes quiet
 * doesn't swallow the split.
 */
export function splitLabels<T extends Pick<LabelRow, "received_at" | "template" | "event_id">>(
  rows: T[],
  windowMs = INCIDENT_WINDOW_MS,
): { fit: T[]; calibrate: T[]; accept: T[] } {
  const sorted = [...rows].sort((a, b) => a.received_at - b.received_at || a.event_id - b.event_id);
  const groups: T[][] = [];
  const open = new Map<string, { g: T[]; start: number; last: number }>();
  for (const r of sorted) {
    if (!r.template) {
      groups.push([r]);
      continue;
    }
    const cur = open.get(r.template);
    if (cur && r.received_at - cur.last < windowMs && r.received_at - cur.start < windowMs * MAX_INCIDENT_WINDOWS) {
      cur.g.push(r);
      cur.last = r.received_at;
    } else {
      const g = [r];
      groups.push(g);
      open.set(r.template, { g, start: r.received_at, last: r.received_at });
    }
  }
  const out = { fit: [] as T[], calibrate: [] as T[], accept: [] as T[] };
  let seen = 0;
  for (const g of groups) {
    const part = seen < sorted.length * 0.6 ? out.fit : seen < sorted.length * 0.8 ? out.calibrate : out.accept;
    part.push(...g);
    seen += g.length;
  }
  return out;
}

/** A label's training weight: a person's counts humanWeight; otherwise its provenance weight. */
/** The feature version of the built-in model, or null if it can't be read. */
function builtinVersion(): number | null {
  try {
    return (JSON.parse(fs.readFileSync(BUILTIN_MODEL, "utf8")) as ClassifierFile).featurizer_version;
  } catch {
    return null;
  }
}

const weightOf = (r: Pick<LabelRow, "source" | "weight">, humanWeight: number) => (r.source === "human" ? humanWeight : (r.weight ?? 1));

export class Trainer {
  #db: DB;
  #ws: string;
  #triage: Triage;
  #o: TrainOptions;
  #running: Promise<TrainReport> | null = null;

  constructor(db: DB, triage: Triage, opts: TrainOptions, workspace = DEFAULT_WORKSPACE) {
    this.#db = db;
    this.#ws = workspace;
    this.#triage = triage;
    this.#o = opts;
  }

  get running(): boolean {
    return this.#running !== null;
  }

  /** Labels added since the last training run (any outcome). */
  async newLabels(): Promise<number> {
    const last = (await one<{ t: number | null }>(this.#db, "SELECT max(created_at) AS t FROM models WHERE workspace_id = $1 AND status <> 'skipped'", [this.#ws]))!;
    const { n } = (await one<{ n: number }>(
      this.#db,
      "SELECT count(*) AS n FROM labels WHERE workspace_id = $1 AND created_at > $2 AND featurizer_version = $3",
      [this.#ws, last.t ?? 0, this.#triage.featurizer.version],
    ))!;
    return n;
  }

  /** Train if enough new labels arrived since the last run. Used by the scheduler. */
  async maybeTrain(): Promise<TrainReport | null> {
    if (this.#running || (await this.newLabels()) < this.#o.minLabels) return null;
    // A candidate in shadow is still collecting evidence: a scheduled run would replace it
    // before it could ever be promoted. A run by hand (`train`) still may.
    if (await one(this.#db, "SELECT 1 FROM models WHERE workspace_id = $1 AND status = 'shadow' LIMIT 1", [this.#ws])) return null;
    return this.train();
  }

  /** One full run. Concurrent calls share the run in progress. */
  train(opts: { dryRun?: boolean } = {}): Promise<TrainReport> {
    this.#running ??= this.#train(opts).finally(() => (this.#running = null));
    return this.#running;
  }

  async #train({ dryRun = false }): Promise<TrainReport> {
    const started = Date.now();
    // Train for the feature version the active model runs with: that is what the labels hold.
    const version = this.#triage.featurizer.version;
    const id = "mdl_" + new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "_" + randomBytes(3).toString("hex");
    const rows = await all<LabelRow>(
      this.#db,
      `SELECT event_id, y, source, features, received_at, template, provenance, weight, created_at, severity, ctx_rate, ctx_service_errors
       FROM labels WHERE workspace_id = $1 AND featurizer_version = $2 ORDER BY received_at, event_id`,
      [this.#ws, version],
    );
    const positives = rows.filter((r) => r.y).length;
    const { fit, calibrate, accept } = splitLabels(rows, this.#o.incidentWindowMs);
    const labels = { total: rows.length, positives, human: rows.filter((r) => r.source === "human").length, fit: fit.length, calibrate: calibrate.length, accept: accept.length };
    const has = (rs: LabelRow[], y: number) => rs.some((r) => r.y === y);
    if (rows.length < 30 || ![fit, calibrate, accept].every((p) => has(p, 1) && has(p, 0))) {
      return this.#record({ id, status: "skipped", reason: `not enough labels: need escalations and non-escalations in each of fit, calibrate and accept (have ${rows.length}, ${positives} positive)`, labels }, null);
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudfriend-train-"));
    try {
      const write = (file: string, rs: LabelRow[]) => {
        const lines = [["case", "t", "y", "w", ...FEATURE_NAMES].join(",")];
        for (const r of rs) {
          const v = Array.from(decodeFeatures(r.features), (x) => (Number.isNaN(x) ? "" : String(x)));
          lines.push(["labels", r.received_at, r.y, weightOf(r, this.#o.humanWeight), ...v].join(","));
        }
        fs.writeFileSync(path.join(dir, file), lines.join("\n") + "\n");
      };
      write("train.csv", fit);
      write("valid.csv", calibrate);
      const modelsDir = path.join(this.#o.dataDir, "models");
      fs.mkdirSync(modelsDir, { recursive: true });
      const out = path.join(modelsDir, `${id}.json`);
      const base = BUILTIN_MODEL.replace(/\.json$/, ".lgb.txt");
      const argv = [
        TRAIN_SCRIPT, "--train", path.join(dir, "train.csv"), "--valid", path.join(dir, "valid.csv"), "--out", out,
        "--featurizer-version", String(version), "--recall", String(this.#o.recall),
        "--rounds", "200", "--learning-rate", "0.05", "--note", `trained on ${rows.length} labels`,
      ];
      // Boosting on from the built-in model only makes sense when its features mean the same.
      if (fs.existsSync(base) && builtinVersion() === version) argv.push("--init-model", base);
      await run(this.#o.python, argv);

      const file = JSON.parse(fs.readFileSync(out, "utf8")) as ClassifierFile;
      const active = this.#triage.classifier;
      const recent = await this.#recentFeatures();
      const limited = limitThreshold(new Classifier(file), active, recent);
      if (limited.adjusted) {
        file.drop_below = limited.dropBelow;
        file.note = `${file.note ?? ""}; drop_below lowered to keep ${pct(limited.candidate)} of recent events going to Jev`.replace(/^; /, "");
        fs.writeFileSync(out, JSON.stringify(file));
      }
      const candidate = new Classifier(file);
      const known = rulesAtTheTime(rows, accept, {
        escalatedTtlMs: this.#o.knownTtlMs ?? 0,
        escalatedMemoryMs: this.#o.escalatedMemoryMs,
        suppressionTtlMs: this.#o.suppressionTtlMs ?? 0,
      });
      const cMetrics = evaluate(candidate, accept, this.#o.humanWeight, known);
      const aMetrics = active ? evaluate(active, accept, this.#o.humanWeight, known) : null;
      const safety = loadSafetySet(this.#o.safetySet ?? null, version);
      const safe = safety ? { must_reach: safety.length, reached: safety.filter((x) => candidate.score(x) >= candidate.file.drop_below).length } : null;
      const suite = await runSuite(loadScenarios(BUILTIN_SCENARIOS, this.#o.regressionSuite), candidate, {
        routing: {
          verdictTtlMs: this.#o.verdictTtlMs ?? 15 * 60_000,
          escalatedTtlMs: this.#o.knownTtlMs ?? 0,
          escalatedMemoryMs: this.#o.escalatedMemoryMs,
          suppressionTtlMs: this.#o.suppressionTtlMs ?? 0,
        },
        novelGuard: this.#o.novelGuard ?? true,
      });
      const regression: RegressionSummary = {
        passed: suite.passed,
        scenarios: suite.scenarios,
        must_reach: suite.must_reach,
        reached: suite.reached,
        reached_by_score: suite.reached_by_score,
        failures: suite.failures.slice(0, 20).map((f) => ({ scenario: f.scenario, message: f.message, route: f.route })),
      };
      const verdict = gate(cMetrics, aMetrics, this.#o.recall, { regression, safety: safe });
      const model = { path: out, trees: candidate.gbdt.numTrees, drop_below: candidate.file.drop_below, threshold: candidate.file.threshold, trained_at: candidate.file.trained_at };
      const shadow = (this.#o.shadowPeriodMs ?? 0) > 0;
      const report: TrainReport = {
        id,
        status: !verdict.ok || dryRun ? "rejected" : shadow ? "shadow" : "promoted",
        reason: dryRun ? `dry run: ${verdict.reason}` : verdict.ok && shadow ? `${verdict.reason}; running in shadow before promotion` : verdict.reason,
        labels,
        safety: safe,
        regression,
        candidate: cMetrics,
        active: aMetrics,
        model,
        recent: { events: recent.length, active: limited.active, candidate: limited.candidate, adjusted: limited.adjusted },
        ms: Date.now() - started,
      };
      if (report.status === "promoted") await this.#promote(out);
      if (report.status === "shadow") {
        // A shadow run is judged on its own scores only, never on a replaced one's.
        await this.#db.query("UPDATE models SET status = 'rejected' WHERE workspace_id = $1 AND status = 'shadow'", [this.#ws]);
        await this.#clearShadowScores();
        const shadowPath = path.join(modelsDir, "shadow.json");
        fs.copyFileSync(out, shadowPath + ".tmp");
        fs.renameSync(shadowPath + ".tmp", shadowPath);
        this.#triage.loadShadow(shadowPath);
      }
      return await this.#record(report, out);
    } catch (err) {
      return this.#record({ id, status: "failed", reason: errMsg(err), labels, ms: Date.now() - started }, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async #promote(file: string): Promise<void> {
    const activePath = path.join(this.#o.dataDir, "models", "active.json");
    fs.copyFileSync(file, activePath + ".tmp");
    fs.renameSync(activePath + ".tmp", activePath);
    await this.#triage.load(activePath);
  }

  /** What a candidate in shadow would change: the events it would newly drop, and how they were judged. */
  async shadowEvidence(trainedAt: string) {
    const r = (await one<Record<string, number | null>>(
      this.#db,
      `SELECT
           sum(CASE WHEN e.route NOT IN ('drop', 'audit') AND e.shadow_route = 'drop' THEN 1 ELSE 0 END) AS newly,
           sum(CASE WHEN e.route NOT IN ('drop', 'audit') AND e.shadow_route = 'drop' AND l.event_id IS NOT NULL AND coalesce(l.provenance, '') <> 'follower' THEN 1 ELSE 0 END) AS judged,
           sum(CASE WHEN e.route NOT IN ('drop', 'audit') AND e.shadow_route = 'drop' AND l.y = 1 THEN 1 ELSE 0 END) AS relevant,
           sum(CASE WHEN e.route = 'audit' AND e.shadow_route = 'drop' AND l.event_id IS NOT NULL AND coalesce(l.provenance, '') <> 'follower' THEN 1 ELSE 0 END) AS shared_audited,
           sum(CASE WHEN e.route = 'audit' AND e.shadow_route = 'drop' AND l.y = 1 THEN 1 ELSE 0 END) AS shared_relevant,
           count(*) AS scored
         FROM events e LEFT JOIN labels l ON l.workspace_id = e.workspace_id AND l.event_id = e.id
         WHERE e.workspace_id = $1 AND e.shadow_model = $2`,
      [this.#ws, trainedAt],
    ))!;
    const n = (k: string) => Number(r[k] ?? 0);
    return {
      scored: n("scored"),
      /** Events the active model sends to Jev and the candidate would drop: its savings, and its risk. */
      newly_suppressed: n("newly"),
      /** Judged directly by Jev or a person. A follower only copies its group's answer, so it is no evidence. */
      judged: n("judged"),
      /** Judged relevant, a follower's copied "yes" included: for rejecting, the cautious count. */
      relevant: n("relevant"),
      /** Exact 95% upper bound on the share of newly suppressed events that are relevant. */
      relevant_upper95: n("judged") ? upperBound(n("relevant"), n("judged")) : 1,
      /** Audit samples both models drop: their shared blind spot. */
      shared_drops_audited: n("shared_audited"),
      shared_drops_relevant: n("shared_relevant"),
    };
  }

  /**
   * Decide on the model in shadow. It is rejected as soon as an event it would newly drop
   * (one the active model sends to Jev) is judged relevant by Jev or a person. It is promoted
   * only after the minimum period, and only once at least `shadowMinEvidence` such events
   * have been judged, none relevant: promotion on evidence, not on elapsed time. Without
   * enough evidence it keeps running, up to `shadowMaxMs`, then is rejected.
   */
  async checkShadow(now = Date.now()): Promise<TrainReport | null> {
    const row = await one<{ id: string; created_at: number; path: string; report: string }>(
      this.#db,
      "SELECT id, created_at, path, report FROM models WHERE workspace_id = $1 AND status = 'shadow' ORDER BY created_at DESC LIMIT 1",
      [this.#ws],
    );
    if (!row) return null;
    const report = JSON.parse(row.report) as TrainReport;
    const ev = await this.shadowEvidence(report.model?.trained_at ?? "");
    const age = now - row.created_at;
    const min = this.#o.shadowMinEvidence ?? 200;
    let ok: boolean;
    if (ev.relevant > 0) {
      ok = false;
      report.reason = `shadow: it would have dropped ${ev.relevant} event(s) judged relevant that the active model sends to Jev`;
    } else if (age < (this.#o.shadowPeriodMs ?? 0)) return null;
    else if (ev.judged >= min) {
      ok = true;
      report.reason = `shadow: none of the ${ev.judged} judged events it would newly drop was relevant (at most ${pct(ev.relevant_upper95)} at 95%); ${ev.newly_suppressed} newly dropped in all`;
    } else if (age < (this.#o.shadowMaxMs ?? 7 * 86_400_000)) return null;
    else {
      ok = false;
      report.reason = `shadow: not enough evidence after ${Math.round(age / 3_600_000)}h: ${ev.judged} judged events it would newly drop, ${min} needed`;
    }
    report.status = ok ? "promoted" : "rejected";
    report.shadow = ev;
    if (ok) {
      await this.#db.query("UPDATE models SET status = 'retired' WHERE workspace_id = $1 AND status = 'active'", [this.#ws]);
      await this.#promote(row.path);
    }
    this.#triage.clearShadow();
    await this.#clearShadowScores();
    fs.rmSync(path.join(this.#o.dataDir, "models", "shadow.json"), { force: true });
    await this.#db.query("UPDATE models SET status = $1, report = $2 WHERE id = $3", [ok ? "active" : "rejected", JSON.stringify(report), row.id]);
    log.info(`shadow model ${report.status}`, { model: row.id, reason: report.reason });
    return report;
  }

  async #clearShadowScores(): Promise<void> {
    await this.#db.query(
      "UPDATE events SET shadow_score = NULL, shadow_route = NULL, shadow_model = NULL WHERE workspace_id = $1 AND (shadow_model IS NOT NULL OR shadow_route IS NOT NULL)",
      [this.#ws],
    );
  }

  /** Feature vectors of the most recent events still in retention, newest first. */
  async #recentFeatures(limit = 50_000): Promise<Float32Array[]> {
    const rows = await all<{ features: Uint8Array }>(
      this.#db,
      "SELECT features FROM events WHERE workspace_id = $1 AND features IS NOT NULL AND fv = $2 ORDER BY id DESC LIMIT $3",
      [this.#ws, this.#triage.featurizer.version, limit],
    );
    return rows.map((r) => decodeFeatures(r.features));
  }

  async #record(report: TrainReport, file: string | null): Promise<TrainReport> {
    const status = report.status === "promoted" ? "active" : report.status;
    const now = Date.now();
    await tx(this.#db, async (c) => {
      if (report.status === "promoted") await c.query("UPDATE models SET status = 'retired' WHERE workspace_id = $1 AND status = 'active'", [this.#ws]);
      if (report.status === "shadow") await c.query("UPDATE models SET status = 'rejected' WHERE workspace_id = $1 AND status = 'shadow'", [this.#ws]);
      await c.query(
        "INSERT INTO models (id, workspace_id, created_at, path, status, labels, report) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [report.id, this.#ws, now, file ?? "", status, report.labels?.total ?? 0, JSON.stringify(report)],
      );
    });
    (report.status === "failed" ? log.warn : log.info)(`training ${report.status}`, { model: report.id, reason: report.reason });
    return report;
  }
}

/** What the regression scenarios (scenarios.ts) said about a candidate. */
export interface RegressionSummary {
  passed: boolean;
  scenarios: number;
  must_reach: number;
  reached: number;
  reached_by_score: number;
  failures: { scenario: string; message: string; route: string }[];
}

/**
 * Hard requirements first, then workload:
 *   - at least `recallTarget` of the accept part's escalations (by weight) still reach Jev,
 *     by score or by the routing rules as they stood, with no slack and no relaxing to what
 *     the active model manages;
 *   - every must-reach event of every regression scenario reaches Jev through the complete
 *     pipeline;
 *   - then it must not send Jev more than the active model does, unless the active model
 *     fails the requirements itself.
 * The safety set's score-only result is reported, not required: the rules, which it leaves
 * out, are part of what reaches Jev.
 */
export function gate(
  candidate: Metrics,
  active: Metrics | null,
  recallTarget: number,
  checks: { regression?: RegressionSummary | null; safety?: { must_reach: number; reached: number } | null } = {},
): { ok: boolean; reason: string } {
  const { regression, safety } = checks;
  const notes = [
    ...(candidate.recall_by_score === undefined ? [] : [`${pct(candidate.recall_by_score)} by score alone`]),
    ...(regression ? [`regression scenarios ${regression.reached}/${regression.must_reach} (${regression.reached_by_score} by score alone)`] : []),
    ...(safety ? [`safety set by score ${safety.reached}/${safety.must_reach}`] : []),
  ].join(", ");
  if (candidate.recall_at_drop < recallTarget) {
    return { ok: false, reason: `candidate sends ${pct(candidate.recall_at_drop)} of the accept set's escalations to Jev (${notes}); it must send at least ${pct(recallTarget)}` };
  }
  if (regression && !regression.passed) {
    const names = [...new Set(regression.failures.map((f) => f.scenario))];
    return { ok: false, reason: `candidate fails ${names.length} regression scenario(s): ${names.slice(0, 5).join(", ")}; ${regression.must_reach - regression.reached} must-reach events would not reach Jev` };
  }
  if (!active) return { ok: true, reason: `no active model; requirements met (${notes})` };
  const activeOk = active.recall_at_drop >= recallTarget;
  if (activeOk && candidate.forwarded_share > active.forwarded_share + 1e-9) {
    return { ok: false, reason: `requirements met, but Jev would see ${pct(candidate.forwarded_share)} of events vs ${pct(active.forwarded_share)} now` };
  }
  return {
    ok: true,
    reason: `recall ${pct(candidate.recall_at_drop)} (target ${pct(recallTarget)}; ${notes}); Jev would see ${pct(candidate.forwarded_share)} of events vs ${pct(active.forwarded_share)}${activeOk ? "" : " (the active model fails the requirements)"}`,
  };
}

/**
 * The labelled safety set's must-reach events, as feature vectors. Rows labelled anything
 * else are not used by the gate. Returns null when there is no set or nothing is labelled.
 */
export function loadSafetySet(dir: string | null, featurizerVersion: number): Float32Array[] | null {
  if (!dir) return null;
  const labels = path.join(dir, "candidates.csv");
  const features = path.join(dir, "candidates.features.csv");
  if (!fs.existsSync(labels) || !fs.existsSync(features)) return null;
  const must = new Set<string>();
  const [header, ...lines] = fs.readFileSync(labels, "utf8").split(/\r?\n/).filter(Boolean);
  const cols = parseCsvLine(header!);
  const iId = cols.indexOf("id");
  const iLabel = cols.indexOf("label");
  for (const l of lines) {
    const c = parseCsvLine(l);
    if (c[iLabel]?.trim().toLowerCase() === "must_reach") must.add(c[iId]!);
  }
  if (!must.size) return null;
  const out: Float32Array[] = [];
  const [fh, ...rows] = fs.readFileSync(features, "utf8").split(/\r?\n/).filter(Boolean);
  const fcols = fh!.split(",");
  const version = fcols[1] === "featurizer_v" + featurizerVersion;
  if (!version) throw new Error(`${features} is for another featurizer version (${fcols[1]}); regenerate it with ml/safety-candidates.ts`);
  for (const r of rows) {
    const c = r.split(",");
    if (must.has(c[0]!)) out.push(Float32Array.from(c.slice(2).map((v) => (v === "" ? NaN : Number(v)))));
  }
  return out;
}

/** One CSV line with RFC 4180 quoting. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"', i++);
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") (out.push(cur), (cur = ""));
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/**
 * Labels only cover events Jev saw, so a threshold fitted on them can be far too bold for
 * the traffic Jev never sees. Score recent events with both models: if the candidate would
 * send less than half the share the active model sends, lower its threshold until it sends
 * exactly half. Thresholds then move a step per retrain, each step checked by audits.
 */
export function limitThreshold(candidate: Classifier, active: Classifier | null, recent: ArrayLike<number>[]) {
  const share = (m: Classifier, t: number, scores?: number[]) =>
    (scores ?? recent.map((x) => m.score(x))).filter((s) => s >= t).length / Math.max(recent.length, 1);
  const cScores = recent.map((x) => candidate.score(x));
  const cShare = share(candidate, candidate.file.drop_below, cScores);
  if (!active || recent.length < 100) return { dropBelow: candidate.file.drop_below, active: active ? share(active, active.file.drop_below) : null, candidate: cShare, adjusted: false };
  const aShare = share(active, active.file.drop_below);
  const floor = aShare * MAX_JEV_SHARE_CUT;
  if (cShare >= floor) return { dropBelow: candidate.file.drop_below, active: aShare, candidate: cShare, adjusted: false };
  const sorted = [...cScores].sort((a, b) => b - a);
  const k = Math.max(1, Math.ceil(floor * sorted.length));
  const dropBelow = Math.min(candidate.file.drop_below, sorted[k - 1]!);
  return { dropBelow, active: aShare, candidate: share(candidate, dropBelow, cScores), adjusted: true };
}

/** Score held-out labels with a model, in the terms the gate uses. */
export function evaluate(
  model: Classifier,
  rows: { y: number; source: string; features: Uint8Array; weight?: number | null }[],
  humanWeight: number,
  known: boolean[] = [],
): Metrics {
  const scored = rows.map((r, i) => {
    const p = model.score(decodeFeatures(r.features));
    return { y: r.y, w: weightOf({ source: r.source, weight: r.weight ?? null }, humanWeight), p, byScore: p >= model.file.drop_below, known: known[i] === true };
  });
  const pos = scored.reduce((a, r) => a + r.w * r.y, 0);
  const total = scored.reduce((a, r) => a + r.w, 0);
  const fwd = scored.filter((r) => r.byScore || r.known);
  const hit = scored.filter((r) => r.p >= model.file.threshold);
  const sum = (rs: typeof scored, f: (r: (typeof scored)[number]) => number) => rs.reduce((a, r) => a + f(r), 0);
  return {
    average_precision: averagePrecision(scored),
    recall_at_drop: sum(fwd, (r) => r.w * r.y) / Math.max(pos, 1e-9),
    recall_by_score: sum(scored.filter((r) => r.byScore), (r) => r.w * r.y) / Math.max(pos, 1e-9),
    forwarded_share: sum(fwd, (r) => r.w) / Math.max(total, 1e-9),
    precision_at_threshold: sum(hit, (r) => r.w * r.y) / Math.max(sum(hit, (r) => r.w), 1e-9),
  };
}

/**
 * For each row of `part`: would the routing rules (routing.ts) have sent it to Jev whatever
 * its score, when it arrived? That is: its template was protected or due for review after an
 * escalation, or its kind had not earned suppression in that context. Labels take effect when
 * they were made (`created_at`), not when their event arrived, as in the server: a burst
 * that arrived before Jev answered gets no credit from that answer.
 */
export function rulesAtTheTime(
  all: Pick<LabelRow, "event_id" | "y" | "source" | "received_at" | "template" | "provenance" | "created_at" | "severity" | "ctx_rate" | "ctx_service_errors">[],
  part: Pick<LabelRow, "event_id">[],
  o: Pick<RoutingOptions, "escalatedTtlMs" | "escalatedMemoryMs" | "suppressionTtlMs">,
): boolean[] {
  const state = new RoutingState({ verdictTtlMs: 0, ...o });
  const wanted = new Set(part.map((r) => r.event_id));
  type Step = { t: number; order: number; r: (typeof all)[number] };
  const steps: Step[] = [];
  for (const r of all) {
    if (wanted.has(r.event_id)) steps.push({ t: r.received_at, order: 0, r });
    steps.push({ t: r.created_at ?? r.received_at, order: 1, r });
  }
  // At equal times the event is routed before the label made from it takes effect.
  steps.sort((a, b) => a.t - b.t || a.order - b.order || a.r.event_id - b.r.event_id);
  const at = new Map<number, boolean>();
  for (const { t, order, r } of steps) {
    if (!r.template) continue;
    if (order === 0) {
      const severity = r.severity ?? undefined;
      const p = state.escalated.status(r.template, t);
      const earned = state.ledger.earned(verdictKey({ template: r.template, severity }), t, r.ctx_rate ?? 0, r.ctx_service_errors ?? 0);
      at.set(r.event_id, p !== null || !earned);
    } else {
      state.rebuild([{ template: r.template, severity: r.severity ?? null, y: r.y, source: r.source, provenance: r.provenance, at: t, rate: r.ctx_rate ?? null, serviceErrors: r.ctx_service_errors ?? null }]);
    }
  }
  return part.map((r) => at.get(r.event_id) ?? false);
}

function averagePrecision(rs: { y: number; w: number; p: number }[]): number | null {
  const sorted = [...rs].sort((a, b) => b.p - a.p);
  const pos = sorted.reduce((a, r) => a + r.w * r.y, 0);
  if (!pos) return null;
  let tp = 0;
  let seen = 0;
  let ap = 0;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    let dtp = 0;
    while (j < sorted.length && sorted[j]!.p === sorted[i]!.p) {
      dtp += sorted[j]!.w * sorted[j]!.y;
      seen += sorted[j]!.w;
      j++;
    }
    tp += dtp;
    ap += (dtp / pos) * (tp / seen);
    i = j;
  }
  return ap;
}

function run(cmd: string, argv: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(new Error(`could not run ${cmd}: ${e.message} (set CLOUDFRIEND_PYTHON)`)));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(argv[0]!)} exited ${code}: ${(err || out).trim().split("\n").slice(-3).join(" | ")}`))));
  });
}
