import { randomBytes } from "node:crypto";
import os from "node:os";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import type pg from "pg";
import { all, DEFAULT_WORKSPACE, one, pgText, run, tx, type DB, type Queryable } from "./db.ts";
import type { Intake } from "./intake.ts";
import { LeaseLost, Leases, type Held } from "./leases.ts";
import { errMsg, log } from "./log.ts";
import { EVENT_COLUMNS, eventsByIds, getFlagRow, toEvent, toFlag, type EventRow } from "./store.ts";
import { applyVerdicts, labelProvenance, planBatch, verdictKey, type Outcome, type Pending, type Plan } from "./triage/cascade.ts";
import { humanLabelsSince, type HumanLabel, type Triage } from "./triage/runtime.ts";
import { toDecision, type ActionAdapter, type CloudfriendEvent, type DeciderAdapter, type Decision, type Judgment, type ParsedEvent, type Severity, type SourceAdapter } from "./types.ts";
import { addDeciderCall, budgetOf, utcDay, workspaceState, type WorkspaceSettings } from "./usage.ts";

export interface WorkerOptions {
  db: DB;
  /** The intake of this process, if any: told when rows leave 'new', so its admission cache follows at once. */
  intake?: Intake | null;
  sources: Map<string, SourceAdapter>;
  /** null: events are stored but nothing decides on them until a decider is configured. */
  decider: { name: string; adapter: DeciderAdapter } | null;
  /**
   * Actions enabled by environment variables, by name. They run deliveries whose `action` is an
   * adapter name: rows from before destinations, and `legacyActions` of the default workspace.
   */
  actions: Map<string, ActionAdapter>;
  /** Every loaded action adapter, by name: a destination's `kind` picks one. Defaults to `actions`. */
  actionKinds?: Map<string, ActionAdapter>;
  /** Actions (names in `actions`) that new flags of the default workspace get a delivery for, besides its destinations. Defaults to all of `actions`. */
  legacyActions?: string[];
  /**
   * Opens a workspace's triage state once its lease is claimed. Absent or null: triage is off,
   * and every event goes to the decider as in v0, with no classifier, grouping or labels.
   */
  openTriage?: ((workspace: string) => Promise<Triage>) | null;
  /** The default workspace's Triage made at boot; reused, instead of loaded again, when that is safe. */
  defaultTriage?: Triage | null;
  env: NodeJS.ProcessEnv;
  batchSize: number;
  batchWaitMs: number;
  /** How long a batch of only audit samples may wait for company. */
  auditWaitMs?: number;
  /** Decider calls in flight at once, over every workspace. */
  deciderConcurrency: number;
  retentionMs: number;
  cleanupIntervalMs: number;
  pollMs: number;
  /** Lease owner id; unique per process. */
  owner?: string;
  leaseTtlMs?: number;
  leaseRenewMs?: number;
  /** Most workspaces this worker holds at once. */
  maxWorkspaces?: number;
  /** A workspace with no work for this long is saved, released and dropped from memory. */
  idleUnloadMs?: number;
  /** Daily decider budget per workspace in USD (a workspace's settings.jev_budget_usd overrides it); null = none. */
  jevDailyBudgetUsd?: number | null;
  /** false: never claims a workspace or runs anything (CLOUDFRIEND_ROLE=web). */
  enabled?: boolean;
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
/** Workspaces claimed per round, so a worker that starts doesn't take everything at once. */
const CLAIM_BATCH = 10;
/** How often people's labels written elsewhere (the API) are applied to routing. */
const HUMAN_POLL_MS = 2_000;
/** Only one process runs retention cleanup at a time. Any constant no one else uses. */
const CLEANUP_LOCK = 0x636c6e70;

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

/** One delivery per destination of the workspace that isn't deleted, plus the named actions in $4. */
const INSERT_DELIVERIES = `INSERT INTO deliveries (flag_id, workspace_id, action, next_attempt_at, updated_at)
  SELECT $1, $2, a, $3, $3 FROM (SELECT id AS a FROM destinations WHERE workspace_id = $2 AND deleted_at IS NULL UNION SELECT unnest($4::text[])) x`;

/** $1 y, $2 created_at, $3 provenance, $4 weight, $5 decision id, $6 rate, $7 service errors, $8 workspace, $9 event id. */
const INSERT_LABEL = `INSERT INTO labels (workspace_id, event_id, y, source, route, score, features, featurizer_version, event_source, received_at, data, created_at, template, provenance, weight, decision_id, severity, ctx_rate, ctx_service_errors)
  SELECT workspace_id, id, $1::integer, 'jev', route, score, features, coalesce(fv, 2), source, received_at, data, $2::bigint, template, $3::text, $4::float8, $5::text, severity, $6::float8, $7::float8
  FROM events WHERE workspace_id = $8 AND id = $9 AND features IS NOT NULL
  ON CONFLICT (workspace_id, event_id) DO UPDATE SET y = excluded.y, created_at = excluded.created_at, provenance = excluded.provenance,
    weight = excluded.weight, decision_id = excluded.decision_id, ctx_rate = excluded.ctx_rate, ctx_service_errors = excluded.ctx_service_errors
    WHERE labels.source <> 'human'`;

/** Marks a batch decided, with what the decider made of each event (NULLs leave a column as it was). */
const MARK_DECIDED = `UPDATE events e SET decided = true, judgment = coalesce(u.j, e.judgment), flag_id = coalesce(u.f, e.flag_id), decision_id = coalesce(u.d, e.decision_id)
  FROM unnest($2::bigint[], $3::text[], $4::text[], $5::text[]) AS u(id, j, f, d) WHERE e.workspace_id = $1 AND e.id = u.id`;

interface Claimed {
  flag_id: string;
  workspace_id: string;
  action: string;
  attempts: number;
  /** When it was due before the claim, to hand it back unchanged on shutdown. */
  was_due: number;
  claimed_until: number;
}

/** What the decider made of one event: its judgment, the flag it joined, the call that judged it. */
interface EventOutcome {
  judgment: Judgment["relevance"] | null;
  flag: string | null;
  decision: string | null;
}

/** A workspace this worker holds the lease of, and the state that only its owner keeps. */
class Owned implements Held {
  readonly workspace: string;
  readonly epoch: number;
  readonly triage: Triage | null;
  /** Fires when the lease is lost: in-flight decider calls for it are abandoned. */
  readonly abort = new AbortController();
  /** Event ids inside a decide() call. */
  readonly inflight = new Set<number>();
  readonly decides = new Set<Promise<void>>();
  /** Parse passes run one at a time, so events are scored in arrival order. */
  parsing: Promise<unknown> = Promise.resolve();
  deciderFailures = 0;
  retryAt = 0;
  /** Last time it had anything to parse or decide. */
  lastWork = Date.now();
  /** Set when the lease is lost or released: nothing more may be written for it. */
  gone = false;
  settings: WorkspaceSettings = {};
  /** Decider spend on `spendDay` (UTC), as stored plus what this worker added since. */
  spend = 0;
  spendDay = utcDay();
  budgetLogged: string | null = null;

