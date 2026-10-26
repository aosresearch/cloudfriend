import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { applyVerdicts, planBatch, routeEvent, VerdictCache, type Pending } from "../src/triage/cascade.ts";
import { Classifier, type ClassifierFile } from "../src/triage/classifier.ts";
import { extractEntities, FEATURE_NAMES, Featurizer, FEATURIZER_VERSION, levelOf, maskMessage } from "../src/triage/features.ts";
import { Gbdt } from "../src/triage/gbdt.ts";
import { BUILTIN_MODEL } from "../src/triage/runtime.ts";
import { limitThreshold } from "../src/training.ts";
import { count, fakeDecider, makeCloudfriend, tempDir, type TestCloudfriend } from "./helpers.ts";

const ERRORISH = FEATURE_NAMES.indexOf("errorish");
const json = async (r: Response | Promise<Response>): Promise<any> => (await r).json();

/** A one-tree model: errorish events score ~0.98, the rest ~0.02. */
export function tinyModel(over: Partial<ClassifierFile> = {}): ClassifierFile {
  return {
    format: "cloudfriend-classifier/1",
    featurizer_version: FEATURIZER_VERSION,
    feature_names: [...FEATURE_NAMES],
    trained_at: "2026-10-26T00:00:00Z",
    drop_below: 0.5,
    escalate_above: 1.01,
    threshold: 0.9,
    lightgbm: {
      objective: "binary sigmoid:1",
      tree_info: [
        {
          tree_structure: {
            split_feature: ERRORISH,
            threshold: 0.5,
            decision_type: "<=",
            default_left: true,
            missing_type: "None",
            left_child: { leaf_value: -4 },
            right_child: { leaf_value: 4 },
          },
        },
      ],
    },
    ...over,
  };
}

function writeModel(file: ClassifierFile): string {
  const p = path.join(tempDir(), "model.json");
  fs.writeFileSync(p, JSON.stringify(file));
  return p;
}

describe("featurizer", () => {
  it("masks ids, numbers and values so repeats share a template", () => {
    const a = maskMessage("GetCartAsync called with userId=418ce0b6-15a4-4228-a6cf-27e322509121 in 12ms");
    const b = maskMessage("GetCartAsync called with userId=9f1c0b6e-15a4-4228-a6cf-27e322509999 in 7ms");
    assert.equal(a, b);
    assert.equal(maskMessage("query = select x from t where user_name='HXuSgZPY'"), maskMessage("query = select x from t where user_name='pkiwOTAa'"));
    assert.match(maskMessage('Traceback (most recent call last):\n  File "a.py", line 3\nAttributeError: x'), /Traceback.*AttributeError/);
  });

  it("reads levels from fields or text", () => {
    assert.equal(levelOf({ level: "error" }, ""), 3);
    assert.equal(levelOf({}, "2024-11-22 02:51:59.404  WARN [carts] ..."), 2);
    assert.equal(levelOf({}, "2021-08-01 00:00:01,302 | INFO | 0.0.0.2 | x"), 1);
    assert.equal(levelOf({ level: 50 }, ""), 4);
    assert.ok(Number.isNaN(levelOf({}, "hello")));
  });

  it("finds users in fields, URLs and messages", () => {
    assert.equal(extractEntities({ user_id: "u1" }).user, "u1");
    assert.equal(extractEntities({ url: "http://h:9388/login?uuid=1&user_id=ToeLCkHR" }).user, "ToeLCkHR");
    assert.equal(extractEntities({ message: "where user_name='HXuSgZPY'" }).user, "HXuSgZPY");
  });

  it("scores a template as new once, then tracks its rate", () => {
    const f = new Featurizer();
    const iNew = FEATURE_NAMES.indexOf("tpl_new");
    const iCount = FEATURE_NAMES.indexOf("tpl_count");
    const ev = (n: number) => ({ source: "app", received_at: 1_700_000_000_000 + n * 1000, data: { message: `payment ${n} failed: timeout` } });
    const first = f.featurize(ev(1));
    const second = f.featurize(ev(2));
    assert.equal(first.values[iNew], 1);
    assert.equal(second.values[iNew], 0);
    assert.equal(second.values[iCount], Math.log1p(1));
    assert.equal(first.template, second.template);
    assert.equal(first.values.length, FEATURE_NAMES.length);
    assert.ok(first.errorish);
  });

  it("restores its history from a snapshot", () => {
    const f = new Featurizer();
    for (let i = 0; i < 5; i++) f.featurize({ source: "app", received_at: 1_700_000_000_000 + i, data: { message: "x happened" } });
    const g = new Featurizer();
    assert.ok(g.restore(JSON.parse(JSON.stringify(f.snapshot()))));
    const e = { source: "app", received_at: 1_700_000_001_000, data: { message: "x happened" } };
    assert.deepEqual(g.featurize(e).values, f.featurize(e).values);
    assert.equal(g.restore({ ...f.snapshot(), version: -1 }), false);
  });
});

