import { tx, type DB } from "./db.ts";
import type { Secrets } from "./secrets.ts";

export interface IntakeRow {
  source: string;
  received_at: number;
  body: Uint8Array;
  secret_id: string;
}

interface Pending {
  row: IntakeRow;
  resolve: () => void;
  reject: (err: Error) => void;
}

export class QueueFullError extends Error {}

/**
 * Group-commit writer. Requests that arrive within one commit window are inserted in a
 * single transaction, so one fsync covers the whole batch. Each `append` resolves only
 * after the commit that included its row, which is when the caller may reply 202.
 */
export class Intake {
  #db: DB;
  #secrets: Secrets;
  #windowMs: number;
  #maxQueue: number;
  #insert;
  #pending: Pending[] = [];
  #timer: NodeJS.Timeout | null = null;
  /** Rows with status 'new'. Kept in memory so backpressure costs nothing per request. */
  #backlog: number;

  constructor(db: DB, secrets: Secrets, opts: { windowMs: number; maxQueue: number }) {
    this.#db = db;
    this.#secrets = secrets;
    this.#windowMs = opts.windowMs;
    this.#maxQueue = opts.maxQueue;
    this.#insert = db.prepare("INSERT INTO queue (source, received_at, body) VALUES (?, ?, ?)");
    this.#backlog = (db.prepare("SELECT count(*) AS n FROM queue WHERE status = 'new'").get() as { n: number }).n;
  }

  get backlog(): number {
    return this.#backlog;
  }

  /** The worker calls this after it moves rows out of 'new'. */
  release(n: number): void {
    this.#backlog = Math.max(0, this.#backlog - n);
  }

  append(row: IntakeRow): Promise<void> {
    if (this.#backlog + this.#pending.length >= this.#maxQueue) {
      return Promise.reject(new QueueFullError("queue is full"));
    }
    return new Promise<void>((resolve, reject) => {
      this.#pending.push({ row, resolve, reject });
      this.#timer ??= setTimeout(() => this.flush(), this.#windowMs);
    });
  }

  /** Commit everything collected so far. Also called on shutdown. */
  flush(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const batch = this.#pending.splice(0);
    if (!batch.length) return;
    try {
      tx(this.#db, () => {
        for (const { row } of batch) this.#insert.run(row.source, row.received_at, row.body);
        this.#secrets.touch(new Set(batch.map((p) => p.row.secret_id)), batch.at(-1)!.row.received_at);
      });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      for (const p of batch) p.reject(e);
      return;
    }
    this.#backlog += batch.length;
    for (const p of batch) p.resolve();
  }
}
