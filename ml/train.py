"""Train the escalation classifier with LightGBM.

    python3 ml/train.py --train data/features/train.csv --valid data/features/valid.csv \
        [--eval data/features/eval.csv] [--init-model models/base.lgb.txt] --out models/base.json

Input CSVs come from `node ml/featurize.ts` (benchmarks) or `cloudfriend train` (your own
labels). Columns: case, t, y, w, then one column per feature, named as in the featurizer.

Output:
  <out>             the model cloudfriend loads: thresholds, metrics and the trees as JSON
  <out stem>.lgb.txt  LightGBM's own text format, to continue training from later

Thresholds are chosen on the validation set:
  drop_below      the highest score that still forwards `--recall` of the positives (by
                  weight) to Jev, moved halfway into the gap below it. Events below it are
                  not escalated and cost nothing.
  escalate_above  the lowest score at which `--auto-precision` of events are positive, so
                  they could skip Jev. 1.01 (never) unless --auto-escalate is set.
  threshold       the score with the best F1, used when no Jev is configured.
"""
import argparse
import datetime
import json
import os
import re
import sys

import csv

import lightgbm as lgb
import numpy as np

try:  # pandas reads big benchmark files much faster, but the container doesn't need it
    import pandas as pd
except ImportError:
    pd = None

META = ["case", "t", "y", "w"]


def load(path):
    """Returns (feature matrix float32 with NaN for missing, y, w, feature names)."""
    if pd is not None:
        df = pd.read_csv(path, low_memory=False)
        feats = [c for c in df.columns if c not in META]
        return df[feats].to_numpy(dtype=np.float32), df["y"].to_numpy(dtype=np.int8), df["w"].to_numpy(dtype=np.float64), feats
    with open(path, newline="") as f:
        r = csv.reader(f)
        header = next(r)
        idx = [i for i, c in enumerate(header) if c not in META]
        iy, iw = header.index("y"), header.index("w")
        X, y, w = [], [], []
        for row in r:
            X.append([float(row[i]) if row[i] != "" else np.nan for i in idx])
            y.append(int(row[iy]))
            w.append(float(row[iw]))
    return np.asarray(X, dtype=np.float32).reshape(-1, len(idx)), np.asarray(y, dtype=np.int8), np.asarray(w), [header[i] for i in idx]


def curve(y, w, p):
    """Weighted counts at every distinct score, highest first."""
    order = np.argsort(-p, kind="stable")
    ps, ys, ws = p[order], y[order], w[order]
    tp = np.cumsum(ws * ys)
    fp = np.cumsum(ws * (1 - ys))
    last = np.r_[ps[1:] != ps[:-1], True]  # last index of each tied score
    return ps[last], tp[last], fp[last]


def choose_thresholds(y, w, p, recall, auto_precision, auto_escalate):
    s, tp, fp = curve(y, w, p)
    pos = tp[-1] if len(tp) else 0.0
    rec = tp / max(pos, 1e-9)
    prec = tp / np.maximum(tp + fp, 1e-9)
    # drop_below: the smallest set of top scores that reaches the recall target.
    i = int(np.searchsorted(rec, recall))
    i = min(i, len(s) - 1)
    # Put the threshold halfway (in log-odds) into the gap below the last kept score, so a
    # new event scoring a hair under the lowest kept escalation isn't dropped.
    logit = lambda p: np.log(np.clip(p, 1e-12, 1 - 1e-12) / (1 - np.clip(p, 1e-12, 1 - 1e-12)))
    if i + 1 < len(s):
        drop_below = float(1 / (1 + np.exp(-(logit(s[i]) + logit(s[i + 1])) / 2)))
    else:
        drop_below = float(s[i]) / 2
    # threshold: best F1.
    f1 = 2 * prec * rec / np.maximum(prec + rec, 1e-9)
    threshold = float(s[int(np.argmax(f1))])
    escalate_above = 1.01
    if auto_escalate:
        ok = np.where((prec >= auto_precision) & (tp >= 20))[0]
        if len(ok):
            escalate_above = float(s[ok[-1]])
    return drop_below, escalate_above, threshold


def report(y, w, p, drop_below, threshold):
    """Metrics in the terms cloudfriend cares about."""
    pos = (w * y).sum()
    total = w.sum()
    fwd = p >= drop_below
    hit = p >= threshold
    from_ap = average_precision(y, w, p)
    return {
        "events": float(total),
        "positives": float(pos),
        "auc": roc_auc(y, w, p),
        "average_precision": from_ap,
        "forwarded_share": float((w * fwd).sum() / max(total, 1e-9)),
        "recall_at_drop": float((w * y * fwd).sum() / max(pos, 1e-9)),
        "precision_at_threshold": float((w * y * hit).sum() / max((w * hit).sum(), 1e-9)),
        "recall_at_threshold": float((w * y * hit).sum() / max(pos, 1e-9)),
    }


def average_precision(y, w, p):
    s, tp, fp = curve(y, w, p)
    if not len(tp) or tp[-1] == 0:
        return None
    rec = tp / tp[-1]
    prec = tp / np.maximum(tp + fp, 1e-9)
    return float(np.sum(np.diff(np.r_[0.0, rec]) * prec))


