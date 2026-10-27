// Destinations: where alerts go. kind names an action adapter (slack, webhook, or a custom one);
// config is what that adapter needs ({ url, signing_secret }). Secrets never leave the server.
//   GET    /api/w/:ws/destinations
//   POST   /api/w/:ws/destinations            { name, kind, url, signing_secret? } -> 201 { destination }
//   DELETE /api/w/:ws/destinations/:id        -> 204 (kept with deleted_at, so deliveries still name it)
//   POST   /api/w/:ws/destinations/:id/test   -> { ok: true } | { ok: false, error }
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { AuthEnv } from "../auth/index.ts";
import { all, one, run } from "../db.ts";
import { errMsg, log } from "../log.ts";
import type { ActionAdapter, Flag } from "../types.ts";
import { WS, wsOf, type DashboardDeps } from "./deps.ts";
import { BadRequest, iso, jsonObject, nameField, notFound } from "./http.ts";

const TEST_TIMEOUT_MS = 15_000;

interface Row {
  id: string;
  name: string;
  kind: string;
  config: Record<string, unknown>;
  created_at: number;
  last_delivery_at: number | null;
  last_error: string | null;
}

const COLUMNS = "id, name, kind, config, created_at, last_delivery_at, last_error";

/**
 * The URL with its secret parts hidden: Slack's /services/T…/B…/token keeps only the start of
 * the team id; elsewhere, path segments that look like tokens are shortened, and the query and
 * any user:password are dropped.
 */
export function displayUrl(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "(invalid URL)";
  }
  const parts = u.pathname.split("/").filter(Boolean);
  const query = u.search ? "?…" : "";
  if (/(^|\.)slack\.com$/.test(u.hostname) && parts[0] === "services") {
    return `${u.origin}/services/${(parts[1] ?? "").slice(0, 2)}…/…`;
  }
  const looksSecret = (p: string) => p.length >= 16 || (p.length >= 8 && /\d/.test(p) && /[A-Za-z]/.test(p));
  const path = parts.map((p) => (looksSecret(p) ? `${p.slice(0, 2)}…` : p)).join("/");
  return `${u.origin}/${path}${query}`;
}

function view(r: Row) {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    url_display: displayUrl(r.config.url),
    has_signing_secret: typeof r.config.signing_secret === "string" && r.config.signing_secret !== "",
    created_at: iso(r.created_at),
    last_delivery_at: iso(r.last_delivery_at),
    last_error: r.last_error,
  };
}

