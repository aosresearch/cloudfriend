// The two-stage cascade, minus storage. Browser-safe; used by the worker, the benchmark
// harness (ml/evaluate.ts) and the website demo, so all three make the same decisions.
//
//   1. route   every event gets a classifier score. Below `drop_below` it is done: not
//              escalated, no cost, unless it is an error-like event of a kind never seen
//              before, which Jev always sees once. A small random share of the rest is still
//              sent to Jev as an audit, which is how missed escalations (false negatives) get found.
//              A template Jev or a person escalated recently also always goes to Jev.
//   2. plan    the events headed for Jev are grouped by template. Templates Jev ruled on in
//              the last `ttl` reuse that verdict. Otherwise at most `perTemplate` examples
//              per template go to Jev, and the rest follow their example's verdict.
//   3. apply   Jev's flags are expanded to the followers, verdicts are cached, and every
//              event Jev saw becomes a training label.
import type { Route } from "./classifier.ts";
import type { FlagDraft, Severity } from "../types.ts";

export type FullRoute = Route | "audit" | "novel" | "known" | "classifier";

export interface RouteOptions {
  dropBelow: number;
  escalateAbove: number;
  /** Used instead of the two thresholds when there is no Jev: escalate at or above it. */
  threshold: number;
  hasJev: boolean;
  /** Share of dropped events sent to Jev anyway, 0..1. */
  auditRate: number;
  /** Send error-like events of a never-seen template to Jev whatever their score (default on). */
  novelGuard?: boolean;
  rand?: () => number;
}

/**
 * Where one scored event goes. With no classifier (score null) everything goes to Jev.
 * `novel`: an error-like event of a never-seen template. `known`: a template Jev or a person
 * escalated recently. Both reach Jev whatever the score, so the classifier can never drop
 * the next instance of something that was escalated.
 */
export function routeEvent(score: number | null, o: RouteOptions, novel = false, known = false): FullRoute {
  if (score === null) return o.hasJev ? "jev" : "drop";
  if (!o.hasJev) return score >= o.threshold ? "classifier" : "drop";
  if (score >= o.escalateAbove) return "auto";
  if (score >= o.dropBelow) return "jev";
  if (known) return "known";
  if (novel && o.novelGuard !== false) return "novel";
  return o.auditRate > 0 && (o.rand ?? Math.random)() < o.auditRate ? "audit" : "drop";
}

export interface Pending {
  id: string;
  template: string;
  score: number | null;
  route: FullRoute;
}

export interface Verdict {
  escalate: boolean;
  /** The flag later events of this template are added to, while the verdict lasts. */
  flagId?: string;
  until: number;
}

/** Recent verdicts by template, so a burst of the same error costs one Jev call. */
export class VerdictCache {
  #map = new Map<string, Verdict>();
  readonly ttlMs: number;
  readonly max: number;
  constructor(ttlMs: number, max = 50_000) {
    this.ttlMs = ttlMs;
    this.max = max;
  }

  get(template: string, now: number): Verdict | undefined {
    const v = this.#map.get(template);
    if (!v) return undefined;
    if (v.until < now) {
      this.#map.delete(template);
      return undefined;
    }
    return v;
  }

