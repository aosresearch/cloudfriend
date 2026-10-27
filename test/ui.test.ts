// The dashboard's static files and its dev mock of the API contract (src/ui/dev/mock-server.ts).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { startMockServer } from "../src/ui/dev/mock-server.ts";

const STATIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/ui/static");
let server: { url: string; close: () => Promise<void> };
let cookie = "";

before(async () => {
  server = await startMockServer({ port: 0, latencyMs: 0 });
});
after(() => server?.close());

async function call(method: string, p: string, body?: unknown, opts: { csrf?: boolean; auth?: boolean } = {}): Promise<{ status: number; json: any; res: Response }> {
  const headers: Record<string, string> = {};
  if (opts.auth !== false && cookie) headers.cookie = cookie;
  if (method !== "GET" && opts.csrf !== false) headers["x-cloudfriend-csrf"] = "1";
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(server.url + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, res };
}

async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("dashboard static files", () => {
  it("serves index.html and every asset it loads, following module imports", async () => {
    const res = await fetch(`${server.url}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    const queue = [...html.matchAll(/(?:src|href)="([^"#][^"]*)"/g)].map((m) => new URL(m[1]!, `${server.url}/`).href);
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
  });

  it("serves the app for unknown non-API paths and 404s for missing files", async () => {
    assert.equal((await fetch(`${server.url}/w/ws_demo/queue`)).status, 200);
    assert.equal((await fetch(`${server.url}/nope.js`)).status, 404);
    assert.equal((await fetch(`${server.url}/../package.json`)).status, 404);
  });

  it("never renders through HTML parsing and makes no third-party requests", () => {
    const files = fs.readdirSync(STATIC, { recursive: true, encoding: "utf8" }).filter((f) => /\.(js|html|css)$/.test(f));
    for (const f of files) {
      const text = fs.readFileSync(path.join(STATIC, f), "utf8");
      assert.doesNotMatch(text, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/, f);
      // No remote scripts, styles, fonts or images; URLs in user-facing text (placeholders, hints) are fine.
      assert.doesNotMatch(text, /(?:src|href)=["']https?:|@import|url\(\s*["']?https?:|fetch\(\s*["']https?:/, f);
    }
  });
});

describe("mock API (design/api-contract.md)", () => {
  it("signs in, checks CSRF, and runs the first-run flow end to end", async () => {
    assert.deepEqual((await call("GET", "/api/auth-config")).json, { password: true, oidc: true, oidcLabel: "Sign in with SSO" });
    assert.equal((await call("GET", "/api/me")).status, 401);
    assert.equal((await call("POST", "/api/login", { email: "admin@example.com", password: "nope" })).status, 401);
    const login = await call("POST", "/api/login", { email: "admin@example.com", password: "password" });
    assert.equal(login.status, 200);
    cookie = (login.res.headers.get("set-cookie") ?? "").split(";")[0]!;
    assert.match(cookie, /^cf_session=/);
    assert.match(login.res.headers.get("set-cookie") ?? "", /HttpOnly/);

    assert.equal((await call("POST", "/api/workspaces", { name: "x" }, { csrf: false })).status, 403);
    const ws = (await call("POST", "/api/workspaces", { name: "Test" })).json.workspace;
    assert.equal(ws.role, "owner");
    const w = `/api/w/${ws.id}`;
    assert.equal((await call("GET", "/api/w/ws_other/queue")).status, 403);

    const created = await call("POST", `${w}/sources`, { name: "app", kind: "json" });
    assert.equal(created.status, 201);
    assert.match(created.json.secret, /^cloudfriend_/);
    const src = created.json.source;
    const ingest = await fetch(src.endpoint_url.replace(/^http:\/\/[^/]+/, server.url), {
      method: "POST",
      headers: { authorization: `Bearer ${created.json.secret}` },
      body: JSON.stringify({ level: "info", message: "hello" }),
    });
    assert.equal(ingest.status, 202);

    const dst = await call("POST", `${w}/destinations`, { name: "hook", kind: "webhook", url: "http://example.com/x" });
    assert.equal(dst.status, 400);
    const ok = await call("POST", `${w}/destinations`, { name: "hook", kind: "webhook", url: "https://example.com/x", signing_secret: "s" });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.destination.has_signing_secret, true);
    assert.deepEqual((await call("POST", `${w}/destinations/${ok.json.destination.id}/test`)).json, { ok: true });

    // The first test exception: novel, judged benign by Jev, no alert.
    const { queue_id } = (await call("POST", `${w}/test-event`)).json;
    const ev = await until(async () => {
      const r = (await call("GET", `${w}/test-event/${queue_id}`)).json;
      return r.event?.decided ? r.event : null;
    });
    assert.equal(ev.route, "novel");
    assert.equal(ev.judgment, "benign");
    assert.equal(ev.flag_id, null);
    const dec = (await call("GET", `${w}/decisions/${ev.decision_id}`)).json.decision;
    assert.deepEqual(dec.event_ids, [ev.id]);
    assert.ok(dec.prompt.includes(ev.id));

    // The second: judged relevant, a flag with a delivery to the destination.
    const second = (await call("POST", `${w}/test-event`)).json.queue_id;
    const ev2 = await until(async () => (await call("GET", `${w}/test-event/${second}`)).json.event?.flag_id && (await call("GET", `${w}/test-event/${second}`)).json.event);
    const detail = await until(async () => {
      const d = (await call("GET", `${w}/flags/${ev2.flag_id}`)).json;
      return d.deliveries.every((x: { status: string }) => x.status === "ok") ? d : null;
    });
    assert.equal(detail.events[0].id, ev2.id);
    assert.equal((await call("GET", `${w}/queue`)).json.flags.length, 1);
    assert.equal((await call("PATCH", `${w}/flags/${ev2.flag_id}`, { status: "resolved" })).json.flag.status, "resolved");
    assert.equal((await call("GET", `${w}/queue`)).json.flags.length, 0);
    assert.equal((await call("POST", `${w}/flags/${ev2.flag_id}/feedback`, { verdict: "confirmed" })).json.flag.status, "confirmed");

    const rotated = (await call("POST", `${w}/sources/${src.id}/rotate`)).json;
    assert.notEqual(rotated.secret, created.json.secret);
    assert.equal((await call("DELETE", `${w}/sources/${src.id}`)).status, 204);
    assert.ok((await call("GET", `${w}/sources`)).json.sources[0].revoked_at);
    assert.equal((await call("POST", "/api/logout")).status, 200);
  });

  it("lists, filters and pages the seeded workspace", async () => {
    const login = await call("POST", "/api/login", { email: "admin@example.com", password: "password" });
    cookie = (login.res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const w = "/api/w/ws_demo";
    const queue = (await call("GET", `${w}/queue`)).json.flags as { severity: string }[];
    assert.deepEqual(queue.map((f) => f.severity), ["critical", "high", "medium", "low"]);
    const first = (await call("GET", `${w}/events?limit=10`)).json;
    assert.equal(first.events.length, 10);
    const second = (await call("GET", `${w}/events?limit=10&before=${first.next}`)).json;
    assert.notEqual(second.events[0].id, first.events[0].id);
    const jev = (await call("GET", `${w}/events?route=jev&since=7d`)).json.events as { route: string }[];
    assert.ok(jev.length > 0 && jev.every((e) => e.route === "jev"));
    assert.equal((await call("GET", `${w}/events?since=bogus`)).status, 400);
    const usage = (await call("GET", `${w}/usage`)).json;
    assert.equal(usage.budget_exhausted, false);
    await fetch(`${server.url}/__mock/budget?exhausted=1`, { method: "POST" });
    assert.equal((await call("GET", `${w}/usage`)).json.budget_exhausted, true);
    assert.ok((await call("GET", `${w}/stats?since=24h`)).json.routes.drop > 0);
  });
});
