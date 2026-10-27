// The dashboard API (design/api-contract.md) on the real server: access control, workspace scoping,
// sources and ingest, destinations, events/flags/decisions, the test event, usage, and the UI files.
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { displayUrl } from "../src/api/destinations.ts";
import { UI_CSP } from "../src/api/static.ts";
import { testSourceId } from "../src/api/sources.ts";
import { hashPassword } from "../src/auth/index.ts";
import { DEFAULT_WORKSPACE } from "../src/db.ts";
import { checkDestinationUrl, setDefaultResolver } from "../src/net/outbound.ts";
import { createApp } from "../src/server.ts";
import type { ActionAdapter, Decision } from "../src/types.ts";
import { Client, until } from "./dashboard-client.ts";
import { ADMIN, fakeDecider, makeCloudfriend, rows, type TestCloudfriend } from "./helpers.ts";

// Destination checks resolve hostnames. Answer for the names these tests use, so the suite
// doesn't depend on the network (hooks.example.com doesn't resolve at all).
before(() =>
  setDefaultResolver(async (host) => {
    if (host === "example.com" || host.endsWith(".example.com") || host === "hooks.slack.com") return [{ address: "93.184.215.14", family: 4 }];
    throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  }),
);
after(() => setDefaultResolver());

const ALICE = { email: "alice@example.com", password: "alice has a long password" };
const BOB = { email: "bob@example.com", password: "bob has a long password too" };
const WS_A = DEFAULT_WORKSPACE;

let cf: TestCloudfriend | null = null;
afterEach(async () => {
  await cf?.close(0).catch(() => {});
  cf = null;
});

type Opts = Parameters<typeof makeCloudfriend>[0] & { withBob?: boolean };

