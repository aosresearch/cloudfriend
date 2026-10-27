import { Hono, type Context, type MiddlewareHandler } from "hono";
import { parseDuration } from "./config.ts";
import { all, DEFAULT_WORKSPACE, one, pgText, run, type DB } from "./db.ts";
import { QueueFullError, type Intake } from "./intake.ts";
import { errMsg, log } from "./log.ts";
import { safeEqual, SOURCE_NAME, type SecretMatch, type Secrets } from "./secrets.ts";
import { eventFeedback, flagFeedback, importLabels, type ImportedLabel } from "./feedback.ts";
import { deliveriesFor, eventsByIds, FLAG_COLUMNS, getFlagRow, listEvents, listFlags, queue, toFlag, type FlagRow } from "./store.ts";
import type { Trainer } from "./training.ts";
import type { Triage } from "./triage/runtime.ts";
import { SEVERITIES, type SourceAdapter } from "./types.ts";

export interface AppDeps {
  db: DB;
  /** The workspace the admin API reads and writes. Ingest follows each secret's workspace. */
  workspace?: string;
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
  if (/^\d+(\.\d+)?(ms|s|m|h|d)$/.test(value)) {
    const t = now - parseDuration(value);
    if (!Number.isSafeInteger(t)) throw new BadRequest(`invalid time: ${value}`);
    return t;
  }
  const t = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  // Out of range (e.g. 30 digits) is as invalid as unparseable: no stored time is near it.
  if (!Number.isSafeInteger(t)) throw new BadRequest(`invalid time: ${value} (use ISO 8601, epoch ms, or e.g. 1h)`);
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
  const ws = deps.workspace ?? DEFAULT_WORKSPACE;
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
    let secret: SecretMatch | null = null;
    try {
      secret = token ? await secrets.check(token, source) : null;
    } catch (err) {
      // The database is unreachable: the sender should retry, as when the write fails.
      log.error("secret check failed", { error: errMsg(err) });
      c.header("retry-after", "5");
      return c.text("storage unavailable, retry later", 503);
    }
    if (!secret) return c.text("unauthorized", 401);

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
      await intake.append({ workspace_id: secret.workspace_id, source, received_at: Date.now(), body, secret_id: secret.id });
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
  for (const prefix of ["/secrets", "/flags", "/events", "/queue", "/stats", "/model", "/labels", "/decisions"]) {
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
      return c.json(await secrets.create(body.name, (body.source as string | null | undefined) || null), 201);
    } catch (err) {
      throw new BadRequest(errMsg(err));
    }
  });

  app.get("/secrets", async (c) => c.json({ secrets: await secrets.list() }));

  app.delete("/secrets/:id", async (c) =>
    (await secrets.revoke(c.req.param("id"))) ? c.body(null, 204) : c.json({ error: "no active secret with that id" }, 404),
  );

  app.get("/flags", async (c) => {
    const q = c.req.query();
    const severity = q.severity || undefined;
    if (severity && !(SEVERITIES as readonly string[]).includes(severity)) {
      throw new BadRequest(`severity must be one of ${SEVERITIES.join(", ")}`);
    }
    let before: { created_at: number; id: string } | undefined;
    if (q.before) {
      const row = await getFlagRow(db, ws, q.before);
      if (!row) throw new BadRequest("before: unknown flag id");
      before = { created_at: row.created_at, id: row.id };
    }
    const limit = parseLimit(q.limit);
    const status = q.status ? q.status.split(",") : undefined;
    const flags = await listFlags(db, ws, { since: parseTime(q.since), until: parseTime(q.until), severity, status, before, limit });
    return c.json({ flags, next: flags.length === limit ? flags.at(-1)!.id : null });
  });

  app.get("/flags/:id", async (c) => {
    const row = await getFlagRow(db, ws, c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    const flag = toFlag(row);
    return c.json({ flag, events: await eventsByIds(db, ws, flag.event_ids, MAX_LIMIT), deliveries: await deliveriesFor(db, ws, flag.id) });
  });

  // --- the escalation queue and feedback -----------------------------------------

  app.get("/queue", async (c) => {
    const q = c.req.query();
    const statuses = q.status ? q.status.split(",") : QUEUE_STATUSES;
    for (const s of statuses) if (!FLAG_STATUSES.includes(s)) throw new BadRequest(`status must be among ${FLAG_STATUSES.join(", ")}`);
    return c.json({ flags: await queue(db, ws, statuses, parseLimit(q.limit)) });
  });

  app.patch("/flags/:id", async (c) => {
    const body = await jsonBody<{ status?: unknown; note?: unknown }>(c, '{"status": "acknowledged"}');
    if (typeof body.status !== "string" || !["open", "acknowledged", "resolved"].includes(body.status)) {
      throw new BadRequest("status must be open, acknowledged or resolved (use /feedback for confirmed or false_positive)");
    }
    const note = typeof body.note === "string" ? pgText(body.note) : null;
    const row = await one<FlagRow>(
      db,
      `UPDATE flags SET status = $1, note = coalesce($2, note), updated_at = $3 WHERE workspace_id = $4 AND id = $5 RETURNING ${FLAG_COLUMNS}`,
      [body.status, note, Date.now(), ws, c.req.param("id")],
    );
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(toFlag(row));
  });

  app.post("/flags/:id/feedback", async (c) => {
    const body = await jsonBody<{ verdict?: unknown; note?: unknown }>(c, '{"verdict": "confirmed" | "false_positive"}');
    if (body.verdict !== "confirmed" && body.verdict !== "false_positive") throw new BadRequest("verdict must be confirmed or false_positive");
    const res = await flagFeedback(db, ws, triage, c.req.param("id"), body.verdict, typeof body.note === "string" ? body.note : null);
    return res ? c.json(res) : c.json({ error: "not found" }, 404);
  });

  app.post("/events/:id/feedback", async (c) => {
    const body = await jsonBody<{ escalate?: unknown; note?: unknown }>(c, '{"escalate": true}');
    if (typeof body.escalate !== "boolean") throw new BadRequest("escalate must be true or false");
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id)) throw new BadRequest("unknown event id");
    const res = await eventFeedback(db, ws, id, body.escalate, typeof body.note === "string" ? body.note : null, triage);
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
    return c.json({ imported: await importLabels(db, ws, items, triage?.featurizer.version) }, 201);
  });

  app.get("/labels", async (c) => {
    const rows = await all<{ source: string; y: number; n: number }>(db, "SELECT source, y, count(*) AS n FROM labels WHERE workspace_id = $1 GROUP BY source, y", [ws]);
    const out: Record<string, { escalate: number; ignore: number }> = {};
    for (const r of rows) {
      out[r.source] ??= { escalate: 0, ignore: 0 };
      out[r.source]![r.y ? "escalate" : "ignore"] += r.n;
    }
    return c.json({ labels: out, new_since_last_training: trainer ? await trainer.newLabels() : null });
  });

  // --- stats and the model ---------------------------------------------------------

  app.get("/stats", async (c) => {
    const since = parseTime(c.req.query("since") || "24h")!;
    const routes = await all<{ route: string; n: number }>(
      db,
      "SELECT coalesce(route, 'none') AS route, count(*) AS n FROM events WHERE workspace_id = $1 AND received_at >= $2 GROUP BY 1",
      [ws, since],
    );
    const flags = await all<{ status: string; decider: string; n: number }>(
      db,
      "SELECT status, decider, count(*) AS n FROM flags WHERE workspace_id = $1 AND created_at >= $2 GROUP BY 1, 2",
      [ws, since],
    );
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

  app.get("/model", async (c) => {
    const history = await all<{ id: string; created_at: number; status: string; labels: number; report: string }>(
      db,
      "SELECT id, created_at, status, labels, report FROM models WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC LIMIT 20",
      [ws],
    );
    const shadow = await one<{ id: string; created_at: number }>(
      db,
      "SELECT id, created_at FROM models WHERE workspace_id = $1 AND status = 'shadow' ORDER BY created_at DESC LIMIT 1",
      [ws],
    );
    return c.json({
      active: triage?.classifier ? modelInfo(triage) : null,
      shadow: shadow && triage?.shadow
        ? {
            id: shadow.id,
            since: new Date(shadow.created_at).toISOString(),
            trained_at: triage.shadow.file.trained_at,
            drop_below: triage.shadow.file.drop_below,
            evidence: trainer ? await trainer.shadowEvidence(triage.shadow.file.trained_at) : null,
          }
        : null,
      training: trainer?.running ?? false,
      history: history.map((h) => ({ ...JSON.parse(h.report), status: h.status, created_at: new Date(h.created_at).toISOString() })),
    });
  });

  app.get("/decisions/:id", async (c) => {
    const row = await one<{ id: string; created_at: number; decider: string; model: string | null; prompt: string | null; response: string | null; event_ids: string[] }>(
      db,
      "SELECT id, created_at, decider, model, prompt, response, event_ids FROM decisions WHERE workspace_id = $1 AND id = $2",
      [ws, c.req.param("id")],
    );
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ ...row, created_at: new Date(row.created_at).toISOString() });
  });

  // What the candidate in shadow would newly drop that a person should look at: events judged
  // relevant (they block promotion) and events nobody judged (uncertain, or only grouped).
  app.get("/model/shadow/review", async (c) => {
    const trainedAt = triage?.shadow?.file.trained_at;
    if (!trainedAt) return c.json({ shadow: null, events: [] });
    const rows = await all<{ id: number; received_at: number; data: string; label: number | null }>(
      db,
      `SELECT e.id, e.source, e.received_at, e.route, e.score, e.shadow_score, e.template, e.data, l.y AS label, l.source AS label_source
       FROM events e LEFT JOIN labels l ON l.workspace_id = e.workspace_id AND l.event_id = e.id
       WHERE e.workspace_id = $1 AND e.shadow_model = $2 AND e.route NOT IN ('drop', 'audit') AND e.shadow_route = 'drop' AND (l.y IS NULL OR l.y = 1)
       ORDER BY (l.y IS NOT DISTINCT FROM 1) DESC, e.id DESC LIMIT 200`,
      [ws, trainedAt],
    );
    return c.json({
      shadow: trainedAt,
      events: rows.map((r) => ({ ...r, id: String(r.id), received_at: new Date(r.received_at).toISOString(), data: JSON.parse(r.data), why: r.label === 1 ? "judged relevant" : "not judged" })),
    });
  });

  app.post("/model/train", async (c) => {
    if (!trainer) return c.json({ error: "triage is off (CLOUDFRIEND_TRIAGE=off)" }, 503);
    const dryRun = c.req.query("dry_run") === "1" || c.req.query("dry_run") === "true";
    return c.json(await trainer.train({ dryRun }));
  });

  app.delete("/flags/:id", async (c) => {
    const n = await run(db, "DELETE FROM flags WHERE workspace_id = $1 AND id = $2", [ws, c.req.param("id")]);
    return n ? c.body(null, 204) : c.json({ error: "not found" }, 404);
  });

  app.get("/events", async (c) => {
    const q = c.req.query();
    let before: number | undefined;
    if (q.before) {
      before = Number(q.before);
      if (!Number.isSafeInteger(before)) throw new BadRequest("before must be an event id");
    }
    const limit = parseLimit(q.limit);
    const events = await listEvents(db, ws, {
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

  app.get("/events/:id", async (c) => {
    const [event] = await eventsByIds(db, ws, [c.req.param("id")]);
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
