"""Convert RCAEval RE3 (code-level faults in Online Boutique, Sock Shop, Train Ticket) into
cloudfriend event streams.

    python3 ml/datasets/re3.py --raw data/raw/rcaeval --out data/prepared/re3

Each case is one stream: about 12 minutes of normal operation, the fault injection, then
about 12 minutes with the fault. Events are the case's log lines (source `logs`) plus its
failed trace spans (source `traces`, Online Boutique only: Train Ticket spans carry no status).

Event labels (weak, from the injection time): a line is positive when it comes after the
injection, reads like an error, and its template is clearly more frequent than before the
injection. Background errors that were already there before the fault stay negative.

Split: by fault (system, service, fault type), so the eval faults are never seen in
training. Every case of a fault lands in the same split.
"""
import argparse
import collections
import glob
import json
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from common import elevated, group_split, is_errorish, template, write_stream  # noqa: E402

SYSTEMS = {"RE3-OB": "online-boutique", "RE3-SS": "sock-shop", "RE3-TT": "train-ticket"}


def convert_case(case_dir: str):
    t0_ms = int(open(os.path.join(case_dir, "inject_time.txt")).read().strip()) * 1000
    logs = pd.read_csv(os.path.join(case_dir, "logs.csv"), dtype=str, keep_default_na=False)
    events = []
    for r in logs.itertuples(index=False):
        ts_ns = int(r.timestamp)
        events.append({
            "t": ts_ns // 1_000_000,
            "source": "logs",
            "data": {
                "timestamp": ts_ns,
                "container_name": r.container_name,
                "pod_name": r.pod_name,
                "node_name": r.node_name,
                "message": r.message,
            },
        })
    trace_path = os.path.join(case_dir, "traces.csv")
    if os.path.exists(trace_path):
        tr = pd.read_csv(trace_path, dtype=str, keep_default_na=False)
        tr = tr[(tr.statusCode != "") & (tr.statusCode != "0.0") & (tr.statusCode != "0")]
        for r in tr.itertuples(index=False):
            events.append({
                "t": int(r.startTimeMillis),
                "source": "traces",
                "data": {
                    "service": r.serviceName,
                    "operation": r.operationName,
                    "method": r.methodName,
                    "status_code": int(float(r.statusCode)),
                    "duration_us": int(float(r.duration or 0)),
                    "trace_id": r.traceID,
                    "message": f"span {r.operationName} failed with gRPC status {int(float(r.statusCode))}",
                },
            })
    if not events:
        return None
    start = min(e["t"] for e in events)
    end = max(e["t"] for e in events)
    pre_secs = max((t0_ms - start) / 1000, 1)
    post_secs = max((end - t0_ms) / 1000, 1)
    key = lambda e: (e["source"], e["data"].get("container_name") or e["data"].get("service"), template(e["data"]["message"]))
    pre = collections.Counter(key(e) for e in events if e["t"] < t0_ms)
    post = collections.Counter(key(e) for e in events if e["t"] >= t0_ms)
    for e in events:
        k = key(e)
        e["y"] = int(
            e["t"] >= t0_ms
            and (e["source"] == "traces" or is_errorish(e["data"]["message"]))
            and elevated(post[k], post_secs, pre[k], pre_secs)
        )
    return events, t0_ms, start, end


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True, help="directory holding RE3-OB, RE3-SS, RE3-TT")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    case_dirs = sorted(glob.glob(os.path.join(args.raw, "RE3-*", "*", "*")))
    faults = {}
    for d in case_dirs:
        parts = d.split(os.sep)
        faults[d] = f"{parts[-3]}/{parts[-2]}"
    splits = {}
    for sys_dir in SYSTEMS:
        splits.update(group_split([f for f in faults.values() if f.startswith(sys_dir + "/")]))

    cases = []
    for d in case_dirs:
        parts = d.split(os.sep)
        system, fault_dir, rep = SYSTEMS[parts[-3]], parts[-2], parts[-1]
        service, fault = fault_dir.rsplit("_", 1) if "_f" in fault_dir else (fault_dir, "")
        if fault_dir.endswith("_f3_1"):
            service, fault = fault_dir[: -len("_f3_1")], "f3"
        out = convert_case(d)
        if out is None:
            continue
        events, t0, start, end = out
        case_id = f"re3-{parts[-3][4:].lower()}-{fault_dir}-{rep}"
        n, pos = write_stream(os.path.join(args.out, "streams", case_id + ".ndjson.gz"), events)
        cases.append({
            "id": case_id, "dataset": "re3", "system": system, "service": service, "fault": fault,
            "split": splits[faults[d]], "start_ms": start, "inject_ms": t0, "end_ms": end,
            "events": n, "positives": pos,
        })
        print(f"{case_id:45s} {splits[faults[d]]:5s} events={n:6d} positives={pos:5d}", flush=True)
    with open(os.path.join(args.out, "cases.json"), "w") as f:
        json.dump(cases, f, indent=1)
    by = collections.Counter(c["split"] for c in cases)
    print("cases per split:", dict(by))


if __name__ == "__main__":
    main()
