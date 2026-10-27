"""Jev's labels for training (round-4 candidate B), from the evidence table and the references.

    python3 ml/jev-labels.py --evidence data/evidence/evidence.csv --references references.csv --out jev-labels.csv

Keeps only direct, deduplicated judgments (ml/evidence.ts: one row per event, followers never
in it). An event Jev answered both ways takes the reviewed reference's label when the review
settled it (relevant or benign), and is left out otherwise. Uncertain, missing and ambiguous
rows are left out. Which cases may train is decided later, by roles (ml/combine.py).
"""
import argparse
import collections
import csv
import json


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--evidence", required=True)
    ap.add_argument("--references", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    ref = {r["id"]: r["label"] for r in csv.DictReader(open(args.references, newline=""))}
    out, why = [], collections.Counter()
    for r in csv.DictReader(open(args.evidence, newline="")):
        if r["ambiguous"] == "1":
            why["ambiguous"] += 1
            continue
        st = r["status"]
        if st in ("relevant", "benign"):
            out.append((r["id"], 1 if st == "relevant" else 0))
            why[st] += 1
        elif st == "conflict" and ref.get(r["id"]) in ("relevant", "benign"):
            out.append((r["id"], 1 if ref[r["id"]] == "relevant" else 0))
            why["conflict settled by review"] += 1
        else:
            why[f"left out: {st}" + (f" (review: {ref[r['id']]})" if r["id"] in ref else "")] += 1
    with open(args.out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "y"])
        w.writerows(out)
    print(json.dumps(dict(why)))


if __name__ == "__main__":
    main()
