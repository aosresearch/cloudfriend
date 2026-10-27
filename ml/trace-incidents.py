"""Trace GAIA incidents through the weak labels, before and after the parsing fix.

    python3 ml/trace-incidents.py --old data/prepared/gaia --new data/prepared/gaia21 \
        --incident inc278-memory-webservice1 ... [--changed] --out trace.json

For each incident asked for (and, with --changed, every incident on the days both
annotations cover whose labelled events differ), lists:
  - each labelled event under the old and the new rules: its text, and what made it read as
    an error (an error word, an HTTP status, or a bare number such as a timestamp's milliseconds)
  - the elevation numbers behind each label: the template's count in the incident's window
    against its count on the baseline days (the fit days outside every window), as rates
  - with no label left: the error-like templates of the incident's service in its window, and
    why none counts (not elevated)

and puts the incident in one category:
  real_symptom           an event reads as an error by its words or a real status, and is
                         elevated in the window
  parsing_artefact       every old label read as an error only through a number that is not a
                         status (mostly timestamp milliseconds), and none is left after the fix
  no_observable_symptom  no label before or after: nothing error-like is elevated

Incidents in the last two categories stay in every denominator; reports list them apart.
"""
import argparse
import collections
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "datasets"))
from common import ERRORISH, _NOT_STATUS, elevated, status_code, template  # noqa: E402
from gaia import GRACE_MS, read_stream  # noqa: E402

# The rule before the fix: any bare 500/502/503/504, wherever it stood.
OLD_NUMBER = re.compile(r"\b(500|502|503|504)\b")


def why(text, old):
    """What makes a line read as an error, under the old or the new rule."""
    m = ERRORISH.search(text)
    if m:
        return {"by": "word", "match": m.group(0)}
    code = status_code(text)
    if code is not None and code >= 500:
        return {"by": "status", "match": code}
    if old:
        n = OLD_NUMBER.search(text)
        if n:
            stripped = _NOT_STATUS.sub(" ", text)
            return {"by": "bare_number", "match": n.group(0), "incidental": not OLD_NUMBER.search(stripped)}
    return None