/** A failure message with the status at most: the first "<something> replied <status>" of a run() error, never a response body. */
function statusOnly(err: unknown): string {
  const msg = errMsg(err);
  const replied = /\b([A-Za-z][\w-]{0,40} replied \d{3})\b/.exec(msg);
  if (replied) return replied[1]!;
  const e = err as { name?: string; cause?: { code?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return `no reply within ${TEST_TIMEOUT_MS / 1000} s`;
  const code = e?.cause?.code;
  if (typeof code === "string" && /^[A-Z_]{3,40}$/.test(code)) return `could not connect (${code})`;
  if (/^destination refused: /.test(msg)) return msg.slice(0, 200);
  return "the test message was not accepted";
}

/** The flag the fallback test sends through run(), for adapters without test(). */
function testFlag(name: string): Flag {
  const now = new Date().toISOString();
  return {
    id: "flg_test_" + randomBytes(6).toString("hex"),
    reason: `cloudfriend test message for destination "${name}". This is a test: nothing is wrong.`,
    severity: "low",
    event_ids: [],
    created_at: now,
    updated_at: now,
    decider: "cloudfriend-test",
    status: "resolved",
    event_count: 0,
    users: [],
    note: "test message sent from the dashboard",
  };
}

async function sendTest(adapter: ActionAdapter, row: Row, env: NodeJS.ProcessEnv): Promise<{ ok: true } | { ok: false; error: string }> {
  const signal = AbortSignal.timeout(TEST_TIMEOUT_MS);
  try {
    if (adapter.test) {
      await adapter.test({ env, signal, config: row.config });
    } else {
      const ok = await adapter.run(testFlag(row.name), { events: [], env, signal, config: row.config });
      if (ok === false) return { ok: false, error: "the destination did not accept the test message" };
    }
    return { ok: true };
  } catch (err) {
    // test() promises a status-only message; run() errors may quote a response body, so only their status is kept.
    const error = adapter.test ? errMsg(err).slice(0, 200) : statusOnly(err);
    log.info("destination test failed", { destination: row.id, kind: row.kind, error });
    return { ok: false, error };
  }
}

export function registerDestinations(app: Hono<AuthEnv>, deps: DashboardDeps): void {
  const { db } = deps;
  const outbound = { allowPrivate: deps.allowPrivateDestinations };

  app.get(`${WS}/destinations`, async (c) => {
    const rows = await all<Row>(db, `SELECT ${COLUMNS} FROM destinations WHERE workspace_id = $1 AND deleted_at IS NULL ORDER BY created_at, id`, [wsOf(c)]);
    return c.json({ destinations: rows.map(view) });
  });

  app.post(`${WS}/destinations`, async (c) => {
    const ws = wsOf(c);
    const body = await jsonObject(c, '{"name": "...", "kind": "webhook", "url": "https://..."}');
    const name = nameField(body.name, "name", 80);
    const kind = body.kind;
    const adapter = typeof kind === "string" ? deps.actions.get(kind) : undefined;
    if (!adapter) throw new BadRequest(`kind must be one of ${[...deps.actions.keys()].join(", ")}`);
    if (typeof body.url !== "string" || !body.url.trim()) throw new BadRequest("url is required");
    const url = body.url.trim();
    if (url.length > 2048) throw new BadRequest("url is too long");
    if (body.signing_secret !== undefined && body.signing_secret !== null && typeof body.signing_secret !== "string") {
      throw new BadRequest("signing_secret must be a string");
    }
    const signing = typeof body.signing_secret === "string" && body.signing_secret !== "" ? body.signing_secret : null;
    if (signing && signing.length > 512) throw new BadRequest("signing_secret is too long");

    const check = await deps.checkUrl(url, outbound);
    if (!check.ok) throw new BadRequest(`url: ${check.error}`);
    let config: Record<string, unknown> = signing ? { url, signing_secret: signing } : { url };
    if (adapter.validate) {
      try {
        config = await adapter.validate(config, { env: deps.env });
      } catch (err) {
        throw new BadRequest(errMsg(err).slice(0, 300));
      }
      // validate() may normalize the URL: whatever is stored is checked.
      if (typeof config.url === "string" && config.url !== url) {
        const again = await deps.checkUrl(config.url, outbound);
        if (!again.ok) throw new BadRequest(`url: ${again.error}`);
      }
    }
    const row: Row = { id: "dst_" + randomBytes(8).toString("hex"), name, kind: kind as string, config, created_at: Date.now(), last_delivery_at: null, last_error: null };
    await run(db, "INSERT INTO destinations (id, workspace_id, name, kind, config, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [
      row.id,
      ws,
      row.name,
      row.kind,
      JSON.stringify(row.config),
      row.created_at,
    ]);
    return c.json({ destination: view(row) }, 201);
  });

  app.delete(`${WS}/destinations/:id`, async (c) => {
    const n = await run(db, "UPDATE destinations SET deleted_at = $3 WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL", [wsOf(c), c.req.param("id"), Date.now()]);
    if (!n) throw notFound("destination");
    return c.body(null, 204);
  });

  app.post(`${WS}/destinations/:id/test`, async (c) => {
    const ws = wsOf(c);
    const row = await one<Row>(db, `SELECT ${COLUMNS} FROM destinations WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL`, [ws, c.req.param("id")]);
    if (!row) throw notFound("destination");
    const adapter = deps.actions.get(row.kind);
    if (!adapter) return c.json({ ok: false, error: `no action adapter named ${row.kind} is loaded` });
    // The address may have started resolving somewhere private since it was saved.
    if (typeof row.config.url === "string") {
      const check = await deps.checkUrl(row.config.url, outbound);
      if (!check.ok) return c.json({ ok: false, error: check.error });
    }
    const result = await sendTest(adapter, row, deps.env);
    if (result.ok) await run(db, "UPDATE destinations SET last_delivery_at = $3 WHERE workspace_id = $1 AND id = $2", [ws, row.id, Date.now()]);
    return c.json(result);
  });
}