  constructor(workspace: string, epoch: number, triage: Triage | null) {
    this.workspace = workspace;
    this.epoch = epoch;
    this.triage = triage;
  }
}

/**
 * Three stages, each durable on its own:
 *   parse:   queue rows 'new'  -> events (not decided), queue row 'done'   (one transaction)
 *   decide:  batch of events   -> flags + deliveries, events decided       (one transaction)
 *   deliver: pending deliveries -> claimed, action.run(), retried with backoff
 * A crash between stages loses nothing: each stage picks up whatever the last one left. No
 * stage waits on the network inside a transaction.
 *
 * Parse and decide (the sorter) run per workspace, only in the worker holding its lease
 * (leases.ts), and every sorter write is fenced on that lease. Delivery is a shared pool: any
 * worker runs any due delivery, claimed with SKIP LOCKED.
 */
export class Worker {
  #o: WorkerOptions;
  #db: DB;
  #enabled: boolean;
  #leases: Leases;
  #owned = new Map<string, Owned>();
  /** Triage state of released workspaces, kept for the next claim (only the boot instance of the default workspace). */
  #parked = new Map<string, Triage>();
  #timer: NodeJS.Timeout | null = null;
  #cleanupTimer: NodeJS.Timeout | null = null;
  #renewTimer: NodeJS.Timeout | null = null;
  #humanTimer: NodeJS.Timeout | null = null;
  /** Ticks only run after start(); tests drive the stages by hand before that. */
  #started = false;
  #stopped = false;
  #ticking: Promise<void> | null = null;
  #cleaning: Promise<unknown> | null = null;
  #claiming: Promise<void> | null = null;
  #maintaining: Promise<void> | null = null;
  #lastClaim = 0;
  #lastRenew = Date.now();
  #abort = new AbortController();
  /** Every decide() call in flight, over all workspaces: the concurrency cap counts these. */
  #decides = new Set<Promise<void>>();
  /** startDueBatches runs one at a time, so two never pick the same events (see #startDueBatches). */
  #starting: Promise<void> = Promise.resolve();
  /** Where the next round of batch starts begins, so workspaces take turns. */
  #turn = 0;
  #delivering: Promise<number> | null = null;
  /** Since start: decider calls, examples asked, events settled by a cached verdict. */
  readonly counters = { deciderCalls: 0, asked: 0, cached: 0, direct: 0 };

