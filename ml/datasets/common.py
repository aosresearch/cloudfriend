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

# Error words. Numbers never count here: a 5xx counts only as an HTTP status (status_code).
ERRORISH = re.compile(
    r"\b(error|err|exception|traceback|fail(ed|ure|s)?|fatal|panic|crash|refused|unavailable|timed? ?out|"
    r"denied|forbidden|unauthori[sz]ed|cannot|can't|unable|invalid|severe|critical|killed|oom)\b"
    r"|Error\b|Exception\b|\bWARN(ING)?\b",
    re.IGNORECASE,
)

# Numbers that are not statuses: timestamps (with their milliseconds), IPs with ports, versions.
_NOT_STATUS = re.compile(
    r"\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?"
    r"|\b\d\d?:\d\d:\d\d(?:[.,]\d+)?"
    r"|\[\d\d/\w{3}/\d{4}:\d\d:\d\d:\d\d [+-]\d{4}\]"
    r"|\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b"
    r"|\bv?\d+\.\d+(?:\.\d+)+\b"
)
# An HTTP status in text: after status/code, after the request in an access log
# ("POST /cart 503 - ms", "\"GET /x HTTP/1.1\" 503 12"), or before its reason phrase.
_STATUS = re.compile(
    r"\b(?:status(?:[_ ]?code)?|http[_ ]?code|response[_ ]?code)[\"']?\s*[=:]?\s*([1-5]\d\d)\b"
    r"|\bHTTP/\d(?:\.\d)?\"?\s+([1-5]\d\d)\b"
    r"|\b(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS) \S+ ([1-5]\d\d)\b"
    r"|\breturn(?:s|ed)? ([1-5]\d\d)\b"
    r"|\b([1-5]\d\d) (?:OK|Created|Accepted|No Content|Found|Not Modified|Bad Request|Unauthorized|Forbidden|Not Found|"
    r"Method Not Allowed|Conflict|Gone|Too Many Requests|Internal Server Error|Not Implemented|Bad Gateway|Service Unavailable|"
    r"Gateway Time-?out)\b",
    re.IGNORECASE,
)


def status_code(text: str):
    """The HTTP status a message reports, or None. Timestamps and other numbers never count."""
    m = _STATUS.search(_NOT_STATUS.sub(" ", str(text)))
    if not m:
        return None
    return int(next(g for g in m.groups() if g))

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
    """Error words, or an HTTP 5xx status. The digits of a timestamp are not a status."""
    text = str(text)
    if ERRORISH.search(text):
        return True
    code = status_code(text)
    return code is not None and code >= 500


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
