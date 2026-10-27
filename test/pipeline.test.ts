import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createCloudfriend } from "../src/cloudfriend.ts";
import { deliveryBackoff, MAX_DELIVERY_ATTEMPTS } from "../src/worker.ts";
import pg from "pg";
import { DEFAULT_WORKSPACE as WS } from "../src/db.ts";
import { count, fakeAction, fakeDecider, makeCloudfriend, rows, testAdapters, testConfig, waitFor, type TestCloudfriend } from "./helpers.ts";

let cloudfriend: TestCloudfriend;
afterEach(async () => {
  await cloudfriend?.close(0).catch(() => {});
});

const flagFirst = fakeDecider((events) => [{ reason: "boom", severity: "high", event_ids: [events[0]!.id] }]);

describe("parse stage", () => {
  it("turns queued requests into events and marks them done", async () => {
    cloudfriend = await makeCloudfriend();
    await cloudfriend.post("myapp", [{ a: 1 }, { a: 2 }]);
    await cloudfriend.post("sentry", { action: "created", data: { issue: { id: "7" } } });
    assert.equal(await cloudfriend.worker.parseNew(), 2);
    assert.equal(await count(cloudfriend, "queue WHERE status = 'done'"), 2);
    const events = await rows(cloudfriend, "SELECT source, data, type, group_key FROM events ORDER BY id");
    assert.deepEqual(
      events.map((e) => [e.source, JSON.parse(e.data), e.type, e.group_key]),
      [
        ["myapp", { a: 1 }, null, null],
        ["myapp", { a: 2 }, null, null],
        ["sentry", { action: "created", data: { issue: { id: "7" } } }, "issue.created", "issue:7"],
      ],
    );
    assert.equal(cloudfriend.intake.backlog, 0);
  });

  it("drops a request when parse returns []", async () => {
    cloudfriend = await makeCloudfriend();
    await cloudfriend.post("sentry", { action: "created", data: { installation: { uuid: "x" } }, installation: { uuid: "x" } });
    await cloudfriend.worker.parseNew();
    assert.equal(await count(cloudfriend, "events"), 0);
    assert.equal(await count(cloudfriend, "queue WHERE status = 'done'"), 1);
  });

  it("keeps a request as 'failed' when its adapter throws", async () => {
    const adapters = await testAdapters(null);
    adapters.sources = new Map([...adapters.sources, ["broken", { parse: () => { throw new Error("nope"); } }]]);
    const s = await createCloudfriend(await testConfig({ decider: "test" }), {}, adapters);
    try {
      await rows(s, "INSERT INTO queue (workspace_id, source, received_at, body) VALUES ($1, 'broken', $2, $3)", WS, Date.now(), Buffer.from("{}"));
      await rows(s, "INSERT INTO queue (workspace_id, source, received_at, body) VALUES ($1, 'myapp', $2, $3)", WS, Date.now(), Buffer.from("{}"));
      await s.worker.parseNew();
      const statuses = await rows(s, "SELECT source, status FROM queue ORDER BY id");
      assert.deepEqual(statuses.map((r) => [r.source, r.status]), [["broken", "failed"], ["myapp", "done"]]);
      assert.equal(await count(s, "events"), 1);
    } finally {
      await s.close(0);
    }
  });
});