/** A server whose bootstrap admin is Alice (owner of ws_default), and Bob with a workspace of his own. */
async function setup(opts: Opts = {}) {
  const { withBob = true, ...rest } = opts;
  cf = await makeCloudfriend({ ...rest, env: { CLOUDFRIEND_ADMIN_EMAIL: ALICE.email, CLOUDFRIEND_ADMIN_PASSWORD: ALICE.password, ...rest.env } });
  const app = cf.app;
  const client = () => new Client((p, init) => app.request(p.startsWith("http") ? p : `http://localhost${p}`, init));
  const alice = client();
  assert.equal((await alice.login(ALICE.email, ALICE.password)).status, 200);
  const bob = client();
  let wsB = "";
  if (withBob) {
    await cf.auth.store.createUser({ id: "usr_bob", email: BOB.email, name: "Bob", password_hash: await hashPassword(BOB.password), created_at: new Date() });
    assert.equal((await bob.login(BOB.email, BOB.password)).status, 200);
    const created = await bob.post("/api/workspaces", { name: "Bob's workspace" });
    assert.equal(created.status, 201);
    wsB = created.json.workspace.id;
  }
  const ingest = (path: string, secret: string, body: unknown) =>
    app.request(`http://localhost${path}`, { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { cf: cf!, alice, bob, wsB, client, ingest };
}

/** A flag (with a decision, a delivery and one event) written as the worker would. */
async function seedFlag(t: TestCloudfriend, ws: string, opts: { severity?: string; destination?: string; eventId?: number } = {}) {
  const id = "flg_" + Math.random().toString(16).slice(2, 12);
  const dec = "dec_" + Math.random().toString(16).slice(2, 12);
  const now = Date.now();
  const ev = opts.eventId ?? null;
  await t.db.query("INSERT INTO decisions (id, workspace_id, created_at, decider, model, prompt, response, event_ids) VALUES ($1, $2, $3, 'jev', 'm', 'the prompt', 'the reply', $4)", [
    dec,
    ws,
    now,
    JSON.stringify(ev ? [String(ev)] : []),
  ]);
  await t.db.query(
    "INSERT INTO flags (id, workspace_id, created_at, reason, severity, event_ids, decider, status, updated_at, event_count, users) VALUES ($1, $2, $3, 'something broke', $4, $5, 'jev', 'open', $3, $6, '[\"u1\"]')",
    [id, ws, now, opts.severity ?? "high", JSON.stringify(ev ? [String(ev)] : []), ev ? 1 : 0],
  );
  if (ev) await t.db.query("UPDATE events SET decided = true, judgment = 'relevant', flag_id = $2, decision_id = $3 WHERE id = $1", [ev, id, dec]);
  if (opts.destination) {
    await t.db.query("INSERT INTO deliveries (flag_id, workspace_id, action, status, attempts, next_attempt_at, updated_at) VALUES ($1, $2, $3, 'ok', 1, $4, $4)", [id, ws, opts.destination, now]);
  }
  return { flag: id, decision: dec };
}

/** A recording action adapter, usable as a destination kind. */
function recordingAdapter(over: Partial<ActionAdapter> = {}) {
  const seen = { runs: [] as { reason: string; config: unknown }[], tests: [] as unknown[], validated: [] as unknown[] };
  const adapter: ActionAdapter = {
    async run(flag, ctx) {
      seen.runs.push({ reason: flag.reason, config: ctx.config });
    },
    async validate(config) {
      seen.validated.push(config);
      return config;
    },
    async test(ctx) {
      seen.tests.push(ctx.config);
    },
    ...over,
  };
  return { adapter, seen };
}

// --- access ----------------------------------------------------------------------------------

/** Every workspace route of the contract, with a body where one is needed. */
function routes(ws: string, ids = { src: "src_x", dst: "dst_x", ev: "1", flg: "flg_x", dec: "dec_x", q: "1" }): [string, string, unknown?][] {
  const w = `/api/w/${ws}`;
  return [
    ["GET", `${w}/sources`],
    ["POST", `${w}/sources`, { name: "x", kind: "json" }],
    ["POST", `${w}/sources/${ids.src}/rotate`],
    ["DELETE", `${w}/sources/${ids.src}`],
    ["GET", `${w}/destinations`],
    ["POST", `${w}/destinations`, { name: "x", kind: "webhook", url: "https://example.com/hook" }],
    ["DELETE", `${w}/destinations/${ids.dst}`],
    ["POST", `${w}/destinations/${ids.dst}/test`],
    ["GET", `${w}/events`],
    ["GET", `${w}/events/${ids.ev}`],
    ["POST", `${w}/events/${ids.ev}/feedback`, { escalate: true }],
    ["POST", `${w}/test-event`],
    ["GET", `${w}/test-event/${ids.q}`],
    ["GET", `${w}/queue`],
    ["GET", `${w}/flags`],
    ["GET", `${w}/flags/${ids.flg}`],
    ["PATCH", `${w}/flags/${ids.flg}`, { status: "resolved" }],
    ["POST", `${w}/flags/${ids.flg}/feedback`, { verdict: "confirmed" }],
    ["GET", `${w}/decisions/${ids.dec}`],
    ["GET", `${w}/usage`],
    ["GET", `${w}/stats`],
  ];
}

describe("dashboard API access", () => {
  it("answers 401 signed out and 403 in someone else's workspace, for every route", async () => {
    const t = await setup({ actions: { webhook: recordingAdapter().adapter } });
    const anon = t.client();
    for (const [method, path] of [["GET", "/api/me"], ["GET", "/api/workspaces"], ["POST", "/api/workspaces"]] as const) {
      assert.equal((await anon.call(method, path, method === "POST" ? { name: "x" } : undefined)).status, 401, `${method} ${path}`);
    }
    for (const [method, path, body] of routes(WS_A)) {
      const signedOut = await anon.call(method, path, body);
      assert.equal(signedOut.status, 401, `signed out: ${method} ${path}`);
      assert.deepEqual(signedOut.json, { error: "not signed in" });
      const other = await t.bob.call(method, path, body);
      assert.equal(other.status, 403, `Bob in Alice's workspace: ${method} ${path}`);
    }
    for (const [method, path, body] of routes(t.wsB)) assert.equal((await t.alice.call(method, path, body)).status === 403, true, `Alice in Bob's: ${method} ${path}`);
    // Nothing was created by the refused requests.
    assert.equal((await rows(t.cf, "SELECT count(*) AS n FROM sources WHERE workspace_id = $1 AND id NOT LIKE 'src_test_%'", WS_A))[0].n, 0);
    assert.equal((await rows(t.cf, "SELECT count(*) AS n FROM queue"))[0].n, 0);
  });

  it("scopes every id by workspace: another workspace's ids are 404 in yours", async () => {
    const hook = recordingAdapter();
    const t = await setup({ actions: { webhook: hook.adapter } });
    const a = `/api/w/${WS_A}`;
    const src = (await t.alice.post(`${a}/sources`, { name: "app", kind: "json" })).json;
    const dst = (await t.alice.post(`${a}/destinations`, { name: "hook", kind: "webhook", url: "https://example.com/hook" })).json.destination;
    assert.equal((await t.ingest(`/in/${src.source.id}`, src.secret, { level: "error", message: "boom" })).status, 202);
    await t.cf.intake.flush();
    await t.cf.worker.parseNew();
    const ev = (await t.alice.get(`${a}/events`)).json.events[0];
    const { flag, decision } = await seedFlag(t.cf, WS_A, { eventId: Number(ev.id), destination: dst.id });
    const q = (await t.alice.post(`${a}/test-event`)).json.queue_id;

    const ids = { src: src.source.id, dst: dst.id, ev: ev.id, flg: flag, dec: decision, q };
    let checked = 0;
    for (const [method, path, body] of routes(t.wsB, ids)) {
      if (!Object.values(ids).some((id) => path.endsWith(`/${id}`) || path.includes(`/${id}/`))) continue;
      checked++;
      const r = await t.bob.call(method, path, body);
      assert.equal(r.status, 404, `Bob with Alice's id: ${method} ${path} -> ${r.status} ${JSON.stringify(r.json)}`);
    }
    assert.equal(checked, 11);
    // Bob's lists show none of Alice's data.
    const b = `/api/w/${t.wsB}`;
    assert.deepEqual((await t.bob.get(`${b}/sources`)).json.sources, []);
    assert.deepEqual((await t.bob.get(`${b}/destinations`)).json.destinations, []);
    assert.deepEqual((await t.bob.get(`${b}/events`)).json.events, []);
    assert.deepEqual((await t.bob.get(`${b}/flags`)).json.flags, []);
    assert.deepEqual((await t.bob.get(`${b}/queue`)).json.flags, []);
    assert.equal((await t.bob.get(`${b}/stats?since=1h`)).json.events, 0);
    assert.equal((await t.bob.get(`${b}/flags?before=${flag}`)).status, 400);
    // Alice's data is untouched.
    assert.equal((await t.alice.get(`${a}/sources`)).json.sources[0].revoked_at, null);
    assert.equal((await t.alice.get(`${a}/destinations`)).json.destinations.length, 1);
    assert.equal((await t.alice.get(`${a}/flags/${flag}`)).json.flag.status, "open");
    assert.equal(hook.seen.tests.length, 0);
    assert.equal((await t.ingest(`/in/${src.source.id}`, src.secret, { message: "still works" })).status, 202);
  });

  it("requires the CSRF header on state-changing requests", async () => {
    const t = await setup({ withBob: false });
    const a = `/api/w/${WS_A}`;
    const created = await t.alice.call("POST", `${a}/sources`, { name: "app", kind: "json" }, { csrf: false });
    assert.equal(created.status, 403);
    assert.match(created.json.error, /x-cloudfriend-csrf/);
    assert.equal((await t.alice.call("POST", "/api/workspaces", { name: "x" }, { csrf: false })).status, 403);
    const src = (await t.alice.post(`${a}/sources`, { name: "app", kind: "json" })).json.source;
    assert.equal((await t.alice.call("DELETE", `${a}/sources/${src.id}`, undefined, { csrf: false })).status, 403);
    assert.equal((await t.alice.get(`${a}/sources`)).json.sources[0].revoked_at, null);
    assert.equal((await t.alice.call("POST", "/api/logout", undefined, { csrf: false })).status, 403);
    assert.equal((await t.alice.get("/api/me")).status, 200);
  });

  it("lists and creates workspaces; the creator owns the new one", async () => {
    const t = await setup();
    const me = (await t.alice.get("/api/me")).json;
    assert.equal(me.user.email, ALICE.email);
    assert.deepEqual(me.workspaces, [{ id: WS_A, name: "default", role: "owner" }]);
    const list = (await t.bob.get("/api/workspaces")).json.workspaces;
    assert.deepEqual(list.map((w: any) => [w.id, w.role]), [[t.wsB, "owner"]]);
    assert.match(list[0].created_at, /^\d{4}-\d\d-\d\dT/);
    assert.equal((await t.bob.post("/api/workspaces", { name: " " })).status, 400);
    assert.equal((await t.bob.post("/api/workspaces", { name: "x".repeat(81) })).status, 400);
    assert.equal((await t.bob.call("POST", "/api/workspaces", "not an object")).status, 400);
    const big = await t.bob.call("POST", "/api/workspaces", { name: "x", pad: "x".repeat(70_000) });
    assert.equal(big.status, 413);
    assert.deepEqual(big.json, { error: "request body too large" });
  });

  it("keeps the admin-key API working, on the default workspace", async () => {
    const t = await setup({ withBob: false });
    const src = (await t.alice.post(`/api/w/${WS_A}/sources`, { name: "app", kind: "json" })).json;
    assert.equal((await t.ingest(`/in/${src.source.id}`, src.secret, { message: "hi" })).status, 202);
    await t.cf.intake.flush();
    await t.cf.worker.parseNew();
    const res = await t.cf.app.request("/events", { headers: { authorization: `Bearer ${ADMIN}` } });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).events[0].source, src.source.id);
    // The admin API's secrets are the legacy ones; source secrets are managed per source.
    const secrets = (await (await t.cf.app.request("/secrets", { headers: { authorization: `Bearer ${ADMIN}` } })).json()) as any;
    assert.ok(secrets.secrets.every((s: any) => s.name !== "app"));
    // A session cookie is no admin key.
    assert.equal((await t.alice.get("/events")).status, 401);
  });
});

