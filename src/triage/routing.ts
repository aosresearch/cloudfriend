// What the cascade remembers between batches, and how it routes with it. Browser-safe, and
// used by the server, the benchmark replay, the demo export and the regression scenarios, so
// all of them decide the same way.
//
//   escalations  templates Jev judged relevant or a person escalated. Within `ttl` every event
//                of one goes to Jev (route `known`). After that, up to `memory`, the next event
//                goes to Jev once (route `review`): relevant renews the protection, benign
//                retires it. Silence never ends it. A benign judgment while protected ends it
//                too, once the last escalation is an hour old: Jev says the incident is over.
//   suppression  the classifier may only drop an event whose key (template and severity) Jev
//                or a person has judged benign within `ttl`, in a similar context: the template
//                no more than 5x as frequent, and its service not suddenly erroring. Everything
//                else goes to Jev (route `review`) until it has earned that.
//   verdicts     the short-lived verdict cache that groups bursts (`VerdictCache`).
import { routeEvent, VerdictCache, verdictKey, type FullRoute, type Outcome, type Pending, type RouteOptions } from "./cascade.ts";

/** A template or service this many times busier than when judged is a new situation. */
export const CONTEXT_BURST = 5;
/** Service errors (last 10 minutes) below this never count as a change of context. */
export const SERVICE_ERROR_FLOOR = 10;
/** A benign judgment this long after the last relevant one ends an escalation: the incident is over. */
export const ESCALATION_SETTLE_MS = 3_600_000;

const NEVER = -Infinity;

/** The template part of a verdict key (`template#severity`). */
export const templateOfKey = (key: string) => key.slice(0, key.lastIndexOf("#"));

export class EscalationMemory {
  #map = new Map<string, number>();
  readonly ttlMs: number;
  readonly memoryMs: number;
  readonly max: number;
  constructor(ttlMs: number, memoryMs = Math.max(ttlMs, 90 * 86_400_000), max = 100_000) {
    this.ttlMs = ttlMs;
    this.memoryMs = ttlMs > 0 ? Math.max(memoryMs, ttlMs) : 0;
    this.max = max;
  }

  /** `protected` within the TTL, `review` after it (until the memory runs out), else null. */
  status(template: string, now: number): "protected" | "review" | null {
    const t = this.#map.get(template);
    if (t === undefined) return null;
    const age = now - t;
    if (age <= this.ttlMs) return "protected";
    if (age <= this.memoryMs) return "review";
    this.#map.delete(template);
    return null;
  }

  has(template: string, now: number): boolean {
    return this.status(template, now) === "protected";
  }

  /** When the template was last escalated, if it is remembered. */
  lastAt(template: string): number | undefined {
    return this.#map.get(template);
  }

  /**
   * Jev judged the template benign at `now`. Within the review window that retires it; while
   * protected, it does once the last escalation is at least an hour old (the incident is over).
   */
  judgedBenign(template: string, now: number): void {
    const status = this.status(template, now);
    const last = this.#map.get(template);
    if (status === "review" || (status === "protected" && last !== undefined && now - last >= ESCALATION_SETTLE_MS)) this.#map.delete(template);
  }

  add(template: string, at: number): void {
    if (this.ttlMs <= 0) return;
    const prev = this.#map.get(template);
    this.#map.delete(template);
    this.#map.set(template, Math.max(prev ?? NEVER, at));
    if (this.#map.size > this.max) for (const k of [...this.#map.keys()].slice(0, this.max / 10)) this.#map.delete(k);
  }

  retire(template: string): void {
    this.#map.delete(template);
  }

  /** Same as retire; kept for callers of the old EscalatedTemplates. */
  delete(template: string): void {
    this.#map.delete(template);
  }

  get size(): number {
    return this.#map.size;
  }
}

interface Earned {
  benignAt: number;
  relevantAt: number;
  /** Context when last judged benign: the template's 1-minute rate, its service's 10-minute errors. */
  rate: number;
  serviceErrors: number;
}

export class SuppressionLedger {
  #map = new Map<string, Earned>();
  /** How long a benign judgment lets the classifier drop its key. 0 = off: dropping needs no judgment. */
  readonly ttlMs: number;
  readonly max: number;
  constructor(ttlMs: number, max = 200_000) {
    this.ttlMs = ttlMs;
    this.max = max;
  }

  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  /** May the classifier drop an event of this key, now, in this context? */
  earned(key: string, now: number, rate = 0, serviceErrors = 0): boolean {
    if (!this.enabled) return true;
    const r = this.#map.get(key);
    if (!r || r.benignAt <= r.relevantAt || now - r.benignAt > this.ttlMs) return false;
    if (rate > CONTEXT_BURST * Math.max(r.rate, 1)) return false;
    if (serviceErrors >= SERVICE_ERROR_FLOOR && serviceErrors > CONTEXT_BURST * Math.max(r.serviceErrors, 1)) return false;
    return true;
  }

  benign(key: string, at: number, rate = 0, serviceErrors = 0): void {
    if (!this.enabled) return;
    const r = this.#map.get(key) ?? { benignAt: NEVER, relevantAt: NEVER, rate: 0, serviceErrors: 0 };
    if (at < r.benignAt) return;
    this.#put(key, { ...r, benignAt: at, rate, serviceErrors });
  }

  relevant(key: string, at: number): void {
    if (!this.enabled) return;
    const r = this.#map.get(key) ?? { benignAt: NEVER, relevantAt: NEVER, rate: 0, serviceErrors: 0 };
    this.#put(key, { ...r, relevantAt: Math.max(r.relevantAt, at) });
  }

