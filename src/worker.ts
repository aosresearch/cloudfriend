import { randomBytes } from "node:crypto";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { tx, type DB } from "./db.ts";
import type { Intake } from "./intake.ts";
import { errMsg, log } from "./log.ts";
import { EVENT_COLUMNS, eventsByIds, getFlagRow, toEvent, toFlag, type EventRow } from "./store.ts";
import { applyVerdicts, labelProvenance, planBatch, verdictKey, type Outcome, type Pending } from "./triage/cascade.ts";
import type { Triage } from "./triage/runtime.ts";
import { FEATURIZER_VERSION } from "./triage/features.ts";
import { toDecision, type ActionAdapter, type CloudfriendEvent, type DeciderAdapter, type Decision, type FlagDraft, type ParsedEvent, type Severity, type SourceAdapter } from "./types.ts";

export interface WorkerOptions {
  db: DB;
  intake: Intake;
  sources: Map<string, SourceAdapter>;
  /** null: events are stored but nothing decides on them until a decider is configured. */
  decider: { name: string; adapter: DeciderAdapter } | null;
  actions: Map<string, ActionAdapter>;
  /** null: every event goes to the decider as in v0, with no classifier, grouping or labels. */
  triage?: Triage | null;
  env: NodeJS.ProcessEnv;
  batchSize: number;
  batchWaitMs: number;
  /** How long a batch of only audit samples may wait for company. */
  auditWaitMs?: number;
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
  /** Since start: decider calls, examples asked, events settled by a cached verdict. */
  readonly counters = { deciderCalls: 0, asked: 0, cached: 0, direct: 0 };
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
        "INSERT INTO events (queue_id, source, received_at, data, external_id, type, group_key, score, route, template, features, user_key, decided, severity, shadow_score, shadow_route) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ),
      pending: db.prepare("SELECT id, received_at, route FROM events WHERE decided = 0 ORDER BY id LIMIT ?"),
      insertFlag: db.prepare(
        "INSERT INTO flags (id, created_at, reason, severity, event_ids, decider, status, updated_at, event_count, users) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)",
      ),
      attachToFlag: db.prepare(
        "UPDATE flags SET event_ids = ?, event_count = coalesce(event_count, 0) + ?, updated_at = ? WHERE id = ?",
      ),
      insertLabel: db.prepare(
        `INSERT INTO labels (event_id, y, source, route, score, features, featurizer_version, event_source, received_at, data, created_at, template, provenance, weight, decision_id)
         SELECT id, ?, 'jev', route, score, features, ${FEATURIZER_VERSION}, source, received_at, data, ?, template, ?, ?, ? FROM events WHERE id = ? AND features IS NOT NULL
         ON CONFLICT(event_id) DO UPDATE SET y = excluded.y, created_at = excluded.created_at, provenance = excluded.provenance,
           weight = excluded.weight, decision_id = excluded.decision_id WHERE labels.source <> 'human'`,
      ),
      insertDecisionRecord: db.prepare(
        "INSERT INTO decisions (id, created_at, decider, model, prompt, response, event_ids) VALUES (?, ?, ?, ?, ?, ?, ?)",
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
      this.saveTriageState();
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
    this.saveTriageState();
  }

