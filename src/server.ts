import { Hono, type Context, type MiddlewareHandler } from "hono";
import { parseDuration } from "./config.ts";
import type { DB } from "./db.ts";
import { QueueFullError, type Intake } from "./intake.ts";
import { errMsg, log } from "./log.ts";
import { safeEqual, SOURCE_NAME, type Secrets } from "./secrets.ts";
import { deliveriesFor, eventsByIds, getFlagRow, listEvents, listFlags, toFlag } from "./store.ts";
import { SEVERITIES, type SourceAdapter } from "./types.ts";

export interface AppDeps {
  db: DB;
  intake: Intake;
  secrets: Secrets;
  sources: Map<string, SourceAdapter>;
  adminKey: string;
  maxBodyBytes: number;
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
  const { db, intake, secrets, sources, adminKey, maxBodyBytes } = deps;
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
  for (const prefix of ["/secrets", "/flags", "/events"]) {
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
    const flags = listFlags(db, { since: parseTime(q.since), until: parseTime(q.until), severity, before, limit });
    return c.json({ flags, next: flags.length === limit ? flags.at(-1)!.id : null });
  });

  app.get("/flags/:id", (c) => {
    const row = getFlagRow(db, c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    const flag = toFlag(row);
    return c.json({ flag, events: eventsByIds(db, flag.event_ids, MAX_LIMIT), deliveries: deliveriesFor(db, flag.id) });
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