describe("gbdt", () => {
  it("follows LightGBM's missing-value rules", () => {
    const g = new Gbdt({
      objective: "binary sigmoid:1",
      tree_info: [
        {
          tree_structure: {
            split_feature: 0, threshold: 1, decision_type: "<=", default_left: false, missing_type: "NaN",
            left_child: { leaf_value: -1 }, right_child: { leaf_value: 1 },
          },
        },
        {
          tree_structure: {
            split_feature: 1, threshold: -0.5, decision_type: "<=", default_left: true, missing_type: "Zero",
            left_child: { leaf_value: 0.5 }, right_child: { leaf_value: 0 },
          },
        },
      ],
    });
    assert.equal(g.raw([0.5, 3]), -1);
    assert.equal(g.raw([2, 3]), 1);
    assert.equal(g.raw([NaN, 3]), 1, "NaN goes the default way (right)");
    assert.equal(g.raw([2, 0]), 1.5, "zero goes the default way (left) when missing_type is Zero");
    assert.equal(g.raw([2, NaN]), 1.5, "NaN counts as zero when missing_type is Zero");
    assert.ok(Math.abs(g.predict([2, 3]) - 1 / (1 + Math.exp(-1))) < 1e-12);
  });

  it("matches LightGBM's own scores for the built-in model", () => {
    const fixture = path.join(import.meta.dirname, "fixtures", "parity.json");
    const model = new Classifier(JSON.parse(fs.readFileSync(BUILTIN_MODEL, "utf8")));
    const p = JSON.parse(fs.readFileSync(fixture, "utf8")) as { rows: (number | null)[][]; scores: number[] };
    p.rows.forEach((r, i) => {
      const s = model.score(r.map((v) => (v === null ? NaN : v)));
      assert.ok(Math.abs(s - p.scores[i]!) < 1e-9, `row ${i}: ${s} vs ${p.scores[i]}`);
    });
  });
});

