// Scores feature vectors with a LightGBM model, without LightGBM. Training happens in Python
// (ml/train.py); it saves the trees with `Booster.dump_model()`, and this file walks them.
// Pure TypeScript with no imports, so it also runs in a browser.
//
// Only what ml/train.py produces is supported: binary objective, numerical splits.

/** The parts of LightGBM's `dump_model()` JSON this evaluator reads. */
export interface LightGbmDump {
  objective?: string;
  feature_names?: string[];
  max_feature_idx?: number;
  num_class?: number;
  tree_info: { tree_structure: DumpNode }[];
}

type DumpNode =
  | { leaf_value: number }
  | {
      split_feature: number;
      threshold: number | string;
      decision_type: string;
      default_left: boolean;
      missing_type: "None" | "Zero" | "NaN";
      left_child: DumpNode;
      right_child: DumpNode;
    };

const ZERO_THRESHOLD = 1e-35;
const MISSING = { None: 0, Zero: 1, NaN: 2 } as const;

/**
 * All trees flattened into parallel arrays. Node `i` is internal when `feature[i] >= 0`;
 * a child index below zero points at leaf `~child`.
 */
export class Gbdt {
  readonly featureNames: string[];
  readonly numTrees: number;
  #roots: Int32Array;
  #feature: Int32Array;
  #threshold: Float64Array;
  #left: Int32Array;
  #right: Int32Array;
  #defaultLeft: Uint8Array;
  #missing: Uint8Array;
  #leaves: Float64Array;
  #sigmoid: number;

  constructor(dump: LightGbmDump) {
    if ((dump.num_class ?? 1) !== 1) throw new Error("only binary LightGBM models are supported");
    const obj = dump.objective ?? "binary sigmoid:1";
    if (!obj.startsWith("binary")) throw new Error(`unsupported objective: ${obj}`);
    this.#sigmoid = Number(/sigmoid:([\d.]+)/.exec(obj)?.[1] ?? 1);
    this.featureNames = dump.feature_names ?? [];

    const feature: number[] = [];
    const threshold: number[] = [];
    const left: number[] = [];
    const right: number[] = [];
    const defaultLeft: number[] = [];
    const missing: number[] = [];
    const leaves: number[] = [];
    const roots: number[] = [];

    const add = (n: DumpNode): number => {
      if ("leaf_value" in n) {
        leaves.push(n.leaf_value);
        return ~(leaves.length - 1);
      }
      if (n.decision_type !== "<=") throw new Error(`unsupported split '${n.decision_type}' (categorical features are not supported)`);
      const i = feature.length;
      feature.push(n.split_feature);
      threshold.push(Number(n.threshold));
      defaultLeft.push(n.default_left ? 1 : 0);
      missing.push(MISSING[n.missing_type] ?? 0);
      left.push(0);
      right.push(0);
      left[i] = add(n.left_child);
      right[i] = add(n.right_child);
      return i;
    };
    for (const t of dump.tree_info) roots.push(add(t.tree_structure));

    this.numTrees = roots.length;
    this.#roots = Int32Array.from(roots);
    this.#feature = Int32Array.from(feature);
    this.#threshold = Float64Array.from(threshold);
    this.#left = Int32Array.from(left);
    this.#right = Int32Array.from(right);
    this.#defaultLeft = Uint8Array.from(defaultLeft);
    this.#missing = Uint8Array.from(missing);
    this.#leaves = Float64Array.from(leaves);
  }

  /** Sum of leaf values (the log-odds). Mirrors LightGBM's NumericalDecision. */
  raw(x: ArrayLike<number>): number {
    let sum = 0;
    for (let t = 0; t < this.#roots.length; t++) {
      let node = this.#roots[t]!;
      while (node >= 0) {
        let v = x[this.#feature[node]!] ?? NaN;
        const mt = this.#missing[node]!;
        if (Number.isNaN(v) && mt !== MISSING.NaN) v = 0;
        let goLeft: boolean;
        if ((mt === MISSING.Zero && Math.abs(v) <= ZERO_THRESHOLD) || (mt === MISSING.NaN && Number.isNaN(v))) {
          goLeft = this.#defaultLeft[node] === 1;
        } else {
          goLeft = v <= this.#threshold[node]!;
        }
        node = goLeft ? this.#left[node]! : this.#right[node]!;
      }
      sum += this.#leaves[~node]!;
    }
    return sum;
  }

  /** Probability that the event should be escalated. */
  predict(x: ArrayLike<number>): number {
    return 1 / (1 + Math.exp(-this.#sigmoid * this.raw(x)));
  }
}