  set(template: string, escalate: boolean, now: number, flagId?: string): void {
    if (this.ttlMs <= 0) return;
    this.#map.delete(template);
    this.#map.set(template, { escalate, flagId, until: now + this.ttlMs });
    if (this.#map.size > this.max) for (const k of [...this.#map.keys()].slice(0, this.max / 10)) this.#map.delete(k);
  }

  delete(template: string): void {
    this.#map.delete(template);
  }

  get size(): number {
    return this.#map.size;
  }
}

export interface Plan {
  /** Sent to Jev, one entry per example, with how many followers share its verdict. */
  ask: { item: Pending; similar: number }[];
  /** Example id -> events with the same template that take the example's verdict. */
  followers: Map<string, Pending[]>;
  /** Decided by a cached verdict, without asking Jev. */
  cached: { item: Pending; verdict: Verdict }[];
  /** Escalated on the classifier alone (route auto or classifier), grouped by template. */
  direct: Map<string, Pending[]>;
}

export function planBatch(items: Pending[], cache: VerdictCache, now: number, perTemplate = 3): Plan {
  const plan: Plan = { ask: [], followers: new Map(), cached: [], direct: new Map() };
  const byTemplate = new Map<string, Pending[]>();
  for (const it of items) {
    if (it.route === "auto" || it.route === "classifier") {
      const v = cache.get(it.template, now);
      if (v?.escalate) {
        plan.cached.push({ item: it, verdict: v });
        continue;
      }
      const g = plan.direct.get(it.template) ?? [];
      g.push(it);
      plan.direct.set(it.template, g);
      continue;
    }
    if (it.route === "drop") continue;
    const v = cache.get(it.template, now);
    if (v) {
      plan.cached.push({ item: it, verdict: v });
      continue;
    }
    const g = byTemplate.get(it.template) ?? [];
    g.push(it);
    byTemplate.set(it.template, g);
  }
  for (const group of byTemplate.values()) {
    const examples = group.slice(0, perTemplate);
    const rest = group.slice(perTemplate);
    examples.forEach((ex, i) => {
      // Spread the followers over the examples so each verdict covers its share.
      const mine = rest.filter((_, j) => j % examples.length === i);
      plan.ask.push({ item: ex, similar: mine.length });
      if (mine.length) plan.followers.set(ex.id, mine);
    });
  }
  return plan;
}

export interface Outcome {
  /** New flags, each with its examples' followers added. */
  flags: (FlagDraft & { templates: string[]; via: "decider" | "classifier" })[];
  /** Events added to flags that already exist (cached positive verdicts), by flag id. */
  attach: Map<string, string[]>;
  /** Training labels from Jev: every example and follower Jev's verdict covers. */
  labels: { id: string; y: 0 | 1; route: FullRoute }[];
  /** Verdicts to cache once the new flags have ids: template -> index into `flags`, or -1 for "no". */
  verdicts: Map<string, number>;
}

/** Combine Jev's flags (over the asked examples) with the rest of the plan. */
export function applyVerdicts(plan: Plan, drafts: FlagDraft[], maxFollowerLabels = 10): Outcome {
  const out: Outcome = { flags: [], attach: new Map(), labels: [], verdicts: new Map() };
  const byId = new Map(plan.ask.map((a) => [a.item.id, a.item]));
  const flagged = new Set<string>();
  for (const d of drafts) {
    const ids = new Set<string>();
    const templates = new Set<string>();
    for (const id of d.event_ids) {
      const it = byId.get(id);
      if (!it) continue;
      ids.add(id);
      templates.add(it.template);
      flagged.add(id);
      for (const f of plan.followers.get(id) ?? []) ids.add(f.id);
    }
    if (!ids.size) continue;
    const index = out.flags.push({ ...d, event_ids: [...ids], templates: [...templates], via: "decider" }) - 1;
    for (const t of templates) out.verdicts.set(t, index);
  }
  for (const { item } of plan.ask) {
    const y = flagged.has(item.id) ? 1 : 0;
    out.labels.push({ id: item.id, y, route: item.route });
    for (const f of (plan.followers.get(item.id) ?? []).slice(0, maxFollowerLabels)) out.labels.push({ id: f.id, y, route: f.route });
    if (!y && !out.verdicts.has(item.template)) out.verdicts.set(item.template, -1);
  }
  for (const { item, verdict } of plan.cached) {
    if (!verdict.escalate || !verdict.flagId) continue;
    const list = out.attach.get(verdict.flagId) ?? [];
    list.push(item.id);
    out.attach.set(verdict.flagId, list);
  }
  for (const [template, group] of plan.direct) {
    const top = Math.max(...group.map((g) => g.score ?? 0));
    out.flags.push({
      reason: `Classifier escalation (score ${top.toFixed(2)}): ${group.length}× ${template.split("|").slice(1).join(": ").slice(0, 120)}`,
      severity: severityFromScore(top),
      event_ids: group.map((g) => g.id),
      templates: [template],
      via: "classifier",
    });
    out.verdicts.set(template, out.flags.length - 1);
  }
  return out;
}

export function severityFromScore(score: number): Severity {
  return score >= 0.97 ? "high" : score >= 0.85 ? "medium" : "low";
}

/**
 * Templates that were escalated recently (by Jev or a person), and when. Events of these
 * templates always reach Jev; a person's "false positive" takes a template off the list.
 */
export class EscalatedTemplates {
  #map = new Map<string, number>();
  readonly ttlMs: number;
  readonly max: number;
  constructor(ttlMs: number, max = 100_000) {
    this.ttlMs = ttlMs;
    this.max = max;
  }

  has(template: string, now: number): boolean {
    const t = this.#map.get(template);
    if (t === undefined) return false;
    if (now - t > this.ttlMs) {
      this.#map.delete(template);
      return false;
    }
    return true;
  }

  add(template: string, at: number): void {
    if (this.ttlMs <= 0) return;
    this.#map.delete(template);
    this.#map.set(template, at);
    if (this.#map.size > this.max) for (const k of [...this.#map.keys()].slice(0, this.max / 10)) this.#map.delete(k);
  }

  delete(template: string): void {
    this.#map.delete(template);
  }

  get size(): number {
    return this.#map.size;
  }
}