// --- sources and ingest ------------------------------------------------------------------------

describe("dashboard API: sources", () => {
  it("creates a source whose secret files events under the source id, parsed by the source's kind", async () => {
    const t = await setup({ withBob: false });
    const a = `/api/w/${WS_A}`;
    const res = await t.alice.post(`${a}/sources`, { name: "sentry-prod", kind: "sentry" });
    assert.equal(res.status, 201);
    const { source, secret } = res.json;
    assert.match(source.id, /^src_[0-9a-f]{16}$/);
    assert.match(secret, /^cloudfriend_[A-Za-z0-9_-]{43}$/);
    assert.ok(secret.startsWith(source.secret_prefix) && source.secret_prefix.length > 12);
    assert.deepEqual(Object.keys(source).sort(), ["created_at", "endpoint_url", "id", "kind", "last_used_at", "name", "revoked_at", "secret_prefix"]);
    assert.equal(source.endpoint_url, `http://localhost/in/${source.id}`);
    assert.equal(source.kind, "sentry");
    assert.equal(source.last_used_at, null);
    assert.ok(!JSON.stringify((await t.alice.get(`${a}/sources`)).json).includes(secret), "the secret is shown once");
    assert.ok(!JSON.stringify(await rows(t.cf, "SELECT * FROM secrets")).includes(secret), "only a hash is stored");

    const sentryIssue = { action: "created", data: { issue: { id: "123", title: "TypeError: x is undefined" } } };
    assert.equal((await t.ingest(`/in/${source.id}`, secret, sentryIssue)).status, 202);
    await t.cf.intake.flush();
    const [q] = await rows(t.cf, "SELECT workspace_id, source, adapter FROM queue");
    assert.deepEqual(q, { workspace_id: WS_A, source: source.id, adapter: "sentry" });
    await t.cf.worker.parseNew();
    const events = (await t.alice.get(`${a}/events?source=${source.id}`)).json.events;
    assert.equal(events.length, 1);
    assert.equal(events[0].source, source.id);
    assert.deepEqual(events[0].data, sentryIssue);
    // The sentry adapter, not json, parsed it: it pulls out the issue as the group key.
    assert.deepEqual(await rows(t.cf, "SELECT group_key FROM events"), [{ group_key: "issue:123" }]);
    assert.ok((await t.alice.get(`${a}/sources`)).json.sources[0].last_used_at);
  });

  it("uses CLOUDFRIEND_PUBLIC_URL for endpoint URLs", async () => {
    const t = await setup({ withBob: false, env: { CLOUDFRIEND_PUBLIC_URL: "https://cf.example.com/base/" } });
    const { source } = (await t.alice.post(`/api/w/${WS_A}/sources`, { name: "app", kind: "json" })).json;
    assert.equal(source.endpoint_url, `https://cf.example.com/base/in/${source.id}`);
  });

  it("takes a source's secret only on its own path, and legacy secrets only on legacy paths", async () => {
    const t = await setup({ withBob: false });
    const a = `/api/w/${WS_A}`;
    const one = (await t.alice.post(`${a}/sources`, { name: "one", kind: "json" })).json;
    const two = (await t.alice.post(`${a}/sources`, { name: "two", kind: "json" })).json;
    assert.equal((await t.ingest(`/in/${two.source.id}`, one.secret, {})).status, 401);
    assert.equal((await t.ingest("/in/json", one.secret, {})).status, 401);
    assert.equal((await t.ingest(`/in/${one.source.id}`, t.cf.secret, {})).status, 401, "a legacy secret on a source id");
    assert.equal((await t.ingest("/in/myapp", t.cf.secret, {})).status, 202, "a legacy secret on a legacy path");
    assert.equal((await t.ingest(`/in/${one.source.id}`, "cloudfriend_nope", {})).status, 401);
    // The test source has no secrets of its own: nothing outside can post to it.
    assert.equal((await t.alice.post(`${a}/test-event`)).status, 200);
    assert.equal((await t.ingest(`/in/${testSourceId(WS_A)}`, t.cf.secret, {})).status, 401);
    assert.equal((await t.ingest(`/in/${testSourceId(WS_A)}`, one.secret, {})).status, 401);
  });

  it("keeps the old secret working for 24 hours after a rotation, then refuses it", async () => {
    const t = await setup({ withBob: false });
    const a = `/api/w/${WS_A}`;
    const created = (await t.alice.post(`${a}/sources`, { name: "app", kind: "json" })).json;
    const id = created.source.id;
    const before = Date.now();
    const rotated = await t.alice.post(`${a}/sources/${id}/rotate`);
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.json.secret, created.secret);
    assert.ok(rotated.json.secret.startsWith(rotated.json.source.secret_prefix));
    assert.equal((await t.ingest(`/in/${id}`, created.secret, {})).status, 202, "old secret, within the grace period");
    assert.equal((await t.ingest(`/in/${id}`, rotated.json.secret, {})).status, 202);
    const [old] = await rows(t.cf, "SELECT expires_at FROM secrets WHERE source_id = $1 AND expires_at IS NOT NULL", id);
    assert.ok(old.expires_at >= before + 24 * 3600_000 && old.expires_at <= Date.now() + 24 * 3600_000);

    // A second rotation leaves the first secret's earlier expiry, and gives the second its 24 h.
    const third = (await t.alice.post(`${a}/sources/${id}/rotate`)).json;
    const expiries = (await rows(t.cf, "SELECT expires_at FROM secrets WHERE source_id = $1 ORDER BY created_at, id", id)).map((r) => r.expires_at);
    assert.equal(expiries[0], old.expires_at);
    assert.ok(expiries[1] >= old.expires_at);
    assert.equal(expiries[2], null);

    // Past the grace period: refused. The newest works.
    await t.cf.db.query("UPDATE secrets SET expires_at = $2 WHERE source_id = $1 AND expires_at IS NOT NULL", [id, Date.now() - 1]);
    assert.equal((await t.ingest(`/in/${id}`, created.secret, {})).status, 401);
    assert.equal((await t.ingest(`/in/${id}`, rotated.json.secret, {})).status, 401);
    assert.equal((await t.ingest(`/in/${id}`, third.secret, {})).status, 202);
  });

  it("revokes a source and every secret it has", async () => {
    const t = await setup({ withBob: false });
    const a = `/api/w/${WS_A}`;
    const created = (await t.alice.post(`${a}/sources`, { name: "app", kind: "json" })).json;
    const id = created.source.id;
    const rotated = (await t.alice.post(`${a}/sources/${id}/rotate`)).json;
    assert.equal((await t.alice.call("DELETE", `${a}/sources/${id}`)).status, 204);
    assert.equal((await t.ingest(`/in/${id}`, created.secret, {})).status, 401);
    assert.equal((await t.ingest(`/in/${id}`, rotated.secret, {})).status, 401);
    const listed = (await t.alice.get(`${a}/sources`)).json.sources;
    assert.equal(listed.length, 1);
    assert.ok(listed[0].revoked_at);
    assert.equal((await t.alice.post(`${a}/sources/${id}/rotate`)).status, 400);
    assert.equal((await t.alice.call("DELETE", `${a}/sources/${id}`)).status, 204, "revoking twice is harmless");
    assert.equal((await t.alice.call("DELETE", `${a}/sources/src_nope`)).status, 404);
    // The name can be used again.
    assert.equal((await t.alice.post(`${a}/sources`, { name: "app", kind: "json" })).status, 201);
  });

  it("validates input", async () => {
    const t = await setup({ withBob: false });
    const a = `/api/w/${WS_A}/sources`;
    assert.equal((await t.alice.post(a, {})).status, 400);
    assert.equal((await t.alice.post(a, { name: "has space", kind: "json" })).status, 400);
    assert.equal((await t.alice.post(a, { name: "x", kind: "nope" })).status, 400);
    assert.equal((await t.alice.post(a, { name: "cloudfriend-test", kind: "json" })).status, 400);
    assert.equal((await t.alice.post(a, { name: "dup", kind: "json" })).status, 201);
    assert.equal((await t.alice.post(a, { name: "dup", kind: "posthog" })).status, 409);
    assert.equal((await t.alice.call("POST", a, "{not json")).status, 400);
  });
});

