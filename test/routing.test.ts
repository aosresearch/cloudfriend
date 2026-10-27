import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyVerdicts, planBatch, verdictKey, type Pending, type RouteOptions } from "../src/triage/cascade.ts";
import { EscalationMemory, RoutingState, SuppressionLedger, type LabelFact } from "../src/triage/routing.ts";

const DAY = 86_400_000;
const LOW: RouteOptions = { dropBelow: 0.5, escalateAbove: 2, threshold: 0.9, hasJev: true, auditRate: 0 };
const state = () => new RoutingState({ verdictTtlMs: 60_000, escalatedTtlMs: 7 * DAY, escalatedMemoryMs: 90 * DAY, suppressionTtlMs: 30 * DAY });
const facts = (template: string, more: Partial<{ severity: string; novel: boolean; rate: number; serviceErrors: number }> = {}) => ({
  template,
  severity: "i",
  novel: false,
  rate: 1,
  serviceErrors: 0,
  ...more,
});

/** Run one batch through planBatch/applyVerdicts with the given judgments, as the worker does. */
function judge(s: RoutingState, items: Pending[], relevance: (p: Pending) => "relevant" | "benign" | "uncertain", now: number) {
  const plan = planBatch(items, s.cache, now);
  const out = applyVerdicts(plan, { flags: [], judgments: plan.ask.map(({ item }) => ({ event_id: item.id, relevance: relevance(item) })) });
  s.learn(items, out, now, []);
  return out;
}

describe("earned suppression", () => {
  it("lets the classifier drop a kind only after it was judged benign", () => {
    const s = state();
    assert.equal(s.route(0.01, LOW, facts("web|GET /"), 0), "review", "never judged: Jev sees it");
    judge(s, [{ id: "1", template: "web|GET /", severity: "i", score: 0.01, route: "review", rate: 1 }], () => "benign", 1000);
    assert.equal(s.route(0.01, LOW, facts("web|GET /"), 2000), "drop");
    assert.equal(s.route(0.9, LOW, facts("web|GET /"), 2000), "jev", "a high score still goes to Jev");
  });

  it("is not earned by silence, an uncertain answer, or another severity", () => {
    const s = state();
    const item: Pending = { id: "1", template: "db|slow query", severity: "w", score: 0.01, route: "review", rate: 1 };
    judge(s, [item], () => "uncertain", 0);
    assert.equal(s.route(0.01, LOW, facts("db|slow query", { severity: "w" }), 1000), "review");
    s.learn([item], applyVerdicts(planBatch([item], s.cache, 0), { flags: [] }), 0, []);
    assert.equal(s.route(0.01, LOW, facts("db|slow query", { severity: "w" }), 1000), "review", "a v0 reply judges nothing");
    judge(s, [{ ...item, id: "2" }], () => "benign", 2000);
    assert.equal(s.route(0.01, LOW, facts("db|slow query", { severity: "w" }), 3000), "drop");
    assert.equal(s.route(0.01, LOW, facts("db|slow query", { severity: "e5" }), 3000), "review", "the same text as an error is a new kind");
  });

  it("is lost when the context changes: a burst, or the service starting to fail", () => {
    const s = state();
    judge(s, [{ id: "1", template: "api|retrying", severity: "w", score: 0.01, route: "review", rate: 4, serviceErrors: 2 }], () => "benign", 0);
    const f = (rate: number, serviceErrors: number) => s.route(0.01, LOW, facts("api|retrying", { severity: "w", rate, serviceErrors }), 1000);
    assert.equal(f(4, 2), "drop");
    assert.equal(f(19, 2), "drop", "under 5x");
    assert.equal(f(21, 2), "review", "5x busier than when judged");
    assert.equal(f(4, 9), "drop", "few errors never count as a change");
    assert.equal(f(4, 11), "review", "its service is now failing");
  });

  it("expires, and is revoked by a relevant judgment", () => {
    const s = state();
    judge(s, [{ id: "1", template: "q|lag", severity: "w", score: 0.01, route: "review", rate: 1 }], () => "benign", 0);
    assert.equal(s.route(0.01, LOW, facts("q|lag", { severity: "w" }), 29 * DAY), "drop");
    assert.equal(s.route(0.01, LOW, facts("q|lag", { severity: "w" }), 31 * DAY), "review", "a fresh look after 30 days");
    judge(s, [{ id: "2", template: "q|lag", severity: "w", score: 0.01, route: "review", rate: 1 }], () => "relevant", 31 * DAY);
    assert.equal(s.route(0.01, LOW, facts("q|lag", { severity: "w" }), 31 * DAY + 1), "known");
  });

  it("can be turned off", () => {
    const off = new SuppressionLedger(0);
    assert.equal(off.earned("anything#i", 0), true);
  });
});

