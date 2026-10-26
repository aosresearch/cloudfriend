import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createSieve } from "../src/sieve.ts";
import { deliveryBackoff, MAX_DELIVERY_ATTEMPTS } from "../src/worker.ts";
import { count, fakeAction, fakeDecider, makeSieve, testAdapters, testConfig, waitFor, type TestSieve } from "./helpers.ts";

let sieve: TestSieve;
afterEach(async () => {
  await sieve?.close(0).catch(() => {});
});

const flagFirst = fakeDecider((events) => [{ reason: "boom", severity: "high", event_ids: [events[0]!.id] }]);

describe("parse stage", () => {
  it("turns queued requests into events and marks them done", async () => {
    sieve = await makeSieve();
    await sieve.post("myapp", [{ a: 1 }, { a: 2 }]);
    await sieve.post("sentry", { action: "created", data: { issue: { id: "7" } } });
    assert.equal(sieve.worker.parseNew(), 2);
    assert.equal(count(sieve, "queue WHERE status = 'done'"), 2);
    const events = sieve.db.prepare("SELECT source, data, type, group_key FROM events ORDER BY id").all() as any[];
    assert.deepEqual(
      events.map((e) => [e.source, JSON.parse(e.data), e.type, e.group_key]),
      [
        ["myapp", { a: 1 }, null, null],
        ["myapp", { a: 2 }, null, null],
        ["sentry", { action: "created", data: { issue: { id: "7" } } }, "issue.created", "issue:7"],
      ],
    );
    assert.equal(sieve.intake.backlog, 0);
  });

  it("drops a request when parse returns []", async () => {
    sieve = await makeSieve();
    await sieve.post("sentry", { action: "created", data: { installation: { uuid: "x" } }, installation: { uuid: "x" } });
    sieve.worker.parseNew();
    assert.equal(count(sieve, "events"), 0);
    assert.equal(count(sieve, "queue WHERE status = 'done'"), 1);
  });

  it("keeps a request as 'failed' when its adapter throws", async () => {
    const adapters = await testAdapters(null);
    adapters.sources = new Map([...adapters.sources, ["broken", { parse: () => { throw new Error("nope"); } }]]);
    const s = await createSieve(testConfig({ decider: "test" }), {}, adapters);
    try {
      s.db.prepare("INSERT INTO queue (source, received_at, body) VALUES ('broken', ?, ?)").run(Date.now(), Buffer.from("{}"));
      s.db.prepare("INSERT INTO queue (source, received_at, body) VALUES ('myapp', ?, ?)").run(Date.now(), Buffer.from("{}"));
      s.worker.parseNew();
      const statuses = s.db.prepare("SELECT source, status FROM queue ORDER BY id").all() as any[];
      assert.deepEqual(statuses.map((r) => [r.source, r.status]), [["broken", "failed"], ["myapp", "done"]]);
      assert.equal((s.db.prepare("SELECT count(*) AS n FROM events").get() as any).n, 1);
    } finally {
      await s.close(0);
    }
  });
});