describe("decide stage", () => {
  it("decides as soon as a batch reaches the size limit", async () => {
    const d = fakeDecider();
    cloudfriend = await makeCloudfriend({ decider: d.adapter, config: { batchSize: 3, batchWaitMs: 60_000 } });
    for (let i = 0; i < 2; i++) await cloudfriend.post("myapp", { i });
    await cloudfriend.worker.parseNew();
    await cloudfriend.worker.startDueBatches();
    await cloudfriend.worker.whenIdle();
    assert.equal(d.calls.length, 0, "two events, under the size limit and the wait: no call yet");

    await cloudfriend.post("myapp", { i: 2 });
    await cloudfriend.worker.parseNew();
    await cloudfriend.worker.startDueBatches();
    await cloudfriend.worker.whenIdle();
    assert.equal(d.calls.length, 1);
    assert.deepEqual(d.calls[0]!.map((e) => (e.data as any).i), [0, 1, 2]);
    assert.equal(await count(cloudfriend, "events WHERE NOT decided"), 0);
  });

  it("decides a partial batch once the oldest event has waited long enough", async () => {
    const d = fakeDecider();
    cloudfriend = await makeCloudfriend({ decider: d.adapter, config: { batchSize: 100, batchWaitMs: 10_000 } });
    await cloudfriend.post("myapp", {});
    await cloudfriend.worker.parseNew();
    await cloudfriend.worker.startDueBatches(Date.now() + 9_000);
    await cloudfriend.worker.whenIdle();
    assert.equal(d.calls.length, 0);
    await cloudfriend.worker.startDueBatches(Date.now() + 10_001);
    await cloudfriend.worker.whenIdle();
    assert.equal(d.calls.length, 1);
  });

  it("caps each decide() call at the batch size", async () => {
    const d = fakeDecider();
    cloudfriend = await makeCloudfriend({ decider: d.adapter, config: { batchSize: 3, deciderConcurrency: 4 } });
    await cloudfriend.post("myapp", Array.from({ length: 8 }, (_, i) => ({ i })));
    await cloudfriend.worker.parseNew();
    await cloudfriend.worker.startDueBatches(Date.now() + 60_000);
    await cloudfriend.worker.whenIdle();
    // The three calls run concurrently, so they may reach the decider in any order.
    assert.deepEqual(d.calls.map((c) => c.length).sort((a, b) => b - a), [3, 3, 2]);
    const seen = d.calls.flat().map((e) => e.id);
    assert.equal(new Set(seen).size, 8, "no event is decided twice");
  });

  it("passes only source, received_at, data (and hints) to the decider", async () => {
    const d = fakeDecider();
    cloudfriend = await makeCloudfriend({ decider: d.adapter, config: { batchSize: 1 } });
    await cloudfriend.post("myapp", { msg: "hi" });
    await cloudfriend.worker.parseNew();
    await cloudfriend.worker.startDueBatches();
    await cloudfriend.worker.whenIdle();
    const [e] = d.calls[0]!;
    assert.deepEqual(Object.keys(e!).sort(), ["data", "id", "received_at", "source"]);
    assert.ok(!Number.isNaN(Date.parse(e!.received_at)));
  });

  it("stores flags with their events and queues a delivery per action", async () => {
    const act = fakeAction();
    cloudfriend = await makeCloudfriend({ decider: flagFirst.adapter, actions: { a: act.adapter, b: act.adapter }, config: { batchSize: 2 } });
    await cloudfriend.post("myapp", [{ n: 1 }, { n: 2 }]);
    await cloudfriend.worker.parseNew();
    await cloudfriend.worker.startDueBatches();
    await cloudfriend.worker.whenIdle();
    const [flag] = await rows(cloudfriend, "SELECT * FROM flags");
    assert.equal(flag.reason, "boom");
    assert.equal(flag.severity, "high");
    assert.equal(flag.decider, "test");
    assert.match(flag.id, /^flg_[0-9a-f]{20}$/);
    assert.equal(flag.event_ids.length, 1);
    assert.equal(await count(cloudfriend, "deliveries WHERE status = 'pending'"), 2);
  });

  it("ignores flags that point at events outside the batch", async () => {
    const d = fakeDecider(() => [
      { reason: "made up", severity: "low", event_ids: ["99999"] },
      { reason: "", severity: "low", event_ids: ["1"] },
    ]);
    cloudfriend = await makeCloudfriend({ decider: d.adapter, config: { batchSize: 1 } });
    await cloudfriend.post("myapp", {});
    await cloudfriend.worker.parseNew();
    await cloudfriend.worker.startDueBatches();
    await cloudfriend.worker.whenIdle();
    assert.equal(await count(cloudfriend, "flags"), 0);
    assert.equal(await count(cloudfriend, "events WHERE decided"), 1);
  });

  it("keeps events queued when the decider fails, and retries after a backoff", async () => {
    let fail = true;
    const d = fakeDecider(() => {
      if (fail) throw new Error("model down");
      return [];
    });
    cloudfriend = await makeCloudfriend({ decider: d.adapter, config: { batchSize: 1 } });
    await cloudfriend.post("myapp", {});
    await cloudfriend.worker.parseNew();
    await cloudfriend.worker.startDueBatches();
    await cloudfriend.worker.whenIdle();
    assert.equal(await count(cloudfriend, "events WHERE NOT decided"), 1);

    fail = false;
    await cloudfriend.worker.startDueBatches(); // still backing off
    await cloudfriend.worker.whenIdle();
    assert.equal(d.calls.length, 1);
    await cloudfriend.worker.startDueBatches(Date.now() + 1_500);
    await cloudfriend.worker.whenIdle();
    assert.equal(d.calls.length, 2);
    assert.equal(await count(cloudfriend, "events WHERE NOT decided"), 0);
  });

  it("stores events without deciding when no decider is configured", async () => {
    cloudfriend = await makeCloudfriend({ decider: null, config: { batchSize: 1 } });
    assert.equal(cloudfriend.decider, null);
    await cloudfriend.post("myapp", {});
    await cloudfriend.worker.parseNew();
    await cloudfriend.worker.startDueBatches(Date.now() + 60_000);
    assert.equal(await count(cloudfriend, "events WHERE NOT decided"), 1);
  });
});