def load(dir_):
    cases = json.load(open(os.path.join(dir_, "cases.json")))
    return cases, {i["id"]: (c, i) for c in cases for i in c["incidents"]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--old", required=True)
    ap.add_argument("--new", required=True)
    ap.add_argument("--incident", action="append", default=[])
    ap.add_argument("--changed", action="store_true", help="also every incident whose labelled events changed")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    old_cases, old_inc = load(args.old)
    new_cases, new_inc = load(args.new)
    targets = list(dict.fromkeys(args.incident))
    if args.changed:
        for iid, (_, i) in old_inc.items():
            if iid in new_inc and new_inc[iid][1].get("positives", 0) != i.get("positives", 0) and iid not in targets:
                targets.append(iid)
    missing = [t for t in targets if t not in new_inc]
    if missing:
        raise SystemExit(f"not in the new annotation: {missing}")
    print(f"{len(targets)} incidents to trace", flush=True)

    # The incidents' windows (with the labelling grace) and the days that hold them.
    win = {t: (new_inc[t][1]["start_ms"], new_inc[t][1]["end_ms"] + GRACE_MS) for t in targets}
    days = sorted({new_inc[t][0]["id"] for t in targets})

    def labelled(dir_, cases_by_id, old):
        out = collections.defaultdict(list)
        for day in days:
            if day not in cases_by_id:
                continue
            for e in read_stream(dir_, day):
                for iid in e.get("inc") or []:
                    if iid in win:
                        msg = e["data"]["message"]
                        out[iid].append({"t": e["t"], "source": e["source"], "service": e["data"].get("service"), "text": msg[:400], "why": why(msg, old),
                                         "key": [e["source"], e["data"].get("service"), template(msg)]})
        return out

    old_pos = labelled(args.old, {c["id"]: c for c in old_cases}, True)
    new_pos = labelled(args.new, {c["id"]: c for c in new_cases}, False)

    # Error-like templates (new rule) of each incident's service inside its window.
    during = collections.Counter()
    for day in days:
        for e in read_stream(args.new, day):
            for iid, (s, end) in win.items():
                if s <= e["t"] <= end and e["data"].get("service") == new_inc[iid][1]["service"]:
                    msg = e["data"]["message"]
                    if why(msg, False):
                        during[(iid, e["source"], e["data"].get("service"), template(msg))] += 1
    keys = {k[1:] for k in during} | {tuple(p["key"]) for ps in list(old_pos.values()) + list(new_pos.values()) for p in ps}

    # Baseline: the new annotation's fit days, outside every incident window.
    fit = [c for c in new_cases if c["split"] == "train"]
    all_windows = sorted((i["start_ms"], i["end_ms"] + GRACE_MS) for c in new_cases for i in c["incidents"])
    lo, hi = min(c["start_ms"] for c in fit), max(c["end_ms"] for c in fit)
    covered, cur = 0, None
    for s, e in all_windows:
        s, e = max(s, lo), min(e, hi)
        if e <= s:
            continue
        if cur is None or s > cur[1]:
            if cur:
                covered += cur[1] - cur[0]
            cur = [s, e]
        else:
            cur[1] = max(cur[1], e)
    if cur:
        covered += cur[1] - cur[0]
    base_secs = (hi - lo - covered) / 1000
    starts = [w[0] for w in all_windows]
    import bisect
    longest = max((e - s for s, e in all_windows), default=0)

    def in_window(t):
        i = bisect.bisect_right(starts, t)
        j = bisect.bisect_left(starts, t - longest)
        return any(s <= t <= e for s, e in all_windows[j:i])

    base = collections.Counter()
    for c in fit:
        for e in read_stream(args.new, c["id"]):
            msg = e["data"]["message"]
            k = (e["source"], e["data"].get("service"), template(msg))
            if k in keys and not in_window(e["t"]):
                base[k] += 1
        print(f"  baseline {c['id']}", flush=True)

    def elevation(iid, key):
        s, e = win[iid]
        secs = (e - s) / 1000
        d = during[(iid,) + tuple(key)]
        b = base[tuple(key)]
        return {"in_window": d, "window_s": round(secs), "baseline": b, "baseline_s": round(base_secs),
                "ratio": round((d / max(secs, 1)) / (b / max(base_secs, 1)), 1) if b else None,
                "elevated": elevated(d, secs, b, base_secs)}

    report = []
    for iid in targets:
        c, inc = new_inc[iid]
        olds, news = old_pos.get(iid, []), new_pos.get(iid, [])
        artefact = bool(olds) and all(p["why"] and p["why"]["by"] == "bare_number" and p["why"]["incidental"] for p in olds)
        real = any(p["why"] and p["why"]["by"] in ("word", "status") for p in news)
        category = "real_symptom" if real else "parsing_artefact" if artefact else "no_observable_symptom"
        for p in olds + news:
            p["elevation"] = elevation(iid, p["key"])
        cands = sorted(((k[1:], n) for k, n in during.items() if k[0] == iid), key=lambda x: -x[1])[:10]
        report.append({
            "incident": iid, "day": c["id"], "kind": inc["kind"], "service": inc["service"],
            "start": inc["start_ms"], "end": inc["end_ms"], "category": category,
            "old_positives": len(olds), "new_positives": len(news),
            "old": olds[:20], "new": news[:20],
            "service_error_templates_in_window": [{"key": list(k), "count": n, "elevation": elevation(iid, k)} for k, n in cands],
        })
        print(f"{iid:32s} {category:22s} old={len(olds):3d} new={len(news):3d}", flush=True)
    json.dump({"old": args.old, "new": args.new, "baseline_days": [c["id"] for c in fit], "incidents": report}, open(args.out, "w"), indent=1)
    counts = collections.Counter(r["category"] for r in report)
    print(json.dumps(counts))


if __name__ == "__main__":
    main()
