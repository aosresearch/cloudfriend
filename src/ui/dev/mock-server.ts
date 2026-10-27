/**
 * Dev mock of the dashboard API (design/api-contract.md plus src/ui/CONTRACT-NOTES.md), in memory.
 *
 *   node --disable-warning=ExperimentalWarning src/ui/dev/mock-server.ts
 *
 * Serves src/ui/static/ at / on port 5180 (PORT overrides). Sign in with admin@example.com / password.
 *
 * Knobs (environment):
 *   MOCK_EMPTY=1        start with no workspaces (first-run flow)
 *   MOCK_OIDC=0         hide the SSO button (shown by default; the mock SSO signs in as the admin)
 *   MOCK_LATENCY=80     added delay per API request, in ms
 *
 * Dev-only endpoints (no auth, not part of the contract):
 *   POST /__mock/budget?exhausted=1|0   turn the Jev budget-exhausted state on or off
 *   POST /__mock/decider?mode=jev|classifier|none
 *
 * The pipeline is simulated: a queued request is parsed into an event after ~1.2 s, events routed to Jev
 * are decided ~4 s after they arrive, and deliveries settle ~2 s later. Test exceptions alternate between
 * "judged benign, no alert" and "judged relevant, alert raised", so both outcomes can be seen.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../static");

// --- types ---------------------------------------------------------------------------------------

type Route = "drop" | "review" | "novel" | "known" | "audit" | "jev" | "auto" | "classifier";
type Judgment = "relevant" | "benign" | "uncertain";
type Severity = "low" | "medium" | "high" | "critical";
type FlagStatus = "open" | "acknowledged" | "resolved" | "confirmed" | "false_positive";

interface User { id: string; email: string; name: string; password: string }
interface Workspace { id: string; name: string; created_at: string; members: Map<string, "owner" | "member">; data: WsData }
interface Source {
  id: string; name: string; kind: "json" | "sentry" | "posthog"; created_at: string;
  last_used_at: string | null; revoked_at: string | null;
  secrets: { hash: string; prefix: string; expires: number | null }[];
}
interface Destination {
  id: string; name: string; kind: "slack" | "webhook"; url: string; signing_secret: string | null;
  created_at: string; last_delivery_at: string | null; last_error: string | null;
}
interface Ev {
  id: string; source: string; received_at: string; data: unknown; score: number | null; route: Route | null;
  template: string | null; severity: string | null; decided: boolean; decision_id: string | null;
  judgment: Judgment | null; flag_id: string | null;
}
interface Flag {
  id: string; reason: string; severity: Severity; status: FlagStatus; event_ids: string[]; users: string[];
  created_at: string; updated_at: string; decider: string;
}
interface Delivery {
  flag_id: string; destination_id: string; status: "pending" | "ok" | "failed"; attempts: number;
  last_error: string | null; updated_at: string; due: number;
}
interface Decision { id: string; created_at: string; decider: string; model: string; prompt: string | null; response: string | null; event_ids: string[] }
interface QueueItem { id: string; source: string; body: unknown; created: number; status: "new" | "done" | "failed"; event_id: string | null; test: boolean }
interface WsData {
  sources: Source[]; destinations: Destination[]; events: Ev[]; flags: Flag[]; deliveries: Delivery[];
  decisions: Map<string, Decision>; queue: QueueItem[]; jevCalls: number; jevSpend: number; budget: number; testCount: number;
}

// --- state ---------------------------------------------------------------------------------------

const env = process.env;
let latency = Number(env.MOCK_LATENCY ?? 80);
const mock = { budgetExhausted: false, decider: "jev" as "jev" | "classifier" | "none", oidc: env.MOCK_OIDC !== "0" };

const users: User[] = [{ id: "usr_admin", email: "admin@example.com", name: "Admin", password: "password" }];
const sessions = new Map<string, string>();
const workspaces: Workspace[] = [];

const rid = (prefix: string, bytes = 8) => `${prefix}_${crypto.randomBytes(bytes).toString("hex")}`;
const iso = (t = Date.now()) => new Date(t).toISOString();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const newSecret = () => `cloudfriend_${crypto.randomBytes(24).toString("base64url")}`;
const JEV_ROUTES = new Set<Route>(["review", "novel", "known", "audit", "jev"]);
const SEV_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function emptyData(): WsData {
  return { sources: [], destinations: [], events: [], flags: [], deliveries: [], decisions: new Map(), queue: [], jevCalls: 0, jevSpend: 0, budget: 5, testCount: 0 };
}

// --- seed data -----------------------------------------------------------------------------------

function seed(): void {
  const demo: Workspace = { id: "ws_demo", name: "Acme production", created_at: iso(Date.now() - 20 * 86400_000), members: new Map([["usr_admin", "owner"]]), data: emptyData() };
  const other: Workspace = { id: "ws_other", name: "Someone else's workspace", created_at: iso(), members: new Map(), data: emptyData() };
  workspaces.push(demo, other);
  const d = demo.data;
  const now = Date.now();
  const mkSource = (id: string, name: string, kind: Source["kind"], ageDays: number): Source => ({
    id, name, kind, created_at: iso(now - ageDays * 86400_000), last_used_at: iso(now - 40_000), revoked_at: null,
    secrets: [{ hash: sha(`seed-${id}`), prefix: `cloudfriend_${id.slice(4, 8)}`, expires: null }],
  });
  d.sources.push(mkSource("src_sentry01", "sentry-prod", "sentry", 19), mkSource("src_posthog1", "posthog", "posthog", 12), mkSource("src_applogs", "app-logs", "json", 18));
  const old = mkSource("src_legacy", "legacy-collector", "json", 30);
  old.revoked_at = iso(now - 5 * 86400_000);
  old.last_used_at = iso(now - 6 * 86400_000);
  d.sources.push(old);
  d.destinations.push(
    { id: "dst_slack", name: "#ops-alerts", kind: "slack", url: "https://hooks.slack.com/services/T0ACME/B0OPS/xyzSECRET", signing_secret: null, created_at: iso(now - 19 * 86400_000), last_delivery_at: iso(now - 3600_000), last_error: null },
    { id: "dst_hook", name: "pager bridge", kind: "webhook", url: "https://pager.example.com/fail/cloudfriend", signing_secret: "whsec", created_at: iso(now - 10 * 86400_000), last_delivery_at: iso(now - 86400_000), last_error: "webhook replied 404" },
  );

  const templates: { src: string; route: Route; sev: string; tpl: string; data: (i: number) => unknown; score: number }[] = [
    { src: "src_applogs", route: "drop", sev: "info", score: 0.004, tpl: "logs|checkout|GET /api/cart <V> in <V>ms", data: (i) => ({ level: "info", service: "checkout", message: `GET /api/cart 200 in ${30 + i}ms`, user_id: `u_${1000 + i}` }) },
    { src: "src_applogs", route: "drop", sev: "info", score: 0.01, tpl: "logs|auth|session refreshed for user=<V>", data: (i) => ({ level: "info", service: "auth", message: `session refreshed for user=u_${2000 + i}` }) },
    { src: "src_applogs", route: "jev", sev: "error", score: 0.71, tpl: "logs|payments|payment provider timeout after <V>ms", data: (i) => ({ level: "error", service: "payments", message: `payment provider timeout after ${5000 + i * 10}ms`, route: "/checkout", status_code: 504, user_id: `u_${3000 + i}`, trace_id: crypto.randomBytes(8).toString("hex") }) },
    { src: "src_sentry01", route: "known", sev: "error", score: 0.64, tpl: "sentry|web|TypeError: Cannot read properties of undefined (reading <V>)", data: (i) => ({ action: "created", data: { error: { title: "TypeError: Cannot read properties of undefined (reading 'price')", level: "error", culprit: "app/cart/LineItem.tsx", platform: "javascript", tags: [["release", "web@4.12.0"], ["url", `https://shop.example.com/cart?item=${i}`]], user: { id: `u_${4000 + i}` }, exception: { values: [{ type: "TypeError", value: "Cannot read properties of undefined (reading 'price')", stacktrace: { frames: [{ filename: "app/cart/LineItem.tsx", function: "LineItem", lineno: 42 }] } }] } } } }) },
    { src: "src_posthog1", route: "review", sev: "warning", score: 0.08, tpl: "posthog|$exception|ResizeObserver loop completed with undelivered notifications", data: (i) => ({ event: "$exception", distinct_id: `ph_${5000 + i}`, properties: { $exception_message: "ResizeObserver loop completed with undelivered notifications", $exception_type: "Error", $current_url: "https://shop.example.com/products", $browser: "Chrome" }, person: { properties: { email: `shopper${i}@example.net` } } }) },
    { src: "src_applogs", route: "audit", sev: "info", score: 0.02, tpl: "logs|search|query took <V>ms", data: (i) => ({ level: "info", service: "search", message: `query took ${200 + i}ms`, query: "<img src=x onerror=alert(1)>" }) },
    { src: "src_sentry01", route: "novel", sev: "error", score: 0.33, tpl: "sentry|worker|IntegrityError: duplicate key value violates unique constraint <V>", data: () => ({ action: "created", data: { error: { title: 'IntegrityError: duplicate key value violates unique constraint "orders_pkey"', level: "error", culprit: "worker/orders.py in save_order", platform: "python", exception: { values: [{ type: "IntegrityError", value: 'duplicate key value violates unique constraint "orders_pkey"' }] } } } }) },
  ];

  const decisionFor = (evs: Ev[], verdicts: Judgment[], alerts: { reason: string; severity: Severity }[], ageMs: number): Decision => {
    const dec: Decision = {
      id: rid("dec"), created_at: iso(now - ageMs), decider: "jev", model: "typesafe/jev-router", event_ids: evs.map((e) => e.id),
      prompt: buildPrompt(evs), response: JSON.stringify({ judgments: evs.map((e, i) => ({ event: e.id, verdict: verdicts[i] ?? "uncertain" })), alerts: alerts.map((a) => ({ events: evs.filter((_, i) => verdicts[i] === "relevant").map((e) => e.id), reason: a.reason, severity: a.severity })) }, null, 2),
    };
    d.decisions.set(dec.id, dec);
    return dec;
  };

  let k = 0;
  const mkEvent = (t: (typeof templates)[number], ageMs: number): Ev => {
    k++;
    const ev: Ev = { id: `ev_${(100000 + k).toString()}`, source: t.src, received_at: iso(now - ageMs), data: t.data(k), score: Math.min(0.999, t.score + (k % 7) * 0.003), route: t.route, template: t.tpl, severity: t.sev, decided: true, decision_id: null, judgment: null, flag_id: null };
    d.events.push(ev);
    return ev;
  };
  for (let i = 0; i < 70; i++) mkEvent(templates[i % 2]!, (i + 1) * 47_000);
  // Payment timeouts: Jev judged relevant, critical flag, open.
  const pay = [0, 1, 2, 3, 4].map((i) => mkEvent(templates[2]!, 600_000 + i * 30_000));
  const payDec = decisionFor(pay.slice(0, 3), ["relevant", "relevant", "relevant"], [{ reason: "Payment provider timeouts on /checkout", severity: "critical" }], 590_000);
  const payFlag = mkFlag(d, "Payment provider timeouts on /checkout: 5 failed payments in 2 minutes", "critical", "open", pay, now - 590_000);
  for (const e of pay) Object.assign(e, { decision_id: payDec.id, judgment: "relevant", flag_id: payFlag.id });
  // Sentry TypeError: high, acknowledged.
  const te = [0, 1, 2].map((i) => mkEvent(templates[3]!, 3 * 3600_000 + i * 60_000));
  const teDec = decisionFor(te, ["relevant", "relevant", "uncertain"], [{ reason: "TypeError in cart line items after web@4.12.0", severity: "high" }], 3 * 3600_000 - 10_000);
  const teFlag = mkFlag(d, "TypeError in cart line items after release web@4.12.0", "high", "acknowledged", te, now - 3 * 3600_000);
  for (const e of te) Object.assign(e, { decision_id: teDec.id, judgment: e === te[2] ? "uncertain" : "relevant", flag_id: teFlag.id });
  // IntegrityError: novel, medium, open.
  const ie = [mkEvent(templates[6]!, 25 * 60_000)];
  const ieDec = decisionFor(ie, ["relevant"], [{ reason: "Duplicate order ids in the order worker", severity: "medium" }], 24 * 60_000);
  const ieFlag = mkFlag(d, "Duplicate order ids rejected by the database in the order worker", "medium", "open", ie, now - 24 * 60_000);
  Object.assign(ie[0]!, { decision_id: ieDec.id, judgment: "relevant", flag_id: ieFlag.id });
  // PostHog ResizeObserver: reviewed, benign, no flag.
  const ro = [0, 1].map((i) => mkEvent(templates[4]!, 5 * 3600_000 + i * 1000));
  const roDec = decisionFor(ro.slice(0, 1), ["benign"], [], 5 * 3600_000 - 5000);
  for (const e of ro) Object.assign(e, { decision_id: roDec.id, judgment: "benign" });
  // Audit sample with an HTML payload.
  const au = [mkEvent(templates[5]!, 2 * 3600_000)];
  const auDec = decisionFor(au, ["benign"], [], 2 * 3600_000 - 60_000);
  Object.assign(au[0]!, { decision_id: auDec.id, judgment: "benign" });
  // Older flags: low open, resolved, false positive, one whose decision text is past retention.
  const lowEv = [mkEvent(templates[4]!, 26 * 3600_000)];
  const lowDec = decisionFor(lowEv, ["relevant"], [{ reason: "Spike of front-end exceptions", severity: "low" }], 26 * 3600_000);
  Object.assign(lowDec, { prompt: null, response: null });
  const lowFlag = mkFlag(d, "Spike of ResizeObserver exceptions on the product page", "low", "open", lowEv, now - 26 * 3600_000);
  Object.assign(lowEv[0]!, { decision_id: lowDec.id, judgment: "relevant", flag_id: lowFlag.id });
  mkFlag(d, "Checkout latency above 2 s for 10 minutes", "high", "resolved", [], now - 2 * 86400_000);
  mkFlag(d, "Session refresh errors (staging traffic)", "medium", "false_positive", [], now - 3 * 86400_000);
  mkFlag(d, "Inventory sync failing for warehouse 3", "high", "confirmed", [], now - 4 * 86400_000);
  d.jevCalls = 14;
  d.jevSpend = 0.071;
  d.events.sort((a, b) => b.received_at.localeCompare(a.received_at));
}

function mkFlag(d: WsData, reason: string, severity: Severity, status: FlagStatus, evs: Ev[], at: number): Flag {
  const users = [...new Set(evs.map((e) => userOf(e.data)).filter((u): u is string => !!u))];
  const flag: Flag = { id: rid("flg"), reason, severity, status, event_ids: evs.map((e) => e.id), users, created_at: iso(at), updated_at: iso(at + 60_000), decider: "jev" };
  d.flags.push(flag);
  for (const dst of d.destinations) {
    const failing = dst.url.includes("fail");
    d.deliveries.push({ flag_id: flag.id, destination_id: dst.id, status: failing ? "failed" : "ok", attempts: failing ? 15 : 1, last_error: failing ? "webhook replied 404" : null, updated_at: iso(at + 5000), due: 0 });
  }
  return flag;
}

function userOf(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  if (typeof o.user_id === "string") return o.user_id;
  const inner = (o.data as { error?: { user?: { id?: string } } } | undefined)?.error?.user?.id;
  return typeof inner === "string" ? inner : null;
}

function buildPrompt(evs: Ev[]): string {
  return [
    "You are Jev, the decider for an event triage pipeline. For each event below, judge whether it is",
    "relevant (worth a person's attention now), benign, or uncertain. Then list the alerts to raise.",
    "",
    "Open alerts: none",
    "",
    ...evs.map((e, i) => `Event ${i + 1} (id ${e.id}, source ${e.source}, template seen ${i + 3} times in the last hour):\n${JSON.stringify(e.data).slice(0, 1500)}`),
    "",
    'Reply with JSON: {"judgments": [{"event", "verdict"}], "alerts": [{"events", "reason", "severity"}]}',
  ].join("\n");
}

// --- simulated pipeline --------------------------------------------------------------------------

const TEST_TEMPLATE = "json|cloudfriend-test|cloudfriend test exception: <V>";

function tick(): void {
  const now = Date.now();
  for (const ws of workspaces) {
    const d = ws.data;
    for (const q of d.queue) {
      if (q.status !== "new" || now - q.created < 1200) continue;
      const body = q.body as Record<string, unknown> | null;
      const errorish = q.test || /error|exception|fatal/i.test(JSON.stringify(body ?? ""));
      const ev: Ev = {
        id: rid("ev"), source: q.source, received_at: iso(q.created), data: body, score: q.test ? 0.41 : errorish ? 0.38 : 0.006,
        route: errorish ? "novel" : "drop", template: q.test ? TEST_TEMPLATE : `json|${q.source}|${String(body?.message ?? "event").replace(/\d+/g, "<V>")}`,
        severity: errorish ? "error" : "info", decided: !errorish, decision_id: null, judgment: null, flag_id: null,
      };
      // Without Jev, the classifier escalates on its own score (threshold 0.4 here) and drops the rest.
      if (mock.decider !== "jev" || mock.budgetExhausted) ev.route = (ev.score ?? 0) >= 0.4 ? "classifier" : "drop";
      d.events.unshift(ev);
      q.status = "done";
      q.event_id = ev.id;
    }
    for (const ev of d.events) {
      if (ev.decided || now - Date.parse(ev.received_at) < 5200) continue;
      if (mock.decider === "none" || mock.decider === "classifier" || mock.budgetExhausted || !ev.route || !JEV_ROUTES.has(ev.route)) {
        ev.decided = true;
        if (ev.route === "classifier" && mock.decider !== "none") {
          const flag = mkFlag(d, "Error event escalated by the classifier (no Jev)", "medium", "open", [ev], now);
          flag.decider = "classifier";
          ev.flag_id = flag.id;
        }
        continue;
      }
      const isTest = ev.template === TEST_TEMPLATE;
      let verdict: Judgment = "relevant";
      if (isTest) verdict = d.testCount % 2 === 1 ? "benign" : "relevant";
      const alert = verdict === "relevant";
      const reason = isTest ? "Test exception sent from the setup page" : `New error: ${String((ev.data as Record<string, unknown>)?.message ?? ev.template)}`;
      const dec: Decision = {
        id: rid("dec"), created_at: iso(), decider: "jev", model: "typesafe/jev-router", event_ids: [ev.id], prompt: buildPrompt([ev]),
        response: JSON.stringify({
          judgments: [{ event: ev.id, verdict, why: isTest ? (alert ? "An unhandled exception reached production logging; the payload says it is a test, but alerting confirms delivery." : "The event says it is a test exception sent from the setup page; nobody needs to act on it.") : "A new error template from a production service." }],
          alerts: alert ? [{ events: [ev.id], reason, severity: "low" }] : [],
        }, null, 2),
      };
      d.decisions.set(dec.id, dec);
      d.jevCalls++;
      d.jevSpend += 0.0046;
      Object.assign(ev, { decided: true, decision_id: dec.id, judgment: verdict });
      if (alert) {
        const flag = mkFlag(d, reason, "low", "open", [ev], now);
        for (const del of d.deliveries.filter((x) => x.flag_id === flag.id)) Object.assign(del, { status: "pending", attempts: 0, last_error: null, due: now + 1500 });
        ev.flag_id = flag.id;
      }
    }
    for (const del of d.deliveries) {
      if (del.status !== "pending" || now < del.due) continue;
      const dst = d.destinations.find((x) => x.id === del.destination_id);
      del.attempts++;
      del.updated_at = iso();
      if (dst && !dst.url.includes("fail")) {
        del.status = "ok";
        dst.last_delivery_at = iso();
        dst.last_error = null;
      } else {
        del.last_error = "webhook replied 404";
        if (dst) dst.last_error = del.last_error;
        if (del.attempts >= 3) del.status = "failed";
        else del.due = now + 2000 * del.attempts;
      }
    }
  }
}

// --- views (API shapes) ----------------------------------------------------------------------------

function baseUrl(req: http.IncomingMessage): string {
  return `http://${req.headers.host ?? "localhost:5180"}`;
}
const sourceView = (s: Source, req: http.IncomingMessage) => ({
  id: s.id, name: s.name, kind: s.kind, endpoint_url: `${baseUrl(req)}/in/${s.id}`, secret_prefix: s.secrets.at(-1)?.prefix ?? "",
  created_at: s.created_at, last_used_at: s.last_used_at, revoked_at: s.revoked_at,
});
const destView = (x: Destination) => ({
  id: x.id, name: x.name, kind: x.kind, url_display: displayUrl(x.url), has_signing_secret: !!x.signing_secret,
  created_at: x.created_at, last_delivery_at: x.last_delivery_at, last_error: x.last_error,
});
function displayUrl(u: string): string {
  try {
    const url = new URL(u);
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.hostname === "hooks.slack.com") return `${url.origin}/${parts.slice(0, 2).join("/")}/${(parts[2] ?? "").slice(0, 2)}…/…`;
    return `${url.origin}${url.pathname}${url.search ? "?…" : ""}`;
  } catch {
    return "(invalid URL)";
  }
}
const flagView = (f: Flag) => ({
  id: f.id, reason: f.reason, severity: f.severity, status: f.status, event_count: f.event_ids.length, users: f.users,
  created_at: f.created_at, updated_at: f.updated_at, decider: f.decider,
});
const eventView = (e: Ev) => ({ ...e });

// --- HTTP ----------------------------------------------------------------------------------------

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Res = { status: number; body?: unknown; headers?: Record<string, string | string[]> };

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {}
  throw new HttpError(400, "body must be a JSON object");
}

function cookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(v.join("="));
  }
  return out;
}

function currentUser(req: http.IncomingMessage): User | null {
  const token = cookies(req).cf_session;
  const uid = token ? sessions.get(token) : undefined;
  return users.find((u) => u.id === uid) ?? null;
}

function sessionCookie(token: string, maxAge?: number): string {
  return `cf_session=${token}; Path=/; HttpOnly; SameSite=Lax${maxAge === 0 ? "; Max-Age=0" : ""}`;
}

function signIn(user: User): string {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, user.id);
  return token;
}

function limitOf(q: URLSearchParams, def = 50): number {
  const v = q.get("limit");
  if (!v) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "limit must be a positive integer");
  return Math.min(n, 500);
}

function sinceOf(v: string | null): number | undefined {
  if (!v) return undefined;
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(v);
  if (m) return Date.now() - Number(m[1]) * { ms: 1, s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2] as "ms"];
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new HttpError(400, `invalid time: ${v} (use ISO 8601, epoch ms, or e.g. 1h)`);
  return t;
}

function page<T extends { id: string }>(items: T[], q: URLSearchParams): { items: T[]; next: string | null } {
  const limit = limitOf(q);
  const before = q.get("before");
  let start = 0;
  if (before) {
    const i = items.findIndex((x) => x.id === before);
    start = i < 0 ? items.length : i + 1;
  }
  const slice = items.slice(start, start + limit);
  return { items: slice, next: start + limit < items.length ? (slice.at(-1)?.id ?? null) : null };
}

function validateDestinationUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "url is not a valid URL");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && local) return;
  if (url.protocol !== "https:") throw new HttpError(400, "url must use https (http is allowed only for localhost with CLOUDFRIEND_ALLOW_PRIVATE_DESTINATIONS=on)");
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(url.hostname)) throw new HttpError(400, "url resolves to a private address");
}

function enqueue(d: WsData, source: string, body: unknown, test: boolean): QueueItem {
  const q: QueueItem = { id: rid("q"), source, body, created: Date.now(), status: "new", event_id: null, test };
  d.queue.push(q);
  return q;
}

async function api(req: http.IncomingMessage, url: URL): Promise<Res> {
  const method = req.method ?? "GET";
  const p = url.pathname;
  const q = url.searchParams;
  const text = method === "GET" || method === "HEAD" ? "" : await readBody(req);
  if (method !== "GET" && method !== "HEAD" && p.startsWith("/api/") && req.headers["x-cloudfriend-csrf"] !== "1") {
    throw new HttpError(403, "missing x-cloudfriend-csrf header");
  }

  if (p === "/api/auth-config" && method === "GET") return { status: 200, body: { password: true, oidc: mock.oidc, oidcLabel: "Sign in with SSO" } };
  if (p === "/api/login" && method === "POST") {
    const b = parseJson(text);
    const user = users.find((u) => u.email.toLowerCase() === String(b.email ?? "").trim().toLowerCase() && u.password === b.password);
    if (!user) throw new HttpError(401, "wrong email or password");
    return { status: 200, body: { user: { id: user.id, email: user.email, name: user.name } }, headers: { "set-cookie": sessionCookie(signIn(user)) } };
  }
  if (p === "/api/logout" && method === "POST") {
    const token = cookies(req).cf_session;
    if (token) sessions.delete(token);
    return { status: 200, body: {}, headers: { "set-cookie": sessionCookie("", 0) } };
  }

  const user = currentUser(req);
  if (!user) throw new HttpError(401, "not signed in");
  const mine = () => workspaces.filter((w) => w.members.has(user.id));
  const wsView = (w: Workspace) => ({ id: w.id, name: w.name, role: w.members.get(user.id), created_at: w.created_at });

  if (p === "/api/me" && method === "GET") {
    return { status: 200, body: { user: { id: user.id, email: user.email, name: user.name }, workspaces: mine().map((w) => ({ id: w.id, name: w.name, role: w.members.get(user.id) })) } };
  }
  if (p === "/api/workspaces" && method === "GET") return { status: 200, body: { workspaces: mine().map(wsView) } };
  if (p === "/api/workspaces" && method === "POST") {
    const name = String(parseJson(text).name ?? "").trim();
    if (!name) throw new HttpError(400, "name is required");
    if (name.length > 80) throw new HttpError(400, "name is too long (80 characters at most)");
    const w: Workspace = { id: rid("ws"), name, created_at: iso(), members: new Map([[user.id, "owner"]]), data: emptyData() };
    workspaces.push(w);
    return { status: 201, body: { workspace: wsView(w) } };
  }

  const m = /^\/api\/w\/([^/]+)(\/.*)?$/.exec(p);
  if (!m) throw new HttpError(404, "not found");
  const ws = workspaces.find((w) => w.id === decodeURIComponent(m[1]!));
  if (!ws) throw new HttpError(404, "workspace not found");
  if (!ws.members.has(user.id)) throw new HttpError(403, "you are not a member of this workspace");
  const d = ws.data;
  const rest = m[2] ?? "/";
  const seg = rest.split("/").filter(Boolean).map(decodeURIComponent);
  const route = `${method} /${seg.map((s, i) => (i % 2 === 1 ? ":id" : s)).join("/")}`;
  const id = seg[1] ?? "";
  const find = <T extends { id: string }>(list: T[], what: string) => {
    const x = list.find((i) => i.id === id);
    if (!x) throw new HttpError(404, `${what} not found`);
    return x;
  };

  switch (route) {
    case "GET /sources":
      return { status: 200, body: { sources: d.sources.map((s) => sourceView(s, req)) } };
    case "POST /sources": {
      const b = parseJson(text);
      const name = String(b.name ?? "").trim();
      const kind = String(b.kind ?? "");
      if (!name) throw new HttpError(400, "name is required");
      if (!/^[a-z0-9][a-z0-9._-]{0,62}$/i.test(name)) throw new HttpError(400, "name may use letters, digits, '.', '_' and '-' (64 at most)");
      if (!["json", "sentry", "posthog"].includes(kind)) throw new HttpError(400, "kind must be json, sentry or posthog");
      if (d.sources.some((s) => s.name === name && !s.revoked_at)) throw new HttpError(400, `a source named ${name} already exists`);
      const secret = newSecret();
      const s: Source = { id: rid("src", 4), name, kind: kind as Source["kind"], created_at: iso(), last_used_at: null, revoked_at: null, secrets: [{ hash: sha(secret), prefix: secret.slice(0, 16), expires: null }] };
      d.sources.push(s);
      return { status: 201, body: { source: sourceView(s, req), secret } };
    }
    case "POST /sources/:id/rotate": {
      const s = find(d.sources, "source");
      if (s.revoked_at) throw new HttpError(400, "source is revoked");
      const secret = newSecret();
      for (const old of s.secrets) old.expires ??= Date.now() + 86400_000;
      s.secrets.push({ hash: sha(secret), prefix: secret.slice(0, 16), expires: null });
      return { status: 200, body: { source: sourceView(s, req), secret } };
    }
    case "DELETE /sources/:id": {
      const s = find(d.sources, "source");
      s.revoked_at ??= iso();
      return { status: 204 };
    }
    case "GET /destinations":
      return { status: 200, body: { destinations: d.destinations.map(destView) } };
    case "POST /destinations": {
      const b = parseJson(text);
      const name = String(b.name ?? "").trim();
      const kind = String(b.kind ?? "");
      const u = String(b.url ?? "").trim();
      if (!name) throw new HttpError(400, "name is required");
      if (kind !== "slack" && kind !== "webhook") throw new HttpError(400, "kind must be slack or webhook");
      validateDestinationUrl(u);
      const x: Destination = { id: rid("dst", 4), name, kind, url: u, signing_secret: typeof b.signing_secret === "string" && b.signing_secret ? b.signing_secret : null, created_at: iso(), last_delivery_at: null, last_error: null };
      d.destinations.push(x);
      return { status: 201, body: { destination: destView(x) } };
    }
    case "DELETE /destinations/:id": {
      find(d.destinations, "destination");
      d.destinations = d.destinations.filter((x) => x.id !== id);
      return { status: 204 };
    }
    case "POST /destinations/:id/test": {
      const x = find(d.destinations, "destination");
      await new Promise((r) => setTimeout(r, 600));
      if (x.url.includes("fail")) return { status: 200, body: { ok: false, error: x.kind === "slack" ? "slack replied 404 (no_service)" : "webhook replied 404" } };
      if (x.url.includes("timeout")) return { status: 200, body: { ok: false, error: "no reply within 10 s" } };
      x.last_delivery_at = iso();
      return { status: 200, body: { ok: true } };
    }
    case "GET /events": {
      const since = sinceOf(q.get("since"));
      const r = q.get("route");
      const src = q.get("source");
      let list = d.events;
      if (r) list = list.filter((e) => (r === "pending" ? e.route === null : e.route === r));
      if (src) list = list.filter((e) => e.source === src);
      if (since !== undefined) list = list.filter((e) => Date.parse(e.received_at) >= since);
      const { items, next } = page(list, q);
      return { status: 200, body: { events: items.map(eventView), next } };
    }
    case "GET /events/:id":
      return { status: 200, body: { event: eventView(find(d.events, "event")) } };
    case "POST /events/:id/feedback": {
      find(d.events, "event");
      const b = parseJson(text);
      if (typeof b.escalate !== "boolean") throw new HttpError(400, "escalate must be true or false");
      return { status: 200, body: {} };
    }
    case "POST /test-event": {
      d.testCount++;
      const qi = enqueue(d, "cloudfriend-test", {
        level: "error", service: "cloudfriend-setup", message: `cloudfriend test exception: sent from the setup page at ${iso()}`,
        exception: { type: "CloudfriendTestError", value: "This is a test exception. Nothing is broken.", stacktrace: ["at sendTestEvent (setup)", "at onboarding"] },
        cloudfriend_test: true,
      }, true);
      return { status: 200, body: { queue_id: qi.id } };
    }
    case "GET /test-event/:id": {
      const qi = find(d.queue, "queued request");
      const ev = qi.event_id ? d.events.find((e) => e.id === qi.event_id) ?? null : null;
      return { status: 200, body: { queue_id: qi.id, status: qi.status, event: ev && eventView(ev) } };
    }
    case "GET /queue": {
      const flags = d.flags.filter((f) => f.status === "open" || f.status === "acknowledged")
        .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.created_at.localeCompare(a.created_at));
      return { status: 200, body: { flags: flags.map(flagView) } };
    }
    case "GET /flags": {
      const st = q.get("status");
      const list = d.flags.filter((f) => !st || f.status === st).sort((a, b) => b.created_at.localeCompare(a.created_at));
      const { items, next } = page(list, q);
      return { status: 200, body: { flags: items.map(flagView), next } };
    }
    case "GET /flags/:id": {
      const f = find(d.flags, "flag");
      const deliveries = d.deliveries.filter((x) => x.flag_id === f.id).map((x) => ({
        destination_id: x.destination_id, destination_name: d.destinations.find((y) => y.id === x.destination_id)?.name ?? "(deleted destination)",
        status: x.status, attempts: x.attempts, last_error: x.last_error, updated_at: x.updated_at,
      }));
      return { status: 200, body: { flag: flagView(f), events: d.events.filter((e) => f.event_ids.includes(e.id)).map(eventView), deliveries } };
    }
    case "PATCH /flags/:id": {
      const f = find(d.flags, "flag");
      const st = parseJson(text).status;
      if (st !== "acknowledged" && st !== "resolved") throw new HttpError(400, "status must be acknowledged or resolved");
      f.status = st;
      f.updated_at = iso();
      return { status: 200, body: { flag: flagView(f) } };
    }
    case "POST /flags/:id/feedback": {
      const f = find(d.flags, "flag");
      const v = parseJson(text).verdict;
      if (v !== "confirmed" && v !== "false_positive") throw new HttpError(400, "verdict must be confirmed or false_positive");
      f.status = v;
      f.updated_at = iso();
      return { status: 200, body: { flag: flagView(f) } };
    }
    case "GET /decisions/:id": {
      const dec = d.decisions.get(id);
      if (!dec) throw new HttpError(404, "decision not found");
      return { status: 200, body: { decision: dec } };
    }
    case "GET /usage": {
      const day = iso().slice(0, 10);
      const today = d.events.filter((e) => e.received_at.startsWith(day)).length;
      const backlog = d.queue.filter((x) => x.status === "new").length + d.events.filter((e) => !e.decided).length;
      const exhausted = mock.budgetExhausted;
      return { status: 200, body: { day, events: today, backlog, jev_calls: d.jevCalls, jev_spend_usd: exhausted ? d.budget : Math.round(d.jevSpend * 10000) / 10000, jev_budget_usd: d.budget, budget_exhausted: exhausted, decider: exhausted ? "classifier" : mock.decider } };
    }
    case "GET /stats": {
      const since = sinceOf(q.get("since") || "24h") ?? 0;
      const routes: Record<string, number> = {};
      let n = 0;
      for (const e of d.events) {
        if (Date.parse(e.received_at) < since) continue;
        n++;
        const r = e.route ?? "none";
        routes[r] = (routes[r] ?? 0) + 1;
      }
      return { status: 200, body: { routes, events: n, flags: d.flags.filter((f) => Date.parse(f.created_at) >= since).length } };
    }
  }
  throw new HttpError(404, "not found");
}

/** POST /in/:source — just enough ingest to try the curl example from the setup page. */
async function ingest(req: http.IncomingMessage, url: URL): Promise<Res> {
  const sourceId = decodeURIComponent(url.pathname.slice(4));
  const auth = req.headers.authorization ?? "";
  const secret = auth.startsWith("Bearer ") ? auth.slice(7) : (url.searchParams.get("secret") ?? "");
  const text = await readBody(req);
  for (const ws of workspaces) {
    const s = ws.data.sources.find((x) => x.id === sourceId);
    if (!s) continue;
    const ok = !s.revoked_at && s.secrets.some((x) => x.hash === sha(secret) && (x.expires === null || x.expires > Date.now()));
    if (!ok) return { status: 401, body: { error: "bad secret" } };
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    const items = Array.isArray(body) ? body : [body];
    for (const item of items) enqueue(ws.data, s.id, item, false);
    s.last_used_at = iso();
    return { status: 202, body: { accepted: items.length } };
  }
  return { status: 401, body: { error: "bad secret" } };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon", ".png": "image/png",
};

