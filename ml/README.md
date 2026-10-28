# ml/

Scripts that build, train and evaluate cloudfriend's classifier on public benchmark data, and record the website demo. The server doesn't need any of this at runtime except `train.py`, which retraining calls. See [docs/benchmarks.md](../docs/benchmarks.md) for what the data is, how it is labelled, and the results.

| File | |
| --- | --- |
| `datasets/re3.py` | RCAEval RE3 → event streams, one per case, with weak labels and a split by fault |
| `datasets/gaia.py` | GAIA MicroSS → event streams, one per day, with weak labels and a split by day |
| `featurize.ts` | streams → training CSVs, using the server's own featurizer |
| `train.py` | CSVs → LightGBM model (JSON for the server, `.lgb.txt` to continue from) and thresholds |
| `evaluate.ts` | replays streams through the cascade as the server runs it (`src/triage/sim.ts`), with baselines, and reports per-incident results with bounds |
| `lofo.ts` | leave one RE3 fault group out: one model per group, replayed on that group |
| `review-samples.ts` | turns `evaluate.ts --samples-out` into CSVs for people to label: an audit of Jev's judgments, and a sample of drops |
| `jev.ts` | Jev client for the scripts: offline by default (recorded calls only, keyed by everything that shapes the answer); live calls need `--live` and a budget |
| `no-network.ts` | `node --import` preload that blocks every request and counts attempts, for offline runs |
| `rekey-cache.ts` | moves recorded calls from the round-3 cache key to the current one, verifying each |
| `evidence.ts` | rebuilds Jev's direct judgments, per event id, from the recorded calls |
| `review-packets.ts`, `references.py`, `review-report.ts`, `jev-labels.py` | blind review packets, merging two reviewers and an adjudicator into references, comparing them with Jev and the weak labels, and Jev's labels for training |
| `trace-incidents.py` | traces GAIA incidents through the weak labels before and after the parsing fix |
| `combine.py` | weak-label CSVs plus Jev's labels (replacing weak rows by id, fit cases only) |
| `roles.ts`, `holdout.ts` | data roles, and the frozen holdout run (freeze, commit, then run) |
| `dev-gate-report.ts` | the dev must-reach gate over saved replays: every reviewed event, exposures included; never approves a release |
| `replay.ts` | streams a case into a running cloudfriend over HTTP |
| `export-demo.ts` | records replays for cloudfriend.dev/demo |
| `safety-candidates.ts` | picks events from the held-out data for the human-labelled safety set (`benchmarks/safety-set/`) |

Everything below writes under `data/` (git-ignored). You need Node 22.18+, Python 3.11+ with `lightgbm numpy pandas`, and about 15 GB of disk for GAIA.

## 1. Get the data

```bash
mkdir -p data/raw/rcaeval data/raw/gaia
# RCAEval RE3: 3 zips, 534 MB (https://zenodo.org/records/14590730, MIT)
for s in OB SS TT; do
  curl -L -o data/raw/rcaeval/RE3-$s.zip "https://zenodo.org/records/14590730/files/RE3-$s.zip?download=1"
  unzip -q -d data/raw/rcaeval data/raw/rcaeval/RE3-$s.zip
done
# GAIA MicroSS: the business logs (split zip, 2.2 GB) and run logs
GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 https://github.com/CloudWise-OpenSource/GAIA-DataSet data/raw/gaia/repo
(cd data/raw/gaia/repo/MicroSS/business && cat business_split.z{01..45} business_split.zip > ../../../business.zip)
unzip -q -d data/raw/gaia data/raw/gaia/repo/MicroSS/run/run.zip
```

## 2. Convert to event streams

```bash
python3 ml/datasets/re3.py --raw data/raw/rcaeval --out data/prepared/re3
unzip -p data/raw/gaia/business.zip business/business_table_2021-08.csv 2>/dev/null | \
  python3 ml/datasets/gaia.py --run data/raw/gaia/run/run_table_2021-08.csv --start 2021-08-01 --days 14 --out data/prepared/gaia
```

`unzip` warns that the archive is a concatenated multi-part zip; the data streams fine. GAIA takes about 45 minutes.

## 3. Featurize and train