// --- destinations ------------------------------------------------------------------------------

describe("dashboard API: destinations", () => {
  it("stores a destination's settings and never returns its secrets", async () => {
    const hook = recordingAdapter();
    const t = await setup({ withBob: false, actions: { webhook: hook.adapter } });
    const a = `/api/w/${WS_A}/destinations`;
    const url = "https://hooks.example.com/services/abcd1234efgh5678/x?token=topsecret";
    const res = await t.alice.post(a, { name: "pager", kind: "webhook", url, signing_secret: "whsec_supersecret" });
    assert.equal(res.status, 201);
    const d = res.json.destination;
    assert.deepEqual(Object.keys(d).sort(), ["created_at", "has_signing_secret", "id", "kind", "last_delivery_at", "last_error", "name", "url_display"]);
    assert.equal(d.has_signing_secret, true);
    assert.equal(d.url_display, "https://hooks.example.com/services/ab…/x?…");
    assert.deepEqual(hook.seen.validated, [{ url, signing_secret: "whsec_supersecret" }]);
    const listed = JSON.stringify((await t.alice.get(a)).json);
    for (const secret of ["whsec_supersecret", "topsecret", "abcd1234efgh5678"]) assert.ok(!listed.includes(secret), secret);
    assert.deepEqual((await rows(t.cf, "SELECT config FROM destinations"))[0].config, { url, signing_secret: "whsec_supersecret" });
    const plain = (await t.alice.post(a, { name: "plain", kind: "webhook", url: "https://example.com/hook" })).json.destination;
    assert.equal(plain.has_signing_secret, false);
  });

  it("masks secret parts of URLs", () => {
    assert.equal(displayUrl("https://hooks.slack.com/services/T0ACME123/B0OPS/xyzSECRET"), "https://hooks.slack.com/services/T0…/…");
    assert.equal(displayUrl("https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOp"), "https://discord.com/api/webhooks/12…/Ab…");
    assert.equal(displayUrl("https://user:pw@example.com/hook?k=v"), "https://example.com/hook?…");
    assert.equal(displayUrl("not a url"), "(invalid URL)");
  });

  it("refuses http and private addresses unless CLOUDFRIEND_ALLOW_PRIVATE_DESTINATIONS=on", async () => {
    const t = await setup({ withBob: false, actions: { webhook: recordingAdapter().adapter } });
    const a = `/api/w/${WS_A}/destinations`;
    const http = await t.alice.post(a, { name: "h", kind: "webhook", url: "http://example.com/hook" });
    assert.equal(http.status, 400);
    assert.match(http.json.error, /https/);
    assert.equal((await t.alice.post(a, { name: "h", kind: "webhook", url: "ftp://example.com/x" })).status, 400);
    assert.equal((await t.alice.post(a, { name: "h", kind: "nope", url: "https://example.com/x" })).status, 400);
    assert.equal((await t.alice.post(a, { name: "h", kind: "webhook" })).status, 400);

    // The address check is src/net/outbound.ts's; the API passes the setting and reports its error.
    const seen: boolean[] = [];
    const stub: typeof checkDestinationUrl = async (url, opts) => {
      seen.push(opts.allowPrivate);
      return /\/\/10\./.test(url) && !opts.allowPrivate ? { ok: false, error: "resolves to a private address" } : checkDestinationUrl(url, opts);
    };
    for (const allow of ["off", "on"]) {
      const env = { CLOUDFRIEND_ALLOW_PRIVATE_DESTINATIONS: allow };
      const app = createApp({
        db: t.cf.db,
        intake: t.cf.intake,
        secrets: t.cf.secrets,
        sources: new Map(),
        adminKey: "",
        maxBodyBytes: 1024,
        auth: t.cf.auth,
        actionAdapters: new Map([["webhook", recordingAdapter().adapter]]),
        env,
        checkDestinationUrl: stub,
      });
      const c = new Client((p, init) => app.request(`http://localhost${p}`, init));
      c.cookie = t.alice.cookie;
      const priv = await c.post(a, { name: "p", kind: "webhook", url: "https://10.0.0.5/hook" });
      const local = await c.post(a, { name: "l", kind: "webhook", url: "http://127.0.0.1:9000/hook" });
      if (allow === "off") {
        assert.equal(priv.status, 400);
        assert.equal(priv.json.error, "url: resolves to a private address");
        assert.equal(local.status, 400);
      } else {
        assert.equal(priv.status, 201);
        assert.equal(local.status, 201);
      }
    }
    assert.deepEqual([...new Set(seen)], [false, true]);
  });

  it("passes validate() errors on, and stores what validate() returns", async () => {
    const strict = recordingAdapter({
      async validate(config) {
        if (!String(config.url).startsWith("https://hooks.slack.com/")) throw new Error("use a Slack incoming webhook URL");
        return { ...config, url: String(config.url).trim() };
      },
    });
    const t = await setup({ withBob: false, actions: { slack: strict.adapter } });
    const a = `/api/w/${WS_A}/destinations`;
    const bad = await t.alice.post(a, { name: "s", kind: "slack", url: "https://example.com/x" });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, "use a Slack incoming webhook URL");
    const ok = await t.alice.post(a, { name: "#ops", kind: "slack", url: "https://hooks.slack.com/services/T0ACME/B0OPS/xyz" });
    assert.equal(ok.json.destination.url_display, "https://hooks.slack.com/services/T0…/…");
  });

  it("sends a test with test(), or a labelled run() without it, and reports the status only", async () => {
    const withTest = recordingAdapter();
    const failing = recordingAdapter({ test: undefined, run: async () => { throw new Error('webhook replied 404: {"secret":"body text"}'); } });
    const plain = recordingAdapter({ test: undefined });
    const t = await setup({ withBob: false, actions: { webhook: withTest.adapter, failing: failing.adapter, plain: plain.adapter } });
    const a = `/api/w/${WS_A}/destinations`;
    const mk = async (kind: string) => (await t.alice.post(a, { name: kind, kind, url: "https://example.com/hook", signing_secret: "s1" })).json.destination;
    const [d1, d2, d3] = [await mk("webhook"), await mk("failing"), await mk("plain")];

    assert.deepEqual((await t.alice.post(`${a}/${d1.id}/test`)).json, { ok: true });
    assert.deepEqual(withTest.seen.tests, [{ url: "https://example.com/hook", signing_secret: "s1" }]);
    assert.equal(withTest.seen.runs.length, 0);
    assert.ok((await t.alice.get(a)).json.destinations.find((d: any) => d.id === d1.id).last_delivery_at);

    assert.deepEqual((await t.alice.post(`${a}/${d2.id}/test`)).json, { ok: false, error: "webhook replied 404" });

    assert.deepEqual((await t.alice.post(`${a}/${d3.id}/test`)).json, { ok: true });
    assert.equal(plain.seen.runs.length, 1);
    assert.match(plain.seen.runs[0]!.reason, /test/i);
    assert.deepEqual(plain.seen.runs[0]!.config, { url: "https://example.com/hook", signing_secret: "s1" });

    assert.equal((await t.alice.call("DELETE", `${a}/${d1.id}`)).status, 204);
    assert.equal((await t.alice.post(`${a}/${d1.id}/test`)).status, 404);
    assert.equal((await t.alice.call("DELETE", `${a}/${d1.id}`)).status, 404);
  });

  it("deletes softly: deliveries still name a deleted destination", async () => {
    const t = await setup({ withBob: false, actions: { webhook: recordingAdapter().adapter } });
    const a = `/api/w/${WS_A}`;
    const d = (await t.alice.post(`${a}/destinations`, { name: "pager bridge", kind: "webhook", url: "https://example.com/hook" })).json.destination;
    const { flag } = await seedFlag(t.cf, WS_A, { destination: d.id });
    await t.cf.db.query("INSERT INTO deliveries (flag_id, workspace_id, action, status, attempts, next_attempt_at, updated_at, last_error) VALUES ($1, $2, 'slack', 'failed', 15, 0, 0, 'slack replied 500')", [flag, WS_A]);
    assert.equal((await t.alice.call("DELETE", `${a}/destinations/${d.id}`)).status, 204);
    assert.deepEqual((await t.alice.get(`${a}/destinations`)).json.destinations, []);
    const deliveries = (await t.alice.get(`${a}/flags/${flag}`)).json.deliveries;
    assert.deepEqual(
      deliveries.map((x: any) => [x.destination_id, x.destination_name, x.status, x.attempts, x.last_error]),
      [
        [d.id, "pager bridge", "ok", 1, null],
        ["slack", "slack", "failed", 15, "slack replied 500"],
      ],
    );
    assert.deepEqual(Object.keys(deliveries[0]).sort(), ["attempts", "destination_id", "destination_name", "last_error", "status", "updated_at"]);
  });
});

