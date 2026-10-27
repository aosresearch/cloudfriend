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
//               or by the escalated-template rule as it stood at the time), and every
//               "must reach Jev" event of the human safety set. Only then does a lower Jev load
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
import type { DB } from "./db.ts";
import { errMsg, log } from "./log.ts";
import { Classifier, type ClassifierFile } from "./triage/classifier.ts";
import { FEATURE_NAMES, FEATURIZER_VERSION } from "./triage/features.ts";
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
  /** How long a candidate runs in shadow before promotion. 0 promotes at once. */
  shadowPeriodMs?: number;
  /** Directory with a labelled safety set (candidates.csv + candidates.features.csv), if any. */
  safetySet?: string | null;
  /** Labels of one template within this window are one incident and stay in one split. */
  incidentWindowMs?: number;
  /** CLOUDFRIEND_ESCALATED_TTL: how long an escalated template goes to Jev whatever its score. */
  knownTtlMs?: number;
}

/** One retrain may cut the share of live events sent to Jev to no less than this fraction. */
const MAX_JEV_SHARE_CUT = 0.5;

export interface TrainReport {
  id: string;
  status: "promoted" | "shadow" | "rejected" | "skipped" | "failed";
  reason: string;
  labels?: { total: number; positives: number; human: number; fit: number; calibrate: number; accept: number };
  /** Must-reach events of the human safety set the candidate would still send to Jev. */
  safety?: { must_reach: number; reached: number } | null;
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
}

/** An incident: the same template within 30 minutes (CLOUDFRIEND_INCIDENT_WINDOW). Splits never cut through one. */
export const INCIDENT_WINDOW_MS = 30 * 60_000;

/**
 * Split labels by time into fit / calibrate / accept (60/20/20 by count), keeping each
 * incident (template x 30-minute window) whole, in the part where it began.
 */