describe("decide stage", () => {
  it("decides as soon as a batch reaches the size limit", async () => {
    const d = fakeDecider();
    sieve = await makeSieve({ decider: d.adapter, config: { batchSize: 3, batchWaitMs: 60_000 } });
    for (let i = 0; i < 2; i++) await sieve.post("myapp", { i });
    sieve.worker.parseNew();
    sieve.worker.startDueBatches();
    await sieve.worker.whenIdle();
    assert.equal(d.calls.length, 0, "two events, under the size limit and the wait: no call yet");

    await sieve.post("myapp", { i: 2 });
    sieve.worker.parseNew();
    sieve.worker.startDueBatches();
    await sieve.worker.whenIdle();
    assert.equal(d.calls.length, 1);
    assert.deepEqual(d.calls[0]!.map((e) => (e.data as any).i), [0, 1, 2]);
    assert.equal(count(sieve, "events WHERE decided = 0"), 0);
  });

  it("decides a partial batch once the oldest event has waited long enough", async () => {
    const d = fakeDecider();
    sieve = await makeSieve({ decider: d.adapter, config: { batchSize: 100, batchWaitMs: 10_000 } });
    await sieve.post("myapp", {});
    sieve.worker.parseNew();
    sieve.worker.startDueBatches(Date.now() + 9_000);
    await sieve.worker.whenIdle();
    assert.equal(d.calls.length, 0);
    sieve.worker.startDueBatches(Date.now() + 10_001);
    await sieve.worker.whenIdle();
    assert.equal(d.calls.length, 1);
  });

  it("caps each decide() call at the batch size", async () => {
    const d = fakeDecider();
    sieve = await makeSieve({ decider: d.adapter, config: { batchSize: 3, deciderConcurrency: 4 } });
    await sieve.post("myapp", Array.from({ length: 8 }, (_, i) => ({ i })));
    sieve.worker.parseNew();
    sieve.worker.startDueBatches(Date.now() + 60_000);
    await sieve.worker.whenIdle();
    assert.deepEqual(d.calls.map((c) => c.length), [3, 3, 2]);
    const seen = d.calls.flat().map((e) => e.id);
    assert.equal(new Set(seen).size, 8, "no event is decided twice");
  });

  it("passes only source, received_at, data (and hints) to the decider", async () => {
    const d = fakeDecider();
    sieve = await makeSieve({ decider: d.adapter, config: { batchSize: 1 } });
    await sieve.post("myapp", { msg: "hi" });
    sieve.worker.parseNew();
    sieve.worker.startDueBatches();
    await sieve.worker.whenIdle();
    const [e] = d.calls[0]!;
    assert.deepEqual(Object.keys(e!).sort(), ["data", "id", "received_at", "source"]);
    assert.ok(!Number.isNaN(Date.parse(e!.received_at)));
  });

  it("stores flags with their events and queues a delivery per action", async () => {
    const act = fakeAction();
    sieve = await makeSieve({ decider: flagFirst.adapter, actions: { a: act.adapter, b: act.adapter }, config: { batchSize: 2 } });
    await sieve.post("myapp", [{ n: 1 }, { n: 2 }]);
    sieve.worker.parseNew();
    sieve.worker.startDueBatches();
    await sieve.worker.whenIdle();
    const flag = sieve.db.prepare("SELECT * FROM flags").get() as any;
    assert.equal(flag.reason, "boom");
    assert.equal(flag.severity, "high");
    assert.equal(flag.decider, "test");
    assert.match(flag.id, /^flg_[0-9a-f]{20}$/);
    assert.equal(JSON.parse(flag.event_ids).length, 1);
    assert.equal(count(sieve, "deliveries WHERE status = 'pending'"), 2);
  });

  it("ignores flags that point at events outside the batch", async () => {
    const d = fakeDecider(() => [
      { reason: "made up", severity: "low", event_ids: ["99999"] },
      { reason: "", severity: "low", event_ids: ["1"] },
    ]);
    sieve = await makeSieve({ decider: d.adapter, config: { batchSize: 1 } });
    await sieve.post("myapp", {});
    sieve.worker.parseNew();
    sieve.worker.startDueBatches();
    await sieve.worker.whenIdle();
    assert.equal(count(sieve, "flags"), 0);
    assert.equal(count(sieve, "events WHERE decided = 1"), 1);
  });

  it("keeps events queued when the decider fails, and retries after a backoff", async () => {
    let fail = true;
    const d = fakeDecider(() => {
      if (fail) throw new Error("model down");
      return [];
    });
    sieve = await makeSieve({ decider: d.adapter, config: { batchSize: 1 } });
    await sieve.post("myapp", {});
    sieve.worker.parseNew();
    sieve.worker.startDueBatches();
    await sieve.worker.whenIdle();
    assert.equal(count(sieve, "events WHERE decided = 0"), 1);

    fail = false;
    sieve.worker.startDueBatches(); // still backing off
    await sieve.worker.whenIdle();
    assert.equal(d.calls.length, 1);
    sieve.worker.startDueBatches(Date.now() + 1_500);
    await sieve.worker.whenIdle();
    assert.equal(d.calls.length, 2);
    assert.equal(count(sieve, "events WHERE decided = 0"), 0);
  });

  it("stores events without deciding when no decider is configured", async () => {
    sieve = await makeSieve({ decider: null, config: { batchSize: 1 } });
    assert.equal(sieve.decider, null);
    await sieve.post("myapp", {});
    sieve.worker.parseNew();
    sieve.worker.startDueBatches(Date.now() + 60_000);
    assert.equal(count(sieve, "events WHERE decided = 0"), 1);
  });
});

