import type { DB } from "./db.ts";
import type { Flag, SieveEvent, Severity } from "./types.ts";

export interface EventRow {
  id: number;
  source: string;
  received_at: number;
  data: string;
  external_id: string | null;
  type: string | null;
  group_key: string | null;
}

export interface FlagRow {
  id: string;
  created_at: number;
  reason: string;
  severity: string;
  event_ids: string;
  decider: string;
}

export const EVENT_COLUMNS = "id, source, received_at, data, external_id, type, group_key";

export function toEvent(r: EventRow): SieveEvent {
  const e: SieveEvent = {
    id: String(r.id),
    source: r.source,
    received_at: new Date(r.received_at).toISOString(),
    data: JSON.parse(r.data),
  };
  if (r.external_id !== null) e.external_id = r.external_id;
  if (r.type !== null) e.type = r.type;
  if (r.group_key !== null) e.group_key = r.group_key;
  return e;
}

export function toFlag(r: FlagRow): Flag {
  return {
    id: r.id,
    reason: r.reason,
    severity: r.severity as Severity,
    event_ids: JSON.parse(r.event_ids),
    created_at: new Date(r.created_at).toISOString(),
    decider: r.decider,
  };
}

/** Events by id, in id order. Ids that have aged out are silently missing. */
export function eventsByIds(db: DB, ids: string[], limit = 50): SieveEvent[] {
  const nums = ids.map(Number).filter(Number.isInteger).slice(0, limit);
  if (!nums.length) return [];
  const rows = db
    .prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id IN (${nums.map(() => "?").join(",")}) ORDER BY id`)
    .all(...nums) as unknown as EventRow[];
  return rows.map(toEvent);
}

export interface EventQuery {
  source?: string;
  type?: string;
  group_key?: string;
  /** Inclusive lower bound on received_at, epoch ms. */
  since?: number;
  /** Exclusive upper bound on received_at, epoch ms. */
  until?: number;
  /** Cursor: only events with id below this (newest-first paging). */
  before?: number;
  limit: number;
}

/** Newest first. Page with `before` = the last id of the previous page. */
export function listEvents(db: DB, q: EventQuery): SieveEvent[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const add = (sql: string, v: string | number | undefined) => {
    if (v === undefined) return;
    where.push(sql);
    args.push(v);
  };
  add("source = ?", q.source);
  add("type = ?", q.type);
  add("group_key = ?", q.group_key);
  add("received_at >= ?", q.since);
  add("received_at < ?", q.until);
  add("id < ?", q.before);
  const sql = `SELECT ${EVENT_COLUMNS} FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
  return (db.prepare(sql).all(...args, q.limit) as unknown as EventRow[]).map(toEvent);
}

export interface FlagQuery {
  since?: number;
  until?: number;
  severity?: string;
  /** Cursor: only flags created before this flag (newest-first paging). */
  before?: { created_at: number; id: string };
  limit: number;
}

export function listFlags(db: DB, q: FlagQuery): Flag[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (q.since !== undefined) (where.push("created_at >= ?"), args.push(q.since));
  if (q.until !== undefined) (where.push("created_at < ?"), args.push(q.until));
  if (q.severity !== undefined) (where.push("severity = ?"), args.push(q.severity));
  if (q.before) {
    where.push("(created_at < ? OR (created_at = ? AND id < ?))");
    args.push(q.before.created_at, q.before.created_at, q.before.id);
  }
  const sql = `SELECT * FROM flags ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, id DESC LIMIT ?`;
  return (db.prepare(sql).all(...args, q.limit) as unknown as FlagRow[]).map(toFlag);
}

export function getFlagRow(db: DB, id: string): FlagRow | undefined {
  return db.prepare("SELECT * FROM flags WHERE id = ?").get(id) as unknown as FlagRow | undefined;
}

export interface DeliveryInfo {
  action: string;
  status: string;
  attempts: number;
  last_error: string | null;
  updated_at: string;
}

export function deliveriesFor(db: DB, flagId: string): DeliveryInfo[] {
  const rows = db
    .prepare("SELECT action, status, attempts, last_error, updated_at FROM deliveries WHERE flag_id = ? ORDER BY action")
    .all(flagId) as unknown as (Omit<DeliveryInfo, "updated_at"> & { updated_at: number })[];
  return rows.map((r) => ({ ...r, updated_at: new Date(r.updated_at).toISOString() }));
}
