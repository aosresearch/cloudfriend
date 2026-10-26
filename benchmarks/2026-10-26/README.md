# Benchmark run, 2026-10-26

Everything produced by the benchmark and training experiments on this date that can't be regenerated for free: 9,065 live Jev replies ($20.83 of OpenRouter calls), the evaluation results, the Jev-labelled training sets, and every model trained. The scripts that produced them are in `ml/` (see `ml/README.md`), and `docs/benchmarks.md` and `docs/training.md` summarise the results.

To use them, unpack into `data/` (git-ignored), where the scripts expect them:

```bash
mkdir -p data && for f in benchmarks/2026-10-26/*.tar.gz; do tar xzf "$f" -C data; done
# data/jev-cache, data/results, data/distill, data/models
```

With `data/jev-cache` in place, the evaluations below replay Jev's recorded answers instead of calling it, as long as the model, data and prompt are unchanged. Pass `--cache data/jev-cache` to the scripts.

| File | Contents |
| --- | --- |
| `jev-cache.tar.gz` | One JSON per Jev call, named by the SHA-256 of model + system prompt + batch prompt. Each holds the model the router picked, token usage and cost, latency, and Jev's flags (as indices into the batch). |
| `results.tar.gz` | `ml/evaluate.ts` outputs. `re3-eval.json` is the final model with live Jev on the 20 held-out RCAEval cases. `re3-eval-live.json` and `re3-eval-dry.json` come from the earlier RE3-only model. `gaia-dry.json` and `gaia-dry-re3v3.json` are GAIA dry runs without Jev. `traces-re3/` holds every flag with its events, per case. |
| `distill.tar.gz` | The "train the classifier on Jev's decisions" experiment. `jev-labels-{train,valid}.csv` are 12,045 Jev verdicts with the feature vectors the classifier saw, collected by the GAIA-only model on RCAEval replays. `m0-*.json` are those runs. `eval-{gaia-only,m1}.json` compare the model before and after retraining, on held-out faults with live Jev. `fp-{train,held}.csv` and `m1-fp.*` are the split by fault used to measure stage-1 false positives. |
| `models.tar.gz` | Every trained model: `gaia-only` (M0), `m1`, the RE3-only versions `re3-v1..v3`, and LightGBM parity fixtures. The shipped model is `models/base.json` in the repository. |
| `re3-cases.json`, `gaia-cases.json` | Each case or day: split, fault or incident times, event and positive counts. |
| `*-features-meta.json` | Featurizer version, feature names, sampling shares and row counts of the training CSVs. |
| `streams.sha256`, `features.sha256` | Checksums of the converted event streams (1.2 GB) and training CSVs (0.7 GB). These aren't committed: `ml/datasets/*.py` and `ml/featurize.ts` rebuild them from the public downloads, and the checksums confirm the rebuild matches. |
| `logs/` | Console output of the conversion and evaluation runs. |

The GAIA live evaluation of Aug 12 and 13 was stopped before it finished. The Jev calls it made are in the cache, but there is no results file for it.