def roc_auc(y, w, p):
    s, tp, fp = curve(y, w, p)
    if not len(tp) or tp[-1] == 0 or fp[-1] == 0:
        return None
    tpr = np.r_[0.0, tp / tp[-1]]
    fpr = np.r_[0.0, fp / fp[-1]]
    return float(np.trapezoid(tpr, fpr))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", required=True)
    ap.add_argument("--valid", required=True)
    ap.add_argument("--eval")
    ap.add_argument("--out", required=True)
    ap.add_argument("--init-model", help="LightGBM text model to continue boosting from")
    ap.add_argument("--rounds", type=int, default=600)
    ap.add_argument("--learning-rate", type=float, default=0.05)
    ap.add_argument("--num-leaves", type=int, default=31)
    ap.add_argument("--recall", type=float, default=0.98, help="share of positives that must reach Jev")
    ap.add_argument("--auto-escalate", action="store_true")
    ap.add_argument("--auto-precision", type=float, default=0.995)
    ap.add_argument("--featurizer-version", type=int, required=True)
    ap.add_argument("--note", default="")
    ap.add_argument(
        "--exclude",
        default="",
        help="regex of features to leave out, e.g. ones that only describe the benchmark systems",
    )
    ap.add_argument("--parity", help="also write N sample rows with LightGBM's scores here, for the TS parity test")
    args = ap.parse_args()

    Xtr, ytr, wtr, feats = load(args.train)
    Xva, yva, wva, feats_va = load(args.valid)
    if feats != feats_va:
        sys.exit("train and valid have different feature columns")
    # Continuing from a model means using exactly its features; otherwise apply --exclude.
    if args.init_model:
        with open(args.init_model) as f:
            line = next((l for l in f if l.startswith("feature_names=")), "")
        keep = line.strip().split("=", 1)[1].split(" ") if line else feats
    else:
        rx = re.compile(args.exclude) if args.exclude else None
        keep = [c for c in feats if not (rx and rx.search(c))]
    cols = [feats.index(c) for c in keep]
    Xva_full = Xva  # the parity fixture holds full featurizer rows, as the server scores them
    Xtr, Xva, feats = Xtr[:, cols], Xva[:, cols], keep
    if ytr.sum() == 0 or yva.sum() == 0:
        sys.exit("need at least one positive in train and in valid")

    params = {
        "objective": "binary",
        "learning_rate": args.learning_rate,
        "num_leaves": args.num_leaves,
        # 40 rows per leaf suits the benchmark sets; a few hundred labels need smaller leaves.
        "min_data_in_leaf": max(5, min(40, len(ytr) // 20)),
        "feature_fraction": 0.8,
        "bagging_fraction": 0.8,
        "bagging_freq": 1,
        "lambda_l2": 1.0,
        "max_bin": 255,
        "metric": ["binary_logloss", "average_precision"],
        "first_metric_only": True,
        "verbose": -1,
        "seed": 7,
        "num_threads": os.cpu_count() or 2,
    }
    dtr = lgb.Dataset(Xtr, ytr, weight=wtr, feature_name=feats, free_raw_data=False)
    dva = lgb.Dataset(Xva, yva, weight=wva, reference=dtr)
    booster = lgb.train(
        params,
        dtr,
        num_boost_round=args.rounds,
        valid_sets=[dva],
        valid_names=["valid"],
        init_model=args.init_model,
        callbacks=[lgb.early_stopping(100, verbose=False), lgb.log_evaluation(100)],
    )
    pva = booster.predict(Xva, num_iteration=booster.best_iteration)
    drop_below, escalate_above, threshold = choose_thresholds(
        yva, wva, pva, args.recall, args.auto_precision, args.auto_escalate
    )
    metrics = {"train_rows": int(len(ytr)), "valid": report(yva, wva, pva, drop_below, threshold)}
    if args.eval and os.path.exists(args.eval) and os.path.getsize(args.eval) > 200:
        Xev, yev, wev, feats_ev = load(args.eval)
        if feats_ev != feats_va:
            sys.exit("eval has different feature columns")
        pev = booster.predict(Xev[:, cols], num_iteration=booster.best_iteration)
        metrics["eval"] = report(yev, wev, pev, drop_below, threshold)

    gain = booster.feature_importance("gain", iteration=booster.best_iteration)
    top = sorted(zip(feats, gain), key=lambda x: -x[1])[:15]
    metrics["top_features"] = [[f, round(float(g), 1)] for f, g in top]

    dump = booster.dump_model(num_iteration=booster.best_iteration)
    model = {
        "format": "cloudfriend-classifier/1",
        "featurizer_version": args.featurizer_version,
        "feature_names": feats,
        "trained_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "note": args.note,
        "drop_below": drop_below,
        "escalate_above": escalate_above,
        "threshold": threshold,
        "recall_target": args.recall,
        "trees": booster.best_iteration or booster.current_iteration(),
        "metrics": metrics,
        "lightgbm": {k: dump[k] for k in ("objective", "feature_names", "max_feature_idx", "num_class", "tree_info")},
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    tmp = args.out + ".tmp"
    with open(tmp, "w") as f:
        json.dump(model, f, separators=(",", ":"))
    os.replace(tmp, args.out)
    booster.save_model(os.path.splitext(args.out)[0] + ".lgb.txt", num_iteration=booster.best_iteration)

    if args.parity:
        rng = np.random.default_rng(3)
        idx = rng.choice(len(Xva), size=min(300, len(Xva)), replace=False)
        rows = Xva_full[idx].astype(np.float64)
        rows = np.where(np.isnan(rows), None, rows).tolist()
        with open(args.parity, "w") as f:
            json.dump({"rows": rows, "scores": pva[idx].tolist()}, f)

    # One line of JSON on stdout for `cloudfriend train` to read.
    summary = {k: model[k] for k in ("drop_below", "escalate_above", "threshold", "trees")}
    summary["metrics"] = metrics
    print("RESULT " + json.dumps(summary))


if __name__ == "__main__":
    main()
