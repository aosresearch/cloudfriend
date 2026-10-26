"""Convert GAIA MicroSS (two continuous weeks of a QR-code login system with injected
faults) into cloudfriend event streams, one per day.

    unzip -p business.zip business/business_table_2021-08.csv | \
        python3 ml/datasets/gaia.py --run data/raw/gaia/run/run_table_2021-08.csv \
            --start 2021-08-01 --days 14 --out data/prepared/gaia

Sources:
  business   the services' application logs (about 3.5M lines a day)
  run        the system logs, with the fault-injection records removed

Incidents come from the injection records in the run logs: memory hogs, CPU hogs, file
moves, and access-permission-denied faults. The simulated "QR code expired" login failures
are left in as normal behaviour: they happen every few minutes by design.

Event labels (weak): a line is positive when it falls inside an incident window (plus 5
minutes), reads like an error, and its template is clearly more frequent than outside
incidents. Everything else is negative, so `positives` is small and the interesting number
is how many escalations happen on the quiet days.

Split: by day. Days 1-8 train, 9-10 valid, 11-14 eval. All days form one chain: the
featurizer's history carries over from one day to the next, as it would in production.
"""
import argparse
import collections
import csv
import datetime as dt
import gzip
import io
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from common import elevated, is_errorish, template, write_stream  # noqa: E402

csv.field_size_limit(10**9)
GRACE_MS = 5 * 60_000
TS = re.compile(r"(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)(?:,(\d{3}))?")

INJECTIONS = [
    ("memory", re.compile(r"\[memory_anomalies\].*start at ([\d\-: .]+?) and lasts (\d+)"), None),
    ("cpu", re.compile(r"\[cpu_anomalies\].*start at ([\d\-: .]+?) and lasts (\d+)"), None),
    ("file_move", re.compile(r"trigger the file moving program, start with ([\d\-: .]+?), last for (\d+)"), None),
    ("permission_denied", re.compile(r"trigger an access permission denied exception"), 3600),
]
NOT_EVENTS = re.compile(
    r"\[memory_anomalies\]|\[cpu_anomalies\]|\[normal memory freed label\]|trigger the file moving program|"
    r"trigger an access permission denied exception|to simulate the login failure"
)


def ms(s: str) -> int:
    s = s.strip()
    fmt = "%Y-%m-%d %H:%M:%S.%f" if "." in s else "%Y-%m-%d %H:%M:%S"
    return int(dt.datetime.strptime(s, fmt).replace(tzinfo=dt.timezone.utc).timestamp() * 1000)


_DAY_MS = {}


def line_time(msg: str):
    """Epoch ms of the timestamp a line starts with. Hot path: no strptime per line."""
    if len(msg) < 19 or msg[4] != "-" or msg[10] != " ":
        m = TS.match(msg)
        return ms(m.group(1)) + int(m.group(2) or 0) if m else None
    day = msg[:10]
    base = _DAY_MS.get(day)
    if base is None:
        base = _DAY_MS[day] = ms(day + " 00:00:00")
    try:
        t = base + (int(msg[11:13]) * 3600 + int(msg[14:16]) * 60 + int(msg[17:19])) * 1000
    except ValueError:
        return None
    if len(msg) >= 23 and msg[19] in ",." and msg[20:23].isdigit():
        t += int(msg[20:23])
    return t


