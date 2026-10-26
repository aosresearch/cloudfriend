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

The weak labels are used to train the classifier. The headline results don't rely on them: an RE3 fault counts as detected if anything was escalated after the injection, and a GAIA escalation counts as false if it happened outside every fault window.

### Splits

| | Train | Valid | Eval |
| --- | --- | --- | --- |
| RE3 | 52 cases | 18 cases | 20 cases |
| GAIA | Aug 1–8 | Aug 9–10 | Aug 11–14 |

RE3 is split **by fault**: all repetitions of one (system, service, fault type) land in the same split, so the eval faults are ones the classifier never saw. GAIA is split **by time**, and the featurizer's history runs on from one day to the next, as it would in production.

Training rows: every positive, plus a weighted sample of negatives. That means 5% of plain lines for RE3, and 0.5% of plain lines and 10% of error-like lines for GAIA's 50M. The first 3 minutes of each stream are left out of training. The featurizer knows nothing yet at that point, and in these datasets those minutes are always healthy, which would teach the model that new means fine.

## Results

RESULTS_PLACEHOLDER