```bash
node ml/featurize.ts --data data/prepared/re3 --data data/prepared/gaia:0.005:0.1 --out data/features --keep 0.05
python3 ml/train.py --train data/features/train.csv --valid data/features/valid.csv --eval data/features/eval.csv \
  --featurizer-version 2 --recall 0.995 \
  --exclude '^(tok_|svc_new$|svc_count$|svc_age$|svc_templates$|all_m1$|all_h1$)' \
  --out models/base.json --parity test/fixtures/parity.json --note "RCAEval RE3 + GAIA MicroSS"
```

`--exclude` leaves out features that only describe the benchmark systems: hashed words, and how long or how busily a service has been watched. `--parity` writes rows with LightGBM's own scores, which `npm test` checks the TypeScript evaluator against. Keep only the first 60 rows to keep the fixture small.

## 4. Evaluate

```bash
# Free: the decider answers from the weak labels (3 s latency), so suppression can still be earned.
node ml/evaluate.ts --data data/prepared/re3 --model models/base.json --split eval --decider oracle --out data/results/re3-oracle.json
# Leave one fault group out (one model per group; about an hour).
node ml/lofo.ts --features data/features-v2 --data data/prepared/re3 --out data/results/lofo
# With Jev.
export JEV_API_KEY=sk-or-...
node ml/evaluate.ts --data data/prepared/re3 --model models/base.json --split eval --cases '-1$' --jev --budget 3 \
  --batch-size 15 --samples-out data/results/samples --out data/results/re3-eval.json
node ml/evaluate.ts --data data/prepared/gaia --model models/base.json --split eval --cases 'gaia-2021-08-13' --windows 30m:6 \
  --jev --budget 3 --batch-size 15 --out data/results/gaia-eval.json
node ml/review-samples.ts --in data/results/samples --out benchmarks/review
```

Each case is replayed causally: a batch goes to Jev when the server would send it, and the answer takes effect only after the call's recorded latency. Results are per incident: **withheld** (no event of it reached Jev), **dismissed** (its events reached Jev, no alert followed), **detected** (an alert containing one of its events), with exact one-sided bounds and a bootstrap over fault groups. Incident events are the datasets' weak labels, so all of these are weak.

`--batch-size 15` keeps prompts small: the Jev router picks a larger, pricier model for long prompts (about $0.002 an event against $0.0005). `--windows 30m:6` replays only GAIA's incident windows, padded by 30 minutes, plus 6 random quiet hours. Without `--jev` and without the oracle, Jev is unavailable, nothing earns suppression, and almost everything is counted as going to Jev. Jev replies are cached in `--cache` by prompt hash, so a rerun with the same model, data and settings costs nothing.

## 5. Build the safety-set candidates

```bash
node ml/safety-candidates.ts --data data/prepared/re3 --data data/prepared/gaia --model models/base.json --out benchmarks/safety-set
```

It replays the eval split through the model, makes no Jev calls, and writes about 300 events for people to label. `benchmarks/safety-set/README.md` says how. Re-run it whenever the featurizer version changes, since it also stores each candidate's feature vector.

## 6. Try the loop against a real server

```bash
CLOUDFRIEND_DATA_DIR=/tmp/cf CLOUDFRIEND_ADMIN_KEY=admin JEV_API_KEY=sk-or-... npm start   # prints an ingest secret
node ml/replay.ts --secret cloudfriend_... --data data/prepared/re3 --case re3-ob-cartservice_f1-1
curl -H "Authorization: Bearer admin" localhost:8080/queue
curl -X POST -H "Authorization: Bearer admin" localhost:8080/flags/<id>/feedback -d '{"verdict":"confirmed"}'
CLOUDFRIEND_DATA_DIR=/tmp/cf npm run cloudfriend -- train
```

## 7. Record the demo

```bash
node ml/export-demo.ts --model models/base.json --cache data/jev-cache --out ../cloudfriend-website/public/demo \
  --scenario boutique-ads:data/prepared/re3:re3-ob-adservice_f5-1 \
  --scenario trainticket-auth:data/prepared/re3:re3-tt-ts-auth-service_f3-1 \
  --scenario sockshop-carts:data/prepared/re3:re3-ss-carts_f4-1 \
  --scenario gaia-quiet:data/prepared/gaia:gaia-2021-08-12@14:00-15:00
npm run demo:sync -- ../cloudfriend-website   # copies the model and src/triage/{features,gbdt,classifier}.ts
```