  /** A person said a template matters: no severity of it is suppressed until judged benign again. */
  relevantTemplate(template: string, at: number): void {
    // Collect first: relevant() re-inserts the key, which a live Map iteration would visit again.
    for (const k of [...this.#map.keys()].filter((k) => templateOfKey(k) === template)) this.relevant(k, at);
  }

  #put(key: string, r: Earned): void {
    this.#map.delete(key);
    this.#map.set(key, r);
    if (this.#map.size > this.max) for (const k of [...this.#map.keys()].slice(0, this.max / 10)) this.#map.delete(k);
  }

  get size(): number {
    return this.#map.size;
  }
}

export interface RoutingOptions {
  verdictTtlMs: number;
  /** CLOUDFRIEND_ESCALATED_TTL: 0 turns escalation protection off. */
  escalatedTtlMs: number;
  /** CLOUDFRIEND_ESCALATED_MEMORY: how long an expired protection still triggers a review. */
  escalatedMemoryMs?: number;
  /** CLOUDFRIEND_SUPPRESSION_TTL: 0 lets the classifier drop without earned suppression. */
  suppressionTtlMs: number;
}

/** What routing needs to know about one event besides its score. */
export interface RouteFacts {
  template: string;
  severity?: string;
  novel: boolean;
  /** The template's events in the last minute, and its service's errors in the last 10. */
  rate?: number;
  serviceErrors?: number;
}

/** One label as stored, for rebuilding the state after a restart. Oldest first. */
export interface LabelFact {
  template: string | null;
  severity: string | null;
  y: number;
  source: string;
  provenance: string | null;
  at: number;
  rate: number | null;
  serviceErrors: number | null;
}

export class RoutingState {
  readonly cache: VerdictCache;
  readonly escalated: EscalationMemory;
  readonly ledger: SuppressionLedger;
  constructor(o: RoutingOptions) {
    this.cache = new VerdictCache(o.verdictTtlMs);
    this.escalated = new EscalationMemory(o.escalatedTtlMs, o.escalatedMemoryMs);
    this.ledger = new SuppressionLedger(o.suppressionTtlMs);
  }

  route(score: number | null, o: RouteOptions, f: RouteFacts, now: number): FullRoute {
    const protection = this.escalated.status(f.template, now);
    const unearned = !this.ledger.earned(verdictKey(f), now, f.rate, f.serviceErrors);
    return routeEvent(score, o, f.novel, protection === "protected", protection === "review" || unearned);
  }

  /**
   * Take in one batch's outcome. `batch` holds the context each item was routed with;
   * `flagIds` maps the outcome's new flags to their ids.
   */
  learn(batch: Pending[], out: Outcome, now: number, flagIds: (string | undefined)[]): void {
    const ctx = new Map(batch.map((b) => [verdictKey(b), b]));
    const top = new Map<string, number>();
    for (const b of batch) if (b.score !== null) top.set(verdictKey(b), Math.max(top.get(verdictKey(b)) ?? 0, b.score));
    out.verdicts.forEach((v, key) => {
      const b = ctx.get(key);
      this.cache.set(key, v.escalate, now, typeof v.flag === "number" ? flagIds[v.flag] : v.flag, b?.rate, top.get(key));
      if (!v.escalate && v.judged) {
        this.ledger.benign(key, now, b?.rate ?? 0, b?.serviceErrors ?? 0);
        const t = templateOfKey(key);
        if (!out.relevant.has(t)) this.escalated.judgedBenign(t, now);
      }
    });
    for (const k of out.relevantKeys) this.ledger.relevant(k, now);
    for (const t of out.relevant) this.escalated.add(t, now);
    for (const f of out.flags) if (f.via === "decider") for (const t of f.templates) this.escalated.add(t, now);
  }

  /**
   * A person's verdict on a kind of event, applied at once. "Escalate" protects the template,
   * revokes its earned suppression and clears any cached "no"; "don't" retires the protection
   * and earns suppression in the context given. `cacheNo` also caches a "no" for the key.
   */
  personSaid(template: string, severity: string | undefined, escalate: boolean, now: number, ctx: { rate?: number; serviceErrors?: number } = {}, cacheNo = false): void {
    const key = verdictKey({ template, severity });
    if (escalate) {
      this.cache.deleteTemplate(template);
      this.escalated.add(template, now);
      this.ledger.relevantTemplate(template, now);
      this.ledger.relevant(key, now);
      return;
    }
    if (cacheNo) this.cache.set(key, false, now);
    this.escalated.retire(template);
    this.ledger.benign(key, now, ctx.rate ?? 0, ctx.serviceErrors ?? 0);
  }

  /** Rebuild escalations and earned suppression from stored labels (oldest first). */
  rebuild(labels: Iterable<LabelFact>): void {
    for (const l of labels) {
      if (!l.template || l.provenance === "follower") continue;
      const key = verdictKey({ template: l.template, severity: l.severity ?? undefined });
      if (l.y) {
        this.escalated.add(l.template, l.at);
        this.ledger.relevant(key, l.at);
        continue;
      }
      this.ledger.benign(key, l.at, l.rate ?? 0, l.serviceErrors ?? 0);
      if (l.source === "human") this.escalated.retire(l.template);
      else this.escalated.judgedBenign(l.template, l.at);
    }
  }

  /** How far back `rebuild` needs labels. */
  get horizonMs(): number {
    return Math.max(this.escalated.memoryMs, this.ledger.ttlMs);
  }
}
