"""Training CSVs from weak labels plus Jev's direct judgments (round-4 candidate B).

    python3 ml/combine.py --weak data/features-v3/re3 --weak data/features-v3/gaia \
        --forced data/features-v3/re3/forced.csv --labels jev-labels.csv \
        --roles benchmarks/2026-10-27-r4/roles.json --weak-weight 0.3 --out data/features-v3/combined

--weak dirs are ml/featurize.ts outputs ({train,valid,eval}.csv with an id column). --labels is
a CSV of `id,y` (Jev's authoritative, deduplicated judgments, conflicts settled by review; see
ml/jev-labels.py). --forced holds the feature rows of those events (featurize.ts --force).

Weak rows keep their split, with their weight scaled by --weak-weight. A Jev label replaces the
weak row of the same event in train.csv, at weight 1, and is used only when its case's role is
`fit`: valid.csv (thresholds) and eval.csv stay weak, the same for every arm.
"""
import argparse
import csv
import json
import os


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weak", action="append", required=True)
    ap.add_argument("--forced", action="append", default=[])
    ap.add_argument("--labels")
    ap.add_argument("--roles", required=True)
    ap.add_argument("--weak-weight", type=float, default=0.3)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    roles = json.load(open(args.roles))["cases"]
    jev = {}
    if args.labels:
        with open(args.labels, newline="") as f:
            for r in csv.DictReader(f):
                if roles.get(r["id"].rsplit(":", 1)[0]) == "fit":
                    jev[r["id"]] = int(r["y"])
    os.makedirs(args.out, exist_ok=True)
    header = None
    out = {s: open(os.path.join(args.out, f"{s}.csv"), "w") for s in ("train", "valid", "eval")}
    counts = {s: {"weak": 0, "jev": 0, "weak_replaced": 0} for s in out}

    def check(h, where):
        nonlocal header
        if header is None:
            header = h
            for o in out.values():
                o.write(header)
        elif h != header:
            raise SystemExit(f"{where} has different columns")

    cols = None
    for d in args.weak:
        for s in out:
            with open(os.path.join(d, f"{s}.csv")) as f:
                h = f.readline()
                check(h, f"{d}/{s}.csv")
                cols = h.rstrip("\n").split(",")
                iw = cols.index("w")
                for line in f:
                    c = line.split(",", iw + 1)
                    if s == "train" and c[0] in jev:
                        counts[s]["weak_replaced"] += 1
                        continue
                    c[iw] = repr(float(c[iw]) * args.weak_weight)
                    out[s].write(",".join(c))
                    counts[s]["weak"] += 1
    seen = set()
    for path in args.forced:
        with open(path) as f:
            check(f.readline(), path)
            iy = cols.index("y")
            for line in f:
                c = line.split(",", iy + 1)
                if c[0] not in jev or c[0] in seen:
                    continue
                seen.add(c[0])
                c[iy] = str(jev[c[0]])
                out["train"].write(",".join(c))
                counts["train"]["jev"] += 1
    for o in out.values():
        o.close()
    missing = sorted(set(jev) - seen)
    report = {"weak_weight": args.weak_weight, "jev_labels_for_fit_cases": len(jev), "jev_rows_written": len(seen), "jev_without_features": len(missing), "counts": counts}
    json.dump(report, open(os.path.join(args.out, "combine.json"), "w"), indent=1)
    print(json.dumps(report))


if __name__ == "__main__":
    main()