describe("deliver stage", () => {
  async function flagged(actions: Record<string, any>) {
    cloudfriend = await makeCloudfriend({ decider: flagFirst.adapter, actions, config: { batchSize: 1 } });
    await cloudfriend.post("myapp", { msg: "x" });
    await cloudfriend.worker.parseNew();
    await cloudfriend.worker.startDueBatches();
    await cloudfriend.worker.whenIdle();
    return (await rows(cloudfriend, "SELECT id FROM flags"))[0].id as string;
  }

  it("runs each action with the flag and its events, then marks it ok", async () => {
    const act = fakeAction();
    const flagId = await flagged({ slack: act.adapter });
    await cloudfriend.worker.deliverDue();
    assert.deepEqual(act.calls, [{ flagId, eventIds: ["1"] }]);
    const [d] = await rows(cloudfriend, "SELECT status, attempts FROM deliveries");
    assert.deepEqual({ ...d }, { status: "ok", attempts: 1 });
    await cloudfriend.worker.deliverDue();
    assert.equal(act.calls.length, 1, "an ok delivery is not repeated");
  });

  it("retries a failing action with backoff, then gives up", async () => {
    const act = fakeAction(async () => {
      throw new Error("slack down");
    });
    await flagged({ slack: act.adapter });
    await cloudfriend.worker.deliverDue();
    let [d] = await rows(cloudfriend, "SELECT * FROM deliveries");
    assert.equal(d.status, "pending");
    assert.equal(d.attempts, 1);
    assert.equal(d.last_error, "slack down");
    assert.ok(d.next_attempt_at >= Date.now() + deliveryBackoff(1) - 1_000);

    await cloudfriend.worker.deliverDue();
    assert.equal(act.calls.length, 1, "not retried before the backoff");

    for (let i = 1; i < MAX_DELIVERY_ATTEMPTS; i++) await cloudfriend.worker.deliverDue(Date.now() + 10 * 3_600_000);
    [d] = await rows(cloudfriend, "SELECT * FROM deliveries");
    assert.equal(d.status, "failed");
    assert.equal(d.attempts, MAX_DELIVERY_ATTEMPTS);
    assert.equal(act.calls.length, MAX_DELIVERY_ATTEMPTS);
  });

  it("treats run() returning false as a failure", async () => {
    const act = fakeAction(async () => false);
    await flagged({ hook: act.adapter });
    await cloudfriend.worker.deliverDue();
    assert.equal((await rows(cloudfriend, "SELECT last_error FROM deliveries"))[0].last_error, "run() returned false");
  });

  it("isolates actions: one failing does not block another", async () => {
    const ok = fakeAction();
    const bad = fakeAction(async () => {
      throw new Error("x");
    });
    await flagged({ ok: ok.adapter, bad: bad.adapter });
    await cloudfriend.worker.deliverDue();
    const ds = await rows(cloudfriend, "SELECT action, status FROM deliveries ORDER BY action");
    assert.deepEqual(ds.map((r) => [r.action, r.status]), [["bad", "pending"], ["ok", "ok"]]);
  });
});