export function splitLabels<T extends Pick<LabelRow, "received_at" | "template" | "event_id">>(
  rows: T[],
  windowMs = INCIDENT_WINDOW_MS,
): { fit: T[]; calibrate: T[]; accept: T[] } {
  const sorted = [...rows].sort((a, b) => a.received_at - b.received_at || a.event_id - b.event_id);
  const groups = new Map<string, T[]>();
  for (const r of sorted) {
    const key = r.template ? `${r.template}@${Math.floor(r.received_at / windowMs)}` : `event:${r.event_id}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  const out = { fit: [] as T[], calibrate: [] as T[], accept: [] as T[] };
  let seen = 0;
  for (const g of groups.values()) {
    const part = seen < sorted.length * 0.6 ? out.fit : seen < sorted.length * 0.8 ? out.calibrate : out.accept;
    part.push(...g);
    seen += g.length;
  }
  return out;
}

/** A label's training weight: a person's counts humanWeight; otherwise its provenance weight. */
const weightOf = (r: Pick<LabelRow, "source" | "weight">, humanWeight: number) => (r.source === "human" ? humanWeight : (r.weight ?? 1));

export class Trainer {
  #db: DB;
  #triage: Triage;
  #o: TrainOptions;
  #running: Promise<TrainReport> | null = null;

  constructor(db: DB, triage: Triage, opts: TrainOptions) {
    this.#db = db;
    this.#triage = triage;
    this.#o = opts;
  }

  get running(): boolean {
    return this.#running !== null;
  }

  /** Labels added since the last training run (any outcome). */
  newLabels(): number {
    const last = this.#db.prepare("SELECT max(created_at) AS t FROM models WHERE status <> 'skipped'").get() as { t: number | null };
    return (this.#db.prepare("SELECT count(*) AS n FROM labels WHERE created_at > ? AND featurizer_version = ?").get(last.t ?? 0, FEATURIZER_VERSION) as { n: number }).n;
  }

  /** Train if enough new labels arrived since the last run. Used by the scheduler. */
  async maybeTrain(): Promise<TrainReport | null> {
    if (this.#running || this.newLabels() < this.#o.minLabels) return null;
    return this.train();
  }

  /** One full run. Concurrent calls share the run in progress. */
  train(opts: { dryRun?: boolean } = {}): Promise<TrainReport> {
    this.#running ??= this.#train(opts).finally(() => (this.#running = null));
    return this.#running;
  }

  async #train({ dryRun = false }): Promise<TrainReport> {
    const started = Date.now();
    const id = "mdl_" + new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "_" + randomBytes(3).toString("hex");
    const rows = this.#db
      .prepare(
        "SELECT event_id, y, source, features, received_at, template, provenance, weight FROM labels WHERE featurizer_version = ? ORDER BY received_at, event_id",
      )
      .all(FEATURIZER_VERSION) as unknown as LabelRow[];
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
        "--featurizer-version", String(FEATURIZER_VERSION), "--recall", String(this.#o.recall),
        "--rounds", "200", "--learning-rate", "0.05", "--note", `trained on ${rows.length} labels`,
      ];
      if (fs.existsSync(base)) argv.push("--init-model", base);
      await run(this.#o.python, argv);

      const file = JSON.parse(fs.readFileSync(out, "utf8")) as ClassifierFile;
      const active = this.#triage.classifier;
      const recent = this.#recentFeatures();
      const limited = limitThreshold(new Classifier(file), active, recent);
      if (limited.adjusted) {
        file.drop_below = limited.dropBelow;
        file.note = `${file.note ?? ""}; drop_below lowered to keep ${pct(limited.candidate)} of recent events going to Jev`.replace(/^; /, "");
        fs.writeFileSync(out, JSON.stringify(file));
      }
      const candidate = new Classifier(file);
      const known = knownAtTheTime(rows, accept, this.#o.knownTtlMs ?? 0);
      const cMetrics = evaluate(candidate, accept, this.#o.humanWeight, known);
      const aMetrics = active ? evaluate(active, accept, this.#o.humanWeight, known) : null;
      const safety = loadSafetySet(this.#o.safetySet ?? null);
      const safe = safety ? { must_reach: safety.length, reached: safety.filter((x) => candidate.score(x) >= candidate.file.drop_below).length } : null;
      const activeSafe = safety && active ? safety.every((x) => active.score(x) >= active.file.drop_below) : null;
      const verdict = gate(cMetrics, aMetrics, this.#o.recall, safe, activeSafe);
      const model = { path: out, trees: candidate.gbdt.numTrees, drop_below: candidate.file.drop_below, threshold: candidate.file.threshold, trained_at: candidate.file.trained_at };
      const shadow = (this.#o.shadowPeriodMs ?? 0) > 0;
      const report: TrainReport = {
        id,
        status: !verdict.ok || dryRun ? "rejected" : shadow ? "shadow" : "promoted",
        reason: dryRun ? `dry run: ${verdict.reason}` : verdict.ok && shadow ? `${verdict.reason}; running in shadow before promotion` : verdict.reason,
        labels,
        safety: safe,
        candidate: cMetrics,
        active: aMetrics,
        model,
        recent: { events: recent.length, active: limited.active, candidate: limited.candidate, adjusted: limited.adjusted },
        ms: Date.now() - started,
      };
      if (report.status === "promoted") this.#promote(out);
      if (report.status === "shadow") {
        // A shadow run is judged on its own scores only, never on a replaced one's.
        this.#db.prepare("UPDATE models SET status = 'rejected' WHERE status = 'shadow'").run();
        this.#clearShadowScores();
        const shadowPath = path.join(modelsDir, "shadow.json");
        fs.copyFileSync(out, shadowPath + ".tmp");
        fs.renameSync(shadowPath + ".tmp", shadowPath);
        this.#triage.loadShadow(shadowPath);
      }
      return this.#record(report, out);
    } catch (err) {
      return this.#record({ id, status: "failed", reason: errMsg(err), labels, ms: Date.now() - started }, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  #promote(file: string): void {
    const activePath = path.join(this.#o.dataDir, "models", "active.json");
    fs.copyFileSync(file, activePath + ".tmp");
    fs.renameSync(activePath + ".tmp", activePath);
    this.#triage.load(activePath);
  }

  /**
   * Promote or reject the model in shadow once its period is over. It is promoted only if,
   * among the events scored while in shadow that Jev or a person judged relevant, it would
   * have dropped none (events that reached Jev as never-seen or already-escalated kinds don't
   * count: those routes don't depend on the model).
   */
  checkShadow(now = Date.now()): TrainReport | null {
    const row = this.#db.prepare("SELECT id, created_at, path, report FROM models WHERE status = 'shadow' ORDER BY created_at DESC LIMIT 1").get() as
      | { id: string; created_at: number; path: string; report: string }
      | undefined;
    if (!row || now - row.created_at < (this.#o.shadowPeriodMs ?? 0)) return null;
    // shadow_route already accounts for the novel and escalated-template rules.
    const seen = this.#db
      .prepare(
        `SELECT count(*) AS relevant, sum(CASE WHEN e.shadow_route = 'drop' THEN 1 ELSE 0 END) AS dropped
         FROM labels l JOIN events e ON e.id = l.event_id WHERE l.y = 1 AND e.shadow_route IS NOT NULL`,
      )
      .get() as { relevant: number; dropped: number | null };
    const dropped = seen.dropped ?? 0;
    const report = JSON.parse(row.report) as TrainReport;
    const ok = dropped === 0;
    report.status = ok ? "promoted" : "rejected";
    report.reason = ok
      ? `shadow: of ${seen.relevant} events judged relevant while in shadow, it would have dropped none`
      : `shadow: it would have dropped ${dropped} of ${seen.relevant} events judged relevant while in shadow`;
    if (ok) {
      this.#db.prepare("UPDATE models SET status = 'retired' WHERE status = 'active'").run();
      this.#promote(row.path);
    }
    this.#triage.clearShadow();
    this.#clearShadowScores();
    fs.rmSync(path.join(this.#o.dataDir, "models", "shadow.json"), { force: true });
    this.#db.prepare("UPDATE models SET status = ?, report = ? WHERE id = ?").run(ok ? "active" : "rejected", JSON.stringify(report), row.id);
    log.info(`shadow model ${report.status}`, { model: row.id, reason: report.reason });
    return report;
  }

  #clearShadowScores(): void {
    this.#db.prepare("UPDATE events SET shadow_score = NULL, shadow_route = NULL WHERE shadow_route IS NOT NULL OR shadow_score IS NOT NULL").run();
  }

  /** Feature vectors of the most recent events still in retention, newest first. */
  #recentFeatures(limit = 50_000): Float32Array[] {
    const rows = this.#db
      .prepare("SELECT features FROM events WHERE features IS NOT NULL ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as { features: Uint8Array }[];
    return rows.map((r) => decodeFeatures(r.features));
  }

  #record(report: TrainReport, file: string | null): TrainReport {
    const status = report.status === "promoted" ? "active" : report.status;
    const now = Date.now();
    if (report.status === "promoted") this.#db.prepare("UPDATE models SET status = 'retired' WHERE status = 'active'").run();
    if (report.status === "shadow") this.#db.prepare("UPDATE models SET status = 'rejected' WHERE status = 'shadow'").run();
    this.#db
      .prepare("INSERT INTO models (id, created_at, path, status, labels, report) VALUES (?, ?, ?, ?, ?, ?)")
      .run(report.id, now, file ?? "", status, report.labels?.total ?? 0, JSON.stringify(report));
    (report.status === "failed" ? log.warn : log.info)(`training ${report.status}`, { model: report.id, reason: report.reason });
    return report;
  }
}

/**
 * Hard requirements first, then workload:
 *   - at least `recallTarget` of the accept part's escalations (by weight) still reach Jev,
 *     with no slack and no relaxing to what the active model manages;
 *   - every "must reach Jev" event of the safety set reaches Jev;
 *   - then it must not send Jev more than the active model does, unless the active model
 *     fails the requirements itself.
 */
export function gate(
  candidate: Metrics,
  active: Metrics | null,
  recallTarget: number,
  safety: { must_reach: number; reached: number } | null = null,
  activeSafe: boolean | null = null,
): { ok: boolean; reason: string } {
  if (candidate.recall_at_drop < recallTarget) {
    const byScore = candidate.recall_by_score === undefined ? "" : ` (${pct(candidate.recall_by_score)} by score alone)`;
    return { ok: false, reason: `candidate sends ${pct(candidate.recall_at_drop)} of the accept set's escalations to Jev${byScore}; it must send at least ${pct(recallTarget)}` };
  }
  if (safety && safety.reached < safety.must_reach) {
    return { ok: false, reason: `candidate would drop ${safety.must_reach - safety.reached} of ${safety.must_reach} must-reach events of the safety set` };
  }
  if (!active) return { ok: true, reason: "no active model; requirements met" };
  const activeOk = active.recall_at_drop >= recallTarget && activeSafe !== false;
  if (activeOk && candidate.forwarded_share > active.forwarded_share + 1e-9) {
    return { ok: false, reason: `requirements met, but Jev would see ${pct(candidate.forwarded_share)} of events vs ${pct(active.forwarded_share)} now` };
  }
  return {
    ok: true,
    reason: `recall ${pct(candidate.recall_at_drop)}${candidate.recall_by_score === undefined ? "" : `, ${pct(candidate.recall_by_score)} by score alone`} (target ${pct(recallTarget)})${safety ? `, safety set ${safety.reached}/${safety.must_reach}` : ""}; Jev would see ${pct(candidate.forwarded_share)} of events vs ${pct(active.forwarded_share)}${activeOk ? "" : " (the active model fails the requirements)"}`,
  };
}

