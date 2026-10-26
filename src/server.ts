import { Hono, type Context, type MiddlewareHandler } from "hono";
import { parseDuration } from "./config.ts";
import type { DB } from "./db.ts";
import { QueueFullError, type Intake } from "./intake.ts";
import { errMsg, log } from "./log.ts";
import { safeEqual, SOURCE_NAME, type Secrets } from "./secrets.ts";
import { eventFeedback, flagFeedback, importLabels, type ImportedLabel } from "./feedback.ts";
import { deliveriesFor, eventsByIds, getFlagRow, listEvents, listFlags, queue, toFlag } from "./store.ts";
import type { Trainer } from "./training.ts";
import type { Triage } from "./triage/runtime.ts";
import { SEVERITIES, type SourceAdapter } from "./types.ts";

export interface AppDeps {
  db: DB;
  intake: Intake;
  secrets: Secrets;
  sources: Map<string, SourceAdapter>;
  adminKey: string;
  maxBodyBytes: number;
  triage?: Triage | null;
  trainer?: Trainer | null;
  /** Decider calls and examples asked since start, for /stats. */
  counters?: () => Record<string, number>;
}

const QUEUE_STATUSES = ["open", "acknowledged"];
const FLAG_STATUSES = ["open", "acknowledged", "resolved", "confirmed", "false_positive"];

async function jsonBody<T>(c: Context, hint: string): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new BadRequest(`body must be JSON: ${hint}`);
  }
}

class BadRequest extends Error {}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function bearer(c: Context): string | null {
  const h = c.req.header("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1]!.trim() : null;
}

/** Accepts ISO 8601, epoch milliseconds, or a duration meaning "that long ago" (`1h`, `30m`, `7d`). */
export function parseTime(value: string | undefined, now = Date.now()): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (/^\d+(\.\d+)?(ms|s|m|h|d)$/.test(value)) return now - parseDuration(value);
  if (/^\d+$/.test(value)) return Number(value);
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new BadRequest(`invalid time: ${value} (use ISO 8601, epoch ms, or e.g. 1h)`);
  return t;
}

function parseLimit(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_LIMIT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new BadRequest("limit must be a positive integer");
  return Math.min(n, MAX_LIMIT);
}

