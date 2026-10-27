"""Combine training CSVs for the built-in model: the datasets' weak labels, scaled down, plus
Jev's labels (from ml/evaluate.ts --labels-out), which keep their provenance weights.

    python3 ml/combine.py --weak data/features-v2/re3 --weak data/features-v2/gaia \
        --jev data/relabel/re3.csv --cases data/prepared/re3/cases.json --weak-weight 0.3 \
        --out data/features-v2/combined

Writes <out>/{train,valid,eval}.csv. Weak rows go where featurize.ts put them; a Jev label goes
to the split of its case, and never to eval (relabelling only runs on train and valid cases).
"""
import argparse
import json
import os


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weak", action="append", required=True, help="a featurize.ts output dir")
    ap.add_argument("--jev", action="append", default=[], help="a labels CSV from evaluate.ts --labels-out")
    ap.add_argument("--cases", action="append", default=[], help="cases.json files, for the Jev labels' splits")
    ap.add_argument("--weak-weight", type=float, default=0.3)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    split = {}
    for f in args.cases:
        for c in json.load(open(f)):
            split[c["id"]] = c["split"]
    os.makedirs(args.out, exist_ok=True)
    header = None
    out = {}
    counts = {}
    for s in ("train", "valid", "eval"):
        out[s] = open(os.path.join(args.out, f"{s}.csv"), "w")
        counts[s] = {"weak": 0, "jev": 0}
    for d in args.weak:
        for s in ("train", "valid", "eval"):
            with open(os.path.join(d, f"{s}.csv")) as f:
                h = f.readline()
                if header is None:
                    header = h
                    for o in out.values():
                        o.write(header)
                elif h != header:
                    raise SystemExit(f"{d}/{s}.csv has different columns")
                for line in f:
                    c = line.split(",", 4)
                    c[3] = repr(float(c[3]) * args.weak_weight)
                    out[s].write(",".join(c))
                    counts[s]["weak"] += 1
    for path in args.jev:
        with open(path) as f:
            if f.readline() != header:
                raise SystemExit(f"{path} has different columns")
            for line in f:
                s = split.get(line.split(",", 1)[0])
                if s not in ("train", "valid"):
                    continue
                out[s].write(line)
                counts[s]["jev"] += 1
    for o in out.values():
        o.close()
    print(json.dumps(counts))


if __name__ == "__main__":
    main()
