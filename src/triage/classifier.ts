// The first stage of triage: a LightGBM model that scores every event. Browser-safe.
import { FEATURE_NAMES, SUPPORTED_FEATURIZER_VERSIONS } from "./features.ts";
import { Gbdt, type LightGbmDump } from "./gbdt.ts";

/** A model file, as ml/train.py writes it. */
export interface ClassifierFile {
  format: "cloudfriend-classifier/1";
  featurizer_version: number;
  feature_names: string[];
  trained_at: string;
  note?: string;
  /** Scores below this are not escalated and never reach Jev. */
  drop_below: number;
  /** Scores at or above this are escalated without asking Jev. Above 1 means never. */
  escalate_above: number;
  /** Best-F1 score, used to escalate on the classifier alone when no Jev is configured. */
  threshold: number;
  recall_target?: number;
  trees?: number;
  metrics?: Record<string, unknown>;
  lightgbm: LightGbmDump;
}

export type Route = "drop" | "jev" | "auto";

export class Classifier {
  readonly file: ClassifierFile;
  readonly gbdt: Gbdt;
  #index: number[] | null;

  constructor(file: ClassifierFile) {
    if (file.format !== "cloudfriend-classifier/1") throw new Error(`unknown model format: ${String(file.format)}`);
    if (!SUPPORTED_FEATURIZER_VERSIONS.includes(file.featurizer_version)) {
      throw new Error(`model needs featurizer v${file.featurizer_version}, this build computes v${SUPPORTED_FEATURIZER_VERSIONS.join(", v")}`);
    }
    this.file = file;
    this.gbdt = new Gbdt(file.lightgbm);
    // The model's columns in the featurizer's order; usually identical.
    const same = file.feature_names.length === FEATURE_NAMES.length && file.feature_names.every((n, i) => n === FEATURE_NAMES[i]);
    if (same) this.#index = null;
    else {
      this.#index = file.feature_names.map((n) => {
        const i = FEATURE_NAMES.indexOf(n);
        if (i < 0) throw new Error(`model uses unknown feature '${n}'`);
        return i;
      });
    }
  }

  score(values: ArrayLike<number>): number {
    if (!this.#index) return this.gbdt.predict(values);
    return this.gbdt.predict(this.#index.map((i) => values[i]!));
  }

  /** Where an event with this score goes when Jev is available. */
  route(score: number): Route {
    if (score >= this.file.escalate_above) return "auto";
    if (score < this.file.drop_below) return "drop";
    return "jev";
  }
}