// --- events, flags, decisions ----------------------------------------------------------------

const EVENT_KEYS = ["data", "decided", "decision_id", "flag_id", "id", "judgment", "received_at", "route", "score", "severity", "source", "template"];
const FLAG_KEYS = ["created_at", "decider", "event_count", "id", "reason", "severity", "status", "updated_at", "users"];

describe("dashboard API: events, flags and decisions", () => {
  it("lists events newest first, with filters and cursor paging", async () => {
    const t = await setup({ withBob: false });
    const a = `/api/w/${WS_A}`;
    const src = (await t.alice.post(`${a}/sources`, { name: "app", kind: "json" })).json;
    for (let i = 0; i < 5; i++) assert.equal((await t.ingest(`/in/${src.source.id}`, src.secret, { message: `event ${i}` })).status, 202);
    assert.equal((await t.ingest("/in/legacy", t.cf.secret, { message: "legacy" })).status, 202);
    await t.cf.intake.flush();
    await t.cf.worker.parseNew();

    const first = (await t.alice.get(`${a}/events?limit=4`)).json;
    assert.equal(first.events.length, 4);
    assert.deepEqual(Object.keys(first.events[0]).sort(), EVENT_KEYS);
    assert.equal(first.events[0].source, "legacy");
    assert.equal(first.events[0].route, null);
    assert.equal(first.events[0].judgment, null);
    assert.equal(first.next, first.events[3].id);
    const second = (await t.alice.get(`${a}/events?limit=4&before=${first.next}`)).json;
    assert.deepEqual(second.events.map((e: any) => e.data.message), ["event 1", "event 0"]);
    assert.equal(second.next, null);
    assert.equal((await t.alice.get(`${a}/events?source=${src.source.id}`)).json.events.length, 5);
    assert.equal((await t.alice.get(`${a}/events?route=drop`)).json.events.length, 0);
    assert.equal((await t.alice.get(`${a}/events?route=pending&since=1h`)).json.events.length, 6);
    assert.equal((await t.alice.get(`${a}/events?since=${new Date(Date.now() + 60_000).toISOString()}`)).json.events.length, 0);
    assert.equal((await t.alice.get(`${a}/events?since=bogus`)).status, 400);
    assert.equal((await t.alice.get(`${a}/events?before=x`)).status, 400);
    const one = (await t.alice.get(`${a}/events/${first.events[1].id}`)).json.event;
    assert.deepEqual(one, first.events[1]);
    assert.equal((await t.alice.get(`${a}/events/nope`)).status, 404);
    assert.deepEqual((await t.alice.post(`${a}/events/${one.id}/feedback`, { escalate: true })).json, {});
    assert.equal((await t.alice.post(`${a}/events/${one.id}/feedback`, { escalate: "yes" })).status, 400);
  });

  it("shows flags with their events, deliveries and decisions, and changes their status", async () => {
    const t = await setup({ withBob: false });
    const a = `/api/w/${WS_A}`;
    assert.equal((await t.ingest("/in/app", t.cf.secret, { level: "error", message: "boom" })).status, 202);
    await t.cf.intake.flush();
    await t.cf.worker.parseNew();
    const ev = (await t.alice.get(`${a}/events`)).json.events[0];
    const low = await seedFlag(t.cf, WS_A, { severity: "low" });
    const crit = await seedFlag(t.cf, WS_A, { severity: "critical", eventId: Number(ev.id) });
    const med = await seedFlag(t.cf, WS_A, { severity: "medium" });

    const queue = (await t.alice.get(`${a}/queue`)).json.flags;
    assert.deepEqual(queue.map((f: any) => f.id), [crit.flag, med.flag, low.flag]);
    assert.deepEqual(Object.keys(queue[0]).sort(), FLAG_KEYS);
    assert.equal(queue[0].event_count, 1);
    assert.deepEqual(queue[0].users, ["u1"]);

    const detail = (await t.alice.get(`${a}/flags/${crit.flag}`)).json;
    assert.equal(detail.flag.id, crit.flag);
    assert.deepEqual(detail.events.map((e: any) => [e.id, e.judgment, e.flag_id, e.decision_id, e.decided]), [[ev.id, "relevant", crit.flag, crit.decision, true]]);
    assert.deepEqual(detail.deliveries, []);
    const decision = (await t.alice.get(`${a}/decisions/${crit.decision}`)).json.decision;
    assert.deepEqual(Object.keys(decision).sort(), ["created_at", "decider", "event_ids", "id", "model", "prompt", "response"]);
    assert.deepEqual(decision.event_ids, [ev.id]);
    assert.equal((await t.alice.get(`${a}/decisions/dec_nope`)).status, 404);

    const acked = await t.alice.call("PATCH", `${a}/flags/${crit.flag}`, { status: "acknowledged" });
    assert.equal(acked.json.flag.status, "acknowledged");
    assert.equal((await t.alice.call("PATCH", `${a}/flags/${crit.flag}`, { status: "open" })).status, 400);
    assert.equal((await t.alice.call("PATCH", `${a}/flags/flg_nope`, { status: "resolved" })).status, 404);
    assert.equal((await t.alice.call("PATCH", `${a}/flags/${low.flag}`, { status: "resolved" })).json.flag.status, "resolved");
    assert.deepEqual((await t.alice.get(`${a}/queue`)).json.flags.map((f: any) => [f.id, f.status]), [[crit.flag, "acknowledged"], [med.flag, "open"]]);
    const fb = await t.alice.post(`${a}/flags/${crit.flag}/feedback`, { verdict: "false_positive" });
    assert.equal(fb.json.flag.status, "false_positive");
    assert.equal((await t.alice.post(`${a}/flags/${crit.flag}/feedback`, { verdict: "maybe" })).status, 400);

    const page1 = (await t.alice.get(`${a}/flags?limit=2`)).json;
    assert.equal(page1.flags.length, 2);
    const page2 = (await t.alice.get(`${a}/flags?limit=2&before=${page1.next}`)).json;
    assert.equal(page2.flags.length, 1);
    assert.equal(new Set([...page1.flags, ...page2.flags].map((f: any) => f.id)).size, 3);
    assert.deepEqual((await t.alice.get(`${a}/flags?status=resolved`)).json.flags.map((f: any) => f.id), [low.flag]);
    assert.equal((await t.alice.get(`${a}/flags?status=bogus`)).status, 400);
  });
});

