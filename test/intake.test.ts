import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { ADMIN, count, makeCloudfriend, type TestCloudfriend } from "./helpers.ts";

let cloudfriend: TestCloudfriend;
afterEach(async () => {
  await cloudfriend?.close(0).catch(() => {});
});

describe("ingest", () => {
  it("replies 202 only once the raw body is committed to the queue", async () => {
    cloudfriend = await makeCloudfriend();
    const res = await cloudfriend.post("myapp", '{"level":"error"}');
    assert.equal(res.status, 202);
    assert.equal(await res.text(), "accepted");
    const row = cloudfriend.db.prepare("SELECT source, body, status FROM queue").get() as any;
    assert.equal(row.source, "myapp");
    assert.equal(Buffer.from(row.body).toString(), '{"level":"error"}');
    assert.equal(row.status, "new");
  });

  it("stores bytes as received, without parsing in the request path", async () => {
    cloudfriend = await makeCloudfriend();
    const res = await cloudfriend.post("myapp", "not json at all {");
    assert.equal(res.status, 202);
    assert.equal(count(cloudfriend, "queue"), 1);
  });

  it("group-commits concurrent requests in one transaction", async () => {
    cloudfriend = await makeCloudfriend({ config: { commitWindowMs: 20 } });
    let transactions = 0;
    const exec = cloudfriend.db.exec.bind(cloudfriend.db);
    cloudfriend.db.exec = (sql: string) => {
      if (sql === "BEGIN IMMEDIATE") transactions++;
      return exec(sql);
    };
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => cloudfriend.post("myapp", { i })));
    assert.ok(results.every((r) => r.status === 202));
    assert.equal(count(cloudfriend, "queue"), 50);
    assert.equal(transactions, 1);
  });

  it("records when a secret was last used", async () => {
    cloudfriend = await makeCloudfriend();
    assert.equal(cloudfriend.secrets.list()[0]!.last_used_at, null);
    await cloudfriend.post("myapp", {});
    assert.ok(cloudfriend.secrets.list()[0]!.last_used_at);
  });

  it("accepts the secret as a ?secret= query parameter for senders that can't set headers", async () => {
    cloudfriend = await makeCloudfriend();
    const res = await cloudfriend.app.request(`/in/sentry?secret=${cloudfriend.secret}`, { method: "POST", body: "{}" });
    assert.equal(res.status, 202);
  });

  it("rejects missing, wrong and revoked secrets", async () => {
    cloudfriend = await makeCloudfriend();
    assert.equal((await cloudfriend.app.request("/in/myapp", { method: "POST", body: "{}" })).status, 401);
    assert.equal((await cloudfriend.post("myapp", {}, { authorization: "Bearer cloudfriend_wrong" })).status, 401);
    const id = cloudfriend.secrets.list()[0]!.id;
    cloudfriend.secrets.revoke(id);
    assert.equal((await cloudfriend.post("myapp", {})).status, 401);
    assert.equal(count(cloudfriend, "queue"), 0);
  });

  it("never accepts the admin key for sending events", async () => {
    cloudfriend = await makeCloudfriend();
    assert.equal((await cloudfriend.post("myapp", {}, { authorization: `Bearer ${ADMIN}` })).status, 401);
  });

  it("limits a source-scoped secret to its source", async () => {
    cloudfriend = await makeCloudfriend();
    const scoped = cloudfriend.secrets.create("sentry-prod", "sentry").secret;
    const auth = { authorization: `Bearer ${scoped}` };
    assert.equal((await cloudfriend.post("sentry", {}, auth)).status, 202);
    assert.equal((await cloudfriend.post("posthog", {}, auth)).status, 401);
  });

  it("rejects invalid source names", async () => {
    cloudfriend = await makeCloudfriend();
    assert.equal((await cloudfriend.post("Bad%20Name", {})).status, 404);
  });

  it("rejects bodies over the size limit with 413", async () => {
    cloudfriend = await makeCloudfriend({ config: { maxBodyBytes: 10 } });
    assert.equal((await cloudfriend.post("myapp", "x".repeat(11))).status, 413);
    assert.equal((await cloudfriend.post("myapp", "x".repeat(10))).status, 202);
  });

  it("replies 503 with retry-after when the queue is full", async () => {
    cloudfriend = await makeCloudfriend({ config: { maxQueue: 2 } });
    assert.equal((await cloudfriend.post("myapp", {})).status, 202);
    assert.equal((await cloudfriend.post("myapp", {})).status, 202);
    const res = await cloudfriend.post("myapp", {});
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "5");
    cloudfriend.worker.parseNew(); // draining the queue makes room again
    assert.equal((await cloudfriend.post("myapp", {})).status, 202);
  });

  it("replies 503 when the write fails, so the sender retries", async () => {
    cloudfriend = await makeCloudfriend();
    cloudfriend.db.exec("DROP TABLE queue");
    const res = await cloudfriend.post("myapp", {});
    assert.equal(res.status, 503);
  });

  it("checks the Sentry signature when SENTRY_CLIENT_SECRET is set", async () => {
    cloudfriend = await makeCloudfriend();
    process.env.SENTRY_CLIENT_SECRET = "shh";
    try {
      const body = '{"action":"created","data":{"issue":{"id":"1"}}}';
      const sig = createHmac("sha256", "shh").update(body).digest("hex");
      assert.equal((await cloudfriend.post("sentry", body)).status, 401);
      assert.equal((await cloudfriend.post("sentry", body, { "sentry-hook-signature": "00" })).status, 401);
      assert.equal((await cloudfriend.post("sentry", body, { "sentry-hook-signature": sig })).status, 202);
    } finally {
      delete process.env.SENTRY_CLIENT_SECRET;
    }
  });

  it("serves /healthz without auth", async () => {
    cloudfriend = await makeCloudfriend();
    await cloudfriend.post("myapp", {});
    const res = await cloudfriend.app.request("/healthz");
    assert.deepEqual(await res.json(), { ok: true, queued: 1 });
  });
});
