import { randomBytes } from "node:crypto";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { all, DEFAULT_WORKSPACE, pgText, run, tx, type DB, type Queryable } from "./db.ts";
import type { Intake } from "./intake.ts";
import { errMsg, log } from "./log.ts";
import { EVENT_COLUMNS, eventsByIds, getFlagRow, toEvent, toFlag, type EventRow } from "./store.ts";
import { applyVerdicts, labelProvenance, planBatch, verdictKey, type Outcome, type Pending } from "./triage/cascade.ts";
import type { Triage } from "./triage/runtime.ts";
import { toDecision, type ActionAdapter, type CloudfriendEvent, type DeciderAdapter, type Decision, type FlagDraft, type ParsedEvent, type Severity, type SourceAdapter } from "./types.ts";

export interface WorkerOptions {
  db: DB;
  /** The workspace whose queue this worker drains. */
  workspace?: string;
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
/**
 * A claimed delivery is not due again for this long, so no other claimer runs it meanwhile.
 * Longer than a run may take; if the process dies mid-run, the delivery is retried after it.
 */
const DELIVERY_CLAIM_MS = DELIVERY_TIMEOUT_MS + 45_000;
export const MAX_DELIVERY_ATTEMPTS = 15;

/** 5s, 10s, 20s, ... capped at 1h. 15 attempts span about six hours. */
export const deliveryBackoff = (attempts: number) => Math.min(5_000 * 2 ** (attempts - 1), 3_600_000);
/** 1s, 2s, 4s, ... capped at 5 min. The decider is retried until it works. */
const deciderBackoff = (failures: number) => Math.min(1_000 * 2 ** (failures - 1), 300_000);

const INSERT_EVENTS = `INSERT INTO events (workspace_id, queue_id, source, received_at, data, external_id, type, group_key, score, route, template, features, user_key, decided, severity, shadow_score, shadow_route, shadow_model, fv)
  SELECT $1::text, q, s, t, d, x, ty, g, sc, r, tpl, f, u, dec, sev, ssc, sr, sm, fv
  FROM unnest($2::bigint[], $3::text[], $4::bigint[], $5::text[], $6::text[], $7::text[], $8::text[], $9::float8[], $10::text[], $11::text[], $12::bytea[], $13::text[], $14::boolean[], $15::text[], $16::float8[], $17::text[], $18::text[], $19::integer[])
    WITH ORDINALITY AS e(q, s, t, d, x, ty, g, sc, r, tpl, f, u, dec, sev, ssc, sr, sm, fv, n)
  ORDER BY n`;

const INSERT_FLAG = `INSERT INTO flags (id, workspace_id, created_at, reason, severity, event_ids, decider, status, updated_at, event_count, users)
  VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $10)`;

const INSERT_DELIVERIES = `INSERT INTO deliveries (flag_id, workspace_id, action, next_attempt_at, updated_at)
  SELECT $1, $2, a, $3, $3 FROM unnest($4::text[]) AS a`;

/** $1 y, $2 created_at, $3 provenance, $4 weight, $5 decision id, $6 rate, $7 service errors, $8 workspace, $9 event id. */
const INSERT_LABEL = `INSERT INTO labels (workspace_id, event_id, y, source, route, score, features, featurizer_version, event_source, received_at, data, created_at, template, provenance, weight, decision_id, severity, ctx_rate, ctx_service_errors)
  SELECT workspace_id, id, $1::integer, 'jev', route, score, features, coalesce(fv, 2), source, received_at, data, $2::bigint, template, $3::text, $4::float8, $5::text, severity, $6::float8, $7::float8
  FROM events WHERE workspace_id = $8 AND id = $9 AND features IS NOT NULL
  ON CONFLICT (workspace_id, event_id) DO UPDATE SET y = excluded.y, created_at = excluded.created_at, provenance = excluded.provenance,
    weight = excluded.weight, decision_id = excluded.decision_id, ctx_rate = excluded.ctx_rate, ctx_service_errors = excluded.ctx_service_errors
    WHERE labels.source <> 'human'`;

interface Claimed {
  flag_id: string;
  action: string;
  attempts: number;
  /** When it was due before the claim, to hand it back unchanged on shutdown. */
  was_due: number;
  claimed_until: number;
}

/**
 * Three stages, each durable on its own:
 *   parse:   queue rows 'new'  -> events (not decided), queue row 'done'   (one transaction)
 *   decide:  batch of events   -> flags + deliveries, events decided       (one transaction)
 *   deliver: pending deliveries -> claimed, action.run(), retried with backoff
 * A crash between stages loses nothing: each stage picks up whatever the last one left. No
 * stage waits on the network inside a transaction.
 */
export class Worker {
  #o: WorkerOptions;
  #db: DB;
  #ws: string;
  #timer: NodeJS.Timeout | null = null;
  #cleanupTimer: NodeJS.Timeout | null = null;
  /** Ticks only run after start(); tests drive the stages by hand before that. */
  #started = false;
  #stopped = false;
  #ticking: Promise<void> | null = null;
  #cleaning: Promise<unknown> | null = null;
  #abort = new AbortController();
  /** Event ids currently inside a decide() call. */
  #inflight = new Set<number>();
  #decides = new Set<Promise<void>>();
  /** startDueBatches runs one at a time, so two never pick the same events (see #startDueBatches). */
  #starting: Promise<void> = Promise.resolve();
  #delivering: Promise<number> | null = null;
  /** Since start: decider calls, examples asked, events settled by a cached verdict. */
  readonly counters = { deciderCalls: 0, asked: 0, cached: 0, direct: 0 };
  #deciderFailures = 0;
  #deciderRetryAt = 0;