// --- the test event ------------------------------------------------------------------------------

describe("dashboard API: test event", () => {
  it("goes through intake and the sorter: queued, parsed, routed, judged, flagged", async () => {
    const decider = fakeDecider((events): Decision => {
      const tests = events.filter((e) => (e.data as any)?.cloudfriend_test === true);
      return {
        flags: tests.length ? [{ reason: "Test exception from the setup page", severity: "low", event_ids: tests.map((e) => e.id) }] : [],
        judgments: events.map((e) => ({ event_id: e.id, relevance: tests.includes(e) ? "relevant" : "benign" })),
      };
    });
    const hook = recordingAdapter();
    const t = await setup({ withBob: false, decider: decider.adapter, actions: { webhook: hook.adapter }, config: { triage: true, batchWaitMs: 20 } });
    const a = `/api/w/${WS_A}`;
    const posted = await t.alice.post(`${a}/test-event`);
    assert.equal(posted.status, 200);
    const qid = posted.json.queue_id;
    assert.match(qid, /^\d+$/);
    const queued = (await t.alice.get(`${a}/test-event/${qid}`)).json;
    assert.deepEqual(queued, { queue_id: qid, status: "new", event: null });
    const [row] = await rows(t.cf, "SELECT source, adapter, body FROM queue WHERE id = $1", qid);
    assert.equal(row.source, testSourceId(WS_A));
    assert.equal(row.adapter, "json");
    const sent = JSON.parse(Buffer.from(row.body).toString());
    assert.match(sent.message, /^cloudfriend test exception [0-9a-f]{8}$/);
    assert.equal(sent.level, "error");

    t.cf.worker.start();
    const ev = await until(async () => {
      const r = (await t.alice.get(`${a}/test-event/${qid}`)).json;
      return r.status === "done" && r.event?.decided ? r.event : null;
    });
    assert.equal(ev.source, testSourceId(WS_A));
    assert.ok(ev.route && ev.route !== "drop", `routed past the classifier, got ${ev.route}`);
    assert.ok(decider.calls.flat().some((e) => e.id === ev.id), "the decider judged it");
    assert.equal(ev.judgment, "relevant");
    assert.match(ev.decision_id, /^dec_/);
    const flags = (await t.alice.get(`${a}/queue`)).json.flags;
    assert.equal(flags.length, 1);
    const detail = (await t.alice.get(`${a}/flags/${flags[0].id}`)).json;
    assert.deepEqual(detail.events.map((e: any) => e.id), [ev.id]);
    assert.equal(ev.flag_id, flags[0].id);
    // The test source is not listed with the workspace's sources.
    assert.deepEqual((await t.alice.get(`${a}/sources`)).json.sources, []);
    assert.equal((await t.alice.get(`${a}/test-event/999999`)).status, 404);
    assert.equal((await t.alice.get(`${a}/test-event/abc`)).status, 404);
  });
});

