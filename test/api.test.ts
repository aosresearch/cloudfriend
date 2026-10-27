import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createCloudfriend } from "../src/cloudfriend.ts";
import { parseTime } from "../src/server.ts";
import { ADMIN, count, fakeDecider, makeCloudfriend, testAdapters, testConfig, type TestCloudfriend } from "./helpers.ts";

let cloudfriend: TestCloudfriend;
afterEach(async () => {
  await cloudfriend?.close(0).catch(() => {});
});

const json = (res: Response) => res.json() as Promise<any>;

function admin(method: string, path: string, body?: object) {
  return cloudfriend.app.request(path, {
    method,
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: body && JSON.stringify(body),
  });
}

describe("secrets API", () => {
  it("requires the admin key", async () => {
    cloudfriend = await makeCloudfriend();
    for (const path of ["/secrets", "/flags", "/events", "/flags/x", "/events/1"]) {
      assert.equal((await cloudfriend.app.request(path)).status, 401, path);
      assert.equal(
        (await cloudfriend.app.request(path, { headers: { authorization: `Bearer ${cloudfriend.secret}` } })).status,
        401,
        `${path} with an ingest secret`,
      );
    }
  });

  it("is disabled when CLOUDFRIEND_ADMIN_KEY is unset", async () => {
    cloudfriend = await makeCloudfriend({ config: { adminKey: "" } });
    const res = await cloudfriend.app.request("/secrets", { headers: { authorization: "Bearer " } });
    assert.equal(res.status, 503);
  });

  it("creates a secret, shows it once, and stores only a hash", async () => {
    cloudfriend = await makeCloudfriend();
    const res = await admin("POST", "/secrets", { name: "sentry-prod", source: "sentry" });
    assert.equal(res.status, 201);
    const created = await json(res);
    assert.match(created.secret, /^cloudfriend_[A-Za-z0-9_-]{43}$/);
    assert.equal(created.source, "sentry");

    const listed = (await json(await admin("GET", "/secrets"))).secrets;
    const entry = listed.find((s: any) => s.id === created.id);
    assert.equal(entry.name, "sentry-prod");
    assert.equal(entry.secret, undefined, "the secret is never listed");

    const dump = JSON.stringify((await cloudfriend.db.query("SELECT * FROM secrets")).rows);
    assert.ok(!dump.includes(created.secret), "plain secret is not in the database");

    const ingest = { authorization: `Bearer ${created.secret}` };
    assert.equal((await cloudfriend.post("sentry", {}, ingest)).status, 202);
  });

  it("revokes immediately", async () => {
    cloudfriend = await makeCloudfriend();
    const created = await json(await admin("POST", "/secrets", { name: "tmp" }));
    const ingest = { authorization: `Bearer ${created.secret}` };
    assert.equal((await cloudfriend.post("myapp", {}, ingest)).status, 202);
    assert.equal((await admin("DELETE", `/secrets/${created.id}`)).status, 204);
    assert.equal((await cloudfriend.post("myapp", {}, ingest)).status, 401);
    assert.equal((await admin("DELETE", `/secrets/${created.id}`)).status, 404);
  });

  it("validates input", async () => {
    cloudfriend = await makeCloudfriend();
    assert.equal((await admin("POST", "/secrets", {})).status, 400);
    assert.equal((await admin("POST", "/secrets", { name: "x", source: "Not Valid" })).status, 400);
    const bad = await cloudfriend.app.request("/secrets", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}` },
      body: "nope",
    });
    assert.equal(bad.status, 400);
  });

  it("generates a secret on first boot only", async () => {
    const config = await testConfig({ decider: "test" });
    const a = await createCloudfriend(config, {}, await testAdapters(null));
    assert.match(a.bootSecret!, /^cloudfriend_/);
    await a.close(0);
    const b = await createCloudfriend(config, {}, await testAdapters(null));
    assert.equal(b.bootSecret, null);
    assert.equal((await b.secrets.list()).length, 1);
    await b.close(0);
  });
});

describe("read API", () => {
  async function seeded() {
    const d = fakeDecider((events) => [
      { reason: "first two", severity: "high", event_ids: [events[0]!.id, events[1]!.id] },
      { reason: "third", severity: "low", event_ids: [events[2]!.id] },
    ]);
    cloudfriend = await makeCloudfriend({ decider: d.adapter, config: { batchSize: 3 } });
    await cloudfriend.post("sentry", { action: "created", data: { issue: { id: "1" } } });
    await cloudfriend.post("posthog", { event: "signup_failed" });
    await cloudfriend.post("myapp", { msg: "hi" });
    await cloudfriend.worker.parseNew();
    await cloudfriend.worker.startDueBatches();
    await cloudfriend.worker.whenIdle();
  }

  it("lists events newest first, filtered by source", async () => {
    await seeded();
    const all = await json(await cloudfriend.get("/events"));
    assert.deepEqual(all.events.map((e: any) => e.source), ["myapp", "posthog", "sentry"]);
    assert.equal(all.next, null);
    const sentry = await json(await cloudfriend.get("/events?source=sentry"));
    assert.equal(sentry.events.length, 1);
    assert.equal(sentry.events[0].type, "issue.created");
    assert.deepEqual(sentry.events[0].data, { action: "created", data: { issue: { id: "1" } } });
  });

  it("filters events by since/until, including relative times", async () => {
    await seeded();
    assert.equal((await json(await cloudfriend.get("/events?since=1h"))).events.length, 3);
    assert.equal((await json(await cloudfriend.get(`/events?since=${new Date(Date.now() + 60_000).toISOString()}`))).events.length, 0);
    assert.equal((await json(await cloudfriend.get(`/events?until=${Date.now() - 60_000}`))).events.length, 0);
    assert.equal((await cloudfriend.get("/events?since=yesterday-ish")).status, 400);
  });

  it("pages events with limit and next", async () => {
    await seeded();
    const p1 = await json(await cloudfriend.get("/events?limit=2"));
    assert.equal(p1.events.length, 2);
    const p2 = await json(await cloudfriend.get(`/events?limit=2&before=${p1.next}`));
    assert.deepEqual(p2.events.map((e: any) => e.source), ["sentry"]);
  });

  it("gets one event", async () => {
    await seeded();
    const e = await json(await cloudfriend.get("/events/1"));
    assert.equal(e.source, "sentry");
    assert.equal((await cloudfriend.get("/events/999")).status, 404);
  });

  it("lists flags, filters by severity, and pages", async () => {
    await seeded();
    const all = await json(await cloudfriend.get("/flags"));
    assert.equal(all.flags.length, 2);
    const high = await json(await cloudfriend.get("/flags?severity=high"));
    assert.deepEqual(high.flags.map((f: any) => f.reason), ["first two"]);
    assert.deepEqual(high.flags[0].event_ids, ["1", "2"]);
    assert.equal((await cloudfriend.get("/flags?severity=urgent")).status, 400);

    const p1 = await json(await cloudfriend.get("/flags?limit=1"));
    const p2 = await json(await cloudfriend.get(`/flags?limit=1&before=${p1.next}`));
    assert.equal(p2.flags.length, 1);
    assert.notEqual(p2.flags[0].id, p1.flags[0].id);
  });

  it("gets a flag with its events and delivery status, and deletes it", async () => {
    await seeded();
    const { flags } = await json(await cloudfriend.get("/flags?severity=high"));
    const detail = await json(await cloudfriend.get(`/flags/${flags[0].id}`));
    assert.equal(detail.flag.reason, "first two");
    assert.deepEqual(detail.events.map((e: any) => e.source), ["sentry", "posthog"]);
    assert.deepEqual(detail.deliveries, []);

    assert.equal((await admin("DELETE", `/flags/${flags[0].id}`)).status, 204);
    assert.equal((await cloudfriend.get(`/flags/${flags[0].id}`)).status, 404);
    assert.equal(await count(cloudfriend, "flags"), 1);
  });

  it("returns JSON 404 for unknown routes", async () => {
    cloudfriend = await makeCloudfriend();
    const res = await cloudfriend.app.request("/nope");
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not found" });
  });
});

describe("parseTime", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  it("parses ISO, epoch ms and relative durations", () => {
    assert.equal(parseTime("2026-10-25T11:00:00Z", now), now - 3_600_000);
    assert.equal(parseTime(String(now), now), now);
    assert.equal(parseTime("1h", now), now - 3_600_000);
    assert.equal(parseTime("7d", now), now - 7 * 86_400_000);
    assert.equal(parseTime(undefined, now), undefined);
  });
});