function serveStatic(url: URL, res: http.ServerResponse): void {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.resolve(STATIC_DIR, `.${rel}`);
  const inside = file.startsWith(STATIC_DIR + path.sep);
  let target = inside && fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
  // Unknown non-API paths get the app, as the real server does.
  if (!target && !path.extname(rel)) target = path.join(STATIC_DIR, "index.html");
  if (!target) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[path.extname(target)] ?? "application/octet-stream",
    "cache-control": "no-cache",
    "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
  });
  fs.createReadStream(target).pipe(res);
}

function send(res: http.ServerResponse, r: Res): void {
  const headers: Record<string, string | string[]> = { "cache-control": "no-store", ...r.headers };
  if (r.status === 204 || r.body === undefined) {
    res.writeHead(r.status, headers).end();
    return;
  }
  res.writeHead(r.status, { "content-type": "application/json; charset=utf-8", ...headers }).end(JSON.stringify(r.body));
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  try {
    if (p.startsWith("/__mock/") && req.method === "POST") {
      if (p === "/__mock/budget") mock.budgetExhausted = url.searchParams.get("exhausted") !== "0";
      else if (p === "/__mock/decider") mock.decider = (url.searchParams.get("mode") as typeof mock.decider) ?? "jev";
      else throw new HttpError(404, "not found");
      return send(res, { status: 200, body: { ...mock } });
    }
    if (p === "/auth/oidc/login" || p === "/auth/oidc/callback") {
      if (!mock.oidc) throw new HttpError(404, "SSO is not configured");
      const admin = users[0]!;
      return send(res, { status: 302, headers: { location: "/", "set-cookie": sessionCookie(signIn(admin)) } });
    }
    if (p.startsWith("/in/") && req.method === "POST") return send(res, await ingest(req, url));
    if (p.startsWith("/api/")) {
      if (latency > 0) await new Promise((r) => setTimeout(r, latency * (0.5 + Math.random())));
      return send(res, await api(req, url));
    }
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
    serveStatic(url, res);
  } catch (err) {
    if (err instanceof HttpError) return send(res, { status: err.status, body: { error: err.message } });
    console.error(err);
    send(res, { status: 500, body: { error: "internal error" } });
  }
}

export async function startMockServer(opts: { port?: number; empty?: boolean; latencyMs?: number } = {}): Promise<{ url: string; close: () => Promise<void> }> {
  if (opts.latencyMs !== undefined) latency = opts.latencyMs;
  workspaces.length = 0;
  sessions.clear();
  Object.assign(mock, { budgetExhausted: false, decider: "jev" });
  if (!opts.empty) seed();
  const server = http.createServer((req, res) => void handle(req, res));
  const timer = setInterval(tick, 250);
  await new Promise<void>((resolve) => server.listen(opts.port ?? 5180, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => {
      clearInterval(timer);
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { url } = await startMockServer({ port: Number(env.PORT ?? 5180), empty: env.MOCK_EMPTY === "1" });
  console.log(`cloudfriend UI mock: ${url}  (sign in as admin@example.com / password)`);
}