describe("cascade", () => {
  const item = (id: string, template: string, route: Pending["route"] = "jev", score = 0.6): Pending => ({ id, template, route, score });

  it("routes by score, audits a share of drops, and works without Jev", () => {
    const o = { dropBelow: 0.1, escalateAbove: 0.99, threshold: 0.5, hasJev: true, auditRate: 0 };
    assert.equal(routeEvent(0.05, o), "drop");
    assert.equal(routeEvent(0.5, o), "jev");
    assert.equal(routeEvent(0.995, o), "auto");
    assert.equal(routeEvent(null, o), "jev");
    assert.equal(routeEvent(0.05, { ...o, auditRate: 1 }), "audit");
    assert.equal(routeEvent(0.05, o, true), "novel", "a never-seen error goes to Jev once");
    assert.equal(routeEvent(0.05, { ...o, novelGuard: false }, true), "drop");
    assert.equal(routeEvent(0.6, { ...o, hasJev: false }), "classifier");
    assert.equal(routeEvent(0.4, { ...o, hasJev: false }), "drop");
  });

  it("asks about a few examples per template and gives the rest their verdict", () => {
    const cache = new VerdictCache(60_000);
    const items = [...Array.from({ length: 7 }, (_, i) => item(`a${i}`, "A")), item("b0", "B")];
    const plan = planBatch(items, cache, 0, 3);
    assert.deepEqual(plan.ask.map((a) => a.item.id), ["a0", "a1", "a2", "b0"]);
    assert.equal(plan.ask.reduce((n, a) => n + a.similar, 0), 4);
    const out = applyVerdicts(plan, [{ reason: "A broke", severity: "high", event_ids: ["a1"] }]);
    assert.equal(out.flags.length, 1);
    assert.deepEqual(out.flags[0]!.event_ids.sort(), ["a1", "a4"].sort(), "a1 and its follower");
    assert.equal(out.verdicts.get("A"), 0);
    assert.equal(out.verdicts.get("B"), -1);
    assert.deepEqual(out.labels.filter((l) => l.y).map((l) => l.id).sort(), ["a1", "a4"]);
  });

  it("reuses a cached verdict and adds events to the flag it raised", () => {
    const cache = new VerdictCache(60_000);
    cache.set("A", true, 0, "flg_1");
    cache.set("B", false, 0);
    const plan = planBatch([item("a", "A"), item("b", "B"), item("c", "C")], cache, 1000);
    assert.deepEqual(plan.ask.map((a) => a.item.id), ["c"]);
    const out = applyVerdicts(plan, []);
    assert.deepEqual(out.attach.get("flg_1"), ["a"]);
    assert.equal(planBatch([item("a", "A")], cache, 120_000).ask.length, 1, "verdicts expire");
  });

  it("escalates auto-routed events without asking", () => {
    const plan = planBatch([item("x", "X", "auto", 0.999), item("y", "X", "auto", 0.998)], new VerdictCache(0), 0);
    const out = applyVerdicts(plan, []);
    assert.equal(plan.ask.length, 0);
    assert.equal(out.flags[0]!.via, "classifier");
    assert.deepEqual(out.flags[0]!.event_ids, ["x", "y"]);
  });
});

