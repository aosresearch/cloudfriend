import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { spawn } from "node:child_process";
import pg from "pg";
import { ADMIN, count, makeCloudfriend, tempDir, waitFor, type TestCloudfriend } from "./helpers.ts";
import { freshDatabase } from "./pg.ts";

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
    // Read on a connection of its own: committed, not just written inside a transaction.
    const other = new pg.Client({ connectionString: cloudfriend.config.databaseUrl });
    await other.connect();
    const row = (await other.query("SELECT source, body, status FROM queue")).rows[0];
    await other.end();
    assert.equal(row.source, "myapp");
    assert.equal(Buffer.from(row.body).toString(), '{"level":"error"}');
    assert.equal(row.status, "new");
  });

  it("stores bytes as received, without parsing in the request path", async () => {
    cloudfriend = await makeCloudfriend();
    const res = await cloudfriend.post("myapp", "not json at all {");
    assert.equal(res.status, 202);
    assert.equal(await count(cloudfriend, "queue"), 1);
  });

  it("group-commits concurrent requests in one transaction", async () => {
    // A window long enough that all 50 land in it even on a slow CI machine.
    cloudfriend = await makeCloudfriend({ config: { commitWindowMs: 1000 } });
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => cloudfriend.post("myapp", { i })));
    assert.ok(results.every((r) => r.status === 202));
    assert.equal(await count(cloudfriend, "queue"), 50);
    // xmin is the id of the transaction that wrote the row: one commit for all 50.
    assert.equal(await count(cloudfriend, "(SELECT DISTINCT xmin::text FROM queue) t"), 1);
  });

  it("records when a secret was last used", async () => {
    cloudfriend = await makeCloudfriend();
    assert.equal((await cloudfriend.secrets.list())[0]!.last_used_at, null);
    await cloudfriend.post("myapp", {});
    assert.ok((await cloudfriend.secrets.list())[0]!.last_used_at);
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
    const id = (await cloudfriend.secrets.list())[0]!.id;
    await cloudfriend.secrets.revoke(id);
    assert.equal((await cloudfriend.post("myapp", {})).status, 401);
    assert.equal(await count(cloudfriend, "queue"), 0);
  });

  it("never accepts the admin key for sending events", async () => {
    cloudfriend = await makeCloudfriend();
    assert.equal((await cloudfriend.post("myapp", {}, { authorization: `Bearer ${ADMIN}` })).status, 401);
  });

  it("limits a source-scoped secret to its source", async () => {
    cloudfriend = await makeCloudfriend();
    const scoped = (await cloudfriend.secrets.create("sentry-prod", "sentry")).secret;
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
    await cloudfriend.worker.parseNew(); // draining the queue makes room again
    assert.equal((await cloudfriend.post("myapp", {})).status, 202);
  });

  it("replies 503 when the write fails, so the sender retries", async () => {
    cloudfriend = await makeCloudfriend();
    await cloudfriend.db.query("DROP TABLE queue");
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

describe("crash safety", () => {
  it("commits a batch whole or not at all, and answers every request in it accordingly", async () => {
    // A window long enough that the poison row shares its commit with the other 9, even on a slow CI machine.
    cloudfriend = await makeCloudfriend({ config: { commitWindowMs: 1000 } });
    // A row the database refuses fails the commit it is in.
    await cloudfriend.db.query(`CREATE FUNCTION reject_poison() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF convert_from(NEW.body, 'UTF8') LIKE '%poison%' THEN RAISE EXCEPTION 'poison'; END IF; RETURN NEW; END $$`);
    await cloudfriend.db.query("CREATE TRIGGER reject_poison BEFORE INSERT ON queue FOR EACH ROW EXECUTE FUNCTION reject_poison()");
    const results = await Promise.all([...Array.from({ length: 9 }, (_, i) => cloudfriend.post("myapp", { i })), cloudfriend.post("myapp", { poison: true })]);
    assert.deepEqual(results.map((r) => r.status), Array(10).fill(503), "no request is acknowledged for a commit that failed");
    assert.equal(await count(cloudfriend, "queue"), 0, "and none of the batch is stored");
    assert.equal(cloudfriend.intake.backlog, 0);
    assert.equal((await cloudfriend.post("myapp", { i: 10 })).status, 202, "the next commit goes through");
    assert.equal(await count(cloudfriend, "queue"), 1);
  });

  it("loses no acknowledged request when the process is killed mid-stream", async () => {
    const url = await freshDatabase();
    const port = 19000 + Math.floor(Math.random() * 1000);
    let logs = "";
    const proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/main.ts"], {
      env: { PATH: process.env.PATH, PORT: String(port), HOST: "127.0.0.1", CLOUDFRIEND_DATABASE_URL: url, CLOUDFRIEND_DATA_DIR: tempDir(), CLOUDFRIEND_POLL_INTERVAL: "5ms" },
    });
    proc.stdout!.on("data", (d) => (logs += d));
    proc.stderr!.on("data", (d) => (logs += d));
    const exited = new Promise((r) => proc.once("exit", r));
    try {
      await waitFor(() => logs.includes("cloudfriend listening"), 15_000);
      const secret = /cloudfriend_[A-Za-z0-9_-]{43}/.exec(logs)![0];
      const accepted: number[] = [];
      let next = 0;
      let killed = false;
      // 20 senders, each posting one request after another until the process dies.
      const sender = async () => {
        while (!killed) {
          const n = next++;
          try {
            const res = await fetch(`http://127.0.0.1:${port}/in/myapp`, { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ n }) });
            if (res.status === 202) accepted.push(n);
          } catch {
            return; // connection refused or reset: the process is gone
          }
        }
      };
      const senders = Array.from({ length: 20 }, sender);
      await waitFor(() => accepted.length >= 300, 15_000);
      proc.kill("SIGKILL");
      killed = true;
      await Promise.all(senders);
      await exited;

      const db = new pg.Client({ connectionString: url });
      await db.connect();
      const stored = new Set((await db.query("SELECT body FROM queue")).rows.map((r) => JSON.parse(String(r.body)).n as number));
      await db.end();
      const lost = accepted.filter((n) => !stored.has(n));
      assert.deepEqual(lost, [], `${lost.length} of ${accepted.length} acknowledged requests are missing`);
    } finally {
      proc.kill("SIGKILL");
    }
  });
});