/**
 * The labelled safety set's must-reach events, as feature vectors. Rows labelled anything
 * else are not used by the gate. Returns null when there is no set or nothing is labelled.
 */
export function loadSafetySet(dir: string | null): Float32Array[] | null {
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
  const version = fcols[1] === "featurizer_v" + FEATURIZER_VERSION;
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
 * For each row of `part`: would the escalated-template rule (route `known`) have sent it to
 * Jev whatever its score? True when an earlier label of its template was an escalation within
 * `ttlMs`, and no person has since marked that template as not worth escalating. Uses only
 * labels from before the row, as the runtime would have had them.
 */
export function knownAtTheTime(
  all: Pick<LabelRow, "event_id" | "y" | "source" | "received_at" | "template">[],
  part: Pick<LabelRow, "event_id">[],
  ttlMs: number,
): boolean[] {
  if (ttlMs <= 0) return part.map(() => false);
  const sorted = [...all].sort((a, b) => a.received_at - b.received_at || a.event_id - b.event_id);
  const escalated = new Map<string, number>();
  const at = new Map<number, boolean>();
  for (const r of sorted) {
    if (!r.template) continue;
    const last = escalated.get(r.template);
    at.set(r.event_id, last !== undefined && r.received_at - last <= ttlMs);
    if (r.y) escalated.set(r.template, r.received_at);
    else if (r.source === "human") escalated.delete(r.template);
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
