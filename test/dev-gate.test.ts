import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { tempDir } from "./helpers.ts";

const ROOT = path.join(import.meta.dirname, "..");

/** One saved replay, as ml/evaluate.ts writes it, reduced to what the gate reads. */
const result = (missed: string[], unobserved: string[], sent: number, decider: string) => ({
  model: { path: "m.json", sha256: "ab", drop_below: 0.001 },
  settings: { decider },
  aggregate: { cascade: { events: 1000, asked_jev: sent, incidents: 1, detected: { k: 1 } } },
  cases: [{ id: "re3-x-1", cascade: { incidents: [{ id: "re3-x-1", withheld: false }] } }],
  safety_set: {
    missed: missed.map((id) => ({ case: id.slice(0, id.lastIndexOf(":")), id: id.slice(id.lastIndexOf(":") + 1) })),
    unobserved,
    by: { asked: 1, follower: 0, attached: 0 },
  },
});

describe("dev gate report (ml/dev-gate-report.ts)", () => {
  it("fails a miss or an unobserved event, exposures included, and never approves a release", () => {
    const dir = tempDir();
    const res = path.join(dir, "results");
    fs.mkdirSync(res);
    fs.writeFileSync(path.join(res, "must-reach-ids.txt"), "re3-x-1:1\nre3-x-1:2\nre3-x-1:3\n");
    fs.writeFileSync(path.join(res, "re3-baseline-cautious.json"), JSON.stringify(result([], [], 100, "oracle-cautious")));
    fs.writeFileSync(path.join(res, "re3-A-cautious.json"), JSON.stringify(result(["re3-x-1:2"], [], 50, "oracle-cautious")));
    fs.writeFileSync(path.join(res, "re3-B-cautious.json"), JSON.stringify(result([], ["re3-x-1:3"], 60, "oracle-cautious")));
    const refs = path.join(dir, "references.csv");
    fs.writeFileSync(refs, 'id,label,message\nre3-x-1:1,relevant,boom failed\nre3-x-1:2,relevant,"Posting Card: {""longNum"":""1""}"\nre3-x-1:3,relevant,timeout\n');
    const roles = path.join(dir, "roles.json");
    fs.writeFileSync(roles, JSON.stringify({ version: 1, cases: { "re3-x-1": "dev" } }));
    const out = path.join(dir, "gate.json");
    const run = () =>
      spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(ROOT, "ml/dev-gate-report.ts"), "--results", res, "--references", refs, "--roles", roles, "--out", out], { encoding: "utf8" });
    assert.equal(run().status, 0);
    const first = fs.readFileSync(out, "utf8");
    const r = JSON.parse(first);
    assert.equal(r.decision.baseline.dev_must_reach_pass, true);
    assert.equal(r.decision.A.verdict, "rejected", "a missed exposure fails the gate");
    assert.equal(r.decision.B.verdict, "rejected", "an unobserved event fails the gate");
    assert.equal(r.release.can_approve, false);
    const a = r.runs.find((x: { arm: string }) => x.arm === "A");
    assert.deepEqual(a.must_reach.missed_by_kind, { exposure: 1 });
    assert.equal(a.vs_baseline.events_sent_change_pct, -50);
    assert.equal(run().status, 0);
    assert.equal(fs.readFileSync(out, "utf8"), first, "deterministic");
  });
});
