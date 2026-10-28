# Human review samples

Two samples for people to label. They answer questions no comparison between models, and no
weak label, can: is Jev itself right, and how often does stage 1 drop something that matters?
Made by `ml/review-samples.ts` from the 2026-10-27 runs (`benchmarks/2026-10-27/`). Neither
is used for training.

| File | Rows | What it measures |
| --- | --- | --- |
| `jev-audit.csv` | 200 of Jev's 12,430 judgments, stratified by its answer: 82 relevant, 82 benign, 36 uncertain, one per distinct message | Jev's own accuracy: the **dismissed** failure rate (Jev saw it and said no) and its false alarms. The `jev` column shows its answer, since checking it is the point. |
| `drops.csv` | 300 events, sampled uniformly from what the shipped classifier dropped on the held-out cases (and the Jev-trained alternative would also drop) | The **withheld** failure rate on representative traffic: how often a dropped event mattered. Scores and weak labels are left out so they don't steer you. |

## How to label

Fill in `label` with one of:

- `relevant`: a person or an agent on call should know about this event, as a problem or a symptom of one.
- `benign`: dropping or ignoring it is fine.
- `unsure`: you can't tell from what is shown.

Use `notes` for anything that would help someone else decide, or when two of you disagree.

## What the numbers will mean

With `k` relevant events among `n` labelled drops, the share of drops that matter is at most `upperBound(k, n)` at 95% (`src/stats.ts`). For 0 of 300, that is 1.0%. Multiplied by how much the classifier drops, it gives the expected number of withheld events, and that should be judged against the cost of sending them to Jev. In the Jev audit, the share of `benign` answers you label `relevant` is Jev's miss rate, with the same bound. Those are the misses that the stage-1 safeguards can't fix.

For context, on the weak labels: of the 213 judged events the datasets call incident events, Jev called 194 relevant and 19 benign. Of the 12,217 others it called 1,320 relevant, most of them errors that were already happening before the fault. These are weak labels, so this doesn't say who is right, which is what this sample is for.
