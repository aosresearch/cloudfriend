# Round 4, 2026-10-27

**Candidate A is rejected on the reviewed dev must-reach set. The holdout has not been run.**

- Credential and payment-data exposures count inside the 100% must-reach gate. They are not set aside as an exception.
- The cautious oracle is primary; the weak-label oracle is a sensitivity check.
- `models/base.json` and the website demo are unchanged.
- The retained baseline also fails this gate, and is not newly certified.

No live Jev calls were made in round 4. Every replay ran offline with dummy API keys under `ml/no-network.ts`, which recorded zero network attempts. Review labels are assistant-reviewed references, not human gold.

## Corrections

- **Timestamp milliseconds were read as HTTP statuses.** A comma-separated fraction such as `15:27:27,500` counted as a 500.
  - With corrected labels, the GAIA dev days keep 45 detectable incidents instead of 102.
  - Of the 358 incidents whose labels changed, 197 were artefacts and 161 had real symptoms.
  - RE3's labelled events changed from 121,437 to 121,272.
- **All eight round-3 GAIA "withheld" incidents were artefacts.** The old explanation, that they were memory hogs barely visible in the logs, is withdrawn.
- **RE3 live acceptance detected 4 of 6 incidents through Jev, not 6 of 6.**
  - One incident was unanswered; another was dismissed. Both had classifier fallback alerts.
  - Three GAIA incidents previously called dismissed were unanswered.
- **The recorded acceptance and demo runs replay exactly** (`replay-check.json`), with the same routes and alerts.
- **Direct-answer evidence covers 13,786 events.** 14,447 prompt events were matched to source events, two of them ambiguously. Followers, uncertain answers and missing answers are not authoritative training labels.
- **The blind review covers 845 packets (909 events).** Two independent reviewers agreed on 832 packets, and a third adjudicated the other 13. See [review-protocol.md](review-protocol.md).

## Dev gate decision

The arms:
- **Baseline:** the shipped v2 model.
- **A:** corrected v3 features and weak labels.
- **B:** the same features, with the weak labels at weight 0.3 plus 4,182 direct Jev judgments at weight 1.

Neither candidate is shipped.

The cautious-oracle replay disables random audit. The data:
- **GAIA:** Aug 11–14, using each day's incident windows padded by 30 minutes, plus six sampled quiet hours.
- **RE3:** the 20 dev cases.

These are dev comparisons, not untouched holdout results. In the table, *reached* counts any route to Jev: shown in a prompt, grouped behind a shown example, or attached to an existing alert.

| Dataset / arm | Must-reach reached / encountered | Missed | Unobserved | Events sent | Detected / detectable incidents (weak) |
| --- | --- | --- | --- | --- | --- |
| GAIA baseline | 60/87 | 27 | 1 | 16,322 | 44/45 |
| GAIA A | 41/87 | 46 | 1 | 7,717 | 44/45 |
| GAIA B | 41/87 | 46 | 1 | 7,615 | 44/45 |
| RE3 baseline | 102/114 | 12 | 0 | 9,106 | 20/20 |
| RE3 A | 96/114 | 18 | 0 | 8,602 | 20/20 |
| RE3 B | 97/114 | 17 | 0 | 11,365 | 20/20 |

**A misses 64 encountered must-reach events, and one more is unobserved.**
- By `ml/dev-gate-report.ts`'s exposure pattern, the 64 are 56 exposures and 8 other symptoms. The split depends on the pattern; the gate counts all of them.
- Compared with the baseline, A newly misses 25 events: 23 exposures and two `nullUSER TOKEN` symptoms.
- The handoff's "two more reviewed events" left exposures out. It is not the credential-inclusive release count.

A cuts GAIA decider workload by 52.72% and RE3 by 5.53%, but the savings can't override the safety failure. The baseline leaves 40 events not reached (39 missed, 1 unobserved). It is retained without claiming that it passes.

**Requested events.** The dev set contains 202 unique ids: 200 relevant events and two conservative unknowns. The replays encountered 201. `gaia-2021-08-11:2119600` (packet `p0674`) falls outside the selected GAIA windows, so it is unobserved, not passed.

**How the reached events got to Jev:**

| Arm | GAIA: shown / attached | RE3: shown / attached / follower |
| --- | --- | --- |
| Baseline | 45 / 15 | 68 / 34 / 0 |
| A | 26 / 15 | 61 / 34 / 1 |

A fails even under the broad definition of reached.

**Incidents.** Every cautious arm withholds the same single GAIA incident, `gaia-2021-08-14:inc360-memory-dbservice1`, and none in RE3.

Weak-oracle sensitivity results:

| Dataset / arm | Must-reach reached / encountered | Events sent | Detected / detectable incidents (weak) |
| --- | --- | --- | --- |
| GAIA baseline | 48/87 | 12,686 | 42/45 |
| GAIA A | 27/87 | 4,539 | 42/45 |
| GAIA B | 28/87 | 3,842 | 42/45 |
| RE3 baseline | 86/114 | 9,441 | 20/20 |
| RE3 A | 82/114 | 9,136 | 20/20 |
| RE3 B | 75/114 | 11,913 | 20/20 |

Equal aggregate incident counts don't mean identical misses. Under the weak oracle, compared with the baseline:
- A newly withholds `gaia-2021-08-14:inc377-memory-mobservice2`;
- B newly withholds `gaia-2021-08-13:inc343-cpu-mobservice2`.

This sensitivity check doesn't change the primary cautious-oracle rejection.

