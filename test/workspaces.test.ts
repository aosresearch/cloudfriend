// The multi-workspace sorter: leases (one owner per workspace), fencing, per-workspace state,
// destinations, the decider budget, the backlog counter and process roles.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadAdapters } from "../src/adapters.ts";
import { createCloudfriend, type cloudfriend } from "../src/cloudfriend.ts";
import type { Config } from "../src/config.ts";
import { DEFAULT_WORKSPACE as WS } from "../src/db.ts";
import { Secrets } from "../src/secrets.ts";
import { deliveriesFor } from "../src/store.ts";
import type { ClassifierFile } from "../src/triage/classifier.ts";
import { FEATURE_NAMES, FEATURIZER_VERSION } from "../src/triage/features.ts";
import type { ActionAdapter, CloudfriendEvent, DeciderAdapter, DeciderContext, Decision, FlagDraft } from "../src/types.ts";
import { utcDay } from "../src/usage.ts";
import { ADMIN, count, makeCloudfriend, rows, tempDir, testAdapters, testConfig, waitFor, type TestCloudfriend } from "./helpers.ts";

const WS_B = "ws_b";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A one-tree model: errorish events score ~0.98, the rest ~0.02 (as in triage.test.ts). */
function tinyModel(): string {
  const file: ClassifierFile = {
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
            split_feature: FEATURE_NAMES.indexOf("errorish"),
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
  } as ClassifierFile;
  const p = path.join(tempDir(), "model.json");
  fs.writeFileSync(p, JSON.stringify(file));
  return p;
}

const TRIAGE: Partial<Config> = { triage: true, auditRate: 0, suppressionTtlMs: 0, batchSize: 50, batchWaitMs: 0 };

interface Call {
  workspace: string | undefined;
  ids: string[];
  openFlags: string[];
}

/** A decider that records each call's workspace, events and open flags. `hold` makes calls wait for `release()`. */
function recorder(respond: (events: CloudfriendEvent[]) => FlagDraft[] | Decision = () => [], hold = false) {
  const calls: Call[] = [];
  let open!: () => void;
  let gate = new Promise<void>((r) => (open = r));
  const adapter: DeciderAdapter = {
    async decide(events, ctx: DeciderContext) {
      calls.push({ workspace: ctx.workspace, ids: events.map((e) => e.id), openFlags: (ctx.openFlags ?? []).map((f) => f.id) });
      if (hold) await gate;
      return respond(events);
    },
  };
  return {
    adapter,
    calls,
    release() {
      open();
      gate = Promise.resolve();
    },
  };
}

const flagAll = (events: CloudfriendEvent[]): Decision => ({
  flags: [{ reason: "boom", severity: "high", event_ids: events.map((e) => e.id) }],
  judgments: events.map((e) => ({ event_id: e.id, relevance: "relevant" as const })),
});

/** A second workspace with an ingest secret. */
async function addWorkspace(cf: cloudfriend, id: string, settings: object = {}): Promise<string> {
  await cf.db.query("INSERT INTO workspaces (id, name, created_at, settings) VALUES ($1, $1, $2, $3) ON CONFLICT DO NOTHING", [id, Date.now(), JSON.stringify(settings)]);
  return (await new Secrets(cf.db, id).create("test")).secret;
}

