// The v0 bar: run cloudfriend, point Sentry at it, and get a sensible flag in Slack.
// Runs the real server process with a mock OpenRouter and a mock Slack.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { mockServer, tempDir, waitFor } from "./helpers.ts";
import { freshDatabase } from "./pg.ts";

describe("end to end: Sentry -> decider -> Slack", () => {
  let openrouter: Awaited<ReturnType<typeof mockServer>>;
  let slack: Awaited<ReturnType<typeof mockServer>>;
  let proc: ReturnType<typeof spawn>;
  let logs = "";
  const port = 18000 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;

  before(async () => {
    openrouter = await mockServer((req) => {
      // Answers like Jev: a judgment for every event shown, and alerts for the ones that matter.
      const prompt = JSON.parse(req.body).messages[1].content as string;
      const shown = [...prompt.matchAll(/^\[(\d+)\] /gm)].length;
      const bad = prompt.slice(prompt.indexOf("events, oldest first")).includes("TypeError"); // not the open-alerts list
      const judgments = Array.from({ length: shown }, (_, i) => ({ event: i, relevance: bad ? "relevant" : "benign" }));
      const alerts = bad ? [{ reason: "New TypeError in checkout", severity: "high", events: [0] }] : [];
      return { body: { choices: [{ message: { content: JSON.stringify({ judgments, alerts }) } }] } };
    });
    slack = await mockServer();
    proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/main.ts"], {
      env: {
        PATH: process.env.PATH,
        PORT: String(port),
        HOST: "127.0.0.1",
        CLOUDFRIEND_DATA_DIR: tempDir(),
        CLOUDFRIEND_DATABASE_URL: await freshDatabase(),
        CLOUDFRIEND_ADMIN_KEY: "admin",
        CLOUDFRIEND_BATCH_WAIT: "200ms",
        CLOUDFRIEND_POLL_INTERVAL: "20ms",
        // No random audit samples: one would turn the drop the tests expect into an audit (1 in 100).
        CLOUDFRIEND_AUDIT_RATE: "0",
        OPENROUTER_API_KEY: "sk-or-test",
        OPENROUTER_BASE_URL: openrouter.url,
        SLACK_WEBHOOK_URL: slack.url + "/services/T/B/X",
        // The mock Slack listens on 127.0.0.1.
        CLOUDFRIEND_ALLOW_PRIVATE_DESTINATIONS: "on",
      },
    });
    proc.stdout!.on("data", (d) => (logs += d));
    proc.stderr!.on("data", (d) => (logs += d));
    await waitFor(() => logs.includes("cloudfriend listening"), 10_000);
  });

  after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
      await new Promise((r) => proc.once("exit", r));
    }
    await openrouter.close();
    await slack.close();
  });

  it("prints a first-boot secret that works for ingest", async () => {
    const secret = /cloudfriend_[A-Za-z0-9_-]{43}/.exec(logs)?.[0];
    assert.ok(secret, "secret printed to logs");

    const issue = {
      action: "created",
      installation: { uuid: "i" },
      data: { issue: { id: "4711", title: "TypeError: Cannot read properties of undefined (reading 'total')", culprit: "checkout/cart.ts", level: "error" } },
    };
    const res = await fetch(`${base}/in/sentry?secret=${secret}`, {
      method: "POST",
      headers: { "content-type": "application/json", "sentry-hook-resource": "issue" },
      body: JSON.stringify(issue),
    });
    assert.equal(res.status, 202);

    await waitFor(() => slack.requests.length > 0, 5_000);
    const msg = JSON.parse(slack.requests[0]!.body);
    assert.equal(msg.text, "[high] New TypeError in checkout");

    const flags = (await (await fetch(`${base}/flags`, { headers: { authorization: "Bearer admin" } })).json()) as any;
    assert.equal(flags.flags.length, 1);
    const detail = (await (await fetch(`${base}/flags/${flags.flags[0].id}`, { headers: { authorization: "Bearer admin" } })).json()) as any;
    assert.equal(detail.events[0].group_key, "issue:4711");
    assert.deepEqual(detail.deliveries.map((d: any) => [d.action, d.status]), [["slack", "ok"]]);
  });

  it("reviews a new kind of routine event once, then drops it without asking the model", async () => {
    const secret = /cloudfriend_[A-Za-z0-9_-]{43}/.exec(logs)![0];
    const post = (msg: string) =>
      fetch(`${base}/in/myapp`, { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ level: "info", msg }) });
    const latest = async (n: number) => {
      for (let i = 0; i < 100; i++) {
        const list = (await (await fetch(`${base}/events?source=myapp`, { headers: { authorization: "Bearer admin" } })).json()) as any;
        if (list.events.length >= n && list.events.every((e: any) => e.decided ?? true)) return list.events[0];
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("event not routed");
    };
    const before = openrouter.requests.length;
    assert.equal((await post("user 17 logged in")).status, 202);
    const first = await latest(1);
    assert.equal(first.route, "review", "nobody has judged this kind yet: the classifier may not drop it");
    for (let i = 0; i < 40 && openrouter.requests.length === before; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(openrouter.requests.length, before + 1);
    await new Promise((r) => setTimeout(r, 300));
    // The model judged it benign: the next one is the classifier's to drop.
    assert.equal((await post("user 18 logged in")).status, 202);
    const second = await latest(2);
    assert.equal(second.route, "drop");
    assert.ok(second.score < 0.1);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(openrouter.requests.length, before + 1);
    assert.equal(slack.requests.length, 1);
  });

  it("exits cleanly on SIGTERM", async () => {
    proc.kill("SIGTERM");
    const code = await new Promise((r) => proc.once("exit", r));
    assert.equal(code, 0);
    assert.match(logs, /shutting down/);
  });
});
