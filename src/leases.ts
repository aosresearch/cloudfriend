// One owner per workspace for the sorter (parse/score and decide). The sorter keeps per-workspace
// state in memory (featurizer history, verdict cache, earned suppression, escalation memory), so
// both stages of a workspace run in the one process that holds its lease.
//
//   claim    take a lease that is missing or expired; epoch + 1. Only for workspaces with work.
//   renew    push expires_at forward, only while (owner, epoch) is still ours.
//   fence    every sorter write runs `fence` first in its own transaction: it locks the lease row
//            FOR SHARE, so a claim (an UPDATE of that row) waits until the write commits, and the
//            write fails (LeaseLost) once someone else has claimed, or once the lease was released.
//            Safety rests on the epoch; expiry only decides when another worker may claim.
//   release  expires_at = 0, so another worker may claim at once (graceful shutdown, idle unload).
//
// Times are the database's clock, so workers on machines with skewed clocks agree on expiry.
import { all, one, type DB, type Queryable } from "./db.ts";

/** The database's clock in epoch milliseconds. */
export const DB_NOW = "(extract(epoch from clock_timestamp()) * 1000)::bigint";

/** The workspace's lease is no longer ours: another worker claimed it. Nothing was written. */
export class LeaseLost extends Error {
  readonly workspace: string;
  constructor(workspace: string) {
    super(`lease on workspace ${workspace} was taken over`);
    this.workspace = workspace;
  }
}

export interface Held {
  workspace: string;
  epoch: number;
}

export class Leases {
  readonly owner: string;
  readonly ttlMs: number;
  #db: DB;

  constructor(db: DB, owner: string, ttlMs: number) {
    this.#db = db;
    this.owner = owner;
    this.ttlMs = ttlMs;
  }

  /**
   * Workspaces with work waiting (unparsed requests or undecided events) that nobody holds a
   * live lease on. Random order, so workers claiming at the same moment spread out.
   */
  async claimable(limit: number, exclude: string[] = []): Promise<string[]> {
    if (limit <= 0) return [];
    const rows = await all<{ id: string }>(
      this.#db,
      `SELECT w.id FROM workspaces w LEFT JOIN leases l ON l.workspace_id = w.id
       WHERE (l.workspace_id IS NULL OR l.expires_at < ${DB_NOW}) AND NOT (w.id = ANY($2::text[]))
         AND (EXISTS (SELECT 1 FROM queue q WHERE q.workspace_id = w.id AND q.status = 'new')
              OR EXISTS (SELECT 1 FROM events e WHERE e.workspace_id = w.id AND NOT e.decided))
       ORDER BY random() LIMIT $1`,
      [limit, exclude],
    );
    return rows.map((r) => r.id);
  }

  /** Take the lease if it is missing or expired. Returns the new epoch, or null if someone holds it. */
  async claim(workspace: string): Promise<number | null> {
    const row = await one<{ epoch: number }>(
      this.#db,
      `INSERT INTO leases (workspace_id, owner, epoch, expires_at) VALUES ($1, $2, 1, ${DB_NOW} + $3)
       ON CONFLICT (workspace_id) DO UPDATE SET owner = excluded.owner, epoch = leases.epoch + 1, expires_at = excluded.expires_at
       WHERE leases.expires_at < ${DB_NOW}
       RETURNING epoch`,
      [workspace, this.owner, this.ttlMs],
    );
    return row ? row.epoch : null;
  }

  /** Extend the leases still ours. Returns the workspaces whose lease was renewed. */
  async renew(held: Held[]): Promise<Set<string>> {
    if (!held.length) return new Set();
    const rows = await all<{ workspace_id: string }>(
      this.#db,
      `UPDATE leases l SET expires_at = ${DB_NOW} + $4
       FROM unnest($1::text[], $2::bigint[]) AS u(ws, ep)
       WHERE l.workspace_id = u.ws AND l.epoch = u.ep AND l.owner = $3
       RETURNING l.workspace_id`,
      [held.map((h) => h.workspace), held.map((h) => h.epoch), this.owner, this.ttlMs],
    );
    return new Set(rows.map((r) => r.workspace_id));
  }

  /** Let another worker claim at once. A no-op if the lease is no longer ours. */
  async release(h: Held): Promise<void> {
    await this.#db.query("UPDATE leases SET expires_at = 0 WHERE workspace_id = $1 AND owner = $2 AND epoch = $3", [h.workspace, this.owner, h.epoch]);
  }

  /**
   * Run first in every sorter transaction. Holds the lease row FOR SHARE until the transaction
   * ends, so nobody can claim the workspace while it writes; throws LeaseLost if it is not ours
   * (another epoch or owner) or was released.
   */
  async fence(c: Queryable, h: Held): Promise<void> {
    const ok = await one(c, "SELECT 1 FROM leases WHERE workspace_id = $1 AND owner = $2 AND epoch = $3 AND expires_at > 0 FOR SHARE", [h.workspace, this.owner, h.epoch]);
    if (!ok) throw new LeaseLost(h.workspace);
  }

  /**
   * The epoch whose final state a load at this moment sees, or null if it may still change: the
   * lease is held (live, or expired but not yet claimed, so its owner may still be writing).
   * Only a released lease (or none) guarantees that nobody writes until the next claim.
   */
  static async settledEpoch(q: Queryable, workspace: string): Promise<number | null> {
    const row = await one<{ epoch: number; expires_at: number }>(q, "SELECT epoch, expires_at FROM leases WHERE workspace_id = $1", [workspace]);
    if (!row) return 0;
    return row.expires_at === 0 ? row.epoch : null;
  }
}