async function postAs(cf: cloudfriend, secret: string, source: string, body: unknown): Promise<Response> {
  return await cf.app.request(`/in/${source}`, { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
}

async function run(cf: cloudfriend) {
  await cf.worker.parseNew();
  await cf.worker.startDueBatches();
  await cf.worker.whenIdle();
}

const opened: cloudfriend[] = [];
async function another(config: Config, decider: DeciderAdapter | null, actions: Record<string, ActionAdapter> = {}, env: NodeJS.ProcessEnv = {}): Promise<cloudfriend> {
  const cf = await createCloudfriend(config, env, await testAdapters(decider, actions));
  opened.push(cf);
  return cf;
}

let cf: TestCloudfriend;
afterEach(async () => {
  for (const o of opened.splice(0)) await o.close(0).catch(() => {});
  await cf?.close(0).catch(() => {});
});

describe("leases", () => {
  it("gives each workspace one owner, and runs two workspaces on two workers at once", async () => {
    const a = recorder(flagAll, true);
    const b = recorder(flagAll, true);
    cf = await makeCloudfriend({ decider: a.adapter, config: { maxWorkspacesPerWorker: 1, batchSize: 1, batchWaitMs: 0 } });
    const other = await another(cf.config, b.adapter);
    const secretB = await addWorkspace(cf, WS_B);
    assert.equal((await cf.post("app", { n: 1 })).status, 202);
    assert.equal((await postAs(cf, secretB, "app", { n: 2 })).status, 202);
    cf.worker.start();
    other.worker.start();
    // Both decider calls are in flight at the same time, one per worker, one workspace each.
    await waitFor(() => a.calls.length === 1 && b.calls.length === 1);
    assert.notEqual(a.calls[0]!.workspace, b.calls[0]!.workspace);
    const leases = await rows(cf, "SELECT workspace_id, owner FROM leases ORDER BY workspace_id");
    assert.equal(leases.length, 2);
    assert.notEqual(leases[0].owner, leases[1].owner);
    const mine = cf.worker.owned.map((h) => h.workspace);
    const theirs = other.worker.owned.map((h) => h.workspace);
    assert.equal(mine.length, 1);
    assert.equal(theirs.length, 1);
    assert.notEqual(mine[0], theirs[0]);
    a.release();
    b.release();
    await waitFor(async () => (await count(cf, "events WHERE decided")) === 2);
    assert.equal(await count(cf, "flags"), 2);
    assert.equal(a.calls.length + b.calls.length, 2, "each workspace was decided once");
  });

  it("takes over a killed worker's workspace once its lease expires, and finishes the work", async () => {
    const d = recorder(flagAll);
    cf = await makeCloudfriend({ decider: d.adapter, config: { leaseTtlMs: 800, leaseRenewMs: 200, batchSize: 1, batchWaitMs: 0 } });
    await cf.post("app", { n: 1 });
    assert.equal(await cf.worker.parseNew(), 1);
    const killedOwner = cf.worker.owner;
    await cf.worker.stop(0, { release: false }); // dies holding the lease
    await cf.post("app", { n: 2 });
    const other = await another(cf.config, d.adapter);
    other.worker.start();
    await sleep(250);
    assert.equal((await rows(cf, "SELECT owner FROM leases"))[0].owner, killedOwner, "not before the lease expires");
    assert.equal(await count(cf, "queue WHERE status = 'new'"), 1);
    await waitFor(async () => (await count(cf, "events WHERE decided")) === 2, 5_000);
    const [lease] = await rows(cf, "SELECT owner, epoch FROM leases");
    assert.equal(lease.owner, other.worker.owner);
    assert.equal(lease.epoch, 2);
    assert.equal(await count(cf, "flags"), 2);
  });

  it("hands a workspace over at once on a graceful stop", async () => {
    const d = recorder(flagAll);
    cf = await makeCloudfriend({ decider: d.adapter, config: { batchSize: 1, batchWaitMs: 0 } }); // 30 s leases
    await cf.post("app", { n: 1 });
    assert.equal(await cf.worker.parseNew(), 1);
    await cf.worker.stop();
    assert.equal((await rows(cf, "SELECT expires_at FROM leases"))[0].expires_at, 0, "released");
    await cf.post("app", { n: 2 });
    const other = await another(cf.config, d.adapter);
    assert.equal(await other.worker.parseNew(), 1, "claimed without waiting for expiry");
    assert.deepEqual(other.worker.owned, [{ workspace: WS, epoch: 2 }]);
  });

  it("releases an idle workspace and saves its history", async () => {
    cf = await makeCloudfriend({ decider: recorder(flagAll).adapter, config: { ...TRIAGE, modelPath: tinyModel(), leaseRenewMs: 50, idleUnloadMs: 100 } });
    await cf.post("app", { level: "error", message: "disk full on db-1" });
    cf.worker.start();
    await waitFor(async () => (await count(cf, "events WHERE decided")) === 1);
    // A workspace leaves `owned` only once its history is saved and its lease released.
    await waitFor(() => cf.worker.owned.length === 0);
    assert.equal((await rows(cf, "SELECT expires_at FROM leases"))[0].expires_at, 0);
    assert.equal(await count(cf, "snapshots WHERE workspace_id = $1", WS), 1);
  });

  it("holds an unloading workspace until it is released, and starts no parse or decide on it meanwhile", async (t) => {
    const d = recorder(flagAll);
    cf = await makeCloudfriend({ decider: d.adapter, config: { ...TRIAGE, modelPath: tinyModel(), leaseRenewMs: 50, idleUnloadMs: 100 } });
    await cf.post("app", { level: "error", message: "disk full on db-1" });
    await run(cf);
    assert.equal(d.calls.length, 1);
    // Hold the idle unload in its snapshot save.
    const triage = cf.worker.triageFor(WS)!;
    const save = triage.saveState.bind(triage);
    let saving!: () => void;
    const started = new Promise<void>((r) => (saving = r));
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    t.mock.method(triage, "saveState", async (q?: Parameters<typeof save>[0]) => {
      saving();
      await gate;
      return save(q);
    });
    cf.worker.start();
    try {
      await started;
      assert.deepEqual(cf.worker.owned, [{ workspace: WS, epoch: 1 }], "still held: the lease isn't released yet");
      // Work that arrives now is left for the next owner: no paid call whose answer the release would discard.
      await cf.post("app", { level: "error", message: "certificate expired for the payments api" });
      await run(cf);
      await sleep(100);
      assert.equal(d.calls.length, 1);
      assert.equal(await count(cf, "queue WHERE status = 'new'"), 1);
    } finally {
      finish();
    }
    // Released, then claimed again for the new work.
    await waitFor(async () => (await count(cf, "events WHERE decided")) === 2);
    assert.equal(d.calls.length, 2);
    assert.equal((await rows(cf, "SELECT epoch FROM leases"))[0].epoch, 2);
    assert.equal(await count(cf, "snapshots WHERE workspace_id = $1", WS), 1);
  });
});

describe("fencing", () => {
  it("refuses a parse by a worker whose lease was taken over", async () => {
    cf = await makeCloudfriend();
    await cf.post("app", { n: 1 });
    assert.equal(await cf.worker.parseNew(), 1);
    await cf.post("app", { n: 2 });
    await cf.db.query("UPDATE leases SET epoch = epoch + 1, owner = 'someone-else'");
    assert.equal(await cf.worker.parseNew(), 0);
    assert.equal(await count(cf, "queue WHERE status = 'new'"), 1, "nothing was written");
    assert.equal(await count(cf, "events"), 1);
    assert.deepEqual(cf.worker.owned, [], "the worker let the workspace go");
  });

  it("discards a decision that comes back after the lease was taken over; the new owner asks again", async () => {
    const d = recorder(flagAll, true);
    cf = await makeCloudfriend({ decider: d.adapter, config: { ...TRIAGE, modelPath: tinyModel() } });
    await cf.post("app", { level: "error", message: "payment provider timeout" });
    await cf.worker.parseNew();
    await cf.worker.startDueBatches();
    await waitFor(() => d.calls.length === 1);
    // Another worker claims the workspace while the decider call is still pending.
    await cf.db.query("UPDATE leases SET epoch = epoch + 1, owner = 'someone-else'");
    d.release();
    await cf.worker.whenIdle();
    assert.equal(await count(cf, "flags"), 0);
    assert.equal(await count(cf, "decisions"), 0);
    assert.equal(await count(cf, "labels"), 0);
    assert.equal(await count(cf, "events WHERE NOT decided"), 1);
    assert.equal(await count(cf, "usage WHERE jev_calls > 0"), 0);
    assert.deepEqual(cf.worker.owned, []);

    // That worker goes away; the next owner decides the event.
    await cf.db.query("UPDATE leases SET expires_at = 0");
    const again = recorder(flagAll);
    const other = await another(cf.config, again.adapter);
    await run(other);
    assert.equal(again.calls.length, 1);
    assert.equal(await count(cf, "flags"), 1);
    assert.equal(await count(cf, "events WHERE decided"), 1);
  });
});

describe("workspace isolation", () => {
  it("keeps featurizer history, verdict caches, prompts and open flags apart", async () => {
    const d = recorder(flagAll);
    cf = await makeCloudfriend({ decider: d.adapter, config: { ...TRIAGE, modelPath: tinyModel() } });
    const secretB = await addWorkspace(cf, WS_B);
    const err = (ms: number) => ({ level: "error", message: `payment provider timeout after ${ms}ms` });
    await cf.post("app", [err(1), err(2), err(3)]);
    await run(cf);
    assert.equal(d.calls.length, 1);
    const [f1] = await rows(cf, "SELECT id FROM flags WHERE workspace_id = $1", WS);
    // The same template again in the default workspace: its cached verdict answers.
    await cf.post("app", err(4));
    await run(cf);
    assert.equal(d.calls.length, 1, "cached");
    // In the other workspace, nothing is cached: the decider is asked, without the other's flag.
    await postAs(cf, secretB, "app", err(5));
    await run(cf);
    assert.equal(d.calls.length, 2);
    assert.equal(d.calls[1]!.workspace, WS_B);
    assert.deepEqual(d.calls[1]!.openFlags, []);
    // New kinds in both: each prompt lists only its own workspace's open flags.
    await cf.post("app", { level: "error", message: "ledger write failed" });
    await postAs(cf, secretB, "app", { level: "error", message: "ledger write failed" });
    await run(cf);
    assert.equal(d.calls.length, 4);
    for (const call of d.calls) {
      const evWs = await rows(cf, "SELECT DISTINCT workspace_id FROM events WHERE id = ANY($1::bigint[])", call.ids.map(Number));
      assert.deepEqual(evWs.map((r) => r.workspace_id), [call.workspace], "a batch never mixes workspaces");
      for (const id of call.openFlags) assert.equal((await rows(cf, "SELECT workspace_id FROM flags WHERE id = $1", id))[0].workspace_id, call.workspace);
    }
    const defCall = d.calls.slice(2).find((c) => c.workspace === WS)!;
    assert.ok(defCall.openFlags.includes(f1.id));

    // Separate featurizer histories for the same template.
    const [{ template }] = await rows(cf, "SELECT template FROM events WHERE workspace_id = $1 LIMIT 1", WS);
    assert.equal(cf.worker.triageFor(WS)!.featurizer.context(template)!.seen_total, 4);
    assert.equal(cf.worker.triageFor(WS_B)!.featurizer.context(template)!.seen_total, 1);

    // Jev's outcome per event: judgment, flag and call; a cached one has no call.
    const evs = await rows(cf, "SELECT id, judgment, flag_id, decision_id FROM events WHERE workspace_id = $1 ORDER BY id LIMIT 4", WS);
    const [dec] = await rows(cf, "SELECT id FROM decisions WHERE workspace_id = $1 ORDER BY created_at LIMIT 1", WS);
    for (const e of evs.slice(0, 3)) assert.deepEqual({ j: e.judgment, f: e.flag_id, d: e.decision_id }, { j: "relevant", f: f1.id, d: dec.id });
    assert.deepEqual({ j: evs[3].judgment, f: evs[3].flag_id, d: evs[3].decision_id }, { j: "relevant", f: f1.id, d: null });

    await cf.close(0);
    assert.equal((await rows(await another(cf.config, null), "SELECT count(*) AS n FROM snapshots")).at(0).n, 2, "one snapshot per workspace");
  });

  it("applies a person's feedback given to a web process to the worker that owns the workspace", async () => {
    const d = recorder(flagAll);
    cf = await makeCloudfriend({ decider: d.adapter, config: { ...TRIAGE, modelPath: tinyModel(), role: "web" } });
    const worker = await another({ ...cf.config, role: "worker" }, d.adapter);
    worker.start();
    await cf.post("app", { level: "error", message: "replica lag over 30s on db 2" });
    await waitFor(async () => (await count(cf, "flags")) === 1);
    await waitFor(() => worker.worker.triageFor(WS)?.escalated.size === 1);
    const [flag] = await rows(cf, "SELECT id FROM flags");
    const res = await cf.app.request(`/flags/${flag.id}/feedback`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify({ verdict: "false_positive" }),
    });
    assert.equal(res.status, 200);
    await waitFor(() => worker.worker.triageFor(WS)?.escalated.size === 0, 5_000);
  });
});

describe("destinations", () => {
  function capture(fail?: string) {
    const calls: { flag: string; config: Record<string, unknown> | undefined }[] = [];
    const adapter: ActionAdapter = {
      async run(flag, ctx) {
        calls.push({ flag: flag.id, config: ctx.config });
        if (fail) throw new Error(fail);
      },
    };
    return { adapter, calls };
  }

  const dest = (c: cloudfriend, id: string, ws: string, kind: string, config: object) =>
    c.db.query("INSERT INTO destinations (id, workspace_id, name, kind, config, created_at) VALUES ($1, $2, $1, $3, $4, $5)", [id, ws, kind, JSON.stringify(config), Date.now()]);

  it("delivers a workspace's flags to its destinations with their config, and fails a deleted one without retrying", async () => {
    const hook = capture();
    const bad = capture("hook replied 500");
    cf = await makeCloudfriend({ decider: recorder(flagAll).adapter, actions: { hook: hook.adapter, bad: bad.adapter }, config: { batchSize: 1, batchWaitMs: 0 } });
    const secretB = await addWorkspace(cf, WS_B);
    await dest(cf, "dst_live", WS_B, "hook", { url: "https://example.test/a" });
    await dest(cf, "dst_gone", WS_B, "hook", { url: "https://example.test/b" });
    await dest(cf, "dst_bad", WS_B, "bad", {});
    await dest(cf, "dst_old", WS_B, "hook", {});
    await cf.db.query("UPDATE destinations SET deleted_at = 1 WHERE id = 'dst_old'");
    await dest(cf, "dst_other", WS, "hook", { url: "https://example.test/default" });
    await postAs(cf, secretB, "app", { n: 1 });
    await run(cf);
    const [flag] = await rows(cf, "SELECT id FROM flags WHERE workspace_id = $1", WS_B);
    const ds = await rows(cf, "SELECT action FROM deliveries WHERE flag_id = $1 ORDER BY action", flag.id);
    assert.deepEqual(ds.map((r) => r.action), ["dst_bad", "dst_gone", "dst_live"], "its own live destinations, nothing else");

    await cf.db.query("UPDATE destinations SET deleted_at = $1 WHERE id = 'dst_gone'", [Date.now()]);
    await cf.worker.deliverDue();
    assert.deepEqual(hook.calls, [{ flag: flag.id, config: { url: "https://example.test/a" } }]);
    const st = Object.fromEntries((await rows(cf, "SELECT action, status, attempts, last_error FROM deliveries WHERE flag_id = $1", flag.id)).map((r) => [r.action, r]));
    assert.equal(st.dst_live.status, "ok");
    assert.equal(st.dst_gone.status, "failed");
    assert.equal(st.dst_gone.last_error, "destination was deleted");
    assert.equal(st.dst_bad.status, "pending");
    assert.equal(st.dst_bad.last_error, "hook replied 500");
    const d = Object.fromEntries((await rows(cf, "SELECT id, last_delivery_at, last_error FROM destinations")).map((r) => [r.id, r]));
    assert.ok(d.dst_live.last_delivery_at > 0);
    assert.equal(d.dst_live.last_error, null);
    assert.equal(d.dst_bad.last_error, "hook replied 500");
    assert.equal(d.dst_gone.last_delivery_at, null);

    const info = (await deliveriesFor(cf.db, WS_B, flag.id)).find((x) => x.destination_id === "dst_live")!;
    assert.deepEqual([info.action, info.destination_name], ["hook", "dst_live"]);
  });

  it("creates destinations from SLACK_WEBHOOK_URL and WEBHOOK_URL once, and delivers through them", async () => {
    const calls: { kind: string; config: unknown }[] = [];
    const envAction = (kind: string, envVar: string): ActionAdapter => ({
      enabled: (env) => Boolean(env[envVar]),
      async run(_flag, ctx) {
        calls.push({ kind, config: ctx.config });
      },
    });
    const env = { SLACK_WEBHOOK_URL: "https://hooks.slack.test/T/B/X", WEBHOOK_URL: "https://hook.test/in", WEBHOOK_SECRET: "s3cret" };
    const actions = { slack: envAction("slack", "SLACK_WEBHOOK_URL"), webhook: envAction("webhook", "WEBHOOK_URL") };
    const builtins = await loadAdapters();
    const config = await testConfig();
    const first = await createCloudfriend({ ...config, batchSize: 1, batchWaitMs: 0, decider: "test" }, env, { ...builtins, deciders: new Map([["test", recorder(flagAll).adapter]]), actions: new Map(Object.entries(actions)) });
    opened.push(first);
    const seeded = await rows(first, "SELECT kind, config FROM destinations WHERE workspace_id = $1 ORDER BY kind", WS);
    assert.deepEqual(seeded, [
      { kind: "slack", config: { url: env.SLACK_WEBHOOK_URL } },
      { kind: "webhook", config: { url: env.WEBHOOK_URL, signing_secret: "s3cret" } },
    ]);
    await first.close(0);
    opened.pop();
    const second = await createCloudfriend({ ...config, batchSize: 1, batchWaitMs: 0, decider: "test" }, env, { ...builtins, deciders: new Map([["test", recorder(flagAll).adapter]]), actions: new Map(Object.entries(actions)) });
    opened.push(second);
    assert.equal(await count(second, "destinations"), 2, "only once");
    const secret = (await second.secrets.create("x")).secret;
    await postAs(second, secret, "app", { n: 1 });
    await run(second);
    const ds = await rows(second, "SELECT action FROM deliveries");
    assert.equal(ds.length, 2);
    assert.ok(ds.every((r) => r.action.startsWith("dst_")), "through the destinations, not the env actions by name");
    await second.worker.deliverDue();
    assert.deepEqual(calls.sort((a, b) => a.kind.localeCompare(b.kind)), [
      { kind: "slack", config: { url: env.SLACK_WEBHOOK_URL } },
      { kind: "webhook", config: { url: env.WEBHOOK_URL, signing_secret: "s3cret" } },
    ]);
  });
});

describe("decider budget", () => {
  it("records each call's cost, and at the cap the workspace goes classifier-only while others carry on", async () => {
    const d = recorder((events) => ({
      flags: [],
      judgments: events.map((e) => ({ event_id: e.id, relevance: "benign" as const })),
      record: { model: "m", cost_usd: 0.6 },
    }));
    cf = await makeCloudfriend({ decider: d.adapter, config: { ...TRIAGE, modelPath: tinyModel(), verdictTtlMs: 0, jevDailyBudgetUsd: 1 } });
    const secretB = await addWorkspace(cf, WS_B);
    const secretC = await addWorkspace(cf, "ws_c", { jev_budget_usd: 0 });
    for (const msg of ["inventory sync crashed", "email queue stalled", "checkout totals mismatch"]) {
      await cf.post("app", { level: "error", message: msg });
      await run(cf);
    }
    assert.equal(d.calls.filter((c) => c.workspace === WS).length, 2, "the third batch is over budget");
    const [u] = await rows(cf, "SELECT jev_calls, jev_spend_usd FROM usage WHERE workspace_id = $1 AND day = $2", WS, utcDay());
    assert.equal(u.jev_calls, 2);
    assert.ok(Math.abs(u.jev_spend_usd - 1.2) < 1e-9);
    assert.deepEqual((await rows(cf, "SELECT cost_usd FROM decisions")).map((r) => r.cost_usd), [0.6, 0.6]);
    const [over] = await rows(cf, "SELECT decided, judgment FROM events WHERE workspace_id = $1 ORDER BY id DESC LIMIT 1", WS);
    assert.equal(over.decided, true);
    assert.equal(over.judgment, null);
    assert.equal(await count(cf, "flags WHERE workspace_id = $1 AND decider = 'classifier'", WS), 1, "escalated by the classifier alone");

    await postAs(cf, secretB, "app", { level: "error", message: "inventory sync crashed" });
    await postAs(cf, secretC, "app", { level: "error", message: "inventory sync crashed" });
    await run(cf);
    assert.equal(d.calls.filter((c) => c.workspace === WS_B).length, 1, "another workspace has its own budget");
    assert.equal(d.calls.filter((c) => c.workspace === "ws_c").length, 0, "a workspace's own budget overrides the global one");
    assert.equal(await count(cf, "flags WHERE workspace_id = 'ws_c' AND decider = 'classifier'"), 1);
  });

  it("never lowers the spend it counts within a day when it reads the usage again", async () => {
    const d = recorder((events) => ({ flags: [], judgments: events.map((e) => ({ event_id: e.id, relevance: "benign" as const })), record: { model: "m", cost_usd: 0.6 } }));
    // leaseRenewMs 1: every pass renews the lease and reads settings and spend again.
    cf = await makeCloudfriend({ decider: d.adapter, config: { ...TRIAGE, modelPath: tinyModel(), verdictTtlMs: 0, jevDailyBudgetUsd: 1, leaseRenewMs: 1 } });
    for (const msg of ["inventory sync crashed", "email queue stalled"]) {
      await cf.post("app", { level: "error", message: msg });
      await run(cf);
    }
    assert.equal(d.calls.length, 2);
    // A read that predates the second call's commit, as a renewal running alongside it would see.
    await cf.db.query("UPDATE usage SET jev_spend_usd = 0.6 WHERE workspace_id = $1", [WS]);
    await cf.post("app", { level: "error", message: "checkout totals mismatch" });
    await run(cf);
    await run(cf);
    assert.equal(d.calls.length, 2, "still over budget");
  });
});

describe("roles and the backlog", () => {
  it("counts the backlog per workspace across a web-only and a worker-only process, and replies 503 at the limit", async () => {
    cf = await makeCloudfriend({ config: { role: "web", maxQueue: 2 } });
    const worker = await another({ ...cf.config, role: "worker" }, null);
    const secretB = await addWorkspace(cf, WS_B);
    assert.equal((await cf.post("app", { n: 1 })).status, 202);
    assert.equal((await cf.post("app", { n: 2 })).status, 202);
    const full = await cf.post("app", { n: 3 });
    assert.equal(full.status, 503);
    assert.equal(full.headers.get("retry-after"), "5");
    assert.equal((await postAs(cf, secretB, "app", { n: 4 })).status, 202, "the limit is per workspace");
    const backlog = async () => Object.fromEntries((await rows(cf, "SELECT id, backlog FROM workspaces ORDER BY id")).map((r) => [r.id, r.backlog]));
    assert.deepEqual(await backlog(), { [WS]: 2, [WS_B]: 1 });
    assert.equal((await rows(cf, "SELECT events FROM usage WHERE workspace_id = $1", WS))[0].events, 2);

    assert.equal(await worker.worker.parseNew(), 3);
    assert.deepEqual(await backlog(), { [WS]: 0, [WS_B]: 0 });
    // The web process sees the worker's progress within about a second.
    await waitFor(async () => (await cf.post("app", { n: 5 })).status === 202, 3_000);
    assert.equal(await count(cf, "queue WHERE status = 'new' AND workspace_id = $1", WS), 1);
  });

  it("web processes nothing, and worker serves only /healthz", async () => {
    cf = await makeCloudfriend({ decider: recorder(flagAll).adapter, config: { role: "web", batchSize: 1, batchWaitMs: 0 } });
    const worker = await another({ ...cf.config, role: "worker" }, recorder(flagAll).adapter);
    cf.start();
    assert.equal((await cf.post("app", { n: 1 })).status, 202);
    await sleep(300);
    assert.equal(await count(cf, "queue WHERE status = 'new'"), 1);
    assert.equal(await count(cf, "leases"), 0);
    assert.equal(await cf.worker.parseNew(), 0);

    const post = await worker.app.request("/in/app", { method: "POST", headers: { authorization: `Bearer ${cf.secret}` }, body: "{}" });
    assert.equal(post.status, 404);
    assert.equal((await worker.app.request("/flags", { headers: { authorization: `Bearer ${ADMIN}` } })).status, 404);
    const health = await worker.app.request("/healthz");
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { ok: boolean }).ok, true);
    assert.equal(worker.bootSecret, null);

    worker.start();
    await waitFor(async () => (await count(cf, "events WHERE decided")) === 1);
    assert.equal(await count(cf, "flags"), 1);
  });
});