  constructor(opts: WorkerOptions) {
    this.#o = opts;
    this.#db = opts.db;
    this.#ws = opts.workspace ?? DEFAULT_WORKSPACE;
  }

  start(): void {
    this.#started = true;
    this.#schedule(0);
    this.#cleanupTimer = setInterval(() => {
      this.#cleaning ??= Promise.all([
        this.cleanup().catch((err) => log.error("cleanup failed", { error: errMsg(err) })),
        this.saveTriageState(),
      ]).finally(() => (this.#cleaning = null));
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
    // Aborted deliveries hand their claims back, so the next start retries them at once.
    // Decides need nothing: their events were never marked decided.
    await Promise.race([
      Promise.allSettled([this.#ticking, this.#cleaning, this.#delivering]),
      new Promise((r) => setTimeout(r, 1_000).unref()),
    ]);
    await this.saveTriageState();
  }

  /** Persist the featurizer's history so a restart doesn't make every template look new. */
  async saveTriageState(): Promise<void> {
    try {
      await this.#o.triage?.saveState();
    } catch (err) {
      log.warn("saving triage state failed", { error: errMsg(err) });
    }
  }

  /** Resolves once the decide() calls and delivery pass running right now have finished. */
  async whenIdle(): Promise<void> {
    await Promise.allSettled([...this.#decides, this.#delivering]);
  }

  #schedule(ms: number): void {
    if (!this.#started || this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#ticking ??= this.#tick().finally(() => {
        this.#ticking = null;
        this.#schedule(this.#o.pollMs);
      });
    }, ms);
  }

  async #tick(): Promise<void> {
    try {
      while (!this.#stopped && (await this.parseNew()) === PARSE_CHUNK) await yieldToLoop();
      if (!this.#stopped) await this.startDueBatches();
      if (!this.#stopped && !this.#delivering) {
        this.#delivering = this.deliverDue().finally(() => (this.#delivering = null));
        this.#delivering.catch((err) => log.error("delivery pass failed", { error: errMsg(err) }));
      }
    } catch (err) {
      log.error("worker tick failed", { error: errMsg(err) });
    }
  }

  // --- parse ---------------------------------------------------------------

  /**
   * Parse up to one chunk of queued requests into events. Returns how many requests it
   * handled. The rows are locked (SKIP LOCKED) for the one transaction that parses, scores
   * and stores them, so no other parser can take the same rows.
   */
  async parseNew(limit = PARSE_CHUNK): Promise<number> {
    const n = await tx(this.#db, async (c) => {
      const rows = await all<{ id: number; source: string; received_at: number; body: Uint8Array }>(
        c,
        "SELECT id, source, received_at, body FROM queue WHERE workspace_id = $1 AND status = 'new' ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED",
        [this.#ws, limit],
      );
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
      const cols: unknown[][] = Array.from({ length: 18 }, () => []);
      const add = (...values: unknown[]) => values.forEach((v, i) => cols[i]!.push(v));
      for (const { row, events } of results) {
        for (const e of events ?? []) {
          if (!triage) {
            add(row.id, row.source, row.received_at, e.data, e.id, e.type, e.group_key, null, null, null, null, null, false, null, null, null, null, null);
            continue;
          }
          const t = triage.score(row.source, row.received_at, e.parsed);
          const route = routing ? t.route : null;
          add(
            row.id, row.source, row.received_at, e.data, e.id, e.type, e.group_key,
            t.score, route, pgText(t.template), t.features, pgText(t.user), route === "drop", t.severity, t.shadowScore, t.shadowRoute, t.shadowModel, triage.featurizer.version,
          );
        }
      }
      if (cols[0]!.length) await c.query(INSERT_EVENTS, [this.#ws, ...cols]);
      await c.query("UPDATE queue SET status = u.status FROM unnest($1::bigint[], $2::text[]) AS u(id, status) WHERE queue.id = u.id", [
        results.map((r) => r.row.id),
        results.map((r) => (r.events ? "done" : "failed")),
      ]);
      return rows.length;
    });
    this.#o.intake.release(n);
    return n;
  }

  // --- decide --------------------------------------------------------------

  /** Start decide() calls for every batch that is full or has waited long enough. */
  startDueBatches(now = Date.now()): Promise<void> {
    const next = this.#starting.then(() => this.#startDueBatches(now));
    this.#starting = next.catch(() => {});
    return next;
  }

  async #startDueBatches(now: number): Promise<void> {
    if (!(this.#o.decider || this.#o.triage?.classifier)) return;
    // The retry time is checked each round: a decide started in an earlier round may have failed meanwhile.
    while (!this.#stopped && this.#decides.size < this.#o.deciderConcurrency && now >= this.#deciderRetryAt) {
      const rows = await all<{ id: number; received_at: number; route: string | null }>(
        this.#db,
        "SELECT id, received_at, route FROM events WHERE workspace_id = $1 AND NOT decided ORDER BY id LIMIT $2",
        [this.#ws, this.#o.batchSize + this.#inflight.size],
      );
      const batch = rows.filter((r) => !this.#inflight.has(r.id)).slice(0, this.#o.batchSize);
      if (!batch.length || this.#stopped) return;
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
          this.#decides.delete(p);
          // Queued behind startDueBatches: a query for pending events that is already under way
          // may have read these before they were marked decided, and must still skip them.
          this.#starting = this.#starting.then(() => {
            for (const id of ids) this.#inflight.delete(id);
          });
        });
      this.#decides.add(p);
    }
  }

  async #decideBatch(ids: number[]): Promise<void> {
    if (this.#o.triage) return this.#triageBatch(ids, this.#o.triage);
    const { name, adapter } = this.#o.decider!;
    const rows = await all<EventRow>(this.#db, `SELECT ${EVENT_COLUMNS} FROM events WHERE workspace_id = $1 AND id = ANY($2::bigint[]) ORDER BY id`, [this.#ws, ids]);
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
    const flags = await this.#storeDecision(name, ids, drafts);
    log.info("batch decided", { events: ids.length, flags: flags.length, ms: Date.now() - started });
    if (flags.length && !this.#delivering) this.#schedule(0);
  }

  /**
   * The cascade: events routed past the classifier are grouped by template, cached verdicts
   * are reused, and only the remaining examples go to the decider (Jev). Its verdicts become
   * flags, cache entries and training labels, all stored in one transaction.
   */
  async #triageBatch(ids: number[], triage: Triage): Promise<void> {
    const db = this.#db;
    const rows = await all<EventRow & { template: string | null; severity: string | null }>(
      db,
      `SELECT ${EVENT_COLUMNS}, template, severity FROM events WHERE workspace_id = $1 AND id = ANY($2::bigint[]) ORDER BY id`,
      [this.#ws, ids],
    );
    const decider = this.#o.decider;
    const threshold = triage.classifier?.file.threshold ?? 0.5;
    const now = Date.now();
    const items: Pending[] = rows.map((r) => {
      let route = (r.route ?? "jev") as Pending["route"];
      // Routed to Jev while one was configured, but there is none now: the classifier decides.
      if (!decider && (route === "jev" || route === "audit" || route === "novel" || route === "known" || route === "review" || route === "auto")) route = (r.score ?? 0) >= threshold ? "classifier" : "drop";
      const template = r.template ?? `${r.source}|`;
      const ctx = triage.featurizer.context(template);
      return { id: String(r.id), template, score: r.score ?? null, route, severity: r.severity ?? undefined, rate: ctx?.last_1m, serviceErrors: ctx?.service_errors_10m };
    });
    // A cached "escalate" verdict only holds while its flag is still in the queue.
    const cachedFlags = items.map((it) => triage.cache.get(verdictKey(it), now)?.flagId).filter((id): id is string => !!id);
    const open = await this.#openFlags(cachedFlags);
    for (const it of items) {
      const v = triage.cache.get(verdictKey(it), now);
      if (v?.flagId && !open.has(v.flagId)) triage.cache.delete(verdictKey(it));
    }
    const plan = planBatch(items, triage.cache, now, triage.opts.perTemplate);
    let decision: Decision = { flags: [] };
    let decisionId: string | null = null;
    let record: unknown[] | null = null;
    const started = Date.now();
    if (plan.ask.length && decider) {
      const byId = new Map(rows.map((r) => [String(r.id), r]));
      const events: CloudfriendEvent[] = plan.ask.map(({ item, similar }) => ({
        ...toEvent(byId.get(item.id)!),
        triage: { score: item.score ?? 0, similar, context: triage.featurizer.context(item.template) },
      }));
      const openFlags = await all<{ id: string; reason: string; severity: Severity }>(
        db,
        "SELECT id, reason, severity FROM flags WHERE workspace_id = $1 AND status IN ('open', 'acknowledged') ORDER BY coalesce(updated_at, created_at) DESC LIMIT 20",
        [this.#ws],
      );
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
      record = [
        decisionId, this.#ws, now, decider.name, pgText(decision.record?.model ?? null), pgText(decision.record?.prompt ?? null),
        pgText(decision.record?.response ?? JSON.stringify({ flags: decision.flags, judgments: decision.judgments })), JSON.stringify(events.map((e) => e.id)),
      ];
    }
    this.counters.cached += plan.cached.length;
    for (const g of plan.direct.values()) this.counters.direct += g.length;
    // An alert may only continue a flag that is still open now, after the call: one deleted or
    // closed meanwhile (or an id the decider made up) gets a new flag instead.
    const updates = await this.#openFlags(decision.flags.map((f) => f.update).filter((id): id is string => typeof id === "string"));
    for (const f of decision.flags) if (f.update && !updates.has(f.update)) delete f.update;
    const out = applyVerdicts(plan, decision);
    const flagIds = await this.#storeOutcome(decider?.name ?? "classifier", ids, out, rows.map((r) => [String(r.id), r.user_key ?? null]), decisionId, record, triage, items);
    // Verdict cache, escalation memory and earned suppression: what Jev judged relevant keeps
    // reaching it, and what it judged benign may now be dropped by the classifier.
    triage.routing.learn(items, out, now, flagIds);
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

  /** Which of these flags are still in the queue (open or acknowledged). */
  async #openFlags(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await all<{ id: string }>(
      this.#db,
      "SELECT id FROM flags WHERE workspace_id = $1 AND id = ANY($2::text[]) AND status IN ('open', 'acknowledged')",
      [this.#ws, [...new Set(ids)]],
    );
    return new Set(rows.map((r) => r.id));
  }

  /** A new flag and one pending delivery per action. `eventCount` may exceed the ids kept. */
  async #insertFlag(c: Queryable, id: string, now: number, reason: string, severity: string, eventIds: string[], eventCount: number, decider: string, users: string[] | null): Promise<void> {
    await c.query(INSERT_FLAG, [id, this.#ws, now, pgText(reason), severity, JSON.stringify(eventIds), pgText(decider), now, eventCount, users ? JSON.stringify(users) : null]);
    const actions = [...this.#o.actions.keys()];
    if (actions.length) await c.query(INSERT_DELIVERIES, [id, this.#ws, now, actions]);
  }

  async #storeOutcome(
    decider: string,
    ids: number[],
    out: Outcome,
    users: [string, string | null][],
    decisionId: string | null,
    record: unknown[] | null,
    triage: Triage,
    items: Pending[] = [],
  ): Promise<string[]> {
    const ctxOf = new Map(items.map((it) => [it.id, it]));
    const now = Date.now();
    const userOf = new Map(users);
    const flagIds: string[] = [];
    await tx(this.#db, async (c) => {
      if (record) await c.query("INSERT INTO decisions (id, workspace_id, created_at, decider, model, prompt, response, event_ids) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", record);
      for (const f of out.flags) {
        const id = "flg_" + randomBytes(10).toString("hex");
        const linked = [...new Set(f.event_ids.map((e) => userOf.get(e)).filter((u): u is string => !!u))].slice(0, 20);
        await this.#insertFlag(
          c, id, now, f.reason.trim(), f.severity ?? "medium", f.event_ids.slice(0, 1000), f.event_ids.length,
          f.via === "classifier" ? "classifier" : decider, linked.length ? linked : null,
        );
        flagIds.push(id);
      }
      for (const [flagId, evs] of out.attach) {
        // Locked: two batches may add to the same flag at once.
        const row = await getFlagRow(c, this.#ws, flagId, true);
        if (!row) continue;
        const merged = [...new Set([...row.event_ids, ...evs])].slice(0, 1000);
        await c.query("UPDATE flags SET event_ids = $1, event_count = coalesce(event_count, 0) + $2, updated_at = $3 WHERE id = $4", [JSON.stringify(merged), evs.length, now, flagId]);
      }
      for (const l of out.labels) {
        const p = labelProvenance(l, triage.opts.auditRate);
        const ctx = ctxOf.get(l.id);
        await c.query(INSERT_LABEL, [l.y, now, p.provenance, p.weight, decisionId, ctx?.rate ?? null, ctx?.serviceErrors ?? null, this.#ws, Number(l.id)]);
      }
      await c.query("UPDATE events SET decided = true WHERE workspace_id = $1 AND id = ANY($2::bigint[])", [this.#ws, ids]);
    });
    for (const id of flagIds) log.info("flag raised", { flag: id });
    return flagIds;
  }

  async #storeDecision(decider: string, ids: number[], drafts: FlagDraft[]): Promise<string[]> {
    const inBatch = new Set(ids.map(String));
    const now = Date.now();
    const flagIds: string[] = [];
    await tx(this.#db, async (c) => {
      for (const d of drafts) {
        const eventIds = [...new Set((d.event_ids ?? []).map(String))].filter((id) => inBatch.has(id));
        if (!eventIds.length || typeof d.reason !== "string" || !d.reason.trim()) continue;
        const id = "flg_" + randomBytes(10).toString("hex");
        await this.#insertFlag(c, id, now, d.reason.trim(), d.severity ?? "medium", eventIds, eventIds.length, decider, null);
        flagIds.push(id);
      }
      await c.query("UPDATE events SET decided = true WHERE workspace_id = $1 AND id = ANY($2::bigint[])", [this.#ws, ids]);
    });
    for (const id of flagIds) log.info("flag raised", { flag: id });
    return flagIds;
  }

  // --- deliver -------------------------------------------------------------

  /**
   * Claim up to `limit` due deliveries. Rows another claimer has locked are skipped, and a
   * claimed row's next_attempt_at moves forward by DELIVERY_CLAIM_MS, so once this commits no
   * one else finds it due: each delivery runs once per attempt, with no transaction held
   * while it runs.
   */
  async claimDeliveries(now = Date.now(), limit = DELIVERY_CHUNK): Promise<Claimed[]> {
    return all<Claimed>(
      this.#db,
      `UPDATE deliveries d SET next_attempt_at = $3
       FROM (SELECT flag_id, action, next_attempt_at FROM deliveries
             WHERE workspace_id = $1 AND status = 'pending' AND next_attempt_at <= $2
             ORDER BY next_attempt_at LIMIT $4 FOR UPDATE SKIP LOCKED) due
       WHERE d.flag_id = due.flag_id AND d.action = due.action
       RETURNING d.flag_id, d.action, d.attempts, due.next_attempt_at AS was_due, d.next_attempt_at AS claimed_until`,
      [this.#ws, now, now + DELIVERY_CLAIM_MS, limit],
    );
  }

  /** Run every delivery that is due. Returns how many were attempted. */
  async deliverDue(now = Date.now()): Promise<number> {
    const due = await this.claimDeliveries(now);
    await Promise.all(due.map((d) => this.#deliver(d)));
    return due.length;
  }

  async #deliver(d: Claimed): Promise<void> {
    const { flag_id: flagId, action } = d;
    let attempts = d.attempts;
    const row = await getFlagRow(this.#db, this.#ws, flagId);
    if (!row) return; // flag deleted; its deliveries went with it
    const flag = toFlag(row);
    const adapter = this.#o.actions.get(action);
    let error: string | null = null;
    if (!adapter) {
      error = `action '${action}' is not enabled`;
      attempts = MAX_DELIVERY_ATTEMPTS - 1; // no point retrying
    } else {
      try {
        const events = await eventsByIds(this.#db, this.#ws, flag.event_ids);
        const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(DELIVERY_TIMEOUT_MS)]);
        const ok = await adapter.run(flag, { events, env: this.#o.env, signal });
        if (ok === false) error = "run() returned false";
      } catch (err) {
        error = errMsg(err);
      }
    }
    // Where: still ours. Claims expire, and an expired one may have been taken by another worker.
    const mine = "WHERE flag_id = $1 AND action = $2 AND next_attempt_at = $3";
    if (this.#abort.signal.aborted) {
      // Finished after shutdown: stays pending, retried after restart.
      await run(this.#db, `UPDATE deliveries SET next_attempt_at = $4 ${mine}`, [flagId, action, d.claimed_until, d.was_due]);
      return;
    }
    const now = Date.now();
    if (error === null) {
      await run(this.#db, `UPDATE deliveries SET status = 'ok', attempts = attempts + 1, last_error = NULL, updated_at = $4 ${mine}`, [flagId, action, d.claimed_until, now]);
      log.info("action delivered", { flag: flagId, action });
      return;
    }
    const n = attempts + 1;
    const giveUp = n >= MAX_DELIVERY_ATTEMPTS;
    await run(
      this.#db,
      `UPDATE deliveries SET status = $4, attempts = $5, last_error = $6, next_attempt_at = $7, updated_at = $8 ${mine}`,
      [flagId, action, d.claimed_until, giveUp ? "failed" : "pending", n, pgText(error), now + deliveryBackoff(n), now],
    );
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
    const chunked = async (sql: string) => {
      let total = 0;
      for (;;) {
        const n = await run(this.#db, sql, [this.#ws, cutoff]);
        total += n;
        if (n < CLEANUP_CHUNK || this.#stopped) return total;
        await yieldToLoop();
      }
    };
    const queue = await chunked(
      `DELETE FROM queue WHERE id IN (SELECT id FROM queue WHERE workspace_id = $1 AND status IN ('done', 'failed') AND received_at < $2 ORDER BY id LIMIT ${CLEANUP_CHUNK})`,
    );
    const events = await chunked(
      `DELETE FROM events WHERE id IN (SELECT id FROM events WHERE workspace_id = $1 AND received_at < $2 AND decided ORDER BY received_at LIMIT ${CLEANUP_CHUNK})`,
    );
    // A decision's prompt and reply quote event data: they go with the events. The row stays,
    // so labels still say which call (model, events) they came from.
    const decisions = await chunked(
      `UPDATE decisions SET prompt = NULL, response = NULL WHERE id IN (SELECT id FROM decisions WHERE workspace_id = $1 AND created_at < $2 AND (prompt IS NOT NULL OR response IS NOT NULL) LIMIT ${CLEANUP_CHUNK})`,
    );
    if (queue || events || decisions) log.info("cleanup", { requests_deleted: queue, events_deleted: events, decision_texts_cleared: decisions });
    return { queue, events };
  }
}

function serialize(e: ParsedEvent) {
  if (!e || typeof e !== "object" || !("data" in e)) throw new Error("each parsed event needs a `data` field");
  const hint = (v: unknown) => (typeof v === "string" && v ? pgText(v.slice(0, 256)) : typeof v === "number" ? String(v) : null);
  return {
    parsed: e.data ?? null,
    data: JSON.stringify(e.data ?? null),
    id: hint(e.id),
    type: hint(e.type),
    group_key: hint(e.group_key),
  };
}
