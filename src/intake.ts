import { all, tx, type DB } from "./db.ts";
import { errMsg, log } from "./log.ts";
import { Secrets } from "./secrets.ts";
import { addEvents, utcDay } from "./usage.ts";

export interface IntakeRow {
  workspace_id: string;
  /** The source name the request came in under (`/in/<source>`), stored as the events' source. */
  source: string;
  /** The source adapter that parses it, fixed now (from `sources.kind`). Absent: the adapter named like the source. */
  adapter?: string | null;
  received_at: number;
  body: Uint8Array;
  /** The secret the request presented, to record its use. */
  secret_id?: string | null;
}

interface Pending {
  row: IntakeRow;
  resolve: () => void;
  reject: (err: Error) => void;
}

export class QueueFullError extends Error {}

const INSERT = `INSERT INTO queue (workspace_id, source, adapter, received_at, body)
  SELECT w, s, a, t, b FROM unnest($1::text[], $2::text[], $3::text[], $4::bigint[], $5::bytea[]) WITH ORDINALITY AS r(w, s, a, t, b, n) ORDER BY n`;

/** The cached backlog of a workspace is read again from the database after this long. */
const BACKLOG_REFRESH_MS = 1_000;
/** Workspaces not seen for this long are no longer refreshed. */
const BACKLOG_FORGET_MS = 60_000;

interface Backlog {
  /** `workspaces.backlog` as last read, plus what this process committed or parsed since. */
  n: number;
  readAt: number;
  usedAt: number;
}

/**
 * Group-commit writer. Requests that arrive within one commit window are inserted with one
 * multi-row INSERT in one transaction, so one commit (one WAL flush) covers the whole batch.
 * Each `append` resolves only after the commit that included its row, which is when the
 * caller may reply 202. A batch is committed or rejected as a whole.
 *
 * Admission is per workspace: `workspaces.backlog` (rows still 'new') is kept by this commit
 * (+) and by parse (-) in their own transactions, so it is right when web and worker run in
 * different processes. The request path reads it from a cache refreshed at most every second.
 */
export class Intake {
  #db: DB;
  #windowMs: number;
  #maxQueue: number;
  #pending: Pending[] = [];
  #timer: NodeJS.Timeout | null = null;
  /** Commits under way, so shutdown can wait for them. */
  #commits = new Set<Promise<void>>();
  /** Rows per workspace collected or being committed: they count toward the limit. */
  #inflight = new Map<string, number>();
  #backlog = new Map<string, Backlog>();
  #refreshing: Promise<void> | null = null;

  private constructor(db: DB, opts: { windowMs: number; maxQueue: number }) {
    this.#db = db;
    this.#windowMs = opts.windowMs;
    this.#maxQueue = opts.maxQueue;
  }

  /**
   * Bring every workspace's backlog counter in line with its queue (it drifts only if rows are
   * written outside intake and parse, e.g. by the release before the counter existed), then
   * cache it.
   */
  static async open(db: DB, opts: { windowMs: number; maxQueue: number }): Promise<Intake> {
    await reconcileBacklog(db);
    const intake = new Intake(db, opts);
    const now = Date.now();
    for (const r of await all<{ id: string; backlog: number }>(db, "SELECT id, backlog FROM workspaces")) {
      intake.#backlog.set(r.id, { n: r.backlog, readAt: now, usedAt: now });
    }
    return intake;
  }

