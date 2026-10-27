# Benchmark run, 2026-10-26

> **Read with care.** These results come from the pipeline before an external review, which found problems in it: the featurizer v1 "time since last seen" features were always 0, negative labels were taken from every event Jev didn't cite, cached "no" verdicts ignored severity, and the escalated-kinds replay looked ahead. The code is fixed and the numbers will be re-run under the new protocol. See `docs/benchmarks.md` ("What changed after review") and `docs/training.md`. The recorded Jev replies here use the old reply format.

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
| `distill.tar.gz` | The "train the classifier on Jev's decisions" experiment. `jev-labels-{train,valid}.csv` are 12,045 Jev verdicts with the feature vectors the classifier saw, collected by the GAIA-only model on RCAEval replays. `m0-*.json` are those runs. `eval-{gaia-only,m1}.json` compare the model before and after retraining, on held-out faults with live Jev. `fp-{train,held}.csv` are the Jev labels split by fault: 10 faults to retrain on, 3 held out. `m1-fp.*` (recall target 98%) and `m1-fp995.*` (99.5%) are the models retrained on them. |
| `models.tar.gz` | Every trained model: `gaia-only` (M0), `m1`, the RE3-only versions `re3-v1..v3`, and LightGBM parity fixtures. The shipped model is `models/base.json` in the repository. |
| `re3-cases.json`, `gaia-cases.json` | Each case or day: split, fault or incident times, event and positive counts. |
| `*-features-meta.json` | Featurizer version, feature names, sampling shares and row counts of the training CSVs. |
| `*-features-v2-meta.json` | The same for featurizer v2, which the shipped `models/base.json` was retrained on after the review. |
| `streams.sha256`, `features.sha256` | Checksums of the converted event streams (1.2 GB) and training CSVs (0.7 GB). These aren't committed: `ml/datasets/*.py` and `ml/featurize.ts` rebuild them from the public downloads, and the checksums confirm the rebuild matches. |
| `logs/` | Console output of the conversion and evaluation runs. |

The GAIA live evaluation of Aug 12 and 13 was stopped before it finished. The Jev calls it made are in the cache, but there is no results file for it.

## Analysis

`analysis/` holds the scripts behind the "stage-1 false positives" and "what Jev said yes to keeps reaching Jev" results in `docs/training.md`, with their output in `results.txt`. Run them from the repository root, with `distill/` and `models/` unpacked into `data/` and the RE3 streams rebuilt in `data/prepared/re3`. They make no Jev calls, because Jev's recorded verdicts stand in for its answers.

- `stage1-false-positives.ts`: of the events the GAIA-only model sent to Jev and Jev rejected, on held-out faults, how many the retrained model still sends.
- `recall-target.ts`: the same at retraining recall targets of 98% and 99.5%, with and without the escalated-kind rule, on labelled events only.
- `escalated-kinds.ts`: full-stream replay. Later events of kinds Jev had escalated, and how many reach Jev with and without the rule. **Its "100%" result is withdrawn**: the replay protects a template as soon as any of its events is routed to Jev, before Jev has answered, and uses the recording's eventual positives. Both are lookahead. A causal replay will replace it.

`results.txt` also shows 68 of 74 Jev escalations still reaching Jev after retraining. All 65 that the old classifier had forwarded by score still are, and 3 more are recovered. The 6 lost ones had only reached Jev by the audit sample or the never-seen-error rule. The "stage-1 false positives" in it are events Jev didn't cite in a flag under the old reply format, which counts silence as "no", so some of them may not be real negatives.
