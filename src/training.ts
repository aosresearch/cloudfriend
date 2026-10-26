// The training loop: turn the labels Jev and people produced into a better classifier.
//
//   1. export   labels with the current featurizer version -> CSV, split by time: the
//               oldest 80% train, the newest 20% are held out
//   2. train    ml/train.py boosts new trees on top of the built-in base model (so a few
//               hundred labels refine it rather than replace it) and picks thresholds
//   3. gate     the candidate and the active model are scored on the held-out labels; the
//               candidate is promoted only if it is at least as good (see `gate`)
//   4. promote  the file becomes <data>/models/active.json and the worker swaps it in
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
  /** Share of positives that must still reach Jev (ml/train.py --recall). */
  recall: number;
}

export interface TrainReport {
  id: string;
  status: "promoted" | "rejected" | "skipped" | "failed";
  reason: string;
  labels?: { total: number; positives: number; human: number; train: number; holdout: number };
  candidate?: Metrics;
  active?: Metrics | null;
  model?: Pick<ClassifierFile, "drop_below" | "threshold" | "trained_at"> & { path: string; trees: number };
  ms?: number;
}

export interface Metrics {
  average_precision: number | null;
  recall_at_drop: number;
  forwarded_share: number;
  precision_at_threshold: number;
}

interface LabelRow {
  y: number;
  source: string;
  features: Uint8Array;
  received_at: number;
}

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
      .prepare("SELECT y, source, features, received_at FROM labels WHERE featurizer_version = ? ORDER BY received_at, event_id")
      .all(FEATURIZER_VERSION) as unknown as LabelRow[];
    const positives = rows.filter((r) => r.y).length;
    const cut = Math.floor(rows.length * 0.8);
    const train = rows.slice(0, cut);
    const holdout = rows.slice(cut);
    const labels = { total: rows.length, positives, human: rows.filter((r) => r.source === "human").length, train: train.length, holdout: holdout.length };
    const has = (rs: LabelRow[], y: number) => rs.some((r) => r.y === y);
    if (rows.length < 20 || !has(train, 1) || !has(train, 0) || !has(holdout, 1) || !has(holdout, 0)) {
      return this.#record({ id, status: "skipped", reason: `not enough labels: need positives and negatives in both the oldest 80% and newest 20% (have ${rows.length}, ${positives} positive)`, labels }, null);
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudfriend-train-"));
    try {
      const write = (file: string, rs: LabelRow[]) => {
        const lines = [["case", "t", "y", "w", ...FEATURE_NAMES].join(",")];
        for (const r of rs) {
          const v = Array.from(decodeFeatures(r.features), (x) => (Number.isNaN(x) ? "" : String(x)));
          lines.push(["labels", r.received_at, r.y, r.source === "human" ? this.#o.humanWeight : 1, ...v].join(","));
        }
        fs.writeFileSync(path.join(dir, file), lines.join("\n") + "\n");
      };
      write("train.csv", train);
      write("valid.csv", holdout);
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

      const candidate = new Classifier(JSON.parse(fs.readFileSync(out, "utf8")) as ClassifierFile);
      const cMetrics = evaluate(candidate, holdout, this.#o.humanWeight);
      const active = this.#triage.classifier;
      const aMetrics = active ? evaluate(active, holdout, this.#o.humanWeight) : null;
      const verdict = gate(cMetrics, aMetrics, this.#o.recall);
      const model = { path: out, trees: candidate.gbdt.numTrees, drop_below: candidate.file.drop_below, threshold: candidate.file.threshold, trained_at: candidate.file.trained_at };
      const report: TrainReport = { id, status: verdict.ok && !dryRun ? "promoted" : "rejected", reason: dryRun ? `dry run: ${verdict.reason}` : verdict.reason, labels, candidate: cMetrics, active: aMetrics, model, ms: Date.now() - started };
      if (report.status === "promoted") {
        const activePath = path.join(modelsDir, "active.json");
        fs.copyFileSync(out, activePath + ".tmp");
        fs.renameSync(activePath + ".tmp", activePath);
        this.#triage.load(activePath);
      }
      return this.#record(report, out);
    } catch (err) {
      return this.#record({ id, status: "failed", reason: errMsg(err), labels, ms: Date.now() - started }, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  #record(report: TrainReport, file: string | null): TrainReport {
    const status = report.status === "promoted" ? "active" : report.status;
    const now = Date.now();
    if (report.status === "promoted") this.#db.prepare("UPDATE models SET status = 'retired' WHERE status = 'active'").run();
    this.#db
      .prepare("INSERT INTO models (id, created_at, path, status, labels, report) VALUES (?, ?, ?, ?, ?, ?)")
      .run(report.id, now, file ?? "", status, report.labels?.total ?? 0, JSON.stringify(report));
    (report.status === "failed" ? log.warn : log.info)(`training ${report.status}`, { model: report.id, reason: report.reason });
    return report;
  }
}

/**
 * Promote when the candidate ranks held-out labels at least as well as the active model
 * (average precision within 0.01) and still sends enough positives to Jev.
 */
export function gate(candidate: Metrics, active: Metrics | null, recallTarget: number): { ok: boolean; reason: string } {
  const minRecall = Math.min(recallTarget, active?.recall_at_drop ?? recallTarget) - 0.02;
  if (candidate.recall_at_drop < minRecall) {
    return { ok: false, reason: `candidate forwards ${pct(candidate.recall_at_drop)} of held-out escalations to Jev, below ${pct(minRecall)}` };
  }
  if (!active) return { ok: true, reason: "no active model" };
  const c = candidate.average_precision ?? 0;
  const a = active.average_precision ?? 0;
  if (c + 0.01 < a) return { ok: false, reason: `average precision ${c.toFixed(3)} is below the active model's ${a.toFixed(3)}` };
  return {
    ok: true,
    reason: `average precision ${c.toFixed(3)} vs ${a.toFixed(3)}; Jev would see ${pct(candidate.forwarded_share)} of events vs ${pct(active.forwarded_share)}`,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Score held-out labels with a model, in the terms the gate uses. */
export function evaluate(model: Classifier, rows: { y: number; source: string; features: Uint8Array }[], humanWeight: number): Metrics {
  const scored = rows.map((r) => ({ y: r.y, w: r.source === "human" ? humanWeight : 1, p: model.score(decodeFeatures(r.features)) }));
  const pos = scored.reduce((a, r) => a + r.w * r.y, 0);
  const total = scored.reduce((a, r) => a + r.w, 0);
  const fwd = scored.filter((r) => r.p >= model.file.drop_below);
  const hit = scored.filter((r) => r.p >= model.file.threshold);
  const sum = (rs: typeof scored, f: (r: (typeof scored)[number]) => number) => rs.reduce((a, r) => a + f(r), 0);
  return {
    average_precision: averagePrecision(scored),
    recall_at_drop: sum(fwd, (r) => r.w * r.y) / Math.max(pos, 1e-9),
    forwarded_share: sum(fwd, (r) => r.w) / Math.max(total, 1e-9),
    precision_at_threshold: sum(hit, (r) => r.w * r.y) / Math.max(sum(hit, (r) => r.w), 1e-9),
  };
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