  /** Requests not yet parsed, over every workspace this process has cached. */
  get backlog(): number {
    let n = 0;
    for (const b of this.#backlog.values()) n += b.n;
    return n;
  }

  /** A workspace's requests not yet parsed, as cached. */
  backlogOf(workspace: string): number {
    return this.#backlog.get(workspace)?.n ?? 0;
  }

  /** The worker calls this after it moves rows out of 'new' (it has updated the database counter). */
  release(workspace: string, n: number): void {
    const b = this.#backlog.get(workspace);
    if (b) b.n = Math.max(0, b.n - n);
  }

  async append(row: IntakeRow): Promise<void> {
    const ws = row.workspace_id;
    const backlog = await this.#current(ws);
    if (backlog + (this.#inflight.get(ws) ?? 0) >= this.#maxQueue) throw new QueueFullError("queue is full");
    this.#inflight.set(ws, (this.#inflight.get(ws) ?? 0) + 1);
    return new Promise<void>((resolve, reject) => {
      this.#pending.push({ row, resolve, reject });
      this.#timer ??= setTimeout(() => void this.flush(), this.#windowMs);
    });
  }

  /** The cached backlog of a workspace: read now if unknown, refreshed in the background if stale. */
  async #current(ws: string): Promise<number> {
    const now = Date.now();
    const b = this.#backlog.get(ws);
    if (!b || !b.readAt) {
      if (!b) this.#backlog.set(ws, { n: 0, readAt: 0, usedAt: now });
      await this.#refresh();
      return this.#backlog.get(ws)?.n ?? 0;
    }
    b.usedAt = now;
    if (now - b.readAt >= BACKLOG_REFRESH_MS) void this.#refresh();
    return b.n;
  }

  /** Read the counters of the workspaces in use: one query for all of them, one refresh at a time. */
  #refresh(): Promise<void> {
    this.#refreshing ??= (async () => {
      const now = Date.now();
      for (const [ws, b] of this.#backlog) if (now - b.usedAt > BACKLOG_FORGET_MS) this.#backlog.delete(ws);
      const ids = [...this.#backlog.keys()];
      if (!ids.length) return;
      const rows = await all<{ id: string; backlog: number }>(this.#db, "SELECT id, backlog FROM workspaces WHERE id = ANY($1::text[])", [ids]);
      const read = Date.now();
      for (const r of rows) {
        const b = this.#backlog.get(r.id);
        if (b) Object.assign(b, { n: r.backlog, readAt: read });
      }
    })()
      .catch((err) => log.warn("reading the queue backlog failed", { error: errMsg(err) }))
      .finally(() => (this.#refreshing = null));
    return this.#refreshing;
  }

  /** Commit everything collected so far, and wait for commits already under way. Also called on shutdown. */
  async flush(): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const batch = this.#pending.splice(0);
    if (batch.length) {
      const p: Promise<void> = this.#commit(batch).finally(() => this.#commits.delete(p));
      this.#commits.add(p);
    }
    await Promise.all(this.#commits);
  }

  async #commit(batch: Pending[]): Promise<void> {
    const rows = batch.map((p) => p.row);
    const perWs = new Map<string, number>();
    for (const r of rows) perWs.set(r.workspace_id, (perWs.get(r.workspace_id) ?? 0) + 1);
    const ws = [...perWs.keys()].sort();
    try {
      await tx(this.#db, async (c) => {
        // The counters first, in id order, as everywhere (reconcileBacklog), so commits never
        // deadlock. NO KEY UPDATE: the inserts' foreign keys take KEY SHARE on the same rows.
        await c.query("SELECT 1 FROM workspaces WHERE id = ANY($1::text[]) ORDER BY id FOR NO KEY UPDATE", [ws]);
        await c.query(INSERT, [rows.map((r) => r.workspace_id), rows.map((r) => r.source), rows.map((r) => r.adapter ?? null), rows.map((r) => r.received_at), rows.map((r) => r.body)]);
        await c.query("UPDATE workspaces w SET backlog = w.backlog + u.n FROM unnest($1::text[], $2::bigint[]) AS u(id, n) WHERE w.id = u.id", [
          ws,
          ws.map((w) => perWs.get(w)!),
        ]);
        await addEvents(c, perWs, utcDay(rows.at(-1)!.received_at));
        const secrets = rows.map((r) => r.secret_id).filter((id): id is string => !!id);
        if (secrets.length) await Secrets.touch(c, secrets, rows.at(-1)!.received_at);
      });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      for (const p of batch) p.reject(e);
      return;
    } finally {
      for (const [w, n] of perWs) {
        const left = (this.#inflight.get(w) ?? 0) - n;
        if (left > 0) this.#inflight.set(w, left);
        else this.#inflight.delete(w);
      }
    }
    for (const [w, n] of perWs) {
      const b = this.#backlog.get(w);
      if (b) b.n += n;
    }
    for (const p of batch) p.resolve();
  }
}

/**
 * Set each workspace's backlog to its count of 'new' queue rows. The workspace rows are locked
 * first, in id order, and counted after: a commit or parse that changed queue rows but not yet
 * the counter either finishes first (it held the lock) and is counted, or adjusts the counter
 * after this (its queue change wasn't visible yet). Intake and parse change both in one
 * transaction, so the counter stays exact.
 */
export async function reconcileBacklog(db: DB, workspaces?: string[]): Promise<void> {
  const filter = workspaces ? "WHERE id = ANY($1::text[])" : "";
  const args = workspaces ? [workspaces] : [];
  await tx(db, async (c) => {
    await c.query(`SELECT 1 FROM workspaces ${filter} ORDER BY id FOR NO KEY UPDATE`, args);
    await c.query(`UPDATE workspaces SET backlog = (SELECT count(*) FROM queue q WHERE q.workspace_id = workspaces.id AND q.status = 'new') ${filter}`, args);
  });
}