describe("triage in the pipeline", () => {
  let cf: TestCloudfriend;
  afterEach(async () => {
    await cf?.close(0).catch(() => {});
  });

  async function setup(respond: Parameters<typeof fakeDecider>[0] = () => []) {
    const d = fakeDecider(respond);
    cf = await makeCloudfriend({
      decider: d.adapter,
      config: { triage: true, modelPath: writeModel(tinyModel()), auditRate: 0, batchSize: 50, batchWaitMs: 0 },
    });
    return d;
  }

  async function run() {
    cf.worker.parseNew();
    cf.worker.startDueBatches();
    await cf.worker.whenIdle();
  }

  it("drops routine events, asks Jev about a few examples, and labels what Jev saw", async () => {
    const d = await setup((events) => [{ reason: "checkout failing", severity: "high", event_ids: [events[0]!.id] }]);
    const body = [
      ...Array.from({ length: 5 }, (_, i) => ({ level: "info", message: `request ${i} served` })),
      ...Array.from({ length: 6 }, (_, i) => ({ level: "error", message: `payment provider timeout after ${i}ms`, user_id: `u${i}` })),
    ];
    await cf.post("app", body);
    await run();

    assert.equal(count(cf, "events WHERE route = 'drop' AND decided = 1"), 5);
    assert.equal(d.calls.length, 1);
    assert.equal(d.calls[0]!.length, 3, "three examples of the one error template");
    assert.equal(d.calls[0]![0]!.triage?.similar, 1);
    const flags = (await json(cf.get("/queue"))).flags;
    assert.equal(flags.length, 1);
    assert.equal(flags[0].status, "open");
    assert.equal(flags[0].event_count, 2, "the flagged example and its follower");
    assert.ok(flags[0].users.length >= 1);
    assert.equal(count(cf, "labels WHERE source = 'jev'"), 6);
    assert.equal(count(cf, "labels WHERE y = 1"), 2);

    // The same error again: the cached verdict adds it to the open flag without asking Jev.
    await cf.post("app", { level: "error", message: "payment provider timeout after 99ms" });
    await run();
    assert.equal(d.calls.length, 1);
    const again = (await json(cf.get(`/flags/${flags[0].id}`))).flag;
    assert.equal(again.event_count, 3);

    const stats = await json(cf.get("/stats"));
    assert.equal(stats.routes.drop, 5);
    assert.equal(stats.since_start.deciderCalls, 1);
    assert.ok(stats.model.trees >= 1);
  });

  it("turns feedback into human labels and overturns cached verdicts", async () => {
    await setup((events) => [{ reason: "boom", severity: "medium", event_ids: events.map((e) => e.id) }]);
    await cf.post("app", [{ level: "error", message: "disk almost full" }, { level: "info", message: "user signed in" }]);
    await run();
    const [flag] = (await json(cf.get("/queue"))).flags;
    const fb = await cf.app.request(`/flags/${flag.id}/feedback`, {
      method: "POST",
      headers: { authorization: "Bearer test-admin-key", "content-type": "application/json" },
      body: JSON.stringify({ verdict: "false_positive", note: "expected during backups" }),
    });
    assert.equal(fb.status, 200);
    assert.deepEqual(await json(fb), { flag: flag.id, status: "false_positive", labeled: 1 });
    assert.equal(count(cf, "labels WHERE source = 'human' AND y = 0"), 1);
    assert.equal((await json(cf.get("/queue"))).flags.length, 0, "false positives leave the queue");

    // A missed escalation: the dropped info event should have been escalated.
    const dropped = cf.db.prepare("SELECT id FROM events WHERE route = 'drop'").get() as { id: number };
    const miss = await cf.app.request(`/events/${dropped.id}/feedback`, {
      method: "POST",
      headers: { authorization: "Bearer test-admin-key", "content-type": "application/json" },
      body: JSON.stringify({ escalate: true }),
    });
    const res = await json(miss);
    assert.equal(res.kind, "false_negative");
    assert.equal(res.route, "drop");

    // Same template again: the overturned verdict means it is not escalated or asked about.
    await cf.post("app", { level: "error", message: "disk almost full" });
    await run();
    assert.equal(count(cf, "flags"), 1);
  });

  it("acknowledges and resolves flags in the queue", async () => {
    await setup((events) => [{ reason: "boom", severity: "critical", event_ids: [events[0]!.id] }]);
    await cf.post("app", { level: "error", message: "database unreachable" });
    await run();
    const [flag] = (await json(cf.get("/queue"))).flags;
    const patch = (status: string) =>
      cf.app.request(`/flags/${flag.id}`, {
        method: "PATCH",
        headers: { authorization: "Bearer test-admin-key", "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
    assert.equal((await json(patch("acknowledged"))).status, "acknowledged");
    assert.equal((await json(cf.get("/queue"))).flags.length, 1);
    await patch("resolved");
    assert.equal((await json(cf.get("/queue"))).flags.length, 0);
    assert.equal((await patch("confirmed")).status, 400);
  });

  it("escalates on the classifier alone when there is no Jev", async () => {
    cf = await makeCloudfriend({ decider: null, config: { triage: true, modelPath: writeModel(tinyModel()), batchWaitMs: 0 } });
    await cf.post("app", [{ level: "error", message: "out of memory" }, { level: "info", message: "ok" }]);
    await run();
    const [flag] = (await json(cf.get("/queue"))).flags;
    assert.equal(flag.decider, "classifier");
    assert.match(flag.reason, /Classifier escalation/);
    assert.equal(count(cf, "labels"), 0, "no Jev, no labels");
  });

  it("imports labelled history", async () => {
    await setup();
    const res = await cf.app.request("/labels", {
      method: "POST",
      headers: { authorization: "Bearer test-admin-key", "content-type": "application/json" },
      body: JSON.stringify({ labels: [{ source: "app", data: { message: "a" }, escalate: true }, { source: "app", data: { message: "b" }, escalate: false }] }),
    });
    assert.equal(res.status, 201);
    assert.equal(count(cf, "labels WHERE event_id < 0 AND source = 'human'"), 2);
    const labels = await json(cf.get("/labels"));
    assert.deepEqual(labels.labels.human, { escalate: 1, ignore: 1 });
  });
});

describe("threshold limit", () => {
  it("lowers a candidate's threshold so it keeps at least half the active model's Jev share", () => {
    const active = new Classifier(tinyModel({ drop_below: 0.5 }));
    const bold = new Classifier(tinyModel({ drop_below: 0.99 }));
    const recent = Array.from({ length: 1000 }, (_, i) => {
      const v = new Array(FEATURE_NAMES.length).fill(0);
      v[ERRORISH] = i < 100 ? 1 : 0; // 10% of recent events look like errors
      return v;
    });
    const r = limitThreshold(bold, active, recent);
    assert.equal(r.active, 0.1);
    assert.equal(r.adjusted, true);
    assert.ok(r.candidate >= 0.05, `keeps ${r.candidate}`);
    assert.equal(limitThreshold(new Classifier(tinyModel({ drop_below: 0.5 })), active, recent).adjusted, false);
  });
});

const hasLightgbm = spawnSync("python3", ["-c", "import lightgbm"]).status === 0;

describe("training loop", { skip: !hasLightgbm && "python3 with lightgbm is not installed" }, () => {
  let cf: TestCloudfriend;
  afterEach(async () => {
    await cf?.close(0).catch(() => {});
  });

  it("trains on labels, gates the candidate, and swaps the model in", async () => {
    cf = await makeCloudfriend({ decider: fakeDecider().adapter, config: { triage: true, modelPath: writeModel(tinyModel()) } });
    const labels = [];
    for (let i = 0; i < 400; i++) {
      const bad = i % 4 === 0;
      labels.push({
        source: "app",
        received_at: 1_700_000_000_000 + i * 1000,
        data: bad ? { level: "error", message: `checkout failed for order ${i}: card declined by provider` } : { level: "info", message: `page ${i % 7} rendered` },
        escalate: bad,
      });
    }
    await cf.app.request("/labels", {
      method: "POST",
      headers: { authorization: "Bearer test-admin-key", "content-type": "application/json" },
      body: JSON.stringify(labels),
    });
    const res = await cf.app.request("/model/train", { method: "POST", headers: { authorization: "Bearer test-admin-key" } });
    const report = await json(res);
    assert.equal(report.labels.total, 400);
    assert.ok(["promoted", "rejected"].includes(report.status), report.reason);
    assert.ok(report.candidate.recall_at_drop > 0.9);
    const model = await json(cf.get("/model"));
    assert.equal(model.history[0].id, report.id);
    if (report.status === "promoted") {
      assert.equal(model.active.path, path.join(cf.config.dataDir, "models", "active.json"));
      assert.equal(cf.triage!.classifier!.file.trained_at, report.model.trained_at);
    }
  });

  it("skips training without enough labels", async () => {
    cf = await makeCloudfriend({ decider: fakeDecider().adapter, config: { triage: true, modelPath: writeModel(tinyModel()) } });
    const report = await json(cf.app.request("/model/train", { method: "POST", headers: { authorization: "Bearer test-admin-key" } }));
    assert.equal(report.status, "skipped");
  });
});
