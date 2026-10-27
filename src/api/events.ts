// Events, flags, the queue, decisions and the test event (design/api-contract.md).
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { AuthEnv } from "../auth/index.ts";
import { all, one, type Queryable } from "../db.ts";
import { eventFeedback, flagFeedback } from "../feedback.ts";
import { QueueFullError } from "../intake.ts";
import { errMsg, log } from "../log.ts";
import type { FlagRow } from "../store.ts";
import { WS, wsOf, type DashboardDeps } from "./deps.ts";
import { BadRequest, HttpError, iso, jsonObject, notFound, parseId, parseLimit, parseTime } from "./http.ts";
import { ensureTestSource } from "./sources.ts";

const PAGE = 50;
const FLAG_STATUSES = ["open", "acknowledged", "resolved", "confirmed", "false_positive"];
const QUEUE_STATUSES = ["open", "acknowledged"];

// --- shapes --------------------------------------------------------------------------------

interface EventRow {
  id: number;
  source: string;
  received_at: number;
  data: string;
  score: number | null;
  route: string | null;
  template: string | null;
  severity: string | null;
  decided: boolean;
  decision_id: string | null;
  judgment: string | null;
  flag_id: string | null;
}

const EVENT_COLUMNS = "id, source, received_at, data, score, route, template, severity, decided, decision_id, judgment, flag_id";

export const eventView = (r: EventRow) => ({
  id: String(r.id),
  source: r.source,
  received_at: iso(r.received_at),
  data: JSON.parse(r.data) as unknown,
  score: r.score,
  route: r.route,
  template: r.template,
  severity: r.severity,
  decided: r.decided,
  decision_id: r.decision_id,
  judgment: r.judgment,
  flag_id: r.flag_id,
});

const FLAG_COLUMNS = "id, created_at, reason, severity, event_ids, decider, status, updated_at, event_count, users";

export const flagView = (r: Omit<FlagRow, "note">) => ({
  id: r.id,
  reason: r.reason,
  severity: r.severity,
  status: r.status ?? "open",
  event_count: r.event_count ?? r.event_ids.length,
  users: r.users ?? [],
  created_at: iso(r.created_at),
  updated_at: iso(r.updated_at ?? r.created_at),
  decider: r.decider,
});

async function getFlag(db: Queryable, ws: string, id: string): Promise<FlagRow> {
  const row = await one<FlagRow>(db, `SELECT ${FLAG_COLUMNS} FROM flags WHERE workspace_id = $1 AND id = $2`, [ws, id]);
  if (!row) throw notFound("flag");
  return row;
}

async function eventsByIds(db: Queryable, ws: string, ids: string[]) {
  const nums = ids.map(Number).filter(Number.isSafeInteger).slice(0, 1000);
  if (!nums.length) return [];
  const rows = await all<EventRow>(db, `SELECT ${EVENT_COLUMNS} FROM events WHERE workspace_id = $1 AND id = ANY($2::bigint[]) ORDER BY id`, [ws, nums]);
  return rows.map(eventView);
}

// --- the test event ------------------------------------------------------------------------

/** What POST /test-event queues: an error-level exception that says what it is. */
export function testException(tag: string, now = new Date()) {
  return {
    level: "error",
    service: "cloudfriend-setup",
    message: `cloudfriend test exception ${tag}`,
    exception: {
      type: "CloudfriendTestError",
      value: `cloudfriend test exception ${tag}: sent from the dashboard's setup page at ${now.toISOString()}. Nothing is broken.`,
    },
    cloudfriend_test: true,
  };
}

// --- routes --------------------------------------------------------------------------------

