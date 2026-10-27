import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import slack, { slackMessage } from "../src/adapters/actions/slack.ts";
import webhook from "../src/adapters/actions/webhook.ts";
import openrouter, { buildPrompt, parseDecision, parseReply } from "../src/adapters/deciders/openrouter.ts";
import { loadAdapters } from "../src/adapters.ts";
import { compactJson } from "../src/compact.ts";
import type { Flag, CloudfriendEvent } from "../src/types.ts";
import { mockServer } from "./helpers.ts";

const events: CloudfriendEvent[] = [
  { id: "10", source: "sentry", received_at: "2026-10-25T17:30:00.000Z", data: { title: "TypeError in checkout" }, type: "issue.created", group_key: "issue:1" },
  { id: "11", source: "myapp", received_at: "2026-10-25T17:30:01.000Z", data: { msg: "user logged in" } },
];

const flag: Flag = {
  id: "flg_abc",
  reason: "Checkout errors <spiked> & users can't pay",
  severity: "high",
  event_ids: ["10"],
  created_at: "2026-10-25T17:30:05.000Z",
  decider: "openrouter",
};

const signal = new AbortController().signal;

describe("adapter loading", () => {
  it("finds the built-in adapters by file name", async () => {
    const a = await loadAdapters();
    assert.deepEqual([...a.sources.keys()].sort(), ["json", "posthog", "sentry"]);
    assert.deepEqual([...a.deciders.keys()].sort(), ["jev", "openrouter"]);
    assert.deepEqual([...a.actions.keys()].sort(), ["slack", "webhook"]);
  });
});

describe("openrouter decider", () => {
  it("is enabled only with an API key", () => {
    assert.equal(openrouter.enabled!({}), false);
    assert.equal(openrouter.enabled!({ OPENROUTER_API_KEY: "k" }), true);
  });

  it("builds a prompt that numbers events and shows hints", () => {
    const p = buildPrompt(events, {});
    assert.match(p, /^2 events, oldest first:/);
    assert.match(p, /\[0\] source=sentry received_at=2026-10-25T17:30:00.000Z type=issue.created group=issue:1/);
    assert.match(p, /\[1\] source=myapp/);
    assert.match(p, /TypeError in checkout/);
  });

  it("maps event numbers in the reply back to event ids and validates fields", () => {
    const reply = '```json\n{"flags":[{"reason":" Checkout broke ","severity":"HIGH","events":[0,0,5]},{"reason":"x","severity":"weird","events":[1]},{"reason":"none","events":[]}]}\n```';
    assert.deepEqual(parseReply(reply, events), [
      { reason: "Checkout broke", severity: "high", event_ids: ["10"] },
      { reason: "x", severity: "medium", event_ids: ["11"] },
    ]);
    assert.deepEqual(parseReply('{"flags":[]}', events), []);
    assert.throws(() => parseReply("I could not decide", events));
  });

  it("calls the chat completions endpoint and returns flags", async () => {
    const server = await mockServer(() => ({
      body: { choices: [{ message: { content: '{"flags":[{"reason":"Checkout errors","severity":"critical","events":[0]}]}' } }] },
    }));
    try {
      const env = {
        OPENROUTER_API_KEY: "sk-or-test",
        OPENROUTER_BASE_URL: server.url + "/api/v1",
        OPENROUTER_MODEL: "test/model",
        CLOUDFRIEND_DECIDER_INSTRUCTIONS: "Checkout matters most.",
      };
      const decision = await openrouter.decide(events, { env, signal });
      assert.ok(!Array.isArray(decision));
      assert.deepEqual(decision.flags, [{ reason: "Checkout errors", severity: "critical", event_ids: ["10"] }]);
      assert.equal(decision.judgments, undefined, "a v0 reply has no judgments, so it yields no labels");
      assert.match(decision.record!.prompt!, /\[0\] source=sentry/);
      const req = server.requests[0]!;
      assert.equal(req.url, "/api/v1/chat/completions");
      assert.equal(req.headers.authorization, "Bearer sk-or-test");
      const body = JSON.parse(req.body);
      assert.equal(body.model, "test/model");
      assert.equal(body.temperature, 0);
      assert.match(body.messages[0].content, /Checkout matters most\./);
      assert.match(body.messages[1].content, /\[0\] source=sentry/);
    } finally {
      await server.close();
    }
  });

  it("reads judgments and alerts, and never invents a judgment", () => {
    const three = [...events, { ...events[0]!, id: "12" }];
    const d = parseDecision(
      JSON.stringify({
        judgments: [
          { event: 0, relevance: "relevant" },
          { event: 1, relevance: "Benign" },
          { event: 1, relevance: "relevant" },
          { event: 2, relevance: "maybe" },
          { event: 9, relevance: "relevant" },
        ],
        alerts: [
          { reason: "Checkout broke", severity: "high", events: [0] },
          { reason: "Still broken", severity: "high", events: [0], update: "flg_open" },
          { reason: "Bogus update", severity: "low", events: [1], update: "flg_unknown" },
        ],
      }),
      three,
      new Set(["flg_open"]),
    );
    assert.deepEqual(d.judgments, [
      { event_id: "10", relevance: "relevant" },
      { event_id: "11", relevance: "benign" },
    ]);
    assert.equal(d.flags[0]!.update, undefined);
    assert.equal(d.flags[1]!.update, "flg_open");
    assert.equal(d.flags[2]!.update, undefined, "an update to a flag that isn't open becomes a new alert");
  });

  it("only takes real indices: no null, empty or true for event 0 or 1", () => {
    const d = parseDecision(
      JSON.stringify({
        judgments: [
          { event: null, relevance: "benign" },
          { event: "", relevance: "benign" },
          { event: true, relevance: "benign" },
          { event: 1.5, relevance: "benign" },
          { event: "1", relevance: "relevant" },
        ],
        alerts: [{ reason: "x", severity: "low", events: [null, false, "0"] }],
      }),
      events,
    );
    assert.deepEqual(d.judgments, [{ event_id: "11", relevance: "relevant" }]);
    assert.deepEqual(d.flags[0]!.event_ids, ["10"]);
  });

  it("reads judgments without an alerts key as nothing to alert on", () => {
    const d = parseDecision(JSON.stringify({ judgments: [{ event: 0, relevance: "benign" }] }), events);
    assert.deepEqual(d.flags, []);
    assert.equal(d.judgments!.length, 1);
    assert.throws(() => parseDecision(JSON.stringify({ verdict: "fine" }), events), /no alerts/);
  });

  it("shows the decider counts, not the classifier's score", () => {
    const p = buildPrompt(
      [{ ...events[0]!, triage: { score: 0.97, similar: 4, context: { seen_total: 120, last_1m: 3, last_10m: 30, last_hour: 90, usual_per_hour: 2, first_seen_min_ago: 600 } } }],
      {},
      [{ id: "flg_1", reason: "Checkout failing", severity: "high" }],
    );
    assert.doesNotMatch(p, /0\.97|classifier/);
    assert.match(p, /similar_in_batch=4 seen_total=120 last_1m=3 last_10m=30 last_hour=90 usual_per_hour=2 first_seen_min_ago=600/);
    assert.match(p, /Open alerts:\n- flg_1 \(high\) Checkout failing/);
  });

  it("throws on HTTP errors so the batch is retried", async () => {
    const server = await mockServer(() => ({ status: 429, body: { error: { message: "rate limited" } } }));
    try {
      const env = { OPENROUTER_API_KEY: "k", OPENROUTER_BASE_URL: server.url };
      await assert.rejects(openrouter.decide(events, { env, signal }), /OpenRouter 429/);
    } finally {
      await server.close();
    }
  });
});

