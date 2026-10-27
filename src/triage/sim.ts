// The cascade over a stream in simulated time, without a database: what the worker does,
// batch for batch, but causal. A batch goes to the decider when the server would send it,
// and the answer takes effect (flags, verdict cache, escalations, earned suppression) only
// when it would have come back: the call's start plus its latency, with at most
// `concurrency` calls in flight. Events that arrive in the meantime are routed without it.
//
// Used by the regression scenarios (scenarios.ts), the benchmark replay (ml/evaluate.ts) and
// the demo recordings (ml/export-demo.ts), so all of them decide like the server.
import { applyVerdicts, planBatch, routeEvent, verdictKey, type FullRoute, type Outcome, type Pending, type Plan, type RouteOptions } from "./cascade.ts";
import type { RoutingState } from "./routing.ts";
import type { Decision, Severity } from "../types.ts";

export interface SimEvent {
  id: string;
  t: number;
  score: number | null;
  template: string;
  severity?: string;
  novel: boolean;
  rate?: number;
  serviceErrors?: number;
}

export interface SimFlag {
  id: string;
  /** When the flag was raised: when the decider's answer came back. */
  created: number;
  updated: number;
  reason: string;
  severity: Severity;
  via: "decider" | "classifier" | "fallback";
  events: string[];
  templates: string[];
  /** Events added later (cached "yes" verdicts, or alerts that update it), and when. */
  additions: { t: number; ids: string[] }[];
}

/** How an event reached the decider: shown, standing in a shown example's group, or added to a flag. */
export type Reach = "asked" | "follower" | "attached";

export interface DecideResult {
  decision: Decision;
  latencyMs: number;
}

export interface SimHooks {
  /**
   * Ask the decider about these examples. `null` means it is unavailable: the classifier's
   * own threshold decides those events, and nothing is learned.
   */
  decide?(asked: Plan["ask"], openFlags: SimFlag[], start: number): Promise<DecideResult | null>;
  /** Override the route, for baselines (keyword rule, everything to the decider). */
  route?(e: SimEvent, route: FullRoute): FullRoute;
  /** An answer took effect. */
  outcome?(o: { plan: Plan; out: Outcome; at: number; asked: number; flagIds: string[]; answered: boolean }): void;
  /** Events reached the decider, or were added to a flag. */
  reached?(ids: string[], how: Reach, t: number): void;
}

export interface SimOptions {
  route: Omit<RouteOptions, "rand"> & { rand?: () => number };
  batchSize?: number;
  batchWaitMs?: number;
  auditWaitMs?: number;
  perTemplate?: number;
  concurrency?: number;
  /** Learn from answers (verdict cache, escalations, suppression). Off for baselines. */
  learn?: boolean;
  idPrefix?: string;
}

interface Effect {
  at: number;
  apply(): void;
}

export class CascadeSim {
  readonly flags: SimFlag[] = [];
  readonly routed: Record<string, number> = {};
  asked = 0;
  calls = 0;
  unavailable = 0;
  readonly state: RoutingState;
  #o: Required<Omit<SimOptions, "route">> & { route: SimOptions["route"] };
  #hooks: SimHooks;
  #pending: Pending[] = [];
  #oldest = 0;
  #oldestUrgent: number | null = null;
  #effects: Effect[] = [];
  #slots: number[];
  #flagById = new Map<string, SimFlag>();
  #n = 0;

  constructor(state: RoutingState, o: SimOptions, hooks: SimHooks = {}) {
    this.state = state;
    this.#o = { batchSize: 100, batchWaitMs: 10_000, auditWaitMs: 300_000, perTemplate: 3, concurrency: 2, learn: true, idPrefix: "flag", ...o };
    this.#hooks = hooks;
    this.#slots = Array.from({ length: Math.max(1, this.#o.concurrency) }, () => -Infinity);
  }

