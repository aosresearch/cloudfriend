import { randomBytes } from "node:crypto";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { tx, type DB } from "./db.ts";
import type { Intake } from "./intake.ts";
import { errMsg, log } from "./log.ts";
import { EVENT_COLUMNS, eventsByIds, getFlagRow, toEvent, toFlag, type EventRow } from "./store.ts";
import type { ActionAdapter, DeciderAdapter, FlagDraft, ParsedEvent, SourceAdapter } from "./types.ts";

export interface WorkerOptions {
  db: DB;
  intake: Intake;
  sources: Map<string, SourceAdapter>;
  /** null: events are stored but nothing decides on them until a decider is configured. */
  decider: { name: string; adapter: DeciderAdapter } | null;
  actions: Map<string, ActionAdapter>;
  env: NodeJS.ProcessEnv;
  batchSize: number;
  batchWaitMs: number;
  deciderConcurrency: number;
  retentionMs: number;
  cleanupIntervalMs: number;
  pollMs: number;
}

const PARSE_CHUNK = 200;
const CLEANUP_CHUNK = 1000;
const DELIVERY_CHUNK = 50;
const DELIVERY_TIMEOUT_MS = 15_000;
export const MAX_DELIVERY_ATTEMPTS = 15;

/** 5s, 10s, 20s, ... capped at 1h. 15 attempts span about six hours. */
export const deliveryBackoff = (attempts: number) => Math.min(5_000 * 2 ** (attempts - 1), 3_600_000);
/** 1s, 2s, 4s, ... capped at 5 min. The decider is retried until it works. */
const deciderBackoff = (failures: number) => Math.min(1_000 * 2 ** (failures - 1), 300_000);

/**
 * Three stages, each durable on its own:
 *   parse:   queue rows 'new'  -> events (decided = 0), queue row 'done'   (one transaction)
 *   decide:  batch of events   -> flags + deliveries, events decided = 1   (one transaction)
 *   deliver: pending deliveries -> action.run(), retried with backoff
 * A crash between stages loses nothing: each stage picks up whatever the last one left.
 */
export class Worker {
  #o: WorkerOptions;
  #timer: NodeJS.Timeout | null = null;
  #cleanupTimer: NodeJS.Timeout | null = null;
  #stopped = false;
  #busy = false;
  #abort = new AbortController();
  /** Event ids currently inside a decide() call. */
  #inflight = new Set<number>();
  #decides = new Set<Promise<void>>();
  #delivering: Promise<number> | null = null;
  #deciderFailures = 0;
  #deciderRetryAt = 0;
  #stmts;

  constructor(opts: WorkerOptions) {
    this.#o = opts;
    const db = opts.db;
    this.#stmts = {
      newRows: db.prepare("SELECT id, source, received_at, body FROM queue WHERE status = 'new' ORDER BY id LIMIT ?"),
      setStatus: db.prepare("UPDATE queue SET status = ? WHERE id = ?"),
      insertEvent: db.prepare(
        "INSERT INTO events (queue_id, source, received_at, data, external_id, type, group_key) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ),
      pending: db.prepare("SELECT id, received_at FROM events WHERE decided = 0 ORDER BY id LIMIT ?"),
      insertFlag: db.prepare(
        "INSERT INTO flags (id, created_at, reason, severity, event_ids, decider) VALUES (?, ?, ?, ?, ?, ?)",
      ),
      insertDelivery: db.prepare(
        "INSERT INTO deliveries (flag_id, action, next_attempt_at, updated_at) VALUES (?, ?, ?, ?)",
      ),
      markDecided: db.prepare("UPDATE events SET decided = 1 WHERE id = ?"),
      dueDeliveries: db.prepare(
        "SELECT flag_id, action, attempts FROM deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?",
      ),
      deliveryOk: db.prepare(
        "UPDATE deliveries SET status = 'ok', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE flag_id = ? AND action = ?",
      ),
      deliveryFail: db.prepare(
        "UPDATE deliveries SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE flag_id = ? AND action = ?",
      ),
      cleanQueue: db.prepare(
        `DELETE FROM queue WHERE id IN (SELECT id FROM queue WHERE status IN ('done', 'failed') AND received_at < ? ORDER BY id LIMIT ${CLEANUP_CHUNK})`,
      ),
      cleanEvents: db.prepare(
        `DELETE FROM events WHERE id IN (SELECT id FROM events WHERE received_at < ? AND decided = 1 ORDER BY received_at LIMIT ${CLEANUP_CHUNK})`,
      ),
    };
  }

