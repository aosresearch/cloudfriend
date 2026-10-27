import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { applyVerdicts, planBatch, routeEvent, VerdictCache, verdictKey, type Pending } from "../src/triage/cascade.ts";
import { Classifier, type ClassifierFile } from "../src/triage/classifier.ts";
import { extractEntities, FEATURE_NAMES, Featurizer, FEATURIZER_VERSION, levelOf, maskMessage } from "../src/triage/features.ts";
import { Gbdt } from "../src/triage/gbdt.ts";
import { BUILTIN_MODEL } from "../src/triage/runtime.ts";
import { gate, limitThreshold, rulesAtTheTime, splitLabels } from "../src/training.ts";
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

  it("measures the time since a template and its service were last seen", () => {
    const f = new Featurizer();
    const iTpl = FEATURE_NAMES.indexOf("tpl_since_last");
    const iSvc = FEATURE_NAMES.indexOf("svc_since_last");
    const ev = (t: number) => ({ source: "app", received_at: 1_700_000_000_000 + t, data: { service: "api", message: "cache refreshed" } });
    f.featurize(ev(0));
    const second = f.featurize(ev(60_000));
    assert.ok(Math.abs(second.values[iTpl]! - Math.log1p(60)) < 1e-9, "60 s since the last one");
    assert.ok(Math.abs(second.values[iSvc]! - Math.log1p(60)) < 1e-9);
    const ctx = f.context(second.template)!;
    assert.equal(ctx.seen_total, 2);
    assert.ok(ctx.last_10m > 1 && ctx.last_10m <= 2);
  });

  it("ignores a timestamp in the data that is hours away from the arrival time", () => {
    const f = new Featurizer();
    const now = 1_700_000_000_000;
    const ev = (t: number, data: object = {}) => ({ source: "app", received_at: now + t, data: { service: "api", message: "tick", ...data } });
    for (let i = 0; i < 20; i++) f.featurize(ev(i * 1000));
    // One event claims to be from 9 hours later (a local time read as UTC).
    f.featurize(ev(21_000, { time: new Date(now + 9 * 3_600_000).toISOString() }));
    const ctx = f.context(f.featurize(ev(22_000)).template)!;
    assert.ok(ctx.last_1m > 10, `the burst is still visible (${ctx.last_1m})`);
  });

  it("keeps its clock across a restart", () => {
    const f = new Featurizer();
    const r = f.featurize({ source: "app", received_at: 1_700_000_000_000, data: { message: "tick" } });
    const g = new Featurizer();
    g.restore(JSON.parse(JSON.stringify(f.snapshot())));
    assert.ok(g.context(r.template)!.first_seen_min_ago >= 0);
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
    assert.equal(routeEvent(0.05, o, false, true), "known", "a kind of event that was escalated always reaches Jev");
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
    assert.deepEqual(out.verdicts.get("A#"), { escalate: true, flag: 0 });
    // A v0 answer (flags only) says nothing about the events it didn't cite: no "no" verdict, no negative labels.
    assert.equal(out.verdicts.has("B#"), false);
    assert.deepEqual(out.labels.map((l) => [l.id, l.y, l.follower]).sort(), [["a1", 1, false], ["a4", 1, true]]);
  });

  it("labels only what the decider explicitly judged", () => {
    const items = [...Array.from({ length: 3 }, (_, i) => item(`a${i}`, "A")), item("b0", "B"), item("c0", "C")];
    const plan = planBatch(items, new VerdictCache(60_000), 0, 3);
    const out = applyVerdicts(plan, {
      flags: [],
      judgments: [
        { event_id: "a0", relevance: "relevant" },
        { event_id: "a1", relevance: "uncertain" },
        { event_id: "b0", relevance: "benign" },
        // a2 and c0 have no judgment
      ],
    });
    assert.deepEqual(out.labels.map((l) => [l.id, l.y]).sort(), [["a0", 1], ["b0", 0]]);
    assert.deepEqual(out.verdicts.get("B#"), { escalate: false, judged: true }, "every example of B was judged benign");
    assert.equal(out.verdicts.has("A#"), false, "A had an uncertain and a silent example: no cached verdict");
    assert.equal(out.verdicts.has("C#"), false);
    assert.deepEqual([...out.relevant], ["A"], "a relevant judgment protects the template even without an alert");
  });

  it("never lets a verdict cross severities, bursts, or second-look routes", () => {
    const cache = new VerdictCache(60_000);
    const info = { ...item("i", "GET /checkout"), severity: "i2", rate: 1 };
    cache.set(verdictKey(info), false, 0, undefined, 1);
    // The same message as an error with a 5xx is a different unit: it is asked about.
    const err = { ...item("e", "GET /checkout"), severity: "e5", rate: 1 };
    assert.deepEqual(planBatch([err], cache, 1000).ask.map((a) => a.item.id), ["e"]);
    // The same info message, now 10x as frequent: the "no" no longer applies.
    assert.equal(planBatch([{ ...info, id: "i2", rate: 10 }], cache, 1000).ask.length, 1);
    cache.set(verdictKey(info), false, 0, undefined, 1);
    assert.equal(planBatch([{ ...info, id: "i3", rate: 1 }], cache, 1000).cached.length, 1, "same rate: the no stands");
    // Audits, never-seen errors and escalated kinds get a second look past a cached "no".
    for (const route of ["audit", "novel", "known", "review"] as const) {
      assert.equal(planBatch([{ ...info, id: route, route, rate: 1 }], cache, 1000).ask.length, 1, route);
    }
  });

  it("reuses a cached verdict and adds events to the flag it raised", () => {
    const cache = new VerdictCache(60_000);
    cache.set(verdictKey(item("a", "A")), true, 0, "flg_1");
    cache.set(verdictKey(item("b", "B")), false, 0);
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
      // These tests are about the cascade's other mechanics; earned suppression has its own below.
      config: { triage: true, modelPath: writeModel(tinyModel()), auditRate: 0, batchSize: 50, batchWaitMs: 0, suppressionTtlMs: 0 },
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
    // Jev cited one example: it and its follower are labelled "escalate". The two it didn't cite
    // get no label at all: silence is not a "benign" verdict.
    assert.equal(count(cf, "labels WHERE source = 'jev'"), 2);
    assert.equal(count(cf, "labels WHERE y = 1"), 2);
    assert.equal(count(cf, "labels WHERE provenance = 'follower'"), 1);
    assert.equal(count(cf, "decisions"), 1, "the call is recorded");

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

  it("keeps sending Jev a kind of event it escalated, even when the classifier would drop it", async () => {
    // This classifier drops everything (errors score 0.98, the threshold is 0.99).
    const d = fakeDecider((events) => {
      const hit = events.filter((e) => JSON.stringify(e.data).includes("ledger"));
      return hit.length ? [{ reason: "ledger writes failing", severity: "critical", event_ids: hit.map((e) => e.id) }] : [];
    });
    cf = await makeCloudfriend({
      decider: d.adapter,
      config: { triage: true, modelPath: writeModel(tinyModel({ drop_below: 0.99, threshold: 0.995 })), auditRate: 0, verdictTtlMs: 0, batchWaitMs: 0, suppressionTtlMs: 0 },
    });
    const route = () => (cf.db.prepare("SELECT route FROM events ORDER BY id DESC LIMIT 1").get() as { route: string }).route;
    // First time: a never-seen error goes to Jev once (novel), and Jev escalates it.
    await cf.post("app", { level: "error", message: "ledger write failed for account 17" });
    await run();
    assert.equal(route(), "novel");
    assert.equal(count(cf, "flags"), 1);
    // Next ones would be dropped by the classifier, but Jev escalated this kind: they still reach it.
    await cf.post("app", { level: "error", message: "ledger write failed for account 18" });
    await run();
    assert.equal(route(), "known");
    assert.equal(d.calls.length, 2);
    // A kind Jev didn't escalate is dropped once it isn't new.
    await cf.post("app", [{ level: "error", message: "thumbnail cache miss for image 1" }, { level: "error", message: "thumbnail cache miss for image 2" }]);
    await run();
    assert.equal(route(), "drop");
    // A person says the ledger flag was a false positive: the kind stops reaching Jev.
    const [flag] = (await json(cf.get("/flags"))).flags.slice(-1);
    await cf.app.request(`/flags/${flag.id}/feedback`, {
      method: "POST",
      headers: { authorization: "Bearer test-admin-key", "content-type": "application/json" },
      body: JSON.stringify({ verdict: "false_positive" }),
    });
    await cf.post("app", { level: "error", message: "ledger write failed for account 19" });
    await run();
    assert.equal(route(), "drop");
  });

  it("remembers escalated kinds across a restart", async () => {
    const d = fakeDecider((events) => [{ reason: "boom", severity: "high", event_ids: events.map((e) => e.id) }]);
    const config = { triage: true, modelPath: writeModel(tinyModel({ drop_below: 0.99 })), auditRate: 0, verdictTtlMs: 0, batchWaitMs: 0 };
    cf = await makeCloudfriend({ decider: d.adapter, config });
    await cf.post("app", { level: "error", message: "replica lag over 30s on db 2" });
    await run();
    assert.equal(cf.triage!.escalated.size, 1);
    const dataDir = cf.config.dataDir;
    await cf.close(0);
    cf = await makeCloudfriend({ decider: d.adapter, config: { ...config, dataDir } });
    assert.equal(cf.triage!.escalated.size, 1, "loaded from the labels table");
  });

  it("reviews an error/500 even after the same message as info/200 was judged benign", async () => {
    // The reviewer's reproduction. Everything reaches Jev here (threshold 0).
    const d = fakeDecider((events) => ({
      flags: events.filter((e) => (e.data as any).status === 500).map((e) => ({ reason: "checkout 500s", severity: "high" as const, event_ids: [e.id] })),
      judgments: events.map((e) => ({ event_id: e.id, relevance: (e.data as any).status === 500 ? ("relevant" as const) : ("benign" as const) })),
    }));
    cf = await makeCloudfriend({ decider: d.adapter, config: { triage: true, modelPath: writeModel(tinyModel({ drop_below: 0 })), auditRate: 0, batchWaitMs: 0 } });
    await cf.post("app", { level: "info", status: 200, message: "POST /checkout" });
    await run();
    await cf.post("app", { level: "error", status: 500, message: "POST /checkout" });
    await run();
    assert.equal(d.calls.length, 2, "the error was asked about, not settled by the cached no");
    assert.equal(count(cf, "flags"), 1);
  });

  it("forgets a cached no once someone says the event should have been escalated", async () => {
    const d = fakeDecider((events) => ({ flags: [], judgments: events.map((e) => ({ event_id: e.id, relevance: "benign" as const })) }));
    cf = await makeCloudfriend({ decider: d.adapter, config: { triage: true, modelPath: writeModel(tinyModel({ drop_below: 0 })), auditRate: 0, batchWaitMs: 0 } });
    await cf.post("app", { level: "warn", message: "disk 91% full on db-1" });
    await run();
    await cf.post("app", { level: "warn", message: "disk 92% full on db-1" });
    await run();
    assert.equal(d.calls.length, 1, "the second one was settled by the cached no");
    const missed = cf.db.prepare("SELECT id FROM events ORDER BY id DESC LIMIT 1").get() as { id: number };
    const res = await json(
      cf.app.request(`/events/${missed.id}/feedback`, {
        method: "POST",
        headers: { authorization: "Bearer test-admin-key", "content-type": "application/json" },
        body: JSON.stringify({ escalate: true }),
      }),
    );
    assert.equal(res.labeled, true);
    await cf.post("app", { level: "warn", message: "disk 93% full on db-1" });
    await run();
    assert.equal(d.calls.length, 2, "after the correction it is asked about again");
  });

  it("raises a new flag when an alert updates one that was closed during the call", async () => {
    let target = "";
    const d = fakeDecider((events) => [{ reason: "db down", severity: "high", event_ids: [events[0]!.id], ...(target ? { update: target } : {}) }]);
    cf = await makeCloudfriend({ decider: d.adapter, config: { triage: true, modelPath: writeModel(tinyModel()), auditRate: 0, batchWaitMs: 0, suppressionTtlMs: 0, verdictTtlMs: 0 } });
    await cf.post("app", { level: "error", message: "database unreachable" });
    await run();
    const [flag] = (await json(cf.get("/queue"))).flags;
    target = flag.id;
    await cf.app.request(`/flags/${flag.id}`, {
      method: "PATCH",
      headers: { authorization: "Bearer test-admin-key", "content-type": "application/json" },
      body: JSON.stringify({ status: "resolved" }),
    });
    await cf.post("app", { level: "error", message: "database unreachable" });
    await run();
    assert.equal(count(cf, "flags"), 2, "the events are not hidden in a resolved flag");
    assert.equal((await json(cf.get("/queue"))).flags.length, 1);
  });

  it("clears decision prompts with the events they quote", async () => {
    await setup((events) => ({ flags: [], judgments: events.map((e) => ({ event_id: e.id, relevance: "benign" as const })) }));
    await cf.post("app", { level: "error", message: "card 4111 declined" });
    await run();
    assert.equal(count(cf, "decisions WHERE response IS NOT NULL"), 1);
    await cf.worker.cleanup(Date.now() + cf.config.retentionMs + 1);
    assert.equal(count(cf, "decisions"), 1, "the row stays for the labels that point to it");
    assert.equal(count(cf, "decisions WHERE prompt IS NOT NULL OR response IS NOT NULL"), 0);
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

  it("holds audit samples until a real batch goes out", async () => {
    const d = fakeDecider();
    cf = await makeCloudfriend({
      decider: d.adapter,
      // Without earned suppression, so these events are plain drops that the audit samples.
      config: { triage: true, modelPath: writeModel(tinyModel()), auditRate: 1, auditWaitMs: 60_000, batchSize: 50, batchWaitMs: 0, suppressionTtlMs: 0 },
    });
    await cf.post("app", [{ level: "info", message: "page served" }, { level: "info", message: "cache warm" }]);
    await run();
    assert.equal(count(cf, "events WHERE route = 'audit' AND decided = 0"), 2);
    assert.equal(d.calls.length, 0, "audits alone wait");
    await cf.post("app", { level: "error", message: "queue consumer crashed" });
    await run();
    assert.equal(d.calls.length, 1);
    assert.equal(d.calls[0]!.length, 3, "the audits ride along with the error");
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

describe("training split and gate", () => {
  it("splits labels by time without cutting an incident in two", () => {
    const M = 60_000;
    const rows: { event_id: number; received_at: number; template: string }[] = [];
    // Ten bursts of one template, 10 labels a minute apart, each starting at :25 so it crosses
    // a half hour (the reviewer's case), two hours apart; plus one-off labels in between.
    for (let b = 0; b < 10; b++) {
      for (let i = 0; i < 10; i++) rows.push({ event_id: rows.length, received_at: b * 120 * M + 25 * M + i * M, template: "A" });
      rows.push({ event_id: rows.length, received_at: b * 120 * M + 80 * M, template: `B${b}` });
    }
    const { fit, calibrate, accept } = splitLabels(rows);
    assert.equal(fit.length + calibrate.length + accept.length, rows.length);
    const partOf = new Map<number, string>();
    for (const [name, part] of Object.entries({ fit, calibrate, accept })) for (const r of part) partOf.set(r.event_id, name);
    for (let b = 0; b < 10; b++) {
      const parts = new Set(rows.filter((r) => r.template === "A" && Math.floor(r.received_at / (120 * M)) === b).map((r) => partOf.get(r.event_id)));
      assert.equal(parts.size, 1, `burst ${b} is in ${[...parts]}`);
    }
    assert.ok(accept.length > 0 && calibrate.length > 0);
    assert.ok(Math.max(...fit.map((r) => r.received_at)) <= Math.min(...accept.map((r) => r.received_at)), "accept is the newest");
  });

  it("starts a new incident when a template never goes quiet", () => {
    // One label a minute for ten hours: a single "incident" would leave nothing to hold out.
    const rows = Array.from({ length: 600 }, (_, i) => ({ event_id: i, received_at: i * 60_000, template: "heartbeat" }));
    const { fit, calibrate, accept } = splitLabels(rows);
    assert.ok(fit.length && calibrate.length && accept.length);
  });

  it("credits the routing rules only as they stood when each event arrived", () => {
    const H = 3_600_000;
    const DAY = 24 * H;
    // Each label takes effect 10 s after its event arrived, when Jev's answer came back.
    const row = (event_id: number, t: number, template: string, y: number, source = "jev") => ({
      event_id, received_at: t, created_at: t + 10_000, template, y, source, provenance: "threshold", severity: "e", ctx_rate: 1, ctx_service_errors: 0,
    });
    const all = [
      row(1, 0, "pay", 1), // nothing known yet
      row(2, 1_000, "pay", 1), // same burst, before Jev answered: no credit (the reviewer's look-ahead)
      row(3, H, "pay", 1), // protected by the escalation
      row(4, H, "cache", 0),
      row(5, 2 * H, "cache", 1), // a benign judgment protects nothing
      row(6, 3 * H, "disk", 1),
      row(7, 4 * H, "disk", 0, "human"), // still protected when it arrived; the person's "no" retires it
      row(8, 5 * H, "disk", 1),
      row(9, H + 8 * DAY, "pay", 1), // past the TTL but within memory: reviewed, not dropped
    ];
    const part = all.map(({ event_id }) => ({ event_id }));
    const rules = (o: Partial<{ escalatedTtlMs: number; escalatedMemoryMs: number; suppressionTtlMs: number }>) =>
      rulesAtTheTime(all, part, { escalatedTtlMs: 7 * DAY, escalatedMemoryMs: 90 * DAY, suppressionTtlMs: 0, ...o }).map(Number);
    assert.deepEqual(rules({}), [0, 0, 1, 0, 0, 0, 1, 0, 1]);
    assert.deepEqual(rules({ escalatedMemoryMs: 7 * DAY }).at(-1), 0, "without memory the expired escalation gives no credit");
    assert.deepEqual(rules({ escalatedTtlMs: 0 }), [0, 0, 0, 0, 0, 0, 0, 0, 0], "off when the rule is off");
    // With earned suppression, a kind nobody has judged benign yet always reaches Jev.
    const earned = rules({ escalatedTtlMs: 0, suppressionTtlMs: 30 * DAY });
    assert.equal(earned[3], 1, "cache: never judged before");
    assert.equal(earned[4], 0, "cache: judged benign an hour earlier, in the same context");
  });

  it("holds the recall target with no slack, then compares workload", () => {
    const m = (recall: number, share: number) => ({ average_precision: 0.9, recall_at_drop: recall, forwarded_share: share, precision_at_threshold: 0.9 });
    assert.equal(gate(m(0.99, 0.1), m(0.995, 0.3), 0.995).ok, false, "below target is rejected even if close");
    assert.equal(gate(m(0.99, 0.1), m(0.9, 0.3), 0.995).ok, false, "a worse incumbent doesn't lower the bar");
    assert.equal(gate(m(1, 0.1), m(1, 0.3), 0.995).ok, true);
    assert.equal(gate(m(1, 0.4), m(1, 0.3), 0.995).ok, false, "meets recall but sends Jev more");
    assert.equal(gate(m(1, 0.4), m(0.9, 0.3), 0.995).ok, true, "replaces an incumbent that fails recall");
    const suite = (passed: boolean) => ({ passed, scenarios: 3, must_reach: 10, reached: passed ? 10 : 9, reached_by_score: 4, failures: passed ? [] : [{ scenario: "new-error", message: "x", route: "drop" }] });
    assert.equal(gate(m(1, 0.1), null, 0.995, { regression: suite(false) }).ok, false, "every regression scenario must pass");
    assert.equal(gate(m(1, 0.1), null, 0.995, { regression: suite(true), safety: { must_reach: 10, reached: 3 } }).ok, true, "the score-only safety set is a diagnostic");
    assert.match(gate(m(1, 0.1), null, 0.995, { regression: suite(true), safety: { must_reach: 10, reached: 3 } }).reason, /safety set by score 3\/10/);
  });
});

const hasLightgbm = spawnSync("python3", ["-c", "import lightgbm"]).status === 0;

describe("training loop", { skip: !hasLightgbm && "python3 with lightgbm is not installed" }, () => {
  let cf: TestCloudfriend;
  async function run() {
    cf.worker.parseNew();
    cf.worker.startDueBatches();
    await cf.worker.whenIdle();
  }
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
        received_at: 1_700_000_000_000 + i * 60_000,
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

  it("stops sending Jev what Jev keeps rejecting, once trained on its verdicts", async () => {
    // Stage 1 passes every error-like event. Jev says the cache warnings are routine
    // (stage-1 false positives) and the payment failures matter.
    const jev = fakeDecider((events) => {
      const isPay = (e: (typeof events)[number]) => JSON.stringify(e.data).includes("payment");
      const pay = events.filter(isPay);
      return {
        flags: pay.length ? [{ reason: "payments failing", severity: "high" as const, event_ids: pay.map((e) => e.id) }] : [],
        judgments: events.map((e) => ({ event_id: e.id, relevance: isPay(e) ? ("relevant" as const) : ("benign" as const) })),
      };
    });
    cf = await makeCloudfriend({
      decider: jev.adapter,
      config: { triage: true, modelPath: writeModel(tinyModel()), auditRate: 0, verdictTtlMs: 0, perTemplate: 50, batchSize: 100, batchWaitMs: 0, incidentWindowMs: 1 },
    });
    // One round a minute, as real traffic would arrive (rates and ages then mean something).
    const t0 = Date.now() - 15 * 60_000;
    const at = (i: number, k: number) => new Date(t0 + Math.min(i, 13) * 60_000 + k * 100).toISOString();
    const round = (i: number) => [
      ...Array.from({ length: 8 }, (_, k) => ({ timestamp: at(i, k), level: "warn", service: "cache", message: `cache refresh slow, retrying shard ${k} after ${i}ms timeout` })),
      ...Array.from({ length: 12 }, (_, k) => ({ timestamp: at(i, 10 + k), level: "error", service: "billing", message: `payment failed for order ${i * 100 + k}: card declined by provider` })),
      ...Array.from({ length: 5 }, (_, k) => ({ timestamp: at(i, 30 + k), level: "info", service: "web", message: `GET /page/${k} 200` })),
    ];
    for (let i = 0; i < 12; i++) {
      await cf.post("app", round(i));
      cf.worker.parseNew();
      cf.worker.startDueBatches();
      await cf.worker.whenIdle();
    }
    const asked = jev.calls.flat().length;
    assert.ok(count(cf, "labels WHERE y = 0") > 50, "Jev's rejections are stored as labels");
    const before = cf.db.prepare("SELECT route FROM events WHERE data LIKE '%cache refresh%' ORDER BY id DESC LIMIT 1").get() as { route: string };
    assert.equal(before.route, "jev", "before training, stage 1 passes the warnings on");

    const report = await cf.trainer!.train();
    assert.equal(report.status, "promoted", report.reason);

    await cf.post("app", round(99));
    cf.worker.parseNew();
    cf.worker.startDueBatches();
    await cf.worker.whenIdle();
    const routes = cf.db
      .prepare("SELECT data, route FROM events ORDER BY id DESC LIMIT 25")
      .all() as { data: string; route: string }[];
    const warnings = routes.filter((r) => r.data.includes("cache refresh"));
    const payments = routes.filter((r) => r.data.includes("payment"));
    assert.ok(warnings.every((r) => r.route === "drop"), "after training, the rejected kind is dropped by stage 1");
    // By score, or by the rule that a template Jev escalated keeps reaching it.
    assert.ok(payments.every((r) => r.route === "jev" || r.route === "known"), "what Jev escalates still reaches Jev");
    const newlyAsked = jev.calls.flat().slice(asked);
    assert.ok(newlyAsked.length > 0 && newlyAsked.every((e) => JSON.stringify(e.data).includes("payment")), "Jev only sees the payments now");
  });

  it("runs a candidate in shadow and promotes it only if it drops nothing judged relevant", async () => {
    const jev = fakeDecider((events) => {
      const isPay = (e: (typeof events)[number]) => JSON.stringify(e.data).includes("payment");
      return {
        flags: events.filter(isPay).length ? [{ reason: "payments failing", severity: "high" as const, event_ids: events.filter(isPay).map((e) => e.id) }] : [],
        judgments: events.map((e) => ({ event_id: e.id, relevance: isPay(e) ? ("relevant" as const) : ("benign" as const) })),
      };
    });
    cf = await makeCloudfriend({
      decider: jev.adapter,
      config: { triage: true, modelPath: writeModel(tinyModel()), auditRate: 0, verdictTtlMs: 0, perTemplate: 50, batchSize: 100, batchWaitMs: 0, shadowPeriodMs: 60_000, incidentWindowMs: 1 },
    });
    const round = (i: number) => [
      ...Array.from({ length: 8 }, (_, k) => ({ level: "warn", service: "cache", message: `cache refresh slow, retrying shard ${k} after ${i}ms timeout` })),
      ...Array.from({ length: 12 }, (_, k) => ({ level: "error", service: "billing", message: `payment failed for order ${i * 100 + k}: card declined by provider` })),
    ];
    for (let i = 0; i < 12; i++) {
      await cf.post("app", round(i));
      await run();
    }
    const report = await cf.trainer!.train();
    assert.equal(report.status, "shadow", report.reason);
    assert.ok(cf.triage!.shadow, "the candidate scores events in shadow");
    const activeBefore = cf.triage!.classifier!.file.trained_at;
    await cf.post("app", round(50));
    await run();
    assert.ok(count(cf, "events WHERE shadow_score IS NOT NULL AND shadow_route IS NOT NULL") >= 20);
    assert.equal(cf.trainer!.checkShadow(), null, "nothing happens before the period ends");
    const done = cf.trainer!.checkShadow(Date.now() + 120_000)!;
    assert.equal(done.status, "promoted", done.reason);
    assert.notEqual(cf.triage!.classifier!.file.trained_at, activeBefore);
    assert.equal(cf.triage!.shadow, null);
  });

  it("rejects a shadow candidate that would have dropped a relevant event", async () => {
    // Jev calls everything benign, so the kind earns suppression after its first event.
    const d = fakeDecider((events) => ({ flags: [], judgments: events.map((e) => ({ event_id: e.id, relevance: "benign" as const })) }));
    cf = await makeCloudfriend({ decider: d.adapter, config: { triage: true, modelPath: writeModel(tinyModel()), shadowPeriodMs: 60_000, verdictTtlMs: 0, batchWaitMs: 0, auditRate: 0 } });
    await cf.post("app", { level: "error", message: "ledger write failed" });
    await run();
    // A candidate that drops everything, in shadow since two minutes ago.
    const bad = writeModel(tinyModel({ drop_below: 0.999, trained_at: "2026-10-27T00:00:00Z" }));
    cf.triage!.loadShadow(bad);
    cf.db.prepare("INSERT INTO models (id, created_at, path, status, labels, report) VALUES ('mdl_bad', ?, ?, 'shadow', 0, ?)").run(
      Date.now() - 120_000, bad, JSON.stringify({ id: "mdl_bad", status: "shadow", reason: "", model: { drop_below: 0.999 } }),
    );
    // The same error again: the active model still sends it to Jev; the candidate would drop it.
    await cf.post("app", { level: "error", message: "ledger write failed" });
    await run();
    const ev = cf.db.prepare("SELECT id, route, shadow_route FROM events ORDER BY id DESC LIMIT 1").get() as { id: number; route: string; shadow_route: string };
    assert.deepEqual([ev.route, ev.shadow_route], ["jev", "drop"]);
    // A person says it mattered.
    await cf.app.request(`/events/${ev.id}/feedback`, {
      method: "POST",
      headers: { authorization: "Bearer test-admin-key", "content-type": "application/json" },
      body: JSON.stringify({ escalate: true }),
    });
    const done = cf.trainer!.checkShadow()!;
    assert.equal(done.status, "rejected");
    assert.match(done.reason, /would have dropped 1 of 1/);
    assert.equal(cf.triage!.classifier!.file.trained_at, "2026-10-26T00:00:00Z", "the active model stays");
  });

  it("skips training without enough labels", async () => {
    cf = await makeCloudfriend({ decider: fakeDecider().adapter, config: { triage: true, modelPath: writeModel(tinyModel()) } });
    const report = await json(cf.app.request("/model/train", { method: "POST", headers: { authorization: "Bearer test-admin-key" } }));
    assert.equal(report.status, "skipped");
  });
});