  /** Route one event (in time order) and send a batch when one is due. */
  async push(e: SimEvent): Promise<FullRoute> {
    this.#applyDue(e.t);
    const wait = this.#o.batchWaitMs;
    if (this.#pending.length && (this.#pending.length >= this.#o.batchSize || e.t - (this.#oldestUrgent ?? this.#oldest + this.#o.auditWaitMs - wait) >= wait)) {
      await this.#flush(e.t);
      this.#applyDue(e.t);
    }
    const facts = { template: e.template, severity: e.severity, novel: e.novel, rate: e.rate, serviceErrors: e.serviceErrors };
    let route = this.#o.learn ? this.state.route(e.score, this.#o.route, facts, e.t) : routeEvent(e.score, this.#o.route, e.novel);
    if (this.#hooks.route) route = this.#hooks.route(e, route);
    this.routed[route] = (this.routed[route] ?? 0) + 1;
    if (route === "drop") return route;
    if (!this.#pending.length) this.#oldest = e.t;
    if (route !== "audit" && this.#oldestUrgent === null) this.#oldestUrgent = e.t;
    this.#pending.push({ id: e.id, template: e.template, score: e.score, route, severity: e.severity, rate: e.rate, serviceErrors: e.serviceErrors });
    return route;
  }

  /** Send what is waiting and let every answer take effect. Returns the time the last one did. */
  async finish(now: number): Promise<number> {
    await this.#flush(now);
    const last = Math.max(now, ...this.#effects.map((x) => x.at));
    this.#applyDue(Infinity);
    return last;
  }

  /** Ids of events waiting for a batch (audits can wait minutes). */
  pendingIds(): string[] {
    return this.#pending.map((p) => p.id);
  }

  #applyDue(t: number): void {
    if (!this.#effects.length) return;
    this.#effects.sort((a, b) => a.at - b.at);
    while (this.#effects.length && this.#effects[0]!.at <= t) this.#effects.shift()!.apply();
  }

  async #flush(now: number): Promise<void> {
    const batch = this.#pending;
    this.#pending = [];
    this.#oldestUrgent = null;
    if (!batch.length) return;
    // A cached "escalate" only holds while its flag exists; in a simulation flags stay open.
    const plan = planBatch(batch, this.state.cache, now, this.#o.perTemplate);
    let decision: Decision = { flags: [] };
    let answered = true;
    let at = now;
    if (plan.ask.length) {
      this.asked += plan.ask.length;
      this.calls += Math.ceil(plan.ask.length / this.#o.batchSize);
      // The next free call slot: at most `concurrency` calls in flight.
      const slot = this.#slots.indexOf(Math.min(...this.#slots));
      const start = Math.max(now, this.#slots[slot]!);
      const res = this.#hooks.decide ? await this.#hooks.decide(plan.ask, this.#openFlags(start), start) : null;
      at = start + (res?.latencyMs ?? 0);
      this.#slots[slot] = at;
      if (res) decision = res.decision;
      else {
        answered = false;
        this.unavailable += plan.ask.length;
        const hot = plan.ask.filter(({ item }) => (item.score ?? 0) >= this.#o.route.threshold).map(({ item }) => item.id);
        if (hot.length) decision = { flags: [{ reason: "classifier fallback", severity: "medium", event_ids: hot }] };
      }
      const askedIds = plan.ask.map((a) => a.item.id);
      const followerIds = plan.ask.flatMap((a) => (plan.followers.get(a.item.id) ?? []).map((f) => f.id));
      this.#hooks.reached?.(askedIds, "asked", start);
      if (followerIds.length) this.#hooks.reached?.(followerIds, "follower", start);
    }
    const out = applyVerdicts(plan, decision);
    this.#effects.push({ at, apply: () => this.#apply(batch, plan, out, at, answered) });
  }

  #apply(batch: Pending[], plan: Plan, out: Outcome, at: number, answered: boolean): void {
    const flagIds: string[] = [];
    for (const f of out.flags) {
      const flag: SimFlag = {
        id: `${this.#o.idPrefix}-${++this.#n}`,
        created: at,
        updated: at,
        reason: f.reason,
        severity: f.severity,
        via: f.reason === "classifier fallback" ? "fallback" : f.via,
        events: f.event_ids,
        templates: f.templates,
        additions: [],
      };
      this.flags.push(flag);
      this.#flagById.set(flag.id, flag);
      flagIds.push(flag.id);
    }
    for (const [fid, ids] of out.attach) {
      const f = this.#flagById.get(fid);
      if (!f) continue;
      f.additions.push({ t: at, ids });
      f.updated = at;
      this.#hooks.reached?.(ids, "attached", at);
    }
    if (this.#o.learn && answered) this.state.learn(batch, out, at, flagIds);
    else {
      // Unanswered, or a baseline that doesn't learn: still group a burst behind its flag.
      out.verdicts.forEach((v, key) => v.escalate && this.state.cache.set(key, true, at, typeof v.flag === "number" ? flagIds[v.flag] : v.flag));
    }
    this.#hooks.outcome?.({ plan, out, at, asked: plan.ask.length, flagIds, answered });
  }

  #openFlags(now: number): SimFlag[] {
    return this.flags
      .filter((f) => f.created <= now)
      .sort((a, b) => b.updated - a.updated)
      .slice(0, 20);
  }
}

