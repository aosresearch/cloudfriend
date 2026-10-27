# Benchmark run, 2026-10-27

The third round: earned suppression, review on expiry, causal replay and per-incident results, after the external review of the previous round. `docs/benchmarks.md` summarises the results; the scripts are in `ml/` (see `ml/README.md`). This round spent $13.39 of OpenRouter calls on Jev (by the key's usage), against a $15 budget.

Unpack into a directory of your choice:

```bash
mkdir -p data/r3 && for f in benchmarks/2026-10-27/*.tar.gz; do tar xzf "$f" -C data/r3; done
```

| File | Contents |
| --- | --- |
| `jev-cache.tar.gz` | One JSON per Jev call, named by the SHA-256 of model, system prompt and batch prompt: the model the router picked, tokens and cost, latency, the prompt, the raw reply, Jev's judgments and alerts. Pass `--cache` to replay them for free (same model, data and settings). |
| `results.tar.gz` | `ml/evaluate.ts` outputs. `results/*-oracle-*.json`: replays with the oracle decider (the weak labels answer). `model-weak` is the shipped model, `model-r3` the one also trained on Jev's labels, `classic` has earned suppression off, and `earned6` and `b100` are the previous built-in model. `accept/re3-live.json`, `accept/gaia-live.json`: the live acceptance runs. `relabel/*.json`: the relabelling runs. `lofo/lofo.json` and `lofo/<group>/eval.json`: leave one fault group out. |
| `labels.tar.gz` | Jev's labels as training rows (`relabel/pilot.csv`, `relabel/re3.csv`: case, time, label, weight, feature vector), and every judgment and drop sample the runs wrote (`*/samples-*/judgments.csv`, `drops.csv`), from which `benchmarks/review/` was drawn. |
| `models.tar.gz` | `base-weak` (the shipped `models/base.json`) and `base-r3` (weak labels at 0.3 weight plus 10,434 Jev labels; not shipped). |
| `gaia-cases.json` | GAIA's days with their incidents as relabelled: each incident's labelled events, and the incidents whose windows it overlaps. |
| `gaia-features-meta.json` | Row counts of the GAIA training CSVs with the new labels. |
| `logs/` | Console output: the GAIA relabelling, the Jev relabelling, the live runs, leave-one-group-out, and the demo recordings. |

## Spend

| Run | Calls | Cost | Notes |
| --- | --- | --- | --- |
| Pilot relabel, 2 RE3 train cases, batches of 100 | 108 | $1.06 | Large batches made the router pick large models: about $0.009 a call. |
| Relabel, 10 RE3 train/valid cases, batches of 15 | 677 | $4.05 | Budget ran out after about 3 cases; the rest ran without Jev and their labels aren't written. |
| Acceptance, RE3, 6 held-out cases | 416 | $4.04 | Budget ran out in 3 of the cases; the classifier's fallback covered the rest. |
| Acceptance, GAIA Aug 13, 6 incident windows | 687 | $2.50 | Budget ran out at 09:04; the 4 incidents after that are not counted. |
| Demo recordings, 5 scenarios | 239 | $1.06 | Before each recorded window, the routing state learns from the weak labels instead of Jev. |

The counted calls include retries of replies that weren't valid JSON, which the scripts treat as Jev being unavailable after three tries.