export function createApp(deps: AppDeps): Hono {
  const { db, intake, secrets, sources, adminKey, maxBodyBytes, triage = null, trainer = null } = deps;
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
    log.error("request failed", { path: c.req.path, error: errMsg(err) });
    return c.json({ error: "internal error" }, 500);
  });
  app.notFound((c) => c.json({ error: "not found" }, 404));

  app.get("/healthz", (c) => c.json({ ok: true, queued: intake.backlog }));

  // --- ingest: check the secret, write the raw bytes, commit, reply ----------

  app.post("/in/:source", async (c) => {
    const source = c.req.param("source");
    if (!SOURCE_NAME.test(source)) return c.json({ error: "invalid source name" }, 404);
    const token = bearer(c) ?? c.req.query("secret");
    const secretId = token ? secrets.check(token, source) : null;
    if (!secretId) return c.text("unauthorized", 401);

    const declared = Number(c.req.header("content-length"));
    if (declared > maxBodyBytes) return c.text("payload too large", 413);
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength > maxBodyBytes) return c.text("payload too large", 413);

    const adapter = sources.get(source) ?? sources.get("json")!;
    if (adapter.verify) {
      const headers: Record<string, string> = {};
      c.req.raw.headers.forEach((v, k) => (headers[k] = v));
      if (!adapter.verify({ source, headers, query: c.req.query(), body })) return c.text("unauthorized", 401);
    }

    try {
      await intake.append({ source, received_at: Date.now(), body, secret_id: secretId });
    } catch (err) {
      if (!(err instanceof QueueFullError)) log.error("queue write failed", { error: errMsg(err) });
      c.header("retry-after", "5");
      return c.text(err instanceof QueueFullError ? "queue full, retry later" : "storage unavailable, retry later", 503);
    }
    return c.text("accepted", 202);
  });

  // --- admin API -------------------------------------------------------------

  const requireAdmin: MiddlewareHandler = async (c, next) => {
    if (!adminKey) return c.json({ error: "admin API disabled: set CLOUDFRIEND_ADMIN_KEY" }, 503);
    const token = bearer(c);
    if (!token || !safeEqual(token, adminKey)) return c.json({ error: "unauthorized" }, 401);
    await next();
  };
  for (const prefix of ["/secrets", "/flags", "/events", "/queue", "/stats", "/model", "/labels"]) {
    app.use(prefix, requireAdmin);
    app.use(`${prefix}/*`, requireAdmin);
  }

  app.post("/secrets", async (c) => {
    let body: { name?: unknown; source?: unknown };
    try {
      body = await c.req.json();
    } catch {
      throw new BadRequest("body must be JSON: {\"name\": \"...\", \"source\": \"optional\"}");
    }
    if (typeof body.name !== "string") throw new BadRequest("name is required");
    if (body.source !== undefined && body.source !== null && typeof body.source !== "string") {
      throw new BadRequest("source must be a string");
    }
    try {
      return c.json(secrets.create(body.name, (body.source as string | null | undefined) || null), 201);
    } catch (err) {
      throw new BadRequest(errMsg(err));
    }
  });

  app.get("/secrets", (c) => c.json({ secrets: secrets.list() }));

  app.delete("/secrets/:id", (c) =>
    secrets.revoke(c.req.param("id")) ? c.body(null, 204) : c.json({ error: "no active secret with that id" }, 404),
  );

  app.get("/flags", (c) => {
    const q = c.req.query();
    const severity = q.severity || undefined;
    if (severity && !(SEVERITIES as readonly string[]).includes(severity)) {
      throw new BadRequest(`severity must be one of ${SEVERITIES.join(", ")}`);
    }
    let before: { created_at: number; id: string } | undefined;
    if (q.before) {
      const row = getFlagRow(db, q.before);
      if (!row) throw new BadRequest("before: unknown flag id");
      before = { created_at: row.created_at, id: row.id };
    }
    const limit = parseLimit(q.limit);
    const status = q.status ? q.status.split(",") : undefined;
    const flags = listFlags(db, { since: parseTime(q.since), until: parseTime(q.until), severity, status, before, limit });
    return c.json({ flags, next: flags.length === limit ? flags.at(-1)!.id : null });
  });

  app.get("/flags/:id", (c) => {
    const row = getFlagRow(db, c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    const flag = toFlag(row);
    return c.json({ flag, events: eventsByIds(db, flag.event_ids, MAX_LIMIT), deliveries: deliveriesFor(db, flag.id) });
  });

  // --- the escalation queue and feedback -----------------------------------------

  app.get("/queue", (c) => {
    const q = c.req.query();
    const statuses = q.status ? q.status.split(",") : QUEUE_STATUSES;
    for (const s of statuses) if (!FLAG_STATUSES.includes(s)) throw new BadRequest(`status must be among ${FLAG_STATUSES.join(", ")}`);
    return c.json({ flags: queue(db, statuses, parseLimit(q.limit)) });
  });

  app.patch("/flags/:id", async (c) => {
    const body = await jsonBody<{ status?: unknown; note?: unknown }>(c, '{"status": "acknowledged"}');
    if (typeof body.status !== "string" || !["open", "acknowledged", "resolved"].includes(body.status)) {
      throw new BadRequest("status must be open, acknowledged or resolved (use /feedback for confirmed or false_positive)");
    }
    const note = typeof body.note === "string" ? body.note : null;
    const res = db.prepare("UPDATE flags SET status = ?, note = coalesce(?, note), updated_at = ? WHERE id = ?").run(body.status, note, Date.now(), c.req.param("id"));
    if (!res.changes) return c.json({ error: "not found" }, 404);
    return c.json(toFlag(getFlagRow(db, c.req.param("id"))!));
  });

  app.post("/flags/:id/feedback", async (c) => {
    const body = await jsonBody<{ verdict?: unknown; note?: unknown }>(c, '{"verdict": "confirmed" | "false_positive"}');
    if (body.verdict !== "confirmed" && body.verdict !== "false_positive") throw new BadRequest("verdict must be confirmed or false_positive");
    const res = flagFeedback(db, triage, c.req.param("id"), body.verdict, typeof body.note === "string" ? body.note : null);
    return res ? c.json(res) : c.json({ error: "not found" }, 404);
  });

  app.post("/events/:id/feedback", async (c) => {
    const body = await jsonBody<{ escalate?: unknown; note?: unknown }>(c, '{"escalate": true}');
    if (typeof body.escalate !== "boolean") throw new BadRequest("escalate must be true or false");
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) throw new BadRequest("unknown event id");
    const res = eventFeedback(db, id, body.escalate, typeof body.note === "string" ? body.note : null);
    return res ? c.json(res) : c.json({ error: "not found (events are kept for CLOUDFRIEND_RETENTION)" }, 404);
  });

  app.post("/labels", async (c) => {
    const body = await jsonBody<{ labels?: unknown } | unknown[]>(c, '{"labels": [{"source": "...", "data": {...}, "escalate": true}]}');
    const items = (Array.isArray(body) ? body : (body as { labels?: unknown }).labels) as ImportedLabel[] | undefined;
    if (!Array.isArray(items) || !items.length) throw new BadRequest("labels must be a non-empty array");
    for (const it of items) {
      if (!it || typeof it.source !== "string" || typeof it.escalate !== "boolean" || !("data" in it)) {
        throw new BadRequest("each label needs source (string), data and escalate (boolean)");
      }
    }
    return c.json({ imported: importLabels(db, items) }, 201);
  });

  app.get("/labels", (c) => {
    const rows = db.prepare("SELECT source, y, count(*) AS n FROM labels GROUP BY source, y").all() as { source: string; y: number; n: number }[];
    const out: Record<string, { escalate: number; ignore: number }> = {};
    for (const r of rows) {
      out[r.source] ??= { escalate: 0, ignore: 0 };
      out[r.source]![r.y ? "escalate" : "ignore"] += r.n;
    }
    return c.json({ labels: out, new_since_last_training: trainer?.newLabels() ?? null });
  });

  // --- stats and the model ---------------------------------------------------------

  app.get("/stats", (c) => {
    const since = parseTime(c.req.query("since") || "24h")!;
    const routes = db.prepare("SELECT coalesce(route, 'none') AS route, count(*) AS n FROM events WHERE received_at >= ? GROUP BY 1").all(since) as { route: string; n: number }[];
    const flags = db.prepare("SELECT coalesce(status, 'open') AS status, decider, count(*) AS n FROM flags WHERE created_at >= ? GROUP BY 1, 2").all(since) as { status: string; decider: string; n: number }[];
    const byRoute = Object.fromEntries(routes.map((r) => [r.route, r.n]));
    const events = routes.reduce((a, r) => a + r.n, 0);
    const pastClassifier = (byRoute.jev ?? 0) + (byRoute.audit ?? 0) + (byRoute.auto ?? 0) + (byRoute.none ?? 0);
    return c.json({
      since: new Date(since).toISOString(),
      events,
      routes: byRoute,
      share_past_classifier: events ? pastClassifier / events : 0,
      flags,
      since_start: deps.counters?.() ?? {},
      model: triage?.classifier ? modelInfo(triage) : null,
    });
  });

  app.get("/model", (c) => {
    const history = db.prepare("SELECT id, created_at, status, labels, report FROM models ORDER BY created_at DESC LIMIT 20").all() as {
      id: string; created_at: number; status: string; labels: number; report: string;
    }[];
    return c.json({
      active: triage?.classifier ? modelInfo(triage) : null,
      training: trainer?.running ?? false,
      history: history.map((h) => ({ ...JSON.parse(h.report), status: h.status, created_at: new Date(h.created_at).toISOString() })),
    });
  });

  app.post("/model/train", async (c) => {
    if (!trainer) return c.json({ error: "triage is off (CLOUDFRIEND_TRIAGE=off)" }, 503);
    const dryRun = c.req.query("dry_run") === "1" || c.req.query("dry_run") === "true";
    return c.json(await trainer.train({ dryRun }));
  });

  app.delete("/flags/:id", (c) => {
    const res = db.prepare("DELETE FROM flags WHERE id = ?").run(c.req.param("id"));
    return res.changes ? c.body(null, 204) : c.json({ error: "not found" }, 404);
  });

  app.get("/events", (c) => {
    const q = c.req.query();
    let before: number | undefined;
    if (q.before) {
      before = Number(q.before);
      if (!Number.isInteger(before)) throw new BadRequest("before must be an event id");
    }
    const limit = parseLimit(q.limit);
    const events = listEvents(db, {
      source: q.source || undefined,
      user: q.user || undefined,
      route: q.route || undefined,
      type: q.type || undefined,
      group_key: q.group_key || undefined,
      since: parseTime(q.since),
      until: parseTime(q.until),
      before,
      limit,
    });
    return c.json({ events, next: events.length === limit ? events.at(-1)!.id : null });
  });

  app.get("/events/:id", (c) => {
    const [event] = eventsByIds(db, [c.req.param("id")]);
    return event ? c.json(event) : c.json({ error: "not found" }, 404);
  });

  return app;
}

function modelInfo(triage: Triage) {
  const f = triage.classifier!.file;
  return {
    path: triage.modelPath,
    trained_at: f.trained_at,
    note: f.note ?? null,
    trees: triage.classifier!.gbdt.numTrees,
    drop_below: f.drop_below,
    escalate_above: f.escalate_above,
    threshold: f.threshold,
    metrics: f.metrics ?? null,
  };
}