export function registerEvents(app: Hono<AuthEnv>, deps: DashboardDeps): void {
  const { db } = deps;
  const triageFor = (ws: string) => (ws === deps.triageWorkspace ? deps.triage : null);

  app.get(`${WS}/events`, async (c) => {
    const ws = wsOf(c);
    const q = c.req.query();
    const args: unknown[] = [ws];
    const where = ["workspace_id = $1"];
    const add = (sql: string, v: unknown) => {
      args.push(v);
      where.push(sql.replace("?", `$${args.length}`));
    };
    if (q.route === "pending" || q.route === "none") where.push("route IS NULL");
    else if (q.route) add("route = ?", q.route);
    if (q.source) add("source = ?", q.source);
    const since = parseTime(q.since);
    if (since !== undefined) add("received_at >= ?", since);
    const until = parseTime(q.until);
    if (until !== undefined) add("received_at < ?", until);
    if (q.before) {
      const before = Number(q.before);
      if (!/^\d{1,15}$/.test(q.before) || !Number.isSafeInteger(before)) throw new BadRequest("before must be an event id (the previous page's next)");
      add("id < ?", before);
    }
    const limit = parseLimit(q.limit, PAGE);
    args.push(limit);
    const rows = await all<EventRow>(db, `SELECT ${EVENT_COLUMNS} FROM events WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT $${args.length}`, args);
    const events = rows.map(eventView);
    return c.json({ events, next: events.length === limit ? events.at(-1)!.id : null });
  });

  app.get(`${WS}/events/:id`, async (c) => {
    const row = await one<EventRow>(db, `SELECT ${EVENT_COLUMNS} FROM events WHERE workspace_id = $1 AND id = $2`, [wsOf(c), parseId(c.req.param("id"), "event")]);
    if (!row) throw notFound("event");
    return c.json({ event: eventView(row) });
  });

  app.post(`${WS}/events/:id/feedback`, async (c) => {
    const ws = wsOf(c);
    const id = parseId(c.req.param("id"), "event");
    const body = await jsonObject(c, '{"escalate": true}');
    if (typeof body.escalate !== "boolean") throw new BadRequest("escalate must be true or false");
    const res = await eventFeedback(db, ws, id, body.escalate, typeof body.note === "string" ? body.note.slice(0, 2000) : null, triageFor(ws));
    if (!res) throw notFound("event");
    return c.json({});
  });

  // Most severe first, then most recently active (as the admin API's /queue).
  app.get(`${WS}/queue`, async (c) => {
    const rows = await all<FlagRow>(
      db,
      `SELECT ${FLAG_COLUMNS} FROM flags WHERE workspace_id = $1 AND status = ANY($2::text[])
       ORDER BY CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, coalesce(updated_at, created_at) DESC, id
       LIMIT 500`,
      [wsOf(c), QUEUE_STATUSES],
    );
    return c.json({ flags: rows.map(flagView) });
  });

  app.get(`${WS}/flags`, async (c) => {
    const ws = wsOf(c);
    const q = c.req.query();
    const args: unknown[] = [ws];
    const where = ["workspace_id = $1"];
    if (q.status) {
      const statuses = q.status.split(",");
      for (const s of statuses) if (!FLAG_STATUSES.includes(s)) throw new BadRequest(`status must be among ${FLAG_STATUSES.join(", ")}`);
      args.push(statuses);
      where.push(`status = ANY($${args.length}::text[])`);
    }
    const since = parseTime(q.since);
    if (since !== undefined) {
      args.push(since);
      where.push(`created_at >= $${args.length}`);
    }
    if (q.before) {
      const b = await one<{ created_at: number; id: string }>(db, "SELECT created_at, id FROM flags WHERE workspace_id = $1 AND id = $2", [ws, q.before]);
      if (!b) throw new BadRequest("before: unknown flag id");
      args.push(b.created_at, b.id);
      where.push(`(created_at < $${args.length - 1} OR (created_at = $${args.length - 1} AND id < $${args.length}))`);
    }
    const limit = parseLimit(q.limit, PAGE);
    args.push(limit);
    const rows = await all<FlagRow>(db, `SELECT ${FLAG_COLUMNS} FROM flags WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT $${args.length}`, args);
    const flags = rows.map(flagView);
    return c.json({ flags, next: flags.length === limit ? flags.at(-1)!.id : null });
  });

  app.get(`${WS}/flags/:id`, async (c) => {
    const ws = wsOf(c);
    const flag = await getFlag(db, ws, c.req.param("id"));
    const deliveries = await all<{ action: string; destination_name: string | null; status: string; attempts: number; last_error: string | null; updated_at: number }>(
      db,
      // deliveries.action is a destination id (dst_...), or an adapter name for rows from before destinations.
      // Deleted destinations are kept (deleted_at), so their name is still there.
      `SELECT d.action, dst.name AS destination_name, d.status, d.attempts, d.last_error, d.updated_at
       FROM deliveries d LEFT JOIN destinations dst ON dst.id = d.action AND dst.workspace_id = d.workspace_id
       WHERE d.workspace_id = $1 AND d.flag_id = $2 ORDER BY d.action`,
      [ws, flag.id],
    );
    return c.json({
      flag: flagView(flag),
      events: await eventsByIds(db, ws, flag.event_ids),
      deliveries: deliveries.map((d) => ({
        destination_id: d.action,
        destination_name: d.destination_name ?? d.action,
        status: d.status,
        attempts: d.attempts,
        last_error: d.last_error,
        updated_at: iso(d.updated_at),
      })),
    });
  });

  app.patch(`${WS}/flags/:id`, async (c) => {
    const ws = wsOf(c);
    const body = await jsonObject(c, '{"status": "acknowledged"}');
    if (body.status !== "acknowledged" && body.status !== "resolved") {
      throw new BadRequest("status must be acknowledged or resolved (use /feedback for confirmed or false_positive)");
    }
    const row = await one<FlagRow>(db, `UPDATE flags SET status = $3, updated_at = $4 WHERE workspace_id = $1 AND id = $2 RETURNING ${FLAG_COLUMNS}`, [
      ws,
      c.req.param("id"),
      body.status,
      Date.now(),
    ]);
    if (!row) throw notFound("flag");
    return c.json({ flag: flagView(row) });
  });

  app.post(`${WS}/flags/:id/feedback`, async (c) => {
    const ws = wsOf(c);
    const body = await jsonObject(c, '{"verdict": "confirmed" | "false_positive"}');
    if (body.verdict !== "confirmed" && body.verdict !== "false_positive") throw new BadRequest("verdict must be confirmed or false_positive");
    const res = await flagFeedback(db, ws, triageFor(ws), c.req.param("id"), body.verdict, typeof body.note === "string" ? body.note.slice(0, 2000) : null);
    if (!res) throw notFound("flag");
    return c.json({ flag: flagView(await getFlag(db, ws, c.req.param("id"))) });
  });

  app.get(`${WS}/decisions/:id`, async (c) => {
    const row = await one<{ id: string; created_at: number; decider: string; model: string | null; prompt: string | null; response: string | null; event_ids: string[] }>(
      db,
      "SELECT id, created_at, decider, model, prompt, response, event_ids FROM decisions WHERE workspace_id = $1 AND id = $2",
      [wsOf(c), c.req.param("id")],
    );
    if (!row) throw notFound("decision");
    return c.json({ decision: { ...row, created_at: iso(row.created_at), event_ids: row.event_ids.map(String) } });
  });

  // The test event goes through intake like any request: queued, parsed, routed by the sorter, judged.
  app.post(`${WS}/test-event`, async (c) => {
    const ws = wsOf(c);
    const source = await ensureTestSource(db, ws);
    const receivedAt = Date.now();
    const body = new TextEncoder().encode(JSON.stringify(testException(randomBytes(4).toString("hex"), new Date(receivedAt))));
    // Intake returns no ids. Its row gets an id above every id there is now, so it is found by a short primary-key range scan.
    const floor = (await one<{ m: number }>(db, "SELECT coalesce(max(id), 0) AS m FROM queue"))!.m;
    try {
      await deps.intake.append({ workspace_id: ws, source, adapter: "json", received_at: receivedAt, body, secret_id: null });
    } catch (err) {
      if (!(err instanceof QueueFullError)) log.error("queue write failed", { error: errMsg(err) });
      c.header("retry-after", "5");
      throw new HttpError(503, err instanceof QueueFullError ? "the queue is full, try again shortly" : "storage unavailable, try again shortly");
    }
    const row = await one<{ id: number }>(db, "SELECT id FROM queue WHERE id > $4 AND workspace_id = $1 AND source = $2 AND received_at = $3 ORDER BY id DESC LIMIT 1", [
      ws,
      source,
      receivedAt,
      floor,
    ]);
    if (!row) throw new Error("test event was queued but not found");
    return c.json({ queue_id: String(row.id) });
  });

  app.get(`${WS}/test-event/:queue_id`, async (c) => {
    const ws = wsOf(c);
    const id = parseId(c.req.param("queue_id"), "queued request");
    const q = await one<{ id: number; status: string; received_at: number }>(db, "SELECT id, status, received_at FROM queue WHERE workspace_id = $1 AND id = $2", [ws, id]);
    if (!q) throw notFound("queued request");
    // Parsed events keep their request's received_at, which keeps this on the (workspace_id, received_at) index.
    const ev = await one<EventRow>(
      db,
      `SELECT ${EVENT_COLUMNS} FROM events WHERE workspace_id = $1 AND received_at = $2 AND queue_id = $3 ORDER BY id LIMIT 1`,
      [ws, q.received_at, q.id],
    );
    return c.json({ queue_id: String(q.id), status: q.status, event: ev ? eventView(ev) : null });
  });
}
