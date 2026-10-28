---
title: Benchmarks
---

# Benchmarks

cloudfriend's built-in classifier is trained on, and the whole pipeline is tested against, two public datasets of real logs from microservice systems with injected faults. Each answers different questions:

| Dataset | What it is | What it measures |
| --- | --- | --- |
| [RCAEval RE3](https://github.com/phamquiluan/RCAEval) (90 cases, 534 MB, MIT) | Code-level faults injected into Online Boutique, Sock Shop and Train Ticket. Each case is about 12 minutes of normal operation, the injection, then about 12 minutes with the fault. Logs for all three systems, traces for Online Boutique and Train Ticket. | Was the fault escalated? How fast? How much of the stream reached Jev? |
| [GAIA MicroSS](https://github.com/CloudWise-OpenSource/GAIA-DataSet) (two weeks, about 50M log lines) | A QR-code login system in normal operation, with faults injected now and then. Every injection is logged with a timestamp. User ids appear in log lines and trace URLs. | How many escalations per day happen when nothing is wrong? Can events be linked across sources by user? |

Everything here can be reproduced with the scripts in `ml/` (see `ml/README.md`). The numbers below come from those scripts, with live Jev calls through OpenRouter.

## From datasets to events

Each case, or each GAIA day, becomes a stream of events in time order. Each event is exactly what a sender would `POST /in/<source>`:

- **RE3:** every log line (`{container_name, pod_name, node_name, timestamp, message}`, source `logs`), plus every failed trace span for Online Boutique (`{service, operation, status_code, duration_us, trace_id, message}`, source `traces`). Train Ticket's spans carry no status.
- **GAIA:** the services' application logs (`{service, message}`, source `business`, about 3.5M lines a day), and the system logs (source `run`) with the fault-injection records removed, since they would give the answer away. The two weeks are 2021-08-01 to 2021-08-14.

### Labels

The datasets say when a fault was injected, not which log lines matter, so each event gets a **weak label**:

- **RE3:** a line is an incident event if it comes after the injection, reads like an error (error level or words, a failed span), and its template is clearly more frequent than before the injection: new, or more than 3 times its earlier rate. Errors that were already there before the fault are not. Neither is Sock Shop's constant stream of warnings.
- **GAIA:** a line is an incident event if it falls inside an injected fault's window (start to end, plus 5 minutes), reads like an error, and its template is clearly more frequent than at baseline. Memory hogs, CPU hogs, file moves and permission-denied faults count as faults. The "QR code expired" login failures that GAIA simulates every few minutes count as normal behaviour.

The weak labels train the built-in classifier, and every number computed from them below is marked **weak**: they are heuristics. An external review found three problems, now fixed or accounted for:

- GAIA's baseline was computed over all 14 days, eval days included. It now uses the train days (Aug 1–8) only.
- A GAIA event was matched to the first fault window containing it, whatever the service, which hid overlapping incidents. Now an event belongs to every window it falls in, and each incident is evaluated on its own. 98 of the 385 incidents start inside another's window; 370 have at least one labelled event.
- RE3's 20 eval cases come from only 6 (system, service, fault) groups, so per-case numbers are not 20 independent results. Results are now reported per incident with bounds, bootstrapped by fault group, and also leaving each of the 28 fault groups out in turn.

### Splits

| | Train | Valid | Eval |
| --- | --- | --- | --- |
| RE3 | 52 cases | 18 cases | 20 cases |
| GAIA | Aug 1–8 | Aug 9–10 | Aug 11–14 |

RE3 is split **by fault**: all repetitions of one (system, service, fault type) land in the same split, so the eval faults are ones the classifier never saw. GAIA is split **by time**, and the featurizer's history runs on from one day to the next, as it would in production.

Training rows: every positive, plus a weighted sample of negatives. That means 5% of plain lines for RE3, and 0.5% of plain lines and 10% of error-like lines for GAIA's 50M. The first 3 minutes of each stream are left out of training. The featurizer knows nothing yet at that point, and in these datasets those minutes are always healthy, which would teach the model that new means fine.

## Results

Everything here comes from the run of 2026-10-27 (`benchmarks/2026-10-27/`). Earlier results are at the end, for the record.

### How it is measured

Each case is replayed through `ml/evaluate.ts` exactly as the server would run it (`src/triage/sim.ts`): the same featurizer, classifier, routing rules, verdict cache and batching. A batch goes to Jev when the server would send it, and Jev's answer takes effect only after the call's recorded latency, so nothing in the replay knows the future. Results are per incident (an RE3 fault, or a GAIA incident), and two failures are kept apart:

- **withheld:** no event of the incident reached Jev. This is stage 1's miss.
- **dismissed:** its events reached Jev, but no alert containing one followed. This is Jev's miss.
- **detected:** an alert containing one of its events. Time to detect runs from the injection to that alert.

Every rate comes with an exact one-sided 95% upper bound, because the samples are small. Zero misses in 20 incidents still allows up to 14%.

Live Jev costs money (about $0.005 a call, more when the router picks a large model), so most runs use an **oracle** decider instead: it answers from the weak labels, with a 3-second latency. That measures stage 1 and the routing rules for free. Live runs cover a subset.

### Stage 1: how often is an incident withheld?

The shipped model, with the oracle decider:

| Evaluation | Incidents | Withheld | 95% bound | Jev read | Median time to detect |
| --- | --- | --- | --- | --- | --- |
| RE3, 20 held-out cases | 20 | 0 | 14% | 0.91% of 1.27M events | 27 s |
| RE3, leave one fault group out (28 models, 84 cases) | 90 | 0 | 3.3% (by group: 0 of 28, 10%) | 0.84% | |
| GAIA, Aug 11 and 13, incident windows plus 6 quiet hours | 47 | 8 | 29% | 0.34% | 125 s |

All of these are weak. On GAIA, all 8 withheld incidents left only one to three labelled events: memory hogs that barely show in the logs. Of the 30 incidents with four or more, none was withheld (bound 9.5%). Event by event, the cascade sent 99.6% of RE3's labelled incident events to Jev, and 98.4% of GAIA's.

**Earned suppression costs Jev calls in short replays.** Compared with the previous built-in model (same features), with it off (the old behaviour) Jev read 0.36% of RE3's events instead of 0.91%, and both withheld no incident. In each 25-minute RE3 case, every kind of message is new and gets its first look. On GAIA, which warms up on the day before, the cost was the same either way (0.37% and 0.38%), and so was the miss rate (8 and 9 of 47). With earned suppression on, fewer incident events went unseen on RE3: 84 against 155.

**The rule that a kind Jev escalated keeps reaching it does a lot of the work.** In the live RE3 run, 47,202 later events were of a kind Jev had escalated; the classifier's score alone would have sent 8,246 of them (17%).

### With live Jev

| Run | Incidents with Jev answering | Detected | Withheld | Dismissed | Median time to detect | Jev |
| --- | --- | --- | --- | --- | --- | --- |
| RE3, one repetition of each of the 6 held-out fault groups | 6 | 6 | 0 | 0 | 30 s (first event at Jev: 25 s) | 416 calls, $4.04 |
| GAIA Aug 13, four incident windows | 4 | 4 | 0 | 0 | 13 s to 520 s | 687 calls, $2.50 |

These are small samples: 6 of 6 detected is consistent with a detection rate as low as 61%, at 95%. The budget ran out during both runs. On RE3, three cases were fully answered and three partly, and the classifier's fallback took over for the rest. On GAIA, the four incidents after 09:04 had no Jev answers and aren't counted. Of 97 RE3 alerts, 83 contain no labelled incident event, 80 of them raised before the fault. Most are Sock Shop's real, pre-existing errors, which Jev judges relevant and the weak labels don't.

**Jev against the weak labels**, over its 12,430 judgments in these runs: of the 213 events the labels call incident events, Jev judged 194 relevant and 19 benign; of the others, it judged 1,320 relevant. That is a disagreement, not an accuracy figure. `benchmarks/review/` holds a stratified sample of Jev's judgments and a uniform sample of drops for people to label, which can settle it.

### Training on Jev's labels

Jev relabelled 4 RE3 train cases ($5.35, 10,434 labels; the budget allowed no more). A built-in model trained on the weak labels plus these, with the weak labels down-weighted to 0.3, moved toward Jev's view: on the held-out weak labels it caught 93.4% of incident events by score (against 98.6%) while sending 0.27% of events onward (against 0.34%). Replayed with the oracle decider, it sent more to Jev on RE3 (1.08% against 0.91%) and withheld 10 GAIA incidents against 8. It is not shipped. The weak labels judge it, and they disagree with Jev by design; the human-labelled samples are what can decide between them.

### Regression scenarios

The 13 built-in scenarios (`regression/`, see [Training](./training.md#regression-scenarios)) pass with the shipped model: 39 of 39 must-reach events reach Jev, 37 of them by score alone.

### Earlier results (2026-10-26)

These came from the pipeline before the review: featurizer v1, labels from silence, a template-only verdict cache, and a replay that applied Jev's answers at once. They are kept for the record (`benchmarks/2026-10-26/`).

On the 20 held-out RE3 cases with live Jev, the cascade sent 0.25% of 1.27M events to Jev ($1.55 in 531 calls). It raised a flag after the injection in all 20, with a median of 23 seconds, and 35 flags before the fault. That metric credited any flag after the injection, related or not. The classifier alone raised 161 flags; a keyword rule raised 1,145, 606 of them before the fault.