  constructor(opts: WorkerOptions) {
    this.#o = opts;
    this.#db = opts.db;
    this.#enabled = opts.enabled !== false;
    const owner = opts.owner ?? `${os.hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;
    this.#leases = new Leases(opts.db, owner, opts.leaseTtlMs ?? 30_000);
    if (opts.defaultTriage) this.#parked.set(DEFAULT_WORKSPACE, opts.defaultTriage);
  }

  /** This worker's lease owner id. */
  get owner(): string {
    return this.#leases.owner;
  }

  /** The workspaces this worker holds, with their lease epochs. */
  get owned(): Held[] {
    return [...this.#owned.values()].map((o) => ({ workspace: o.workspace, epoch: o.epoch }));
  }

  /** The triage state of a workspace this worker holds, or null. */
  triageFor(workspace: string): Triage | null {
    return this.#owned.get(workspace)?.triage ?? null;
  }

  start(): void {
    if (!this.#enabled || this.#started) return;
    this.#started = true;
    this.#schedule(0);
    this.#cleanupTimer = setInterval(() => {
      this.#cleaning ??= Promise.all([
        this.cleanup().catch((err) => log.error("cleanup failed", { error: errMsg(err) })),
        this.saveTriageState(),
      ]).finally(() => (this.#cleaning = null));
    }, this.#o.cleanupIntervalMs);
    this.#cleanupTimer.unref();
    // Leases are renewed on a timer of their own, so a long parse backlog never lets them lapse.
    this.#renewTimer = setInterval(() => void this.#maintain(true), this.#renewMs);
    this.#renewTimer.unref();
    this.#humanTimer = setInterval(() => void this.#applyHumanLabels().catch((err) => log.warn("reading people's labels failed", { error: errMsg(err) })), HUMAN_POLL_MS);
    this.#humanTimer.unref();
  }

  get #renewMs(): number {
    return this.#o.leaseRenewMs ?? 10_000;
  }

  /**
   * Stop taking new work and give in-flight decides and deliveries `graceMs` to finish. After
   * that they are aborted and whatever they return is discarded: their events and deliveries
   * are still pending in the database and get picked up after a restart. Then each workspace's
   * featurizer history is saved and its lease released, so another worker takes over at once.
   * `release: false` leaves the leases to expire, as if the process had died.
   */
  async stop(graceMs = 5_000, opts: { release?: boolean } = {}): Promise<void> {
    this.#stopped = true;
    for (const t of [this.#timer, this.#cleanupTimer, this.#renewTimer, this.#humanTimer]) if (t) clearTimeout(t);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((r) => (timer = setTimeout(r, graceMs)));
    const idle = await Promise.race([this.whenIdle().then(() => true), timeout.then(() => false)]);
    clearTimeout(timer);
    if (!idle) {
      log.warn("shutdown grace period over; abandoning in-flight work (it is retried after restart)", {
        decides: this.#decides.size,
        delivering: this.#delivering !== null,
      });
    }
    this.#abort.abort(new Error("shutting down"));
    // Aborted deliveries hand their claims back, so the next start retries them at once.
    // Decides need nothing: their events were never marked decided.
    await Promise.race([
      Promise.allSettled([this.#ticking, this.#cleaning, this.#delivering, this.#claiming, this.#maintaining]),
      new Promise((r) => setTimeout(r, 1_000).unref()),
    ]);
    const owned = [...this.#owned.values()];
    if (opts.release === false) {
      for (const o of owned) o.gone = true;
      this.#owned.clear();
      return;
    }
    await Promise.all(owned.map((o) => this.#unload(o, "shutdown")));
  }

  /** Persist each held workspace's featurizer history, so a restart doesn't make every template look new. */
  async saveTriageState(): Promise<void> {
    for (const o of [...this.#owned.values()]) {
      if (!o.triage || o.gone) continue;
      try {
        await this.#fenced(o, (c) => o.triage!.saveState(c));
      } catch (err) {
        if (err instanceof LeaseLost) this.#lose(o);
        else log.warn("saving triage state failed", { workspace: o.workspace, error: errMsg(err) });
      }
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
      await this.#ensureLeases(false);
      await this.#parseAll();
      if (!this.#stopped) await this.#startDue(Date.now(), false);
      if (!this.#stopped && !this.#delivering) {
        this.#delivering = this.deliverDue().finally(() => (this.#delivering = null));
        this.#delivering.catch((err) => log.error("delivery pass failed", { error: errMsg(err) }));
      }
    } catch (err) {
      log.error("worker tick failed", { error: errMsg(err) });
    }
  }

  // --- leases ----------------------------------------------------------------

  /** Claim workspaces with work if there is room (at most every few polls unless `now`), and renew if due. */
  async #ensureLeases(now: boolean): Promise<void> {
    if (!this.#enabled || this.#stopped) return;
    if (Date.now() - this.#lastRenew >= this.#renewMs) await this.#maintain(false);
    if (!now && Date.now() - this.#lastClaim < Math.min(1_000, this.#o.pollMs * 5)) return;
    this.#claiming ??= this.#claim()
      .catch((err) => log.error("claiming workspaces failed", { error: errMsg(err) }))
      .finally(() => (this.#claiming = null));
    await this.#claiming;
  }

  async #claim(): Promise<void> {
    this.#lastClaim = Date.now();
    const max = this.#o.maxWorkspaces ?? 200;
    const room = max - this.#owned.size;
    if (room <= 0) return;
    for (const ws of await this.#leases.claimable(Math.min(room, CLAIM_BATCH), [...this.#owned.keys()])) {
      if (this.#stopped || this.#owned.size >= max) return;
      const epoch = await this.#leases.claim(ws);
      if (epoch === null) continue; // another worker was faster
      try {
        await this.#adopt(ws, epoch);
      } catch (err) {
        log.error("loading a claimed workspace failed; releasing it", { workspace: ws, error: errMsg(err) });
        await this.#leases.release({ workspace: ws, epoch }).catch(() => {});
      }
    }
  }

  async #adopt(ws: string, epoch: number): Promise<void> {
    const triage = await this.#loadTriage(ws, epoch);
    const o = new Owned(ws, epoch, triage);
    const state = (await workspaceState(this.#db, [ws], o.spendDay)).get(ws);
    o.settings = state?.settings ?? {};
    o.spend = state?.spend ?? 0;
    if (this.#stopped) {
      await this.#leases.release(o);
      return;
    }
    this.#owned.set(ws, o);
    log.info("workspace claimed", { workspace: ws, epoch });
  }

  /**
   * The workspace's triage state. A parked one is current if nobody held the lease since it was
   * released (the claim got the next epoch); otherwise it is loaded from the database again.
   */
  async #loadTriage(ws: string, epoch: number): Promise<Triage | null> {
    if (!this.#o.openTriage) return null;
    const parked = this.#parked.get(ws);
    if (parked) {
      this.#parked.delete(ws);
      if (parked.settledEpoch !== epoch - 1) await parked.reload();
      parked.settledEpoch = null;
      return parked;
    }
    return this.#o.openTriage(ws);
  }

  /** Renew the leases (and drop the ones lost), read settings and spend, unload idle workspaces. */
  #maintain(unloadIdle: boolean): Promise<void> {
    this.#maintaining ??= (async () => {
      this.#lastRenew = Date.now();
      const held = [...this.#owned.values()];
      if (!held.length || this.#stopped) return;
      const kept = await this.#leases.renew(held);
      for (const o of held) if (!kept.has(o.workspace)) this.#lose(o);
      const day = utcDay();
      const state = await workspaceState(this.#db, [...this.#owned.keys()], day);
      for (const [ws, s] of state) {
        const o = this.#owned.get(ws);
        if (!o) continue;
        o.settings = s.settings;
        o.spend = s.spend;
        o.spendDay = day;
      }
      if (!unloadIdle) return;
      const idleMs = this.#o.idleUnloadMs ?? 600_000;
      for (const o of [...this.#owned.values()]) {
        if (Date.now() - o.lastWork >= idleMs && !o.decides.size && !o.inflight.size) await this.#unload(o, "idle");
      }
    })()
      .catch((err) => log.error("renewing leases failed", { error: errMsg(err) }))
      .finally(() => (this.#maintaining = null));
    return this.#maintaining;
  }

  /** The lease was taken over: forget the workspace's state without writing anything more. */
  #lose(o: Owned): void {
    if (o.gone) return;
    o.gone = true;
    o.abort.abort(new LeaseLost(o.workspace));
    if (this.#owned.get(o.workspace) === o) this.#owned.delete(o.workspace);
    // The boot instance of the default workspace stays the same object (cloudfriend.triage): it
    // is loaded again on the next claim.
    if (o.triage && o.triage === this.#o.defaultTriage) {
      o.triage.settledEpoch = null;
      this.#parked.set(o.workspace, o.triage);
    }
    log.warn("lease lost; another worker took over the workspace", { workspace: o.workspace, epoch: o.epoch });
  }

  /** Save the workspace's history, release its lease and drop its state. */
  async #unload(o: Owned, why: string): Promise<void> {
    if (o.gone) return;
    this.#owned.delete(o.workspace);
    await o.parsing;
    try {
      if (o.triage) await this.#fenced(o, (c) => o.triage!.saveState(c));
    } catch (err) {
      if (err instanceof LeaseLost) {
        this.#owned.set(o.workspace, o); // so #lose finds it
        this.#lose(o);
        return;
      }
      log.warn("saving triage state failed", { workspace: o.workspace, error: errMsg(err) });
    }
    o.gone = true;
    let released = false;
    try {
      await this.#leases.release(o);
      released = true;
    } catch (err) {
      log.warn("releasing the lease failed; it expires on its own", { workspace: o.workspace, error: errMsg(err) });
    }
    if (o.triage && o.triage === this.#o.defaultTriage) {
      o.triage.settledEpoch = released ? o.epoch : null;
      this.#parked.set(o.workspace, o.triage);
    }
    log.info("workspace released", { workspace: o.workspace, epoch: o.epoch, why });
  }

  /** A transaction that only commits while the workspace's lease is still ours (leases.ts). */
  #fenced<T>(o: Owned, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    if (o.gone) return Promise.reject(new LeaseLost(o.workspace));
    return tx(this.#db, async (c) => {
      await this.#leases.fence(c, o);
      return fn(c);
    });
  }

  /** Apply people's labels written since the last pass (possibly by another process) to routing. */
  async #applyHumanLabels(): Promise<void> {
    const list = [...this.#owned.values()].filter((o) => o.triage && !o.gone);
    if (!list.length) return;
    const since = Math.min(...list.map((o) => o.triage!.humanSince));
    const rows = await humanLabelsSince(this.#db, list.map((o) => o.workspace), since);
    const byWs = new Map<string, HumanLabel[]>();
    for (const r of rows) byWs.set(r.workspace_id, [...(byWs.get(r.workspace_id) ?? []), r]);
    for (const o of list) {
      if (o.gone) continue;
      o.triage!.applyHumanLabels((byWs.get(o.workspace) ?? []).filter((r) => r.created_at > o.triage!.humanSince));
    }
  }

  // --- parse ---------------------------------------------------------------

  /**
   * Parse up to one chunk of queued requests into events, for each workspace this worker holds
   * (claiming workspaces with work first). Returns how many requests it handled.
   */
  async parseNew(limit = PARSE_CHUNK): Promise<number> {
    await this.#ensureLeases(true);
    let n = 0;
    for (const o of [...this.#owned.values()]) n += await this.#parseChunk(o, limit);
    return n;
  }

  /** Parse every held workspace's queue empty, one chunk per workspace per round. */
  async #parseAll(): Promise<void> {
    let round = [...this.#owned.values()];
    while (round.length && !this.#stopped) {
      const next: Owned[] = [];
      for (const o of round) {
        if (this.#stopped) return;
        try {
          if ((await this.#parseChunk(o, PARSE_CHUNK)) === PARSE_CHUNK) next.push(o);
        } catch (err) {
          log.error("parse failed", { workspace: o.workspace, error: errMsg(err) });
        }
      }
      round = next;
      if (round.length) await yieldToLoop();
    }
  }

  #parseChunk(o: Owned, limit: number): Promise<number> {
    const p = o.parsing.then(() => this.#parseOnce(o, limit));
    o.parsing = p.catch(() => {});
    return p;
  }

  /**
   * One chunk of a workspace's queue. The rows are locked (SKIP LOCKED) for the one transaction
   * that parses, scores and stores them, fenced on the workspace's lease: scoring changes the
   * featurizer's history, so only the owner may do it, in arrival order.
   */
  async #parseOnce(o: Owned, limit: number): Promise<number> {
    if (o.gone || this.#stopped) return 0;
    const triage = o.triage;
    if (triage) await triage.sync();
    let n: number;
    try {
      n = await this.#fenced(o, async (c) => {
        const rows = await all<{ id: number; source: string; adapter: string | null; received_at: number; body: Uint8Array }>(
          c,
          "SELECT id, source, adapter, received_at, body FROM queue WHERE workspace_id = $1 AND status = 'new' ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED",
          [o.workspace, limit],
        );
        if (!rows.length) return 0;
        o.lastWork = Date.now();
        const results = rows.map((row) => {
          const adapter = (row.adapter ? this.#o.sources.get(row.adapter) : this.#o.sources.get(row.source)) ?? this.#o.sources.get("json")!;
          try {
            const parsed = adapter.parse(row.body, { source: row.source, received_at: new Date(row.received_at) });
            if (!Array.isArray(parsed)) throw new Error("parse() must return an array");
            return { row, events: parsed.map(serialize) };
          } catch (err) {
            log.warn("parse failed; request kept with status 'failed'", {
              workspace: o.workspace,
              queue_id: row.id,
              source: row.source,
              error: errMsg(err),
            });
            return { row, events: null };
          }
        });
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
        if (cols[0]!.length) await c.query(INSERT_EVENTS, [o.workspace, ...cols]);
        await c.query("UPDATE queue SET status = u.status FROM unnest($1::bigint[], $2::text[]) AS u(id, status) WHERE queue.id = u.id", [
          results.map((r) => r.row.id),
          results.map((r) => (r.events ? "done" : "failed")),
        ]);
        await c.query("UPDATE workspaces SET backlog = greatest(backlog - $2, 0) WHERE id = $1", [o.workspace, rows.length]);
        return rows.length;
      });
    } catch (err) {
      if (err instanceof LeaseLost) {
        this.#lose(o);
        return 0;
      }
      throw err;
    }
    if (n) this.#o.intake?.release(o.workspace, n);
    return n;
  }

  // --- decide --------------------------------------------------------------

  /** Start decide() calls for every batch that is full or has waited long enough (claiming workspaces with work first). */
  startDueBatches(now = Date.now()): Promise<void> {
    return this.#startDue(now, true);
  }

  #startDue(now: number, claimNow: boolean): Promise<void> {
    const next = this.#starting.then(async () => {
      await this.#ensureLeases(claimNow);
      await this.#startDueBatches(now);
    });
    this.#starting = next.catch(() => {});
    return next;
  }

  /**
   * Fair across workspaces: each round offers every held workspace one batch, starting with a
   * different one each time, until the global cap on decider calls is reached.
   */
  async #startDueBatches(now: number): Promise<void> {
    const list = [...this.#owned.values()];
    if (!list.length) return;
    const first = this.#turn++ % list.length;
    const order = [...list.slice(first), ...list.slice(0, first)];
    const active = new Set(order);
    while (active.size && !this.#stopped && this.#decides.size < this.#o.deciderConcurrency) {
      for (const o of order) {
        if (!active.has(o)) continue;
        if (this.#stopped || this.#decides.size >= this.#o.deciderConcurrency) return;
        let started = false;
        try {
          started = await this.#startBatch(o, now);
        } catch (err) {
          log.error("starting a batch failed", { workspace: o.workspace, error: errMsg(err) });
        }
        if (!started) active.delete(o);
      }
    }
  }

  /** The decider a workspace may use now: none once its daily budget is spent (the classifier decides alone). */
  #deciderFor(o: Owned): WorkerOptions["decider"] {
    const decider = this.#o.decider;
    if (!decider) return null;
    const day = utcDay();
    if (o.spendDay !== day) {
      o.spendDay = day;
      o.spend = 0;
    }
    const budget = budgetOf(o.settings, this.#o.jevDailyBudgetUsd ?? null);
    if (budget === null || o.spend < budget) return decider;
    if (o.budgetLogged !== day) {
      o.budgetLogged = day;
      log.warn("daily decider budget reached; the classifier decides alone until the UTC day ends", { workspace: o.workspace, spend_usd: round4(o.spend), budget_usd: budget });
    }
    return null;
  }

  /** The decider's env for a workspace: its own instructions appended to CLOUDFRIEND_DECIDER_INSTRUCTIONS. */
  #envFor(o: Owned): NodeJS.ProcessEnv {
    const own = typeof o.settings.decider_instructions === "string" ? o.settings.decider_instructions.trim() : "";
    if (!own) return this.#o.env;
    const base = this.#o.env.CLOUDFRIEND_DECIDER_INSTRUCTIONS?.trim();
    return { ...this.#o.env, CLOUDFRIEND_DECIDER_INSTRUCTIONS: base ? `${base}\n\n${own}` : own };
  }

  /** Start one batch for a workspace if one is due. Returns whether it did. */
  async #startBatch(o: Owned, now: number): Promise<boolean> {
    if (o.gone || now < o.retryAt) return false;
    const decider = this.#deciderFor(o);
    if (!(decider || o.triage?.classifier)) return false;
    const rows = await all<{ id: number; received_at: number; route: string | null }>(
      this.#db,
      "SELECT id, received_at, route FROM events WHERE workspace_id = $1 AND NOT decided ORDER BY id LIMIT $2",
      [o.workspace, this.#o.batchSize + o.inflight.size],
    );
    if (rows.length) o.lastWork = Date.now();
    const batch = rows.filter((r) => !o.inflight.has(r.id)).slice(0, this.#o.batchSize);
    if (!batch.length || this.#stopped || o.gone) return false;
    const full = batch.length >= this.#o.batchSize;
    // Audit samples aren't urgent: they wait for other events, or for auditWaitMs.
    const urgent = batch.find((r) => r.route !== "audit");
    const waited = urgent
      ? now - urgent.received_at >= this.#o.batchWaitMs
      : now - batch[0]!.received_at >= (this.#o.auditWaitMs ?? this.#o.batchWaitMs);
    if (!full && !waited) return false;
    const ids = batch.map((r) => r.id);
    for (const id of ids) o.inflight.add(id);
    const p: Promise<void> = this.#decideBatch(o, ids, decider)
      .catch((err) => {
        if (err instanceof LeaseLost) {
          this.#lose(o);
          log.warn("decision discarded: the workspace's lease was taken over; its new owner decides again", { workspace: o.workspace, events: ids.length });
        } else log.error("storing decision failed; events stay queued", { workspace: o.workspace, error: errMsg(err) });
      })
      .finally(() => {
        this.#decides.delete(p);
        o.decides.delete(p);
        // Queued behind startDueBatches: a query for pending events that is already under way
        // may have read these before they were marked decided, and must still skip them.
        this.#starting = this.#starting.then(() => {
          for (const id of ids) o.inflight.delete(id);
        });
      });
    this.#decides.add(p);
    o.decides.add(p);
    return true;
  }

  async #decideBatch(o: Owned, ids: number[], decider: WorkerOptions["decider"]): Promise<void> {
    const signal = AbortSignal.any([this.#abort.signal, o.abort.signal]);
    if (o.triage) return this.#triageBatch(o, ids, o.triage, decider, signal);
    const { name, adapter } = decider!;
    const rows = await all<EventRow>(this.#db, `SELECT ${EVENT_COLUMNS} FROM events WHERE workspace_id = $1 AND id = ANY($2::bigint[]) ORDER BY id`, [o.workspace, ids]);
    const events = rows.map(toEvent);
    const started = Date.now();
    let decision: Decision;
    try {
      decision = toDecision(await adapter.decide(events, { env: this.#envFor(o), signal, workspace: o.workspace }));
      if (signal.aborted || o.gone) return; // finished after shutdown or takeover; decided again later
    } catch (err) {
      if (this.#stopped || o.gone) return; // events stay pending and are decided after restart
      this.#deciderFailed(o, name, ids.length, err);
      return;
    }
    o.deciderFailures = 0;
    this.counters.deciderCalls++;
    const cost = costOf(decision);
    const flags = await this.#storeDecision(o, name, ids, decision, cost);
    o.spend += cost;
    log.info("batch decided", { workspace: o.workspace, events: ids.length, flags: flags.length, ms: Date.now() - started });
    if (flags.length && !this.#delivering) this.#schedule(0);
  }

  #deciderFailed(o: Owned, name: string, events: number, err: unknown): void {
    o.deciderFailures++;
    const wait = deciderBackoff(o.deciderFailures);
    o.retryAt = Date.now() + wait;
    log.error("decider failed; events stay queued", { workspace: o.workspace, decider: name, events, retry_in_ms: wait, error: errMsg(err) });
  }

  /**
   * The cascade: events routed past the classifier are grouped by template, cached verdicts
   * are reused, and only the remaining examples go to the decider (Jev). Its verdicts become
   * flags, cache entries and training labels, all stored in one transaction. `decider` null
   * (none configured, or the workspace's budget is spent): the classifier decides alone.
   */
  async #triageBatch(o: Owned, ids: number[], triage: Triage, decider: WorkerOptions["decider"], signal: AbortSignal): Promise<void> {
    const db = this.#db;
    const ws = o.workspace;
    await triage.sync();
    const rows = await all<EventRow & { template: string | null; severity: string | null }>(
      db,
      `SELECT ${EVENT_COLUMNS}, template, severity FROM events WHERE workspace_id = $1 AND id = ANY($2::bigint[]) ORDER BY id`,
      [ws, ids],
    );
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
    const open = await this.#openFlags(ws, cachedFlags);
    for (const it of items) {
      const v = triage.cache.get(verdictKey(it), now);
      if (v?.flagId && !open.has(v.flagId)) triage.cache.delete(verdictKey(it));
    }
    const plan = planBatch(items, triage.cache, now, triage.opts.perTemplate);
    let decision: Decision = { flags: [] };
    let decisionId: string | null = null;
    let record: unknown[] | null = null;
    let cost: number | null = null;
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
        [ws],
      );
      try {
        decision = toDecision(await decider.adapter.decide(events, { env: this.#envFor(o), signal, openFlags, workspace: ws }));
        // Finished after shutdown, or after another worker took the workspace over: its new
        // owner asks again.
        if (signal.aborted || o.gone) return;
      } catch (err) {
        if (this.#stopped || o.gone) return;
        this.#deciderFailed(o, decider.name, events.length, err);
        return;
      }
      o.deciderFailures = 0;
      this.counters.deciderCalls++;
      this.counters.asked += plan.ask.length;
      cost = costOf(decision);
      decisionId = "dec_" + randomBytes(8).toString("hex");
      record = [
        decisionId, ws, now, decider.name, pgText(decision.record?.model ?? null), pgText(decision.record?.prompt ?? null),
        pgText(decision.record?.response ?? JSON.stringify({ flags: decision.flags, judgments: decision.judgments })), JSON.stringify(events.map((e) => e.id)), cost,
      ];
    }
    this.counters.cached += plan.cached.length;
    for (const g of plan.direct.values()) this.counters.direct += g.length;
    // An alert may only continue a flag that is still open now, after the call: one deleted or
    // closed meanwhile (or an id the decider made up) gets a new flag instead.
    const updates = await this.#openFlags(ws, decision.flags.map((f) => f.update).filter((id): id is string => typeof id === "string"));
    for (const f of decision.flags) if (f.update && !updates.has(f.update)) delete f.update;
    const out = applyVerdicts(plan, decision);
    const perEvent = outcomes(plan, decision, decisionId);
    const flagIds = await this.#storeOutcome(o, decider?.name ?? "classifier", ids, out, rows.map((r) => [String(r.id), r.user_key ?? null]), decisionId, record, cost, triage, items, perEvent);
    if (cost !== null) o.spend += cost;
    // Verdict cache, escalation memory and earned suppression: what Jev judged relevant keeps
    // reaching it, and what it judged benign may now be dropped by the classifier.
    triage.routing.learn(items, out, now, flagIds);
    log.info("batch decided", {
      workspace: ws,
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
  async #openFlags(ws: string, ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await all<{ id: string }>(
      this.#db,
      "SELECT id FROM flags WHERE workspace_id = $1 AND id = ANY($2::text[]) AND status IN ('open', 'acknowledged')",
      [ws, [...new Set(ids)]],
    );
    return new Set(rows.map((r) => r.id));
  }

  /** A new flag and one pending delivery per destination (and, in the default workspace, per env-configured action). */
  async #insertFlag(c: Queryable, ws: string, id: string, now: number, reason: string, severity: string, eventIds: string[], eventCount: number, decider: string, users: string[] | null): Promise<void> {
    await c.query(INSERT_FLAG, [id, ws, now, pgText(reason), severity, JSON.stringify(eventIds), pgText(decider), now, eventCount, users ? JSON.stringify(users) : null]);
    const named = ws === DEFAULT_WORKSPACE ? (this.#o.legacyActions ?? [...this.#o.actions.keys()]) : [];
    await c.query(INSERT_DELIVERIES, [id, ws, now, named]);
  }

  async #storeOutcome(
    o: Owned,
    decider: string,
    ids: number[],
    out: Outcome,
    users: [string, string | null][],
    decisionId: string | null,
    record: unknown[] | null,
    cost: number | null,
    triage: Triage,
    items: Pending[],
    perEvent: Map<string, EventOutcome>,
  ): Promise<string[]> {
    const ws = o.workspace;
    const ctxOf = new Map(items.map((it) => [it.id, it]));
    const now = Date.now();
    const userOf = new Map(users);
    const flagIds: string[] = [];
    const flagOf = new Map<string, string>();
    await this.#fenced(o, async (c) => {
      if (record) {
        await c.query("INSERT INTO decisions (id, workspace_id, created_at, decider, model, prompt, response, event_ids, cost_usd) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)", record);
        await addDeciderCall(c, ws, utcDay(now), cost ?? 0);
      }
      for (const f of out.flags) {
        const id = "flg_" + randomBytes(10).toString("hex");
        const linked = [...new Set(f.event_ids.map((e) => userOf.get(e)).filter((u): u is string => !!u))].slice(0, 20);
        await this.#insertFlag(
          c, ws, id, now, f.reason.trim(), f.severity ?? "medium", f.event_ids.slice(0, 1000), f.event_ids.length,
          f.via === "classifier" ? "classifier" : decider, linked.length ? linked : null,
        );
        flagIds.push(id);
        for (const e of f.event_ids) flagOf.set(e, id);
      }
      for (const [flagId, evs] of out.attach) {
        // Locked: two batches may add to the same flag at once.
        const row = await getFlagRow(c, ws, flagId, true);
        if (!row) continue;
        const merged = [...new Set([...row.event_ids, ...evs])].slice(0, 1000);
        await c.query("UPDATE flags SET event_ids = $1, event_count = coalesce(event_count, 0) + $2, updated_at = $3 WHERE id = $4", [JSON.stringify(merged), evs.length, now, flagId]);
        for (const e of evs) flagOf.set(e, flagId);
      }
      for (const l of out.labels) {
        const p = labelProvenance(l, triage.opts.auditRate);
        const ctx = ctxOf.get(l.id);
        await c.query(INSERT_LABEL, [l.y, now, p.provenance, p.weight, decisionId, ctx?.rate ?? null, ctx?.serviceErrors ?? null, ws, Number(l.id)]);
      }
      await markDecided(c, ws, ids, (id) => ({ ...(perEvent.get(id) ?? { judgment: null, decision: null }), flag: flagOf.get(id) ?? null }));
    });
    for (const id of flagIds) log.info("flag raised", { workspace: ws, flag: id });
    return flagIds;
  }

  /** Triage off: the decider's flags, as v0 stored them, with judgments when it gave them. */
  async #storeDecision(o: Owned, decider: string, ids: number[], decision: Decision, cost: number): Promise<string[]> {
    const ws = o.workspace;
    const inBatch = new Set(ids.map(String));
    const now = Date.now();
    const flagIds: string[] = [];
    const flagOf = new Map<string, string>();
    const judged = new Map((decision.judgments ?? []).map((j) => [String(j.event_id), j.relevance]));
    await this.#fenced(o, async (c) => {
      await addDeciderCall(c, ws, utcDay(now), cost);
      for (const d of decision.flags) {
        const eventIds = [...new Set((d.event_ids ?? []).map(String))].filter((id) => inBatch.has(id));
        if (!eventIds.length || typeof d.reason !== "string" || !d.reason.trim()) continue;
        const id = "flg_" + randomBytes(10).toString("hex");
        await this.#insertFlag(c, ws, id, now, d.reason.trim(), d.severity ?? "medium", eventIds, eventIds.length, decider, null);
        flagIds.push(id);
        for (const e of eventIds) if (!flagOf.has(e)) flagOf.set(e, id);
      }
      await markDecided(c, ws, ids, (id) => ({
        judgment: flagOf.has(id) ? "relevant" : (judged.get(id) ?? null),
        flag: flagOf.get(id) ?? null,
        decision: null,
      }));
    });
    for (const id of flagIds) log.info("flag raised", { workspace: ws, flag: id });
    return flagIds;
  }

  // --- deliver -------------------------------------------------------------

  /**
   * Claim up to `limit` due deliveries, of any workspace. Rows another claimer has locked are
   * skipped, and a claimed row's next_attempt_at moves forward by DELIVERY_CLAIM_MS, so once this
   * commits no one else finds it due: each delivery runs once per attempt, with no transaction
   * held while it runs.
   */
  async claimDeliveries(now = Date.now(), limit = DELIVERY_CHUNK): Promise<Claimed[]> {
    if (!this.#enabled) return [];
    return all<Claimed>(
      this.#db,
      `UPDATE deliveries d SET next_attempt_at = $2
       FROM (SELECT flag_id, action, next_attempt_at FROM deliveries
             WHERE status = 'pending' AND next_attempt_at <= $1
             ORDER BY next_attempt_at LIMIT $3 FOR UPDATE SKIP LOCKED) due
       WHERE d.flag_id = due.flag_id AND d.action = due.action
       RETURNING d.flag_id, d.workspace_id, d.action, d.attempts, due.next_attempt_at AS was_due, d.next_attempt_at AS claimed_until`,
      [now, now + DELIVERY_CLAIM_MS, limit],
    );
  }

  /** Run every delivery that is due. Returns how many were attempted. */
  async deliverDue(now = Date.now()): Promise<number> {
    const due = await this.claimDeliveries(now);
    await Promise.all(due.map((d) => this.#deliver(d)));
    return due.length;
  }

  async #deliver(d: Claimed): Promise<void> {
    const { flag_id: flagId, action, workspace_id: ws } = d;
    let attempts = d.attempts;
    const row = await getFlagRow(this.#db, ws, flagId);
    if (!row) return; // flag deleted; its deliveries went with it
    const flag = toFlag(row);
    // `action` is a destination id, or (rows from before destinations, and env-configured
    // actions of the default workspace) an action adapter's name.
    const dest = await one<{ id: string; kind: string; config: Record<string, unknown> | null; deleted_at: number | null }>(
      this.#db,
      "SELECT id, kind, config, deleted_at FROM destinations WHERE workspace_id = $1 AND id = $2",
      [ws, action],
    );
    let adapter: ActionAdapter | undefined;
    let error: string | null = null;
    if (dest) {
      adapter = dest.deleted_at === null ? (this.#o.actionKinds ?? this.#o.actions).get(dest.kind) : undefined;
      if (dest.deleted_at !== null) error = "destination was deleted";
      else if (!adapter) error = `no action adapter '${dest.kind}'`;
    } else {
      adapter = this.#o.actions.get(action);
      if (!adapter) error = `action '${action}' is not enabled`;
    }
    if (!adapter) {
      attempts = MAX_DELIVERY_ATTEMPTS - 1; // no point retrying
    } else {
      try {
        const events = await eventsByIds(this.#db, ws, flag.event_ids);
        const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(DELIVERY_TIMEOUT_MS)]);
        const ok = await adapter.run(flag, { events, env: this.#o.env, signal, ...(dest ? { config: dest.config ?? {} } : {}) });
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
    const live = dest && dest.deleted_at === null;
    if (error === null) {
      const n = await run(this.#db, `UPDATE deliveries SET status = 'ok', attempts = attempts + 1, last_error = NULL, updated_at = $4 ${mine}`, [flagId, action, d.claimed_until, now]);
      if (n && live) await run(this.#db, "UPDATE destinations SET last_delivery_at = $3, last_error = NULL WHERE workspace_id = $1 AND id = $2", [ws, action, now]);
      log.info("action delivered", { workspace: ws, flag: flagId, action, kind: dest?.kind });
      return;
    }
    const n = attempts + 1;
    const giveUp = n >= MAX_DELIVERY_ATTEMPTS;
    const changed = await run(
      this.#db,
      `UPDATE deliveries SET status = $4, attempts = $5, last_error = $6, next_attempt_at = $7, updated_at = $8 ${mine}`,
      [flagId, action, d.claimed_until, giveUp ? "failed" : "pending", n, pgText(error), now + deliveryBackoff(n), now],
    );
    if (changed && live) await run(this.#db, "UPDATE destinations SET last_error = $3 WHERE workspace_id = $1 AND id = $2", [ws, action, pgText(error)]);
    log.warn(giveUp ? "action failed; giving up" : "action failed; will retry", {
      workspace: ws,
      flag: flagId,
      action,
      attempt: n,
      error,
    });
  }

  // --- cleanup -------------------------------------------------------------

  /**
   * Delete processed requests and decided events older than the retention window, of every
   * workspace, in small chunks. One process at a time runs it (an advisory lock); the others skip.
   */
  async cleanup(now = Date.now()): Promise<{ queue: number; events: number }> {
    if (!this.#enabled) return { queue: 0, events: 0 };
    const cutoff = now - this.#o.retentionMs;
    const lock = await this.#db.connect();
    let broken: Error | undefined;
    try {
      if (!(await one<{ ok: boolean }>(lock, "SELECT pg_try_advisory_lock($1) AS ok", [CLEANUP_LOCK]))!.ok) return { queue: 0, events: 0 };
      try {
        const chunked = async (sql: string) => {
          let total = 0;
          for (;;) {
            const n = await run(this.#db, sql, [cutoff]);
            total += n;
            if (n < CLEANUP_CHUNK || this.#stopped) return total;
            await yieldToLoop();
          }
        };
        const queue = await chunked(
          `DELETE FROM queue WHERE id IN (SELECT id FROM queue WHERE status IN ('done', 'failed') AND received_at < $1 ORDER BY id LIMIT ${CLEANUP_CHUNK})`,
        );
        const events = await chunked(`DELETE FROM events WHERE id IN (SELECT id FROM events WHERE received_at < $1 AND decided ORDER BY id LIMIT ${CLEANUP_CHUNK})`);
        // A decision's prompt and reply quote event data: they go with the events. The row stays,
        // so labels still say which call (model, events) they came from.
        const decisions = await chunked(
          `UPDATE decisions SET prompt = NULL, response = NULL WHERE id IN (SELECT id FROM decisions WHERE created_at < $1 AND (prompt IS NOT NULL OR response IS NOT NULL) LIMIT ${CLEANUP_CHUNK})`,
        );
        if (queue || events || decisions) log.info("cleanup", { requests_deleted: queue, events_deleted: events, decision_texts_cleared: decisions });
        return { queue, events };
      } finally {
        await lock.query("SELECT pg_advisory_unlock($1)", [CLEANUP_LOCK]).catch((e: Error) => (broken = e));
      }
    } finally {
      lock.release(broken);
    }
  }
}

/** Mark a batch decided, with each event's outcome. */
async function markDecided(c: Queryable, ws: string, ids: number[], outcome: (id: string) => EventOutcome): Promise<void> {
  const o = ids.map((id) => outcome(String(id)));
  await c.query(MARK_DECIDED, [ws, ids, o.map((x) => x.judgment), o.map((x) => x.flag), o.map((x) => x.decision)]);
}

/**
 * What the decider made of each event of a planned batch: an example's own judgment (an event
 * an alert cites is relevant), its followers' the same, a cached verdict's relevant or benign.
 * Events the classifier escalated alone, or dropped, have none.
 */
function outcomes(plan: Plan, decision: Decision, decisionId: string | null): Map<string, EventOutcome> {
  const out = new Map<string, EventOutcome>();
  const asked = new Set(plan.ask.map((a) => a.item.id));
  const cited = new Set(decision.flags.flatMap((f) => f.event_ids.map(String)).filter((id) => asked.has(id)));
  const judged = new Map((decision.judgments ?? []).map((j) => [String(j.event_id), j.relevance]));
  for (const { item } of plan.ask) {
    const judgment = cited.has(item.id) ? "relevant" : (judged.get(item.id) ?? null);
    out.set(item.id, { judgment, flag: null, decision: decisionId });
    for (const f of plan.followers.get(item.id) ?? []) out.set(f.id, { judgment, flag: null, decision: decisionId });
  }
  for (const { item, verdict } of plan.cached) out.set(item.id, { judgment: verdict.escalate ? "relevant" : "benign", flag: null, decision: null });
  return out;
}

/** What the decider said the call cost, in USD; 0 when it didn't say. */
function costOf(d: Decision): number {
  const c = d.record?.cost_usd;
  return typeof c === "number" && Number.isFinite(c) && c > 0 ? c : 0;
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

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