  /** Persist the featurizer's history so a restart doesn't make every template look new. */
  saveTriageState(): void {
    try {
      this.#o.triage?.saveState();
    } catch (err) {
      log.warn("saving triage state failed", { error: errMsg(err) });
    }
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
    const triage = this.#o.triage;
    // Without a classifier or a decider there is nothing to route to: events wait, as in v0.
    const routing = triage && (triage.classifier || this.#o.decider);
    tx(this.#o.db, () => {
      for (const { row, events } of results) {
        for (const e of events ?? []) {
          if (!triage) {
            this.#stmts.insertEvent.run(row.id, row.source, row.received_at, e.data, e.id, e.type, e.group_key, null, null, null, null, null, 0, null, null, null);
            continue;
          }
          const t = triage.score(row.source, row.received_at, e.parsed);
          const route = routing ? t.route : null;
          this.#stmts.insertEvent.run(
            row.id, row.source, row.received_at, e.data, e.id, e.type, e.group_key,
            t.score, route, t.template, t.features, t.user, route === "drop" ? 1 : 0, t.severity, t.shadowScore, t.shadowRoute,
          );
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
    if (!(this.#o.decider || this.#o.triage?.classifier) || now < this.#deciderRetryAt) return;
    while (this.#decides.size < this.#o.deciderConcurrency) {
      const rows = this.#stmts.pending.all(this.#o.batchSize + this.#inflight.size) as unknown as {
        id: number;
        received_at: number;
        route: string | null;
      }[];
      const batch = rows.filter((r) => !this.#inflight.has(r.id)).slice(0, this.#o.batchSize);
      if (!batch.length) return;
      const full = batch.length >= this.#o.batchSize;
      // Audit samples aren't urgent: they wait for other events, or for auditWaitMs.
      const urgent = batch.find((r) => r.route !== "audit");
      const waited = urgent
        ? now - urgent.received_at >= this.#o.batchWaitMs
        : now - batch[0]!.received_at >= (this.#o.auditWaitMs ?? this.#o.batchWaitMs);
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
    if (this.#o.triage) return this.#triageBatch(ids, this.#o.triage);
    const { name, adapter } = this.#o.decider!;
    const rows = this.#o.db
      .prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`)
      .all(...ids) as unknown as EventRow[];
    const events = rows.map(toEvent);
    const started = Date.now();
    let drafts: FlagDraft[];
    try {
      drafts = toDecision(await adapter.decide(events, { env: this.#o.env, signal: this.#abort.signal })).flags;
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

  /**
   * The cascade: events routed past the classifier are grouped by template, cached verdicts
   * are reused, and only the remaining examples go to the decider (Jev). Its verdicts become
   * flags, cache entries and training labels, all stored in one transaction.
   */
  async #triageBatch(ids: number[], triage: Triage): Promise<void> {
    const db = this.#o.db;
    const rows = db
      .prepare(`SELECT ${EVENT_COLUMNS}, template, severity FROM events WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`)
      .all(...ids) as unknown as (EventRow & { template: string | null; severity: string | null })[];
    const decider = this.#o.decider;
    const threshold = triage.classifier?.file.threshold ?? 0.5;
    const now = Date.now();
    const items: Pending[] = rows.map((r) => {
      let route = (r.route ?? "jev") as Pending["route"];
      // Routed to Jev while one was configured, but there is none now: the classifier decides.
      if (!decider && (route === "jev" || route === "audit" || route === "novel" || route === "known" || route === "auto")) route = (r.score ?? 0) >= threshold ? "classifier" : "drop";
      const template = r.template ?? `${r.source}|`;
      return { id: String(r.id), template, score: r.score ?? null, route, severity: r.severity ?? undefined, rate: triage.featurizer.context(template)?.last_1m };
    });
    // A cached "escalate" verdict only holds while its flag is still in the queue.
    for (const it of items) {
      const v = triage.cache.get(verdictKey(it), now);
      if (v?.flagId && !this.#flagOpen(v.flagId)) triage.cache.delete(verdictKey(it));
    }
    const plan = planBatch(items, triage.cache, now, triage.opts.perTemplate);
    let decision: Decision = { flags: [] };
    let decisionId: string | null = null;
    const started = Date.now();
    if (plan.ask.length && decider) {
      const byId = new Map(rows.map((r) => [String(r.id), r]));
      const events: CloudfriendEvent[] = plan.ask.map(({ item, similar }) => ({
        ...toEvent(byId.get(item.id)!),
        triage: { score: item.score ?? 0, similar, context: triage.featurizer.context(item.template) },
      }));
      const openFlags = (db
        .prepare("SELECT id, reason, severity FROM flags WHERE coalesce(status, 'open') IN ('open', 'acknowledged') ORDER BY coalesce(updated_at, created_at) DESC LIMIT 20")
        .all() as { id: string; reason: string; severity: Severity }[]);
      try {
        decision = toDecision(await decider.adapter.decide(events, { env: this.#o.env, signal: this.#abort.signal, openFlags }));
        if (this.#abort.signal.aborted) return;
      } catch (err) {
        if (this.#stopped) return;
        this.#deciderFailures++;
        const wait = deciderBackoff(this.#deciderFailures);
        this.#deciderRetryAt = Date.now() + wait;
        log.error("decider failed; events stay queued", { decider: decider.name, events: events.length, retry_in_ms: wait, error: errMsg(err) });
        return;
      }
      this.#deciderFailures = 0;
      this.counters.deciderCalls++;
      this.counters.asked += plan.ask.length;
      decisionId = "dec_" + randomBytes(8).toString("hex");
      this.#stmts.insertDecisionRecord.run(
        decisionId, now, decider.name, decision.record?.model ?? null, decision.record?.prompt ?? null,
        decision.record?.response ?? JSON.stringify({ flags: decision.flags, judgments: decision.judgments }), JSON.stringify(events.map((e) => e.id)),
      );
    }
    this.counters.cached += plan.cached.length;
    for (const g of plan.direct.values()) this.counters.direct += g.length;
    const out = applyVerdicts(plan, decision);
    const flagIds = this.#storeOutcome(decider?.name ?? "classifier", ids, out, rows.map((r) => [String(r.id), r.user_key ?? null]), decisionId, triage);
    const rateOf = new Map(items.map((it) => [verdictKey(it), it.rate]));
    out.verdicts.forEach((v, key) => {
      const flagId = typeof v.flag === "number" ? flagIds[v.flag] : v.flag;
      triage.cache.set(key, v.escalate, now, flagId, rateOf.get(key));
    });
    // What Jev escalated or judged relevant keeps reaching Jev, even where the classifier would drop it.
    for (const f of out.flags) if (f.via === "decider") for (const t of f.templates) triage.escalated.add(t, now);
    for (const t of out.relevant) triage.escalated.add(t, now);
    log.info("batch decided", {
      events: ids.length,
      asked: plan.ask.length,
      cached: plan.cached.length,
      labels: out.labels.length,
      flags: flagIds.length,
      ms: Date.now() - started,
    });
    if (flagIds.length && !this.#delivering) this.#schedule(0);
  }

  #flagOpen(id: string): boolean {
    const row = this.#o.db.prepare("SELECT status FROM flags WHERE id = ?").get(id) as { status: string } | undefined;
    return row?.status === "open" || row?.status === "acknowledged";
  }

  #storeOutcome(decider: string, ids: number[], out: Outcome, users: [string, string | null][], decisionId: string | null, triage: Triage): string[] {
    const now = Date.now();
    const actions = [...this.#o.actions.keys()];
    const userOf = new Map(users);
    const flagIds: string[] = [];
    tx(this.#o.db, () => {
      for (const f of out.flags) {
        const id = "flg_" + randomBytes(10).toString("hex");
        const linked = [...new Set(f.event_ids.map((e) => userOf.get(e)).filter(Boolean))].slice(0, 20);
        this.#stmts.insertFlag.run(
          id, now, f.reason.trim(), f.severity ?? "medium", JSON.stringify(f.event_ids.slice(0, 1000)),
          f.via === "classifier" ? "classifier" : decider, now, f.event_ids.length, linked.length ? JSON.stringify(linked) : null,
        );
        for (const action of actions) this.#stmts.insertDelivery.run(id, action, now, now);
        flagIds.push(id);
      }
      for (const [flagId, evs] of out.attach) {
        const row = getFlagRow(this.#o.db, flagId);
        if (!row) continue;
        const merged = [...new Set([...(JSON.parse(row.event_ids) as string[]), ...evs])].slice(0, 1000);
        this.#stmts.attachToFlag.run(JSON.stringify(merged), evs.length, now, flagId);
      }
      for (const l of out.labels) {
        const p = labelProvenance(l, triage.opts.auditRate);
        this.#stmts.insertLabel.run(l.y, now, p.provenance, p.weight, decisionId, Number(l.id));
      }
      for (const id of ids) this.#stmts.markDecided.run(id);
    });
    for (const id of flagIds) log.info("flag raised", { flag: id });
    return flagIds;
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
        this.#stmts.insertFlag.run(id, now, d.reason.trim(), d.severity ?? "medium", JSON.stringify(eventIds), decider, now, eventIds.length, null);
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
    parsed: e.data ?? null,
    data: JSON.stringify(e.data ?? null),
    id: hint(e.id),
    type: hint(e.type),
    group_key: hint(e.group_key),
  };
}
