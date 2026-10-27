# Safety set

Events a classifier is likely to get wrong, for people to label. They are never used for training, so what they measure stays honest. Once labelled:

- `ml/evaluate.ts --safety benchmarks/safety-set` replays each case through the full cascade (classifier, routing rules, verdict cache, batching) and reports which `must_reach` events reached Jev, in the context they really arrived in.
- The trainer, given `CLOUDFRIEND_SAFETY_SET`, reports how many `must_reach` events a candidate's score alone would send to Jev. That is a diagnostic: the routing rules decide too, and the hard must-catch check is the regression scenarios (`regression/`, see `docs/training.md`).

`ml/safety-candidates.ts` picked the rows from the **eval split** of the benchmarks (20 held-out RCAEval RE3 cases and GAIA Aug 11–14). It made no Jev calls and used no model output except to find dropped events. The labels from the datasets were not used to decide anything except the `rare_symptom` and `dropped_positive` strata, and they are not shown.

## Files

| File | |
| --- | --- |
| `candidates.csv` | One row per event. Fill in `label` and, if useful, `notes`. |
| `candidates.features.csv` | Each event's feature vector at the moment it arrived (featurizer v2), for the trainer. Don't edit it. Regenerate it with the script if the featurizer version changes; the ids stay the same. |

## Strata

| Stratum | What it is | Why a classifier gets it wrong |
| --- | --- | --- |
| `transition` | The first error-like event of a template that, before the fault, had been seen at least 20 times and never as an error. | The template looks familiar and harmless. |
| `single_event` | The first error-like event of a template seen at most twice in the whole case. | Too rare to have rates or history. |
| `rare_incident` | GAIA: an error-like event from the affected service during an incident of a rare kind (CPU, file move, permission denied). | Few training examples of the kind. |
| `rare_symptom` | RE3: the first event of a template that the dataset's weak label marks as a symptom at most 10 times in the case. | Few examples, easy to miss. |
| `persistent` | An error-like event during the fault, of a template that already produced at least 5 errors before it. | It may be the same old noise, or the old problem getting worse. People disagree here, which is the point. |
| `dropped_positive` | An event the weak label calls a symptom, but the built-in model drops. | Exactly the miss the gate must catch, if it is real. |
| `dropped` | A uniform sample of the events the built-in model drops. | Checks that drops are mostly right; a `must_reach` here is a real miss. |

Each template appears once, in the first stratum of the table that has it. The rows are spread evenly over cases.

## How to label

Read `message`, `service` and `context`. The `context` column says where the event sits relative to the fault: for RE3, the faulty service, the fault and seconds since injection; for GAIA, the incidents in progress. Then put one of these in `label`:

- `must_reach`: a person on call should see this event, or the classifier must pass it to Jev so Jev can decide. Missing it could hide an incident or delay a response.
- `benign`: dropping it is fine.
- `unsure`: you can't tell from what is shown.

Ask "would I want Jev to look at this?", not "is this the root cause?". A symptom of the fault, in any service, is `must_reach`. A routine line that happens to fall inside the fault window is `benign`. When two people disagree, use `unsure` and say why in `notes`.

Only `must_reach` rows are checked. `benign` and `unsure` rows are kept so the set can later measure false positives and agreement too.

## Rebuilding

```bash
node ml/safety-candidates.ts --data data/prepared/re3 --data data/prepared/gaia --model models/base.json --out benchmarks/safety-set
```

Regenerating overwrites `candidates.csv`, labels included. Labelled rows keep their ids (`<case>:<event index>`), so labels can be merged back by id.