// --- usage and stats ---------------------------------------------------------------------------

describe("dashboard API: usage and stats", () => {
  it("reports today's usage, the backlog, the budget and the decider", async () => {
    const t = await setup({ withBob: false });
    const a = `/api/w/${WS_A}`;
    const day = new Date().toISOString().slice(0, 10);
    let u = (await t.alice.get(`${a}/usage`)).json;
    assert.deepEqual(u, { day, events: 0, backlog: 0, jev_calls: 0, jev_spend_usd: 0, jev_budget_usd: null, budget_exhausted: false, decider: "jev" });
    assert.equal((await t.ingest("/in/app", t.cf.secret, { message: "x" })).status, 202);
    await t.cf.intake.flush();
    // Intake counts the accepted request in the same commit.
    assert.equal((await t.alice.get(`${a}/usage`)).json.events, 1);
    await t.cf.db.query(
      `INSERT INTO usage (workspace_id, day, events, jev_calls, jev_spend_usd) VALUES ($1, $2, 120, 3, 0.25)
       ON CONFLICT (workspace_id, day) DO UPDATE SET events = excluded.events, jev_calls = excluded.jev_calls, jev_spend_usd = excluded.jev_spend_usd`,
      [WS_A, day],
    );
    await t.cf.db.query(`UPDATE workspaces SET settings = '{"jev_budget_usd": 0.25}' WHERE id = $1`, [WS_A]);
    u = (await t.alice.get(`${a}/usage`)).json;
    assert.deepEqual(u, { day, events: 120, backlog: 1, jev_calls: 3, jev_spend_usd: 0.25, jev_budget_usd: 0.25, budget_exhausted: true, decider: "none" });
  });

  it("counts events by route and flags since a time", async () => {
    const t = await setup({ withBob: false });
    const a = `/api/w/${WS_A}`;
    for (const m of ["a", "b"]) assert.equal((await t.ingest("/in/app", t.cf.secret, { message: m })).status, 202);
    await t.cf.intake.flush();
    await t.cf.worker.parseNew();
    await t.cf.db.query("UPDATE events SET route = 'drop' WHERE id = (SELECT min(id) FROM events)");
    await seedFlag(t.cf, WS_A);
    assert.deepEqual((await t.alice.get(`${a}/stats?since=1h`)).json, { routes: { drop: 1, none: 1 }, events: 2, flags: 1 });
    assert.deepEqual((await t.alice.get(`${a}/stats?since=${new Date(Date.now() + 60_000).toISOString()}`)).json, { routes: {}, events: 0, flags: 0 });
    assert.equal((await t.alice.get(`${a}/stats?since=soon`)).status, 400);
  });
});