describe("webhook action", () => {
  it("posts the flag and its events, signed when WEBHOOK_SECRET is set", async () => {
    const server = await mockServer();
    try {
      const env = { WEBHOOK_URL: server.url + "/hook", WEBHOOK_SECRET: "s3cret" };
      await webhook.run(flag, { events, env, signal });
      const req = server.requests[0]!;
      assert.equal(req.headers["x-cloudfriend-flag-id"], "flg_abc");
      assert.deepEqual(JSON.parse(req.body), { flag, events });
      const expected = "sha256=" + createHmac("sha256", "s3cret").update(req.body).digest("hex");
      assert.equal(req.headers["x-cloudfriend-signature"], expected);
    } finally {
      await server.close();
    }
  });

  it("throws on a non-2xx reply", async () => {
    const server = await mockServer(() => ({ status: 500, body: "down" }));
    try {
      await assert.rejects(webhook.run(flag, { events, env: { WEBHOOK_URL: server.url }, signal }), /webhook replied 500/);
    } finally {
      await server.close();
    }
  });
});

describe("slack action", () => {
  it("formats a message with severity, escaped reason and a sample event", () => {
    const msg = slackMessage(flag, events);
    assert.equal(msg.text, "[high] Checkout errors <spiked> & users can't pay");
    const blocks = JSON.stringify(msg.blocks);
    assert.match(blocks, /:large_orange_circle: \*HIGH\*  Checkout errors &lt;spiked&gt; &amp; users can't pay/);
    assert.match(blocks, /1 event from sentry, myapp · flag `flg_abc`/);
    assert.match(blocks, /TypeError in checkout/);
  });

  it("posts to the incoming webhook", async () => {
    const server = await mockServer();
    try {
      await slack.run(flag, { events, env: { SLACK_WEBHOOK_URL: server.url }, signal });
      assert.equal(JSON.parse(server.requests[0]!.body).text, msg());
    } finally {
      await server.close();
    }
    function msg() {
      return slackMessage(flag, events).text;
    }
  });

  it("skips flags below SLACK_MIN_SEVERITY", async () => {
    const server = await mockServer();
    try {
      await slack.run(flag, { events, env: { SLACK_WEBHOOK_URL: server.url, SLACK_MIN_SEVERITY: "critical" }, signal });
      assert.equal(server.requests.length, 0);
    } finally {
      await server.close();
    }
  });
});

describe("compactJson", () => {
  it("puts scalars first and trims long arrays, strings and depth", () => {
    const out = compactJson(
      { nested: { deep: { deeper: { deepest: { x: 1 } } } }, list: [1, 2, 3, 4, 5], title: "t", long: "y".repeat(50), empty: null },
      { maxArray: 2, maxString: 10, maxDepth: 4 },
    );
    assert.equal(
      out,
      '{"title":"t","long":"yyyyyyyyyy…","nested":{"deep":{"deeper":{"deepest":"{…}"}}},"list":[1,2,"…3 more"]}',
    );
  });

  it("truncates the whole string at maxChars", () => {
    assert.equal(compactJson({ a: "x".repeat(100) }, { maxChars: 10 }), '{"a":"xxxx…');
  });
});
