# ml/

Scripts that build, train and evaluate cloudfriend's classifier on public benchmark data, and record the website demo. The server doesn't need any of this at runtime except `train.py`, which retraining calls. See [docs/benchmarks.md](../docs/benchmarks.md) for what the data is, how it is labelled, and the results.

| File | |
| --- | --- |
| `datasets/re3.py` | RCAEval RE3 → event streams, one per case, with weak labels and a split by fault |
| `datasets/gaia.py` | GAIA MicroSS → event streams, one per day, with weak labels and a split by day |
| `featurize.ts` | streams → training CSVs, using the server's own featurizer |
| `train.py` | CSVs → LightGBM model (JSON for the server, `.lgb.txt` to continue from) and thresholds |
| `evaluate.ts` | replays streams through classifier → Jev, with baselines, and reports the benchmark numbers |
| `jev.ts` | Jev client for the scripts: cached on disk by prompt hash, with a budget |
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

## 4. Evaluate with Jev

```bash
export JEV_API_KEY=sk-or-...
node ml/evaluate.ts --data data/prepared/re3 --model models/base.json --split eval --jev --budget 5 --out data/results/re3-eval.json
node ml/evaluate.ts --data data/prepared/gaia --model models/base.json --split eval --jev --budget 10 --out data/results/gaia-eval.json
```

Without `--jev` the run is a dry run. It counts the Jev calls the cascade would make, and the cascade falls back to the classifier's own threshold. Jev replies are cached in `data/jev-cache`, so a rerun with the same model and data costs nothing.

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
