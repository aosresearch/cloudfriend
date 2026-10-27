// The dashboard's first-run flow over HTTP, as the UI drives it: sign in, create a workspace, connect a
// source and a destination, send test exceptions until one alerts, handle the flag, rotate and revoke.
// Run against the dev mock (test/ui.test.ts) and the real server (test/dashboard-api.test.ts), so both
// are held to the same contract.
import assert from "node:assert/strict";
import { Client, until } from "./dashboard-client.ts";

export interface FlowOptions {
  baseUrl: string;
  login: { email: string; password: string };
  /** A workspace the signed-in user is not a member of. */
  foreignWorkspace: string;
  /** How long to wait for the pipeline. */
  timeoutMs?: number;
}

export async function firstRunFlow(o: FlowOptions): Promise<void> {
  const http = new Client((p, init) => fetch(p.startsWith("http") ? p : o.baseUrl + p, init));
  const wait = <T>(fn: () => Promise<T | undefined | null | false>) => until(fn, o.timeoutMs ?? 15_000, 100);

  const cfg = (await http.get("/api/auth-config")).json;
  assert.equal(cfg.password, true);
  assert.equal(typeof cfg.oidc, "boolean");
  assert.equal(typeof cfg.oidcLabel, "string");
  assert.equal((await http.get("/api/me")).status, 401);
  assert.equal((await http.login(o.login.email, "not the password")).status, 401);
  const login = await http.login(o.login.email, o.login.password);
  assert.equal(login.status, 200);
  assert.equal(login.json.user.email, o.login.email);
  assert.match(http.cookie, /^cf_session=/);
  assert.match(login.res.headers.get("set-cookie") ?? "", /HttpOnly/);
  assert.match(login.res.headers.get("set-cookie") ?? "", /SameSite=Lax/);

  assert.equal((await http.call("POST", "/api/workspaces", { name: "x" }, { csrf: false })).status, 403);
  const created = await http.post("/api/workspaces", { name: "Test" });
  assert.equal(created.status, 201);
  const ws = created.json.workspace;
  assert.equal(ws.role, "owner");
  assert.ok((await http.get("/api/me")).json.workspaces.some((w: { id: string; role: string }) => w.id === ws.id && w.role === "owner"));
  assert.equal((await http.get(`/api/w/${o.foreignWorkspace}/queue`)).status, 403);

  const w = `/api/w/${ws.id}`;

  // Step 1: a source, and an event sent to it the way the setup page's curl example does.
  const src = await http.post(`${w}/sources`, { name: "app", kind: "json" });
  assert.equal(src.status, 201);
  assert.match(src.json.secret, /^cloudfriend_/);
  const source = src.json.source;
  assert.match(source.endpoint_url, new RegExp(`/in/${source.id}$`));
  const ingest = await fetch(source.endpoint_url.replace(/^https?:\/\/[^/]+/, o.baseUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${src.json.secret}` },
    body: JSON.stringify({ level: "info", message: "hello" }),
  });
  assert.equal(ingest.status, 202);

  // Step 2: a destination, checked and tested.
  assert.equal((await http.post(`${w}/destinations`, { name: "hook", kind: "webhook", url: "http://example.com/x" })).status, 400);
  const dst = await http.post(`${w}/destinations`, { name: "hook", kind: "webhook", url: "https://example.com/x", signing_secret: "s" });
  assert.equal(dst.status, 201);
  assert.equal(dst.json.destination.has_signing_secret, true);
  assert.ok(!JSON.stringify((await http.get(`${w}/destinations`)).json).includes('"s"'));
  assert.deepEqual((await http.post(`${w}/destinations/${dst.json.destination.id}/test`)).json, { ok: true });

  // Step 3: test exceptions through the pipeline, until one is judged relevant and alerts.
  let alerted: { ev: any; flagId: string } | null = null;
  for (let attempt = 0; attempt < 3 && !alerted; attempt++) {
    const sent = await http.post(`${w}/test-event`);
    assert.equal(sent.status, 200);
    const queueId = sent.json.queue_id;
    assert.equal(typeof queueId, "string");
    const ev = await wait(async () => {
      const r = (await http.get(`${w}/test-event/${queueId}`)).json;
      assert.equal(r.queue_id, queueId);
      assert.ok(["new", "done", "failed"].includes(r.status));
      return r.event?.decided ? r.event : null;
    });
    assert.ok(ev.route, "routed");
    for (const k of ["judgment", "flag_id", "decision_id", "score", "template", "severity"]) assert.ok(k in ev, `Event.${k}`);
    assert.ok(["relevant", "benign", "uncertain"].includes(ev.judgment), `judged, got ${ev.judgment}`);
    assert.equal(typeof ev.decision_id, "string", "judged by a decider call");
    const dec = (await http.get(`${w}/decisions/${ev.decision_id}`)).json.decision;
    assert.ok(dec.event_ids.includes(ev.id));
    // As the setup page does: the event's flag_id says whether (and where) it alerted.
    const flagId: string | null = ev.flag_id ?? null;
    if (flagId) alerted = { ev, flagId };
    else assert.notEqual(ev.judgment, "relevant", "a relevant test exception alerts");
  }
  assert.ok(alerted, "one of the test exceptions alerted");

  const detail = await wait(async () => {
    const d = (await http.get(`${w}/flags/${alerted!.flagId}`)).json;
    return d.deliveries.length && d.deliveries.every((x: { status: string }) => x.status === "ok") ? d : null;
  });
  assert.ok(detail.events.some((e: { id: string }) => e.id === alerted!.ev.id));
  assert.ok(detail.deliveries.every((x: { destination_name: string }) => typeof x.destination_name === "string" && x.destination_name));
  const queue = (await http.get(`${w}/queue`)).json.flags as { id: string }[];
  assert.ok(queue.some((f) => f.id === alerted!.flagId));
  assert.equal((await http.call("PATCH", `${w}/flags/${alerted.flagId}`, { status: "resolved" })).json.flag.status, "resolved");
  assert.ok(!(await http.get(`${w}/queue`)).json.flags.some((f: { id: string }) => f.id === alerted!.flagId));
  assert.equal((await http.post(`${w}/flags/${alerted.flagId}/feedback`, { verdict: "confirmed" })).json.flag.status, "confirmed");

  // The events page and usage.
  const events = (await http.get(`${w}/events`, )).json;
  assert.ok(events.events.some((e: { source: string }) => e.source === source.id), "the curl event is listed under its source id");
  const usage = (await http.get(`${w}/usage`)).json;
  for (const k of ["day", "events", "backlog", "jev_calls", "jev_spend_usd", "jev_budget_usd", "budget_exhausted", "decider"]) assert.ok(k in usage, `usage.${k}`);
  const stats = (await http.get(`${w}/stats?since=1h`)).json;
  assert.ok(stats.events >= 2 && typeof stats.routes === "object" && typeof stats.flags === "number");

  // Rotate and revoke.
  const rotated = (await http.post(`${w}/sources/${source.id}/rotate`)).json;
  assert.notEqual(rotated.secret, src.json.secret);
  assert.equal((await http.call("DELETE", `${w}/sources/${source.id}`)).status, 204);
  assert.ok((await http.get(`${w}/sources`)).json.sources.find((s: { id: string }) => s.id === source.id).revoked_at);
  const refused = await fetch(source.endpoint_url.replace(/^https?:\/\/[^/]+/, o.baseUrl), { method: "POST", headers: { authorization: `Bearer ${rotated.secret}` }, body: "{}" });
  assert.equal(refused.status, 401);
  assert.equal((await http.post("/api/logout")).status, 200);
  assert.equal((await http.get("/api/me")).status, 401);
}

/** index.html and every asset it loads, following module imports, are served with the right types. */
export async function assetsLoad(baseUrl: string): Promise<number> {
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const html = await res.text();
  const queue = [...html.matchAll(/(?:src|href)="([^"#][^"]*)"/g)].map((m) => new URL(m[1]!, `${baseUrl}/`).href);
  assert.ok(queue.some((u) => u.endsWith("/js/app.js")));
  const seen = new Set<string>();
  while (queue.length) {
    const u = queue.shift()!;
    if (seen.has(u)) continue;
    seen.add(u);
    const r = await fetch(u);
    assert.equal(r.status, 200, u);
    if (u.endsWith(".js")) {
      assert.match(r.headers.get("content-type") ?? "", /javascript/, u);
      for (const m of (await r.text()).matchAll(/(?:from|import)\s*"(\.{1,2}\/[^"]+)"/g)) queue.push(new URL(m[1]!, u).href);
    } else await r.arrayBuffer();
  }
  assert.ok(seen.size >= 15, `only ${seen.size} assets found`);
  return seen.size;
}