  start(): void {
    this.#schedule(0);
    this.#cleanupTimer = setInterval(() => {
      this.cleanup().catch((err) => log.error("cleanup failed", { error: errMsg(err) }));
    }, this.#o.cleanupIntervalMs);
    this.#cleanupTimer.unref();
  }

  /**
   * Stop taking new work and give in-flight decides and deliveries `graceMs` to finish. After
   * that they are aborted and whatever they return is discarded: their events and deliveries
   * are still pending in the database and get picked up after a restart.
   */
  async stop(graceMs = 5_000): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#cleanupTimer) clearInterval(this.#cleanupTimer);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((r) => (timer = setTimeout(r, graceMs)));
    const idle = await Promise.race([this.whenIdle().then(() => true), timeout.then(() => false)]);
    clearTimeout(timer);
    if (!idle) {
      log.warn("shutdown grace period over; abandoning in-flight work (it is retried after restart)", {
        decides: this.#decides.size,
        events: this.#inflight.size,
        delivering: this.#delivering !== null,
      });
    }
    this.#abort.abort(new Error("shutting down"));
  }

  /** Resolves once the decide() calls and delivery pass running right now have finished. */
  async whenIdle(): Promise<void> {
    await Promise.allSettled([...this.#decides, this.#delivering]);
  }

  #schedule(ms: number): void {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#tick(), ms);
  }

  async #tick(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      while (!this.#stopped && this.parseNew() === PARSE_CHUNK) await yieldToLoop();
      if (!this.#stopped) this.startDueBatches();
      if (!this.#stopped && !this.#delivering) {
        this.#delivering = this.deliverDue().finally(() => (this.#delivering = null));
        this.#delivering.catch((err) => log.error("delivery pass failed", { error: errMsg(err) }));
      }
    } catch (err) {
      log.error("worker tick failed", { error: errMsg(err) });
    } finally {
      this.#busy = false;
      this.#schedule(this.#o.pollMs);
    }
  }

  // --- parse ---------------------------------------------------------------

  /** Parse up to one chunk of queued requests into events. Returns how many requests it handled. */
  parseNew(limit = PARSE_CHUNK): number {
    const rows = this.#stmts.newRows.all(limit) as unknown as {
      id: number;
      source: string;
      received_at: number;
      body: Uint8Array;
    }[];
    if (!rows.length) return 0;
    const results = rows.map((row) => {
      const adapter = this.#o.sources.get(row.source) ?? this.#o.sources.get("json")!;
      try {
        const parsed = adapter.parse(row.body, { source: row.source, received_at: new Date(row.received_at) });
        if (!Array.isArray(parsed)) throw new Error("parse() must return an array");
        return { row, events: parsed.map(serialize) };
      } catch (err) {
        log.warn("parse failed; request kept with status 'failed'", {
          queue_id: row.id,
          source: row.source,
          error: errMsg(err),
        });
        return { row, events: null };
      }
    });
    tx(this.#o.db, () => {
      for (const { row, events } of results) {
        for (const e of events ?? []) {
          this.#stmts.insertEvent.run(row.id, row.source, row.received_at, e.data, e.id, e.type, e.group_key);
        }
        this.#stmts.setStatus.run(events ? "done" : "failed", row.id);
      }
    });
    this.#o.intake.release(rows.length);
    return rows.length;
  }

  // --- decide --------------------------------------------------------------

  /** Start decide() calls for every batch that is full or has waited long enough. */
  startDueBatches(now = Date.now()): void {
    if (!this.#o.decider || now < this.#deciderRetryAt) return;
    while (this.#decides.size < this.#o.deciderConcurrency) {
      const rows = this.#stmts.pending.all(this.#o.batchSize + this.#inflight.size) as unknown as {
        id: number;
        received_at: number;
      }[];
      const batch = rows.filter((r) => !this.#inflight.has(r.id)).slice(0, this.#o.batchSize);
      if (!batch.length) return;
      const full = batch.length >= this.#o.batchSize;
      const waited = now - batch[0]!.received_at >= this.#o.batchWaitMs;
      if (!full && !waited) return;
      const ids = batch.map((r) => r.id);
      for (const id of ids) this.#inflight.add(id);
      const p: Promise<void> = this.#decideBatch(ids)
        .catch((err) => log.error("storing decision failed; events stay queued", { error: errMsg(err) }))
        .finally(() => {
          for (const id of ids) this.#inflight.delete(id);
          this.#decides.delete(p);
        });
      this.#decides.add(p);
    }
  }

  async #decideBatch(ids: number[]): Promise<void> {
    const { name, adapter } = this.#o.decider!;
    const rows = this.#o.db
      .prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`)
      .all(...ids) as unknown as EventRow[];
    const events = rows.map(toEvent);
    const started = Date.now();
    let drafts: FlagDraft[];
    try {
      drafts = await adapter.decide(events, { env: this.#o.env, signal: this.#abort.signal });
      if (!Array.isArray(drafts)) throw new Error("decide() must return an array");
      if (this.#abort.signal.aborted) return; // finished after shutdown; decided again after restart
    } catch (err) {
      if (this.#stopped) return; // events stay pending and are decided after restart
      this.#deciderFailures++;
      const wait = deciderBackoff(this.#deciderFailures);
      this.#deciderRetryAt = Date.now() + wait;
      log.error("decider failed; events stay queued", {
        decider: name,
        events: ids.length,
        retry_in_ms: wait,
        error: errMsg(err),
      });
      return;
    }
    this.#deciderFailures = 0;
    const flags = this.#storeDecision(name, ids, drafts);
    log.info("batch decided", { events: ids.length, flags: flags.length, ms: Date.now() - started });
    if (flags.length && !this.#delivering) this.#schedule(0);
  }

  #storeDecision(decider: string, ids: number[], drafts: FlagDraft[]): string[] {
    const inBatch = new Set(ids.map(String));
    const now = Date.now();
    const actions = [...this.#o.actions.keys()];
    const flagIds: string[] = [];
    tx(this.#o.db, () => {
      for (const d of drafts) {
        const eventIds = [...new Set((d.event_ids ?? []).map(String))].filter((id) => inBatch.has(id));
        if (!eventIds.length || typeof d.reason !== "string" || !d.reason.trim()) continue;
        const id = "flg_" + randomBytes(10).toString("hex");
        this.#stmts.insertFlag.run(id, now, d.reason.trim(), d.severity ?? "medium", JSON.stringify(eventIds), decider);
        for (const action of actions) this.#stmts.insertDelivery.run(id, action, now, now);
        flagIds.push(id);
      }
      for (const id of ids) this.#stmts.markDecided.run(id);
    });
    for (const id of flagIds) log.info("flag raised", { flag: id });
    return flagIds;
  }

  // --- deliver -------------------------------------------------------------

  /** Run every delivery that is due. Returns how many were attempted. */
  async deliverDue(now = Date.now()): Promise<number> {
    const due = this.#stmts.dueDeliveries.all(now, DELIVERY_CHUNK) as unknown as {
      flag_id: string;
      action: string;
      attempts: number;
    }[];
    await Promise.all(due.map((d) => this.#deliver(d.flag_id, d.action, d.attempts)));
    return due.length;
  }

  async #deliver(flagId: string, action: string, attempts: number): Promise<void> {
    const row = getFlagRow(this.#o.db, flagId);
    if (!row) return; // flag deleted; its deliveries went with it
    const flag = toFlag(row);
    const adapter = this.#o.actions.get(action);
    let error: string | null = null;
    if (!adapter) {
      error = `action '${action}' is not enabled`;
      attempts = MAX_DELIVERY_ATTEMPTS - 1; // no point retrying
    } else {
      try {
        const events = eventsByIds(this.#o.db, flag.event_ids);
        const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(DELIVERY_TIMEOUT_MS)]);
        const ok = await adapter.run(flag, { events, env: this.#o.env, signal });
        if (ok === false) error = "run() returned false";
      } catch (err) {
        error = errMsg(err);
      }
    }
    if (this.#abort.signal.aborted) return; // finished after shutdown; stays pending, retried after restart
    const now = Date.now();
    if (error === null) {
      this.#stmts.deliveryOk.run(now, flagId, action);
      log.info("action delivered", { flag: flagId, action });
      return;
    }
    const n = attempts + 1;
    const giveUp = n >= MAX_DELIVERY_ATTEMPTS;
    this.#stmts.deliveryFail.run(giveUp ? "failed" : "pending", n, error, now + deliveryBackoff(n), now, flagId, action);
    log.warn(giveUp ? "action failed; giving up" : "action failed; will retry", {
      flag: flagId,
      action,
      attempt: n,
      error,
    });
  }

  // --- cleanup -------------------------------------------------------------

  /** Delete processed requests and decided events older than the retention window, in small chunks. */
  async cleanup(now = Date.now()): Promise<{ queue: number; events: number }> {
    const cutoff = now - this.#o.retentionMs;
    let queue = 0;
    let events = 0;
    for (;;) {
      const n = Number(this.#stmts.cleanQueue.run(cutoff).changes);
      queue += n;
      if (n < CLEANUP_CHUNK || this.#stopped) break;
      await yieldToLoop();
    }
    for (;;) {
      const n = Number(this.#stmts.cleanEvents.run(cutoff).changes);
      events += n;
      if (n < CLEANUP_CHUNK || this.#stopped) break;
      await yieldToLoop();
    }
    if (queue || events) log.info("cleanup", { requests_deleted: queue, events_deleted: events });
    return { queue, events };
  }
}

function serialize(e: ParsedEvent) {
  if (!e || typeof e !== "object" || !("data" in e)) throw new Error("each parsed event needs a `data` field");
  const hint = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 256) : typeof v === "number" ? String(v) : null);
  return {
    data: JSON.stringify(e.data ?? null),
    id: hint(e.id),
    type: hint(e.type),
    group_key: hint(e.group_key),
  };
}
