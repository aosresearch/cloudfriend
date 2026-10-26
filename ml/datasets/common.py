"""Shared helpers for turning benchmark datasets into cloudfriend event streams.

A prepared dataset is a directory with:

  cases.json                one entry per case (RCAEval) or day (GAIA): id, split, times, counts
  streams/<case>.ndjson.gz  the case's events in time order, one JSON object per line:
                              {"t": epoch_ms, "source": "...", "data": {...}, "y": 0 or 1}

`data` is what a sender would POST to /in/<source>. `y` is the event-level weak label
(see label_events). The labels never leave the scripts: cloudfriend only sees source and data.
"""
import gzip
import json
import os
import random
import re

ERRORISH = re.compile(
    r"\b(error|err|exception|traceback|fail(ed|ure|s)?|fatal|panic|crash|refused|unavailable|timed? ?out|"
    r"denied|forbidden|unauthori[sz]ed|cannot|can't|unable|invalid|severe|critical|killed|oom|"
    r"500|502|503|504)\b|Error\b|Exception\b|\bWARN(ING)?\b",
    re.IGNORECASE,
)

_MASKS = [
    (re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I), "<U>"),
    (re.compile(r"\b\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?Z?"), "<T>"),
    (re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b"), "<IP>"),
    (re.compile(r"\"[^\"\n]{0,200}\"|'[^'\n]{0,200}'"), "<S>"),
    (re.compile(r"\b([\w.-]+)=[^\s,;&)\]}]+"), r"\1=<V>"),
    (re.compile(r"\b[0-9a-f]{12,}\b", re.I), "<H>"),
    (re.compile(r"[^\s<>=,;:()\[\]{}|]*\d[^\s<>=,;:()\[\]{}|]*"), "<N>"),
    (re.compile(r"\s+"), " "),
]


def template(text: str) -> str:
    """A coarse message template for labelling (not the featurizer's template)."""
    lines = [l.strip() for l in str(text).split("\n") if l.strip()]
    s = f"{lines[0]} … {lines[-1]}" if len(lines) > 1 else (lines[0] if lines else "")
    for rx, rep in _MASKS:
        s = rx.sub(rep, s)
    return s[:120]


def is_errorish(text: str) -> bool:
    return bool(ERRORISH.search(str(text)))


def elevated(during_count: int, during_secs: float, base_count: int, base_secs: float, factor: float = 3.0) -> bool:
    """True when a template is clearly more frequent during an incident than at baseline."""
    if base_count == 0:
        return True
    during_rate = during_count / max(during_secs, 1.0)
    base_rate = base_count / max(base_secs, 1.0)
    return during_count >= 2 and during_rate > factor * base_rate


def write_stream(path: str, events) -> tuple[int, int]:
    """Write events (dicts with t, source, data, y) sorted by time. Returns (count, positives)."""
    events = sorted(events, key=lambda e: e["t"])
    n = pos = 0
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8", compresslevel=5) as f:
        for e in events:
            f.write(json.dumps(e, ensure_ascii=False, separators=(",", ":")) + "\n")
            n += 1
            pos += e["y"]
    return n, pos


def group_split(keys, seed: int = 7, frac=(0.6, 0.2, 0.2)) -> dict:
    """Deterministically assign each key to train / valid / eval."""
    keys = sorted(set(keys))
    rng = random.Random(seed)
    rng.shuffle(keys)
    n = len(keys)
    n_train = max(1, round(n * frac[0]))
    n_valid = max(1, round(n * frac[1]))
    out = {}
    for i, k in enumerate(keys):
        out[k] = "train" if i < n_train else "valid" if i < n_train + n_valid else "eval"
    return out
