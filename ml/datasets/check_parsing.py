"""Check the weak-label parsing against test/fixtures/parsing.json (run by test/parsing.test.ts).

    python3 ml/datasets/check_parsing.py test/fixtures/parsing.json

Prints one line per mismatch and exits 1 if there is any.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import is_errorish, status_code  # noqa: E402


def main():
    cases = json.load(open(sys.argv[1]))["cases"]
    bad = 0
    for c in cases:
        got = (status_code(c["text"]), is_errorish(c["text"]))
        want = (c["status"], c["errorish"])
        if got != want:
            bad += 1
            print(f"{c['note']}: got status={got[0]} errorish={got[1]}, want status={want[0]} errorish={want[1]}")
    print(f"{len(cases) - bad}/{len(cases)} ok")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