// --- the UI ------------------------------------------------------------------------------------

describe("dashboard UI files", () => {
  it("serves the app with its CSP, content types and cache headers, and index.html for app paths", async () => {
    const t = await setup({ withBob: false });
    const get = (p: string, headers: Record<string, string> = {}) => t.cf.app.request(`http://localhost${p}`, { headers });
    const index = await get("/");
    assert.equal(index.status, 200);
    assert.equal(index.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(index.headers.get("content-security-policy"), UI_CSP);
    assert.equal(index.headers.get("x-content-type-options"), "nosniff");
    assert.equal(index.headers.get("referrer-policy"), "same-origin");
    assert.equal(index.headers.get("cache-control"), "no-cache");
    const html = await index.text();
    assert.match(html, /<script type="module" src="js\/app.js">/);

    const js = await get("/js/app.js");
    assert.equal(js.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(js.headers.get("content-security-policy"), UI_CSP);
    assert.equal((await get("/styles.css")).headers.get("content-type"), "text/css; charset=utf-8");
    assert.equal((await get("/favicon.svg")).headers.get("content-type"), "image/svg+xml");
    const etag = js.headers.get("etag")!;
    assert.ok(etag);
    assert.equal((await get("/js/app.js", { "if-none-match": etag })).status, 304);

    for (const p of ["/w/ws_default/queue", "/setup", "/index.html"]) {
      const r = await get(p);
      assert.equal(r.status, 200, p);
      assert.equal(await r.text(), html, p);
    }
    for (const p of ["/nope.js", "/js/missing.js", "/%2e%2e/package.json", "/..%2fpackage.json", "/js/../../package.json"]) {
      const r = await get(p);
      assert.equal(r.status, 404, p);
    }
    for (const p of ["/api/nope", "/in/app", "/auth/oidc/nope"]) {
      const r = await get(p);
      assert.equal(r.status, 404, p);
      assert.match(r.headers.get("content-type") ?? "", /json/, p);
    }
    assert.equal((await get("/healthz")).status, 200);
    const api = await get("/api/auth-config");
    assert.equal(api.headers.get("x-content-type-options"), "nosniff");
    assert.equal(api.headers.get("content-security-policy"), null);
  });
});
