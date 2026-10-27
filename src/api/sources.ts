// Sources: an ingest endpoint (/in/<source id>) plus its secrets.
//   GET    /api/w/:ws/sources
//   POST   /api/w/:ws/sources              { name, kind } -> 201 { source, secret }
//   POST   /api/w/:ws/sources/:id/rotate   -> { source, secret }; the old secret works 24 h more
//   DELETE /api/w/:ws/sources/:id          revokes the source and its secrets
import { createHash, randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import type { AuthEnv } from "../auth/index.ts";
import { all, one, tx, type Queryable } from "../db.ts";
import { insertSourceSecret } from "../secrets.ts";
import { WS, wsOf, type DashboardDeps } from "./deps.ts";
import { BadRequest, HttpError, iso, jsonObject, notFound } from "./http.ts";

export const ROTATION_GRACE_MS = 24 * 3600_000;
const SOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The workspace's test source: what the dashboard's test events are filed under. A sources row
 * (so events name it like any other source) without secrets, so nothing can be sent to it from
 * outside, and left out of the source list.
 */
export function testSourceId(ws: string): string {
  return "src_test_" + createHash("sha256").update(ws).digest("hex").slice(0, 16);
}
export const TEST_SOURCE_NAME = "cloudfriend-test";

export async function ensureTestSource(db: Queryable, ws: string): Promise<string> {
  const id = testSourceId(ws);
  await db.query("INSERT INTO sources (id, workspace_id, name, kind, created_at) VALUES ($1, $2, $3, 'json', $4) ON CONFLICT (id) DO NOTHING", [
    id,
    ws,
    TEST_SOURCE_NAME,
    Date.now(),
  ]);
  return id;
}

interface Row {
  id: string;
  name: string;
  kind: string;
  created_at: number;
  revoked_at: number | null;
  secret_prefix: string | null;
  last_used_at: number | null;
}

const SELECT = `SELECT s.id, s.name, s.kind, s.created_at, s.revoked_at,
    (SELECT prefix FROM secrets k WHERE k.source_id = s.id AND k.revoked_at IS NULL ORDER BY k.created_at DESC, k.id DESC LIMIT 1) AS secret_prefix,
    (SELECT max(last_used_at) FROM secrets k WHERE k.source_id = s.id) AS last_used_at
  FROM sources s`;

/** Where events for a source are POSTed: CLOUDFRIEND_PUBLIC_URL (or the request's origin) + /in/<id>. */
function endpointBase(c: Context, publicUrl: URL | null): string {
  if (publicUrl) return publicUrl.href.replace(/\/+$/, "");
  return new URL(c.req.url).origin;
}

function view(r: Row, base: string) {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    endpoint_url: `${base}/in/${r.id}`,
    secret_prefix: r.secret_prefix ?? "",
    created_at: iso(r.created_at),
    last_used_at: iso(r.last_used_at),
    revoked_at: iso(r.revoked_at),
  };
}

async function getSource(q: Queryable, ws: string, id: string, lock = false): Promise<Row> {
  const row = await one<Row>(q, `${SELECT} WHERE s.workspace_id = $1 AND s.id = $2 AND s.id <> $3${lock ? " FOR UPDATE OF s" : ""}`, [ws, id, testSourceId(ws)]);
  if (!row) throw notFound("source");
  return row;
}

export function registerSources(app: Hono<AuthEnv>, deps: DashboardDeps): void {
  const { db } = deps;

  app.get(`${WS}/sources`, async (c) => {
    const ws = wsOf(c);
    const rows = await all<Row>(db, `${SELECT} WHERE s.workspace_id = $1 AND s.id <> $2 ORDER BY s.created_at, s.id`, [ws, testSourceId(ws)]);
    const base = endpointBase(c, deps.publicUrl);
    return c.json({ sources: rows.map((r) => view(r, base)) });
  });

  app.post(`${WS}/sources`, async (c) => {
    const ws = wsOf(c);
    const body = await jsonObject(c, '{"name": "...", "kind": "json"}');
    if (typeof body.name !== "string" || !body.name.trim()) throw new BadRequest("name is required");
    const name = body.name.trim();
    if (!SOURCE_NAME.test(name)) throw new BadRequest("name may use letters, digits, '.', '_' and '-' (64 characters at most)");
    if (name === TEST_SOURCE_NAME) throw new BadRequest(`${TEST_SOURCE_NAME} is reserved for the dashboard's test events`);
    const kind = body.kind ?? "json";
    if (typeof kind !== "string" || !deps.sources.has(kind)) throw new BadRequest(`kind must be one of ${[...deps.sources.keys()].join(", ")}`);

    const now = Date.now();
    const id = "src_" + randomBytes(8).toString("hex");
    const { secret } = await tx(db, async (q) => {
      // Locks the workspace row, so two creates with the same name can't both pass the check.
      await q.query("SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE", [ws]);
      if (await one(q, "SELECT 1 FROM sources WHERE workspace_id = $1 AND name = $2 AND revoked_at IS NULL", [ws, name])) {
        throw new HttpError(409, `a source named ${name} already exists`);
      }
      await q.query("INSERT INTO sources (id, workspace_id, name, kind, created_at) VALUES ($1, $2, $3, $4, $5)", [id, ws, name, kind, now]);
      return insertSourceSecret(q, ws, id, name, now);
    });
    return c.json({ source: view(await getSource(db, ws, id), endpointBase(c, deps.publicUrl)), secret }, 201);
  });

  app.post(`${WS}/sources/:id/rotate`, async (c) => {
    const ws = wsOf(c);
    const id = c.req.param("id");
    const now = Date.now();
    const { secret } = await tx(db, async (q) => {
      const src = await getSource(q, ws, id, true);
      if (src.revoked_at !== null) throw new BadRequest("this source is revoked; create a new one");
      // Older secrets keep working until now + 24 h, or until their earlier expiry from a previous rotation.
      await q.query(
        "UPDATE secrets SET expires_at = least(coalesce(expires_at, $3), $3) WHERE workspace_id = $1 AND source_id = $2 AND revoked_at IS NULL",
        [ws, id, now + ROTATION_GRACE_MS],
      );
      return insertSourceSecret(q, ws, id, src.name, now);
    });
    return c.json({ source: view(await getSource(db, ws, id), endpointBase(c, deps.publicUrl)), secret });
  });

  app.delete(`${WS}/sources/:id`, async (c) => {
    const ws = wsOf(c);
    const id = c.req.param("id");
    const now = Date.now();
    await tx(db, async (q) => {
      await getSource(q, ws, id, true);
      await q.query("UPDATE sources SET revoked_at = $3 WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL", [ws, id, now]);
      await q.query("UPDATE secrets SET revoked_at = $3 WHERE workspace_id = $1 AND source_id = $2 AND revoked_at IS NULL", [ws, id, now]);
    });
    return c.body(null, 204);
  });
}