describe("escalation memory", () => {
  it("protects within the TTL, then reviews once instead of dropping", () => {
    const m = new EscalationMemory(7 * DAY, 90 * DAY);
    m.add("pay|failed", 0);
    assert.equal(m.status("pay|failed", 6 * DAY), "protected");
    assert.equal(m.status("pay|failed", 8 * DAY), "review", "day 8: not silently back to the classifier");
    assert.equal(m.status("pay|failed", 91 * DAY), null);
  });

  it("ends a protection when Jev calls the kind benign an hour after the incident", () => {
    const m = new EscalationMemory(7 * DAY, 90 * DAY);
    m.add("pay|failed", 0);
    m.judgedBenign("pay|failed", 30 * 60_000);
    assert.equal(m.status("pay|failed", 31 * 60_000), "protected", "half an hour on: the incident may still be going");
    m.judgedBenign("pay|failed", 2 * 3_600_000);
    assert.equal(m.status("pay|failed", 2 * 3_600_000 + 1), null, "two hours on, Jev says it's over");
  });

  it("renews on a relevant review and retires on a benign one", () => {
    const s = state();
    s.escalated.add("pay|failed", 0);
    const item = (id: string): Pending => ({ id, template: "pay|failed", severity: "e", score: 0.01, route: "review", rate: 1 });
    assert.equal(s.route(0.01, LOW, facts("pay|failed", { severity: "e" }), 8 * DAY), "review");
    judge(s, [item("1")], () => "relevant", 8 * DAY);
    assert.equal(s.route(0.01, LOW, facts("pay|failed", { severity: "e" }), 9 * DAY), "known", "renewed");
    s.escalated.add("pay|failed", 0); // pretend the renewal was long ago
    const t = 30 * DAY;
    s.cache.delete(verdictKey(item("x")));
    judge(s, [item("2")], () => "benign", t);
    assert.equal(s.escalated.status("pay|failed", t + 1), null, "retired");
  });
});

describe("routing state after a restart", () => {
  it("rebuilds the same decisions from the labels", () => {
    const labels: LabelFact[] = [
      { template: "web|GET /", severity: "i", y: 0, source: "jev", provenance: "review", at: 0, rate: 3, serviceErrors: 0 },
      { template: "pay|failed", severity: "e", y: 1, source: "jev", provenance: "threshold", at: 1000, rate: 1, serviceErrors: 5 },
      { template: "disk|full", severity: "e", y: 1, source: "jev", provenance: "known", at: 2000, rate: 1, serviceErrors: 0 },
      { template: "disk|full", severity: "e", y: 0, source: "human", provenance: "human", at: 3000, rate: 1, serviceErrors: 0 },
      { template: "web|GET /", severity: "i", y: 0, source: "jev", provenance: "follower", at: 4000, rate: 900, serviceErrors: 0 },
    ];
    const s = state();
    s.rebuild(labels);
    assert.equal(s.route(0.01, LOW, facts("web|GET /", { rate: 3 }), 5000), "drop", "earned, with the context it was judged in");
    assert.equal(s.route(0.01, LOW, facts("web|GET /", { rate: 50 }), 5000), "review", "the follower's context doesn't count");
    assert.equal(s.route(0.01, LOW, facts("pay|failed", { severity: "e" }), 5000), "known");
    assert.equal(s.escalated.status("disk|full", 5000), null, "a person's no retired it");
    assert.equal(s.route(0.01, LOW, facts("pay|failed", { severity: "e" }), 8 * DAY), "review", "and its expiry still means review after the restart");
  });
});
