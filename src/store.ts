import { all, one, type Queryable } from "./db.ts";
import type { Flag, CloudfriendEvent, Severity } from "./types.ts";

export interface EventRow {
  id: number;
  source: string;
  received_at: number;
  data: string;
  external_id: string | null;
  type: string | null;
  group_key: string | null;
  user_key?: string | null;
  score?: number | null;
  route?: string | null;
}

export interface FlagRow {
  id: string;
  created_at: number;
  reason: string;
  severity: string;
  /** jsonb: comes back parsed. */
  event_ids: string[];
  decider: string;
  status?: string | null;
  updated_at?: number | null;
  event_count?: number | null;
  users?: string[] | null;
  note?: string | null;
}

export const EVENT_COLUMNS = "id, source, received_at, data, external_id, type, group_key, user_key, score, route";
export const FLAG_COLUMNS = "id, created_at, reason, severity, event_ids, decider, status, updated_at, event_count, users, note";

export function toEvent(r: EventRow): CloudfriendEvent {
  const e: CloudfriendEvent = {
    id: String(r.id),
    source: r.source,
    received_at: new Date(r.received_at).toISOString(),
    data: JSON.parse(r.data),
  };
  if (r.external_id !== null) e.external_id = r.external_id;
  if (r.type !== null) e.type = r.type;
  if (r.group_key !== null) e.group_key = r.group_key;
  if (r.user_key != null) e.user = r.user_key;
  if (r.score != null) e.score = r.score;
  if (r.route != null) e.route = r.route;
  return e;
}

export function toFlag(r: FlagRow): Flag {
  return {
    id: r.id,
    reason: r.reason,
    severity: r.severity as Severity,
    event_ids: r.event_ids,
    created_at: new Date(r.created_at).toISOString(),
    decider: r.decider,
    status: r.status ?? "open",
    event_count: r.event_count ?? r.event_ids.length,
    users: r.users ?? [],
    updated_at: new Date(r.updated_at ?? r.created_at).toISOString(),
    note: r.note ?? null,
  };
}

/** Events by id, in id order. Ids that have aged out are silently missing. */
export async function eventsByIds(db: Queryable, ws: string, ids: string[], limit = 50): Promise<CloudfriendEvent[]> {
  const nums = ids.map(Number).filter(Number.isSafeInteger).slice(0, limit);
  if (!nums.length) return [];
  const rows = await all<EventRow>(db, `SELECT ${EVENT_COLUMNS} FROM events WHERE workspace_id = $1 AND id = ANY($2::bigint[]) ORDER BY id`, [ws, nums]);
  return rows.map(toEvent);
}

export interface EventQuery {
  source?: string;
  type?: string;
  group_key?: string;
  user?: string;
  route?: string;
  /** Inclusive lower bound on received_at, epoch ms. */
  since?: number;
  /** Exclusive upper bound on received_at, epoch ms. */
  until?: number;
  /** Cursor: only events with id below this (newest-first paging). */
  before?: number;
  limit: number;
}

/** Builds a `WHERE` clause with numbered parameters, starting from the workspace. */
function where(ws: string) {
  const clauses = ["workspace_id = $1"];
  const args: unknown[] = [ws];
  const param = (v: unknown) => (args.push(v), `$${args.length}`);
  return {
    args,
    param,
    clause: (sql: string) => void clauses.push(sql),
    /** Adds `sql(placeholder)` unless the value is undefined. */
    add(sql: (p: string) => string, v: unknown) {
      if (v !== undefined) clauses.push(sql(param(v)));
    },
    get sql() {
      return "WHERE " + clauses.join(" AND ");
    },
  };
}

/** Newest first. Page with `before` = the last id of the previous page. */
export async function listEvents(db: Queryable, ws: string, q: EventQuery): Promise<CloudfriendEvent[]> {
  const w = where(ws);
  w.add((p) => `source = ${p}`, q.source);
  w.add((p) => `type = ${p}`, q.type);
  w.add((p) => `group_key = ${p}`, q.group_key);
  w.add((p) => `user_key = ${p}`, q.user);
  w.add((p) => `route = ${p}`, q.route);
  w.add((p) => `received_at >= ${p}`, q.since);
  w.add((p) => `received_at < ${p}`, q.until);
  w.add((p) => `id < ${p}`, q.before);
  const sql = `SELECT ${EVENT_COLUMNS} FROM events ${w.sql} ORDER BY id DESC LIMIT ${w.param(q.limit)}`;
  return (await all<EventRow>(db, sql, w.args)).map(toEvent);
}

export interface FlagQuery {
  since?: number;
  until?: number;
  severity?: string;
  status?: string[];
  /** Cursor: only flags created before this flag (newest-first paging). */
  before?: { created_at: number; id: string };
  limit: number;
}

export async function listFlags(db: Queryable, ws: string, q: FlagQuery): Promise<Flag[]> {
  const w = where(ws);
  w.add((p) => `created_at >= ${p}`, q.since);
  w.add((p) => `created_at < ${p}`, q.until);
  w.add((p) => `severity = ${p}`, q.severity);
  if (q.status?.length) w.add((p) => `status = ANY(${p}::text[])`, q.status);
  if (q.before) {
    const t = w.param(q.before.created_at);
    w.clause(`(created_at < ${t} OR (created_at = ${t} AND id < ${w.param(q.before.id)}))`);
  }
  const sql = `SELECT ${FLAG_COLUMNS} FROM flags ${w.sql} ORDER BY created_at DESC, id DESC LIMIT ${w.param(q.limit)}`;
  return (await all<FlagRow>(db, sql, w.args)).map(toFlag);
}

/** `forUpdate` locks the row until the transaction `db` belongs to ends. */
export async function getFlagRow(db: Queryable, ws: string, id: string, forUpdate = false): Promise<FlagRow | undefined> {
  return one<FlagRow>(db, `SELECT ${FLAG_COLUMNS} FROM flags WHERE workspace_id = $1 AND id = $2${forUpdate ? " FOR UPDATE" : ""}`, [ws, id]);
}

export interface DeliveryInfo {
  action: string;
  status: string;
  attempts: number;
  last_error: string | null;
  updated_at: string;
}

export async function deliveriesFor(db: Queryable, ws: string, flagId: string): Promise<DeliveryInfo[]> {
  const rows = await all<Omit<DeliveryInfo, "updated_at"> & { updated_at: number }>(
    db,
    "SELECT action, status, attempts, last_error, updated_at FROM deliveries WHERE workspace_id = $1 AND flag_id = $2 ORDER BY action",
    [ws, flagId],
  );
  return rows.map((r) => ({ ...r, updated_at: new Date(r.updated_at).toISOString() }));
}

const SEVERITY_RANK = "CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END";

/** The escalation queue: flags still waiting on a person, most severe first, then newest. */
export async function queue(db: Queryable, ws: string, statuses: string[], limit: number): Promise<Flag[]> {
  const rows = await all<FlagRow>(
    db,
    `SELECT ${FLAG_COLUMNS} FROM flags WHERE workspace_id = $1 AND status = ANY($2::text[])
     ORDER BY ${SEVERITY_RANK} DESC, coalesce(updated_at, created_at) DESC LIMIT $3`,
    [ws, statuses, limit],
  );
  return rows.map(toFlag);
}