describe("deliver stage", () => {
  async function flagged(actions: Record<string, any>) {
    sieve = await makeSieve({ decider: flagFirst.adapter, actions, config: { batchSize: 1 } });
    await sieve.post("myapp", { msg: "x" });
    sieve.worker.parseNew();
    sieve.worker.startDueBatches();
    await sieve.worker.whenIdle();
    return (sieve.db.prepare("SELECT id FROM flags").get() as any).id as string;
  }

  it("runs each action with the flag and its events, then marks it ok", async () => {
    const act = fakeAction();
    const flagId = await flagged({ slack: act.adapter });
    await sieve.worker.deliverDue();
    assert.deepEqual(act.calls, [{ flagId, eventIds: ["1"] }]);
    const d = sieve.db.prepare("SELECT status, attempts FROM deliveries").get() as any;
    assert.deepEqual({ ...d }, { status: "ok", attempts: 1 });
    await sieve.worker.deliverDue();
    assert.equal(act.calls.length, 1, "an ok delivery is not repeated");
  });

  it("retries a failing action with backoff, then gives up", async () => {
    const act = fakeAction(async () => {
      throw new Error("slack down");
    });
    await flagged({ slack: act.adapter });
    await sieve.worker.deliverDue();
    let d = sieve.db.prepare("SELECT * FROM deliveries").get() as any;
    assert.equal(d.status, "pending");
    assert.equal(d.attempts, 1);
    assert.equal(d.last_error, "slack down");
    assert.ok(d.next_attempt_at >= Date.now() + deliveryBackoff(1) - 1_000);

    await sieve.worker.deliverDue();
    assert.equal(act.calls.length, 1, "not retried before the backoff");

    for (let i = 1; i < MAX_DELIVERY_ATTEMPTS; i++) await sieve.worker.deliverDue(Date.now() + 10 * 3_600_000);
    d = sieve.db.prepare("SELECT * FROM deliveries").get() as any;
    assert.equal(d.status, "failed");
    assert.equal(d.attempts, MAX_DELIVERY_ATTEMPTS);
    assert.equal(act.calls.length, MAX_DELIVERY_ATTEMPTS);
  });

  it("treats run() returning false as a failure", async () => {
    const act = fakeAction(async () => false);
    await flagged({ hook: act.adapter });
    await sieve.worker.deliverDue();
    assert.equal((sieve.db.prepare("SELECT last_error FROM deliveries").get() as any).last_error, "run() returned false");
  });

  it("isolates actions: one failing does not block another", async () => {
    const ok = fakeAction();
    const bad = fakeAction(async () => {
      throw new Error("x");
    });
    await flagged({ ok: ok.adapter, bad: bad.adapter });
    await sieve.worker.deliverDue();
    const rows = sieve.db.prepare("SELECT action, status FROM deliveries ORDER BY action").all() as any[];
    assert.deepEqual(rows.map((r) => [r.action, r.status]), [["bad", "pending"], ["ok", "ok"]]);
  });
});

