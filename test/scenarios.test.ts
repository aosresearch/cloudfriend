import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { Classifier, type ClassifierFile } from "../src/triage/classifier.ts";
import { BUILTIN_MODEL } from "../src/triage/runtime.ts";
import { BUILTIN_SCENARIOS, loadScenarios, runSuite } from "../src/triage/scenarios.ts";

const DAY = 86_400_000;
const production = { verdictTtlMs: 15 * 60_000, escalatedTtlMs: 7 * DAY, escalatedMemoryMs: 90 * DAY, suppressionTtlMs: 30 * DAY };
const shipped = () => new Classifier(JSON.parse(fs.readFileSync(BUILTIN_MODEL, "utf8")) as ClassifierFile);

describe("regression scenarios", () => {
  const scenarios = loadScenarios(BUILTIN_SCENARIOS);

  it("covers each must-catch situation, with and without a restart", () => {
    const names = scenarios.map((s) => s.name);
    for (const n of ["new-error", "benign-to-error", "isolated-to-sustained", "returning-after-expiry", "missed-escalation-reported"]) {
      assert.ok(names.includes(n), n);
      assert.ok(names.includes(`${n}-after-restart`), `${n}-after-restart`);
    }
  });

  it("passes every one through the complete pipeline with the shipped model", async () => {
    const r = await runSuite(scenarios, shipped(), { routing: production });
    assert.deepEqual(r.failures, [], JSON.stringify(r.failures, null, 1));
    assert.ok(r.must_reach >= 20);
  });

  it("passes with a model that drops everything by score: the rules carry these situations", async () => {
    const m = shipped();
    const dropAll = new Classifier({ ...m.file, drop_below: 1.01 });
    const r = await runSuite(scenarios, dropAll, { routing: production });
    assert.equal(r.passed, true, JSON.stringify(r.failures));
    assert.equal(r.reached_by_score, 0, "score alone reaches nothing: the diagnostic shows it");
  });

  it("fails when the rules are switched off, so it has teeth", async () => {
    const dropAll = new Classifier({ ...shipped().file, drop_below: 1.01 });
    const r = await runSuite(scenarios, dropAll, { routing: { verdictTtlMs: 15 * 60_000, escalatedTtlMs: 0, suppressionTtlMs: 0 }, novelGuard: false });
    const failed = new Set(r.failures.map((f) => f.scenario));
    for (const n of ["new-error", "benign-to-error", "isolated-to-sustained", "returning-after-expiry", "missed-escalation-reported"]) assert.ok(failed.has(n), n);
  });

  it("fails a returning problem when only the TTL protects it, not the memory", async () => {
    const dropAll = new Classifier({ ...shipped().file, drop_below: 1.01 });
    const only = scenarios.filter((s) => s.name.startsWith("returning-after-expiry-suppression-off"));
    const r = await runSuite(only, dropAll, { routing: { ...production, escalatedMemoryMs: 7 * DAY } });
    assert.equal(r.passed, false, "day 8 would be dropped without the review on expiry");
  });
});
