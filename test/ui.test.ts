// The dashboard's static files and its dev mock of the API contract (src/ui/dev/mock-server.ts).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { startMockServer } from "../src/ui/dev/mock-server.ts";
import { assetsLoad, firstRunFlow } from "./dashboard-flow.ts";

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

describe("dashboard static files", () => {
  it("serves index.html and every asset it loads, following module imports", async () => {
    await assetsLoad(server.url);
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
  // The same flow runs against the real server in test/dashboard-api.test.ts.
  it("signs in, checks CSRF, and runs the first-run flow end to end", async () => {
    await firstRunFlow({ baseUrl: server.url, login: { email: "admin@example.com", password: "password" }, foreignWorkspace: "ws_other" });
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