describe("durability", () => {
  it("processes requests left 'new' by a crash when it starts again", async () => {
    const config = testConfig({ decider: "test", batchSize: 2 });
    const first = await createSieve(config, {}, await testAdapters(null));
    first.db.prepare("INSERT INTO queue (source, received_at, body) VALUES ('myapp', ?, ?)").run(Date.now(), Buffer.from('{"n":1}'));
    first.db.prepare("INSERT INTO queue (source, received_at, body) VALUES ('myapp', ?, ?)").run(Date.now(), Buffer.from('{"n":2}'));
    first.db.close(); // simulate a crash: no worker ran, nothing marked done

    const act = fakeAction();
    const second = await createSieve(config, {}, await testAdapters(flagFirst.adapter, { a: act.adapter }));
    try {
      assert.equal(second.bootSecret, null, "no new secret on restart");
      assert.equal(second.intake.backlog, 2);
      second.worker.start();
      await waitFor(() => act.calls.length === 1);
      assert.equal((second.db.prepare("SELECT count(*) AS n FROM queue WHERE status = 'new'").get() as any).n, 0);
    } finally {
      await second.close(0);
    }
  });

  it("re-decides events whose decision was interrupted", async () => {
    const config = testConfig({ decider: "test", batchSize: 1 });
    let release!: () => void;
    const hang = fakeDecider(() => new Promise((r) => (release = () => r([]))));
    const first = await createSieve(config, {}, await testAdapters(hang.adapter));
    await first.app.request("/in/myapp", {
      method: "POST",
      headers: { authorization: `Bearer ${first.bootSecret}` },
      body: "{}",
    });
    first.worker.parseNew();
    first.worker.startDueBatches();
    assert.equal(hang.calls.length, 1);
    await first.close(0); // shut down mid-decision
    release();

    const d = fakeDecider();
    const second = await createSieve(config, {}, await testAdapters(d.adapter));
    try {
      second.worker.startDueBatches();
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
    sieve = await makeSieve({ decider: d.adapter, config: { batchSize: 1, batchWaitMs: 0, pollMs: 5 } });
    await sieve.post("myapp", { n: 1 });
    sieve.worker.start();
    await waitFor(() => d.calls.length === 1);

    const pending = sieve.post("myapp", { n: 2 }); // still waiting on its commit
    const closing = sieve.close(1_000, 60);
    assert.equal((await pending).status, 202);
    await closing;
    assert.equal(d.calls.length, 1, "the second event is left for the next start, not decided during shutdown");
  });
});

describe("cleanup", () => {
  it("deletes processed requests and decided events past the window, keeps the rest", async () => {
    sieve = await makeSieve({ config: { retentionMs: 1_000, batchSize: 1 } });
    const old = Date.now() - 5_000;
    const insert = sieve.db.prepare("INSERT INTO queue (source, received_at, body, status) VALUES ('x', ?, ?, ?)");
    insert.run(old, Buffer.from("{}"), "done");
    insert.run(old, Buffer.from("{}"), "failed");
    insert.run(old, Buffer.from("{}"), "new"); // never delete unprocessed requests
    insert.run(Date.now(), Buffer.from("{}"), "done");
    const ev = sieve.db.prepare("INSERT INTO events (queue_id, source, received_at, data, decided) VALUES (0, 'x', ?, '{}', ?)");
    ev.run(old, 1);
    ev.run(old, 0); // undecided events wait for the decider
    ev.run(Date.now(), 1);
    sieve.db.prepare("INSERT INTO flags VALUES ('flg_1', ?, 'r', 'low', '[\"1\"]', 'test')").run(old);

    assert.deepEqual(await sieve.worker.cleanup(), { queue: 2, events: 1 });
    assert.equal(count(sieve, "queue"), 2);
    assert.equal(count(sieve, "events"), 2);
    assert.equal(count(sieve, "flags"), 1, "flags are kept until deleted");
  });

  it("deletes in chunks", async () => {
    sieve = await makeSieve({ config: { retentionMs: 1_000 } });
    const insert = sieve.db.prepare("INSERT INTO queue (source, received_at, body, status) VALUES ('x', ?, x'', 'done')");
    sieve.db.exec("BEGIN");
    for (let i = 0; i < 2_500; i++) insert.run(Date.now() - 5_000);
    sieve.db.exec("COMMIT");
    assert.deepEqual(await sieve.worker.cleanup(), { queue: 2_500, events: 0 });
  });
});
