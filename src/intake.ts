import { one, tx, type DB } from "./db.ts";
import { Secrets } from "./secrets.ts";

export interface IntakeRow {
  workspace_id: string;
  source: string;
  received_at: number;
  body: Uint8Array;
  /** The source adapter that parses the row (the source's kind), or null for legacy rows. */
  adapter?: string | null;
  /** The ingest secret used, or null for rows the server queues itself (the dashboard's test event). */
  secret_id: string | null;
}

interface Pending {
  row: IntakeRow;
  resolve: () => void;
  reject: (err: Error) => void;
}

export class QueueFullError extends Error {}

const INSERT = `INSERT INTO queue (workspace_id, source, received_at, body, adapter)
  SELECT w, s, t, b, a FROM unnest($1::text[], $2::text[], $3::bigint[], $4::bytea[], $5::text[]) WITH ORDINALITY AS r(w, s, t, b, a, n) ORDER BY n`;

/**
 * Group-commit writer. Requests that arrive within one commit window are inserted with one
 * multi-row INSERT in one transaction, so one commit (one WAL flush) covers the whole batch.
 * Each `append` resolves only after the commit that included its row, which is when the
 * caller may reply 202. A batch is committed or rejected as a whole.
 */
export class Intake {
  #db: DB;
  #windowMs: number;
  #maxQueue: number;
  #pending: Pending[] = [];
  #timer: NodeJS.Timeout | null = null;
  /** Commits under way, so shutdown can wait for them. */
  #commits = new Set<Promise<void>>();
  /** Rows in a commit that hasn't finished yet. They count toward the queue limit. */
  #writing = 0;
  /** Rows with status 'new'. Kept in memory so backpressure costs nothing per request. */
  #backlog: number;

  private constructor(db: DB, backlog: number, opts: { windowMs: number; maxQueue: number }) {
    this.#db = db;
    this.#windowMs = opts.windowMs;
    this.#maxQueue = opts.maxQueue;
    this.#backlog = backlog;
  }

  /** Starts from the number of rows still waiting to be parsed. */
  static async open(db: DB, opts: { windowMs: number; maxQueue: number }): Promise<Intake> {
    const { n } = (await one<{ n: number }>(db, "SELECT count(*) AS n FROM queue WHERE status = 'new'"))!;
    return new Intake(db, n, opts);
  }

  get backlog(): number {
    return this.#backlog;
  }

  /** The worker calls this after it moves rows out of 'new'. */
  release(n: number): void {
    this.#backlog = Math.max(0, this.#backlog - n);
  }

  append(row: IntakeRow): Promise<void> {
    if (this.#backlog + this.#writing + this.#pending.length >= this.#maxQueue) {
      return Promise.reject(new QueueFullError("queue is full"));
    }
    return new Promise<void>((resolve, reject) => {
      this.#pending.push({ row, resolve, reject });
      this.#timer ??= setTimeout(() => void this.flush(), this.#windowMs);
    });
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
    this.#writing += batch.length;
    try {
      const rows = batch.map((p) => p.row);
      await tx(this.#db, async (c) => {
        await c.query(INSERT, [rows.map((r) => r.workspace_id), rows.map((r) => r.source), rows.map((r) => r.received_at), rows.map((r) => r.body), rows.map((r) => r.adapter ?? null)]);
        await Secrets.touch(c, rows.map((r) => r.secret_id), rows.at(-1)!.received_at);
      });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      for (const p of batch) p.reject(e);
      return;
    } finally {
      this.#writing -= batch.length;
    }
    this.#backlog += batch.length;
    for (const p of batch) p.resolve();
  }
}