def parse_run(path):
    incidents, run_events = [], []
    with open(path, newline="", encoding="utf-8", errors="replace") as f:
        r = csv.reader(f)
        next(r)
        for row in r:
            service, msg = row[-2], row[-1].strip()
            t = line_time(msg)
            if t is None:
                continue
            for kind, rx, fixed in INJECTIONS:
                m = rx.search(msg)
                if not m:
                    continue
                if fixed:
                    start, dur = t, fixed
                else:
                    start, dur = ms(m.group(1)), int(m.group(2))
                    dur = min(max(dur, 60), 600)  # some CPU records claim weeks; the hogs run minutes
                incidents.append({"kind": kind, "service": service, "start_ms": start, "end_ms": start + dur * 1000})
                break
            if not NOT_EVENTS.search(msg):
                run_events.append({"t": t, "source": "run", "data": {"service": service, "message": msg}})
    incidents.sort(key=lambda i: i["start_ms"])
    for n, inc in enumerate(incidents):
        inc["id"] = f"inc{n:03d}-{inc['kind']}-{inc['service']}"
    return incidents, run_events


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--start", default="2021-08-01")
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    day0 = dt.date.fromisoformat(args.start)
    days = [(day0 + dt.timedelta(days=i)).isoformat() for i in range(args.days)]
    lo = ms(days[0] + " 00:00:00")
    hi = lo + args.days * 86_400_000
    incidents, run_events = parse_run(args.run)
    incidents = [i for i in incidents if lo <= i["start_ms"] < hi]
    print(f"{len(incidents)} incidents:", dict(collections.Counter(i["kind"] for i in incidents)), flush=True)
    windows = [(i["start_ms"], i["end_ms"] + GRACE_MS, i["id"]) for i in incidents]

    def incident_at(t):
        for s, e, iid in windows:
            if s <= t <= e:
                return iid
        return None

    tmp_dir = os.path.join(args.out, "tmp")
    os.makedirs(tmp_dir, exist_ok=True)
    tmp = {d: gzip.open(os.path.join(tmp_dir, d + ".ndjson.gz"), "wt", encoding="utf-8", compresslevel=1) for d in days}
    base = collections.Counter()  # (source, service, template) outside incidents
    during = collections.Counter()  # (incident, source, service, template)
    incident_secs = sum((e - s) / 1000 for s, e, _ in windows)
    base_secs = args.days * 86_400 - incident_secs

    def add(e):
        d = dt.datetime.fromtimestamp(e["t"] / 1000, dt.timezone.utc).date().isoformat()
        if d not in tmp:
            return
        msg = e["data"]["message"]
        if is_errorish(msg):
            k = (e["source"], e["data"]["service"], template(msg))
            iid = incident_at(e["t"])
            if iid:
                during[(iid,) + k] += 1
            else:
                base[k] += 1
            e["_k"] = list(k)
            e["_i"] = iid
        tmp[d].write(json.dumps(e, ensure_ascii=False, separators=(",", ":")) + "\n")

    for e in run_events:
        add(e)
    n = 0
    r = csv.reader(io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8", errors="replace", newline=""))
    next(r)
    past = 0
    for row in r:
        n += 1
        if n % 5_000_000 == 0:
            print(f"  read {n:,} lines", flush=True)
        if len(row) < 3 or row[-3] not in tmp:
            # The table is sorted by day: a long run of later days means we are done.
            if len(row) >= 3 and row[-3] > days[-1]:
                past += 1
                if past > 100_000:
                    break
            continue
        past = 0
        msg = row[-1].strip()
        t = line_time(msg)
        if t is None:
            continue
        add({"t": t, "source": "business", "data": {"service": row[-2], "message": msg}})
    for f in tmp.values():
        f.close()

    durations = {iid: (e - s) / 1000 for s, e, iid in windows}
    cases = []
    for i, d in enumerate(days):
        events = []
        with gzip.open(os.path.join(tmp_dir, d + ".ndjson.gz"), "rt", encoding="utf-8") as f:
            for line in f:
                e = json.loads(line)
                k = e.pop("_k", None)
                iid = e.pop("_i", None)
                y = 0
                if k and iid:
                    k = tuple(k)
                    y = int(elevated(during[(iid,) + k], durations[iid], base[k], base_secs))
                e["y"] = y
                events.append(e)
        cnt, pos = write_stream(os.path.join(args.out, "streams", f"gaia-{d}.ndjson.gz"), events)
        start = lo + i * 86_400_000
        split = "train" if i < 8 else "valid" if i < 10 else "eval"
        day_incidents = [x for x in incidents if start <= x["start_ms"] < start + 86_400_000]
        cases.append({
            "id": f"gaia-{d}", "dataset": "gaia", "split": split, "chain": "gaia",
            "start_ms": start, "end_ms": start + 86_400_000, "incidents": day_incidents,
            "events": cnt, "positives": pos,
        })
        print(f"gaia-{d} {split:5s} events={cnt:8d} positives={pos:6d} incidents={len(day_incidents)}", flush=True)
        os.remove(os.path.join(tmp_dir, d + ".ndjson.gz"))
    os.rmdir(tmp_dir)
    with open(os.path.join(args.out, "cases.json"), "w") as f:
        json.dump(cases, f, indent=1)


if __name__ == "__main__":
    main()
