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

- **RE3:** a line is "escalate" if it comes after the injection, reads like an error (error level or words, a failed span), and its template is clearly more frequent than before the injection: new, or more than 3 times its earlier rate. Errors that were already there before the fault stay "don't escalate". So does Sock Shop's constant stream of warnings.
- **GAIA:** a line is "escalate" if it falls inside an injected fault's window (start to end, plus 5 minutes), reads like an error, and its template is clearly more frequent than outside fault windows. Memory hogs, CPU hogs, file moves and permission-denied faults count as faults. The "QR code expired" login failures that GAIA simulates every few minutes count as normal behaviour.

The weak labels are used to train the classifier, and every number computed from them below is marked **weak**. They are heuristics, and an external review found real problems with them:

- GAIA's "clearly more frequent than outside fault windows" baseline is computed over all 14 days, eval days included.
- A GAIA event is matched to the first fault window that contains it, whatever the service. Nine incidents are hidden this way behind an overlapping one.
- RE3's 20 eval cases come from only 6 (system, service, fault) groups, so per-case numbers are not 20 independent results.

A human-labelled safety set (`benchmarks/safety-set/`) and re-annotated GAIA incidents will replace them as the acceptance test. Until then, read the results below as indications, not guarantees.

### Splits

| | Train | Valid | Eval |
| --- | --- | --- | --- |
| RE3 | 52 cases | 18 cases | 20 cases |
| GAIA | Aug 1–8 | Aug 9–10 | Aug 11–14 |

RE3 is split **by fault**: all repetitions of one (system, service, fault type) land in the same split, so the eval faults are ones the classifier never saw. GAIA is split **by time**, and the featurizer's history runs on from one day to the next, as it would in production.

Training rows: every positive, plus a weighted sample of negatives. That means 5% of plain lines for RE3, and 0.5% of plain lines and 10% of error-like lines for GAIA's 50M. The first 3 minutes of each stream are left out of training. The featurizer knows nothing yet at that point, and in these datasets those minutes are always healthy, which would teach the model that new means fine.

## Results

These results come from the run of 2026-10-26 (`benchmarks/2026-10-26/`), with the featurizer v1 model and the decider prompt of that date. Both have since changed (see "What changed after review" below), so they describe the earlier pipeline. They will be re-run under the new protocol.

**RE3, 20 held-out cases, live Jev** (`logs/re3-eval.log`):

| Strategy | Faults with a flag after injection | Median time to first flag | Flags | Flags before the fault | Share of events to Jev |
| --- | --- | --- | --- | --- | --- |
| cascade (classifier → Jev) | 20 of 20 | 22.6 s | 107 | 35 (in 8 cases) | 0.25% (3,173 of 1.27M) |
| classifier alone | 20 of 20 | 22.6 s | 161 | 1 | – |
| keyword rule (error words) | 20 of 20 | 22.3 s | 1,145 | 606 (in all 20) | – |

The cascade made 531 Jev calls for $1.55, with a median latency of 2.1 s per call.

Read the "faults with a flag" column with care: it credits **any** flag raised after the injection, even one about something unrelated to the fault. It shows the pipeline wasn't silent, not that it found the fault. Most of the 35 flags before the fault are about Sock Shop's real pre-existing problems (carts and front-end errors that run all the time), which the weak labels call normal.

**GAIA, Aug 11–14, without Jev** (`logs/gaia-dry.log`): on Aug 11, the cascade sent 0.15% of 3.4M events onward, and the classifier alone raised 2 flags, covering 2 of 26 incident windows (weak). The run crashed on Aug 12; the bug was fixed (`pendingIds()` in `ml/evaluate.ts`) but the run wasn't repeated. The live GAIA run was stopped early to save budget.

**Retraining on Jev's verdicts** is described in [Training](./training.md#what-retraining-does-to-stage-1-false-positives), with the same caveats.

**The shipped model** (`models/base.json`) has since been retrained on featurizer v2, on the same splits. On the eval split it sends 0.54% of events past the classifier and keeps 99.4% of the weakly labelled positives (average precision 0.956, weak). It hasn't been run with Jev yet.

### What changed after review

An external review of these results found problems that inflate them, all now fixed in the code:

- The features "time since this template / service was last seen" were always 0 (featurizer v1). Fixed in featurizer v2, which means models are retrained.
- Negative labels were taken from every event Jev didn't cite in a flag. Jev now judges every event it reads (relevant, benign or uncertain), and labels come only from those judgments.
- Cached "no" verdicts could hide a changed event: they were keyed by template only. They are now keyed by template and severity, are dropped when the template bursts, and never apply to audit, novel or known events.
- Training used the same held-out labels for early stopping, thresholds and the gate, and the gate allowed 2 points of slack. It is now a three-way split with a hard gate. See [Training](./training.md).

Still to do: a causal replay (verdicts take effect only when Jev answers), incident-level metrics (a fault counts as detected only by a flag that includes one of its events), re-annotated GAIA incidents, and leave-one-fault-group-out on RE3.
