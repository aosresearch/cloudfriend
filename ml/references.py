"""Merge the assistant reviews into references (benchmarks/<date>/review-protocol.md).

    python3 ml/references.py disagreements --review data/r4/review --index data/r4/review-index/items.csv \
        --answers data/r4/review-out --out data/r4/review-out/disagreements.md
    python3 ml/references.py merge --index ... --answers ... --model <reviewer model id> --out references.csv

`disagreements` writes every packet where reviewers A and B differ, with both labels and
rationales, for the adjudicator (answers in <answers>/adjudicated.jsonl). `merge` writes one row
per event: A's, B's and the adjudicated label, the final label, and where the item came from.
An important item (a safety-set candidate, a miss positive, or a conflict) whose final label is
`unsure` becomes `unknown`: left out of training and forwarded conservatively.
"""
import argparse
import csv
import datetime
import glob
import json
import os
import re

IMPORTANT = ("safety", "miss-positive", "conflict-labels", "conflict-direct")


def answers(dir_, who):
    out = {}
    for f in sorted(glob.glob(os.path.join(dir_, f"{who}-*.jsonl"))):
        for line in open(f):
            if line.strip():
                j = json.loads(line)
                out[j["packet"]] = j
    return out


def packets(review_dir):
    """Packet id -> its markdown, from the batch files."""
    out = {}
    for f in sorted(glob.glob(os.path.join(review_dir, "batch-*.md"))):
        for chunk in re.split(r"(?m)^(?=## p\d+)", open(f).read()):
            m = re.match(r"## (p\d+)", chunk)
            if m:
                out[m.group(1)] = chunk.strip()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["disagreements", "merge"])
    ap.add_argument("--review")
    ap.add_argument("--index", required=True)
    ap.add_argument("--answers", required=True)
    ap.add_argument("--model", default="")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    index = list(csv.DictReader(open(args.index, newline="")))
    a, b = answers(args.answers, "A"), answers(args.answers, "B")
    missing = [r["packet"] for r in index if r["packet"] not in a or r["packet"] not in b]
    if missing:
        raise SystemExit(f"{len(missing)} packets lack a review, e.g. {missing[:5]}")
    dis = [r["packet"] for r in index if a[r["packet"]]["label"] != b[r["packet"]]["label"]]

    if args.cmd == "disagreements":
        text = packets(args.review)
        parts = []
        for p in dis:
            parts.append(text[p] + "\n\n"
                         + f"Reviewer A: {a[p]['label']} ({a[p].get('confidence')}): {a[p].get('rationale', '')}\n"
                         + f"Reviewer B: {b[p]['label']} ({b[p].get('confidence')}): {b[p].get('rationale', '')}\n")
        open(args.out, "w").write("\n\n".join(parts) + "\n")
        print(json.dumps({"packets": len(index), "agree": len(index) - len(dis), "disagree": len(dis)}))
        return

    adj = answers(args.answers, "adjudicated") if dis else {}
    for f in glob.glob(os.path.join(args.answers, "adjudicated*.jsonl")):
        for line in open(f):
            if line.strip():
                j = json.loads(line)
                adj[j["packet"]] = j
    lacking = [p for p in dis if p not in adj]
    if lacking:
        raise SystemExit(f"{len(lacking)} disagreements lack an adjudication, e.g. {lacking[:5]}")
    date = datetime.date.today().isoformat()
    rows = []
    counts = {}
    for r in index:
        p = r["packet"]
        final = adj[p]["label"] if p in dis else a[p]["label"]
        sources = r["from"].split()
        if final == "unsure" and any(s.split(":")[0] in IMPORTANT for s in sources):
            final = "unknown"
        counts[final] = counts.get(final, 0) + 1
        for eid in r["ids"].split():
            rows.append({
                "id": eid, "packet": p, "case": r["case"], "time": r["time"], "service": r["service"], "from": r["from"],
                "a": a[p]["label"], "b": b[p]["label"], "adjudicated": adj[p]["label"] if p in dis else "",
                "label": final, "confidence": round(min(a[p].get("confidence", 0), b[p].get("confidence", 0)) if p not in dis else adj[p].get("confidence", 0), 2),
                "method": "assistant review: two independent reviewers, adjudicated on disagreement",
                "reviewer_model": args.model, "date": date, "message": r["message"],
            })
    with open(args.out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(json.dumps({"packets": len(index), "events": len(rows), "agree": len(index) - len(dis), "disagree": len(dis), "final_by_packet": counts}))


if __name__ == "__main__":
    main()
