import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SYSTEM_PROMPT } from "../src/adapters/deciders/openrouter.ts";
import { RoutingState } from "../src/triage/routing.ts";
import { CascadeSim, type SimHooks } from "../src/triage/sim.ts";
import type { CloudfriendEvent } from "../src/types.ts";
import { cacheKey, CACHE_KEY_VERSION, fullPrompt, Jev, jevRequest, sha256, type JevRecord, type JevRequest } from "../ml/jev.ts";
import { tempDir } from "./helpers.ts";

const events: CloudfriendEvent[] = [
  { id: "a", source: "app", received_at: "2026-10-27T00:00:00Z", data: { level: "error", message: "payment failed" } },
  { id: "b", source: "app", received_at: "2026-10-27T00:00:01Z", data: { level: "info", message: "GET /health 200" } },
];
const env = { CLOUDFRIEND_EVENT_CHARS: "800" };

/** Write a valid record for `events` as Jev would have, answering with `reply`. */
function record(dir: string, reply: object, over: Partial<JevRecord> = {}): string {
  const req = jevRequest(events, env);
  const key = cacheKey(req);
  const rec: JevRecord = {
    key_version: CACHE_KEY_VERSION,
    request: { model: req.model, system_sha256: sha256(req.system), params: req.params, schema: req.schema, event_chars: req.event_chars },
    model: "some/model",
    latency_ms: 1200,
    flags: [{ reason: "payments failing", severity: "high", events: [0] }],
    judgments: [{ event: 0, relevance: "relevant" }, { event: 1, relevance: "benign" }],
    prompt: fullPrompt(req),
    response: JSON.stringify(reply),
    ...over,
  };
  const file = path.join(dir, key.slice(0, 2), key + ".json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rec));
  return file;
}
const REPLY = { alerts: [{ reason: "payments failing", severity: "high", events: [0] }], judgments: [{ event: 0, relevance: "relevant" }, { event: 1, relevance: "benign" }] };

describe("offline Jev (ml/jev.ts)", () => {
  let fetches = 0;
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      throw new Error("no requests in offline mode");
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("makes no request, even with API keys in the environment", async () => {
    const jev = new Jev({ mode: "offline", dir: tempDir(), env: { ...env, OPENROUTER_API_KEY: "sk-test", JEV_API_KEY: "sk-test" } });
    const a = await jev.ask(events);
    assert.equal(a.kind, "miss");
    assert.equal(fetches, 0);
    assert.deepEqual(jev.outcomes, { recorded: 0, live: 0, miss: 1, invalid: 0, unavailable: 0 });
  });

  it("goes live only when asked, with a budget", () => {
    assert.throws(() => new Jev({ mode: "live", dir: tempDir(), env: { OPENROUTER_API_KEY: "sk" } }), /budget/);
    assert.throws(() => new Jev({ mode: "live", budget: 1, dir: tempDir(), env: {} }), /API_KEY/);
  });

  it("answers from a valid recording", async () => {
    const dir = tempDir();
    record(dir, REPLY);
    const a = await new Jev({ mode: "offline", dir, env }).ask(events);
    assert.equal(a.kind, "recorded");
    if (a.kind !== "recorded") return;
    assert.deepEqual(a.decision.flags.map((f) => f.event_ids), [["a"]]);
    assert.deepEqual(a.decision.judgments, [{ event_id: "a", relevance: "relevant" }, { event_id: "b", relevance: "benign" }]);
    assert.equal(a.call.latency_ms, 1200);
    assert.equal(fetches, 0);
  });

  it("calls a corrupt or mismatched recording invalid, never an answer", async () => {
    const cases: [string, (dir: string) => void][] = [
      ["unreadable", (d) => fs.writeFileSync(record(d, REPLY), "{not json")],
      ["prompt differs", (d) => record(d, REPLY, { prompt: "something else" })],
      ["settings differ", (d) => record(d, REPLY, { request: { model: "other", system_sha256: "x", params: {}, schema: 2, event_chars: "800" } })],
      ["index out of range", (d) => record(d, REPLY, { judgments: [{ event: 7, relevance: "benign" }] })],
      ["stored decision differs from the reply", (d) => record(d, { alerts: [], judgments: [{ event: 0, relevance: "benign" }, { event: 1, relevance: "benign" }] })],
      ["old key version", (d) => record(d, REPLY, { key_version: 1 })],
    ];
    for (const [name, make] of cases) {
      const dir = tempDir();
      make(dir);
      const a = await new Jev({ mode: "offline", dir, env }).ask(events);
      assert.equal(a.kind, "invalid", name);
    }
  });

  it("keys on everything that decides the answer", () => {
    const base = jevRequest(events, env);
    const variants: JevRequest[] = [
      { ...base, model: "other/model" },
      jevRequest(events, { ...env, CLOUDFRIEND_DECIDER_INSTRUCTIONS: "Checkout matters most." }),
      { ...base, params: { temperature: 0.2, max_tokens: 4000, response_format: { type: "json_object" } } },
      { ...base, schema: base.schema + 1 },
      jevRequest(events, { CLOUDFRIEND_EVENT_CHARS: "400" }),
      jevRequest(events, env, [{ id: "flag-1", reason: "x", severity: "high" }]),
    ];
    const keys = new Set([cacheKey(base), ...variants.map(cacheKey)]);
    assert.equal(keys.size, variants.length + 1);
    assert.ok(base.system === SYSTEM_PROMPT && variants[1]!.system.includes("Checkout matters most."));
    assert.equal(cacheKey(jevRequest(events, env)), cacheKey(base), "and only on that");
  });
});

describe("unanswered batches in the simulator", () => {
  const DAY = 86_400_000;
  const state = () => new RoutingState({ verdictTtlMs: 60_000, escalatedTtlMs: 7 * DAY, suppressionTtlMs: 30 * DAY });
  const route = { dropBelow: 0.5, escalateAbove: 2, threshold: 0.9, hasJev: true, auditRate: 0 };
  const ev = (id: string, t: number, score: number) => ({ id, t, score, template: "app|pay|failed", severity: "e", novel: false });

  async function run(decide: SimHooks["decide"]) {
    const reached: string[] = [];
    const censored: string[] = [];
    const unanswered: string[] = [];
    const outcomes: boolean[] = [];
    const s = state();
    const sim = new CascadeSim(s, { route, batchWaitMs: 1000 }, {
      decide,
      reached: (ids) => reached.push(...ids),
      censored: (ids) => censored.push(...ids),
      unanswered: (ids) => unanswered.push(...ids),
      outcome: ({ answered }) => outcomes.push(answered),
    });
    await sim.push(ev("1", 0, 0.95));
    await sim.push(ev("2", 100, 0.2));
    await sim.finish(5000);
    return { sim, s, reached, censored, unanswered, outcomes };
  }

  it("a censored batch reaches no one, teaches nothing and raises nothing", async () => {
    const r = await run(async () => "censored");
    assert.deepEqual(r.reached, []);
    assert.deepEqual(r.censored.sort(), ["1", "2"]);
    assert.equal(r.sim.censored, 2);
    assert.equal(r.sim.flags.length, 0, "no fallback alert either");
    assert.deepEqual(r.outcomes, [false]);
    assert.equal(r.s.ledger.size, 0);
    assert.equal(r.s.escalated.size, 0);
  });

  it("the classifier's fallback when Jev is unavailable is marked as such", async () => {
    const r = await run(async () => null);
    assert.equal(r.sim.flags.length, 1);
    assert.equal(r.sim.flags[0]!.via, "fallback");
    assert.deepEqual(r.unanswered.sort(), ["1", "2"], "reached, but unanswered: not Jev's miss");
    assert.deepEqual(r.outcomes, [false]);
    assert.equal(r.s.escalated.size, 0, "nothing learned from it");
  });
});