describe("delivery claims", () => {
  /** `n` flags, each with one due delivery to action `a`. */
  async function dueDeliveries(cf: TestCloudfriend, n: number) {
    await rows(cf, "INSERT INTO flags (id, workspace_id, created_at, reason, severity, event_ids, decider) SELECT 'flg_' || i, $1, $2, 'r', 'low', '[]', 'test' FROM generate_series(1, $3::int) i", WS, Date.now(), n);
    await rows(cf, "INSERT INTO deliveries (flag_id, workspace_id, action, next_attempt_at, updated_at) SELECT id, $1, 'a', $2, $2 FROM flags", WS, Date.now());
  }

  it("runs each delivery once when two workers claim at the same time", async () => {
    const slow = async () => void (await new Promise((r) => setTimeout(r, 5)));
    const mine = fakeAction(slow);
    const theirs = fakeAction(slow);
    cloudfriend = await makeCloudfriend({ decider: null, actions: { a: mine.adapter } });
    await dueDeliveries(cloudfriend, 120);
    // A second process on the same database.
    const other = await createCloudfriend(cloudfriend.config, {}, await testAdapters(null, { a: theirs.adapter }));
    try {
      for (let round = 0; round < 4; round++) await Promise.all([cloudfriend.worker.deliverDue(), other.worker.deliverDue()]);
      const a = mine.calls.map((c) => c.flagId);
      const b = theirs.calls.map((c) => c.flagId);
      assert.ok(a.length && b.length, `both claimed some (${a.length} and ${b.length})`);
      assert.equal(a.length + b.length, 120, "every delivery ran once");
      assert.equal(new Set([...a, ...b]).size, 120, "and none twice");
      assert.equal(await count(cloudfriend, "deliveries WHERE status = 'ok' AND attempts = 1"), 120);
    } finally {
      await other.close(0);
    }
  });

  it("skips deliveries another claimer has locked instead of waiting for them", async () => {
    cloudfriend = await makeCloudfriend({ decider: null, actions: { a: fakeAction().adapter } });
    await dueDeliveries(cloudfriend, 4);
    const holder = new pg.Client({ connectionString: cloudfriend.config.databaseUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM deliveries WHERE flag_id IN ('flg_1', 'flg_2') FOR UPDATE");
      const claimed = await cloudfriend.worker.claimDeliveries();
      assert.deepEqual(claimed.map((d) => d.flag_id).sort(), ["flg_3", "flg_4"]);
      await holder.query("ROLLBACK");
      const rest = await cloudfriend.worker.claimDeliveries();
      assert.deepEqual(rest.map((d) => d.flag_id).sort(), ["flg_1", "flg_2"], "once released; the claimed ones are not due again");
    } finally {
      await holder.end();
    }
  });

  it("hands a claim back when shutdown interrupts the delivery", async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const hang = fakeAction((_flag, ctx) => {
      started();
      return new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    cloudfriend = await makeCloudfriend({ decider: null, actions: { a: hang.adapter } });
    await dueDeliveries(cloudfriend, 1);
    const due = (await rows(cloudfriend, "SELECT next_attempt_at FROM deliveries"))[0].next_attempt_at;
    cloudfriend.worker.start();
    await running;
    await cloudfriend.close(0);
    const db = new pg.Client({ connectionString: cloudfriend.config.databaseUrl });
    await db.connect();
    const [d] = (await db.query("SELECT status, attempts, next_attempt_at::float8 AS due FROM deliveries")).rows;
    await db.end();
    assert.deepEqual({ ...d }, { status: "pending", attempts: 0, due }, "due again at once, not after the claim expires");
  });
});

describe("durability", () => {
  it("processes requests left 'new' by a crash when it starts again", async () => {
    const config = await testConfig({ decider: "test", batchSize: 2 });
    const first = await createCloudfriend(config, {}, await testAdapters(null));
    await rows(first, "INSERT INTO queue (workspace_id, source, received_at, body) VALUES ($1, 'myapp', $2, $3)", WS, Date.now(), Buffer.from('{"n":1}'));
    await rows(first, "INSERT INTO queue (workspace_id, source, received_at, body) VALUES ($1, 'myapp', $2, $3)", WS, Date.now(), Buffer.from('{"n":2}'));
    await first.db.end(); // simulate a crash: no worker ran, nothing marked done

    const act = fakeAction();
    const second = await createCloudfriend(config, {}, await testAdapters(flagFirst.adapter, { a: act.adapter }));
    try {
      assert.equal(second.bootSecret, null, "no new secret on restart");
      assert.equal(second.intake.backlog, 2);
      second.worker.start();
      await waitFor(() => act.calls.length === 1);
      assert.equal(await count(second, "queue WHERE status = 'new'"), 0);
    } finally {
      await second.close(0);
    }
  });

  it("re-decides events whose decision was interrupted", async () => {
    const config = await testConfig({ decider: "test", batchSize: 1 });
    let release!: () => void;
    const hang = fakeDecider(() => new Promise((r) => (release = () => r([]))));
    const first = await createCloudfriend(config, {}, await testAdapters(hang.adapter));
    await first.app.request("/in/myapp", {
      method: "POST",
      headers: { authorization: `Bearer ${first.bootSecret}` },
      body: "{}",
    });
    await first.worker.parseNew();
    await first.worker.startDueBatches();
    assert.equal(hang.calls.length, 1);
    await first.close(0); // shut down mid-decision
    release();

    const d = fakeDecider();
    const second = await createCloudfriend(config, {}, await testAdapters(d.adapter));
    try {
      await second.worker.startDueBatches();
      await second.worker.whenIdle();
      assert.equal(d.calls.length, 1);
    } finally {
      await second.close(0);
    }
  });
});

describe("shutdown", () => {
  it("starts no new decides once close() is called, but still commits accepted requests", async () => {
    const d = fakeDecider();
    cloudfriend = await makeCloudfriend({ decider: d.adapter, config: { batchSize: 1, batchWaitMs: 0, pollMs: 5 } });
    await cloudfriend.post("myapp", { n: 1 });
    cloudfriend.worker.start();
    await waitFor(() => d.calls.length === 1);

    const pending = cloudfriend.post("myapp", { n: 2 }); // still waiting on its commit
    const closing = cloudfriend.close(1_000, 60);
    assert.equal((await pending).status, 202);
    await closing;
    assert.equal(d.calls.length, 1, "the second event is left for the next start, not decided during shutdown");
  });
});

describe("cleanup", () => {
  it("deletes processed requests and decided events past the window, keeps the rest", async () => {
    cloudfriend = await makeCloudfriend({ config: { retentionMs: 1_000, batchSize: 1 } });
    const old = Date.now() - 5_000;
    const insert = (t: number, status: string) =>
      rows(cloudfriend, "INSERT INTO queue (workspace_id, source, received_at, body, status) VALUES ($1, 'x', $2, $3, $4)", WS, t, Buffer.from("{}"), status);
    await insert(old, "done");
    await insert(old, "failed");
    await insert(old, "new"); // never delete unprocessed requests
    await insert(Date.now(), "done");
    const ev = (t: number, decided: boolean) =>
      rows(cloudfriend, "INSERT INTO events (workspace_id, queue_id, source, received_at, data, decided) VALUES ($1, 0, 'x', $2, '{}', $3)", WS, t, decided);
    await ev(old, true);
    await ev(old, false); // undecided events wait for the decider
    await ev(Date.now(), true);
    await rows(cloudfriend, "INSERT INTO flags (id, workspace_id, created_at, reason, severity, event_ids, decider) VALUES ('flg_1', $1, $2, 'r', 'low', '[\"1\"]', 'test')", WS, old);

    assert.deepEqual(await cloudfriend.worker.cleanup(), { queue: 2, events: 1 });
    assert.equal(await count(cloudfriend, "queue"), 2);
    assert.equal(await count(cloudfriend, "events"), 2);
    assert.equal(await count(cloudfriend, "flags"), 1, "flags are kept until deleted");
  });

  it("deletes in chunks", async () => {
    cloudfriend = await makeCloudfriend({ config: { retentionMs: 1_000 } });
    await rows(
      cloudfriend,
      "INSERT INTO queue (workspace_id, source, received_at, body, status) SELECT $1, 'x', $2, '', 'done' FROM generate_series(1, 2500)",
      WS,
      Date.now() - 5_000,
    );
    assert.deepEqual(await cloudfriend.worker.cleanup(), { queue: 2_500, events: 0 });
  });
});