`dev-gate-report.json`, generated by `ml/dev-gate-report.ts`, records the reproducible dev decision and keeps known failures apart from unperformed holdout gates. A dedicated redaction rule or exposure-routing guard remains follow-up work; exposures stay in the gate.

## Other dev evidence

- **Leave one fault group out, candidate A** (`lofo-A.tar.gz`): 0 of 90 incidents withheld across all 28 RE3 fault groups (95% bound 3.3%; by group 0 of 28, bound 10.1%). 0.87% of events went to Jev. Each fold fits only on fit-role cases and calibrates only on calibration-role cases of the other groups.
- **Regression scenarios** (`regression.json`, rerun): all three arms pass, with 39 of 39 must-reach events. By score alone, the baseline and A reach 37 and B reaches 35.

Neither changes the decision: the reviewed must-reach set is the gate.

## Artifacts

| File | Contents |
| --- | --- |
| `roles.json` | Fit, calibrate, dev and holdout case roles, committed before tuning. |
| `raw.sha256` | Raw input hashes and public dataset sources. Hashes alone are not the data. |
| `inputs.sha256` | Hashes of the corrected prepared streams and v3 feature files (about 3 GB, not in git), with the commands that rebuild them from the raw files. |
| `trace.json.gz` | Changed GAIA labels, and the source lines behind the artefact diagnosis. |
| `rekey.json` | Migration of the recorded-call cache to the expanded identity. |
| `replay-check.json` | Historical offline acceptance and demo replay parity, and the corrected Jev attribution. |
| `evidence.tar.gz` | Direct-answer evidence, shown-event matching, summary, and candidate B's Jev rows. |
| `review.tar.gz` | Blind packets, packet index, independent reviews and adjudication. |
| `references.csv` | Merged assistant-reviewed labels and provenance, one row per event. |
| `review-protocol.md`, `review-report.json` | Review instructions, and agreement and disagreement accounting. |
| `models.tar.gz` | Candidates A and B (LightGBM JSON and text), training logs, and `models.json` with sha256s, exact commands, tool versions and the combine counts. |
| `dev-results.tar.gz` | The twelve dataset/arm/oracle result JSONs, with model hashes and per-event must-reach detail, and the 202 requested ids. |
| `dev-gate-report.json` | The credential-inclusive dev rejection. Not a holdout pass. |
| `lofo-A.tar.gz` | Candidate A's complete leave-one-group-out: summary, per-fold results and logs, and fold-model hashes. |
| `regression.json` | The regression rerun for all three arms, with model hashes. |

To inspect the archived dev results without retraining or contacting an inference service:

```bash
mkdir -p data/r4
tar -xzf benchmarks/2026-10-27-r4/dev-results.tar.gz -C data/r4
JEV_API_KEY=fake-offline-key OPENROUTER_API_KEY=fake-offline-key \
  node --import ./ml/no-network.ts ml/dev-gate-report.ts \
  --results data/r4/dev --references benchmarks/2026-10-27-r4/references.csv \
  --roles benchmarks/2026-10-27-r4/roles.json \
  --out benchmarks/2026-10-27-r4/dev-gate-report.json
```

The report command only audits saved results; it doesn't repeat the replays. Its output is deterministic and lists the sha256 of every input. Each result records the sha256 of the model it ran: the baseline is `7adaec2b…` (`models/base.json`), and the candidates match `models.tar.gz`. The report can't approve a release even if every dev check passes.

The archives and references contain public benchmark logs with credential-like values. Don't copy those values into reports; refer to event ids and categories instead.

## Unperformed holdout work

The GAIA holdout is Aug 15–21. In practice it is Aug 16–21: Aug 15 has no business logs in the source (0 events in `prepared/gaia21`), and Aug 16 is partial.

Candidate A already fails the dev prerequisite, and a later holdout result wouldn't erase that failure. Any future candidate must clear the dev gate first. After that, the run goes like this:

1. **Freeze.**
   - Freeze the unchanged candidate and the baseline with `ml/holdout.ts freeze`, which records every setting in `HOLDOUT_SETTINGS` (cautious oracle, audit off). Commit the freeze.
   - A weak-oracle sensitivity run needs its own freeze, committed before the holdout is inspected.
   - Record Aug 15's verified absence at freeze time with `--unavailable-case gaia-2021-08-15=<source evidence>`. This isn't a way to skip a difficult day: a case recorded as absent that turns up in the data fails the run.
2. **Run** `ml/holdout.ts run`, which works offline.
   - It refuses without committed, unchanged roles and freeze and a complete settings freeze. It also refuses if any holdout case the freeze didn't record as absent is missing.
   - It bounds arm concurrency (`--concurrency`, default 1).
   - `--safety <ids>` adds a must-reach report without changing the frozen settings. That report lists unobserved requested ids, and separates direct prompt visibility from grouped followers and alert attachment.
3. **Review** the first symptoms of every incident, and 300 sampled drops, with the same independent blind protocol. Before accepting a review, check that the generated packet index covers every requested event id.
4. **Gate.** Test every reviewed must-reach event (exposures included), reviewed-positive recall of at least 99.5%, no newly withheld incident against the baseline, and a real improvement.
   - Missing or unobserved ids can't pass.
   - Sampled-drop false-omission rates are not reviewed-positive recall.
   - Join the final references to the evaluator's complete safety outcomes. `review-report.ts` alone is not a release-gate evaluator.

No freeze, holdout replay or holdout review exists for round 4.
