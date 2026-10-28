// The two-stage cascade, minus storage. Browser-safe; used by the worker, the benchmark
// harness (ml/evaluate.ts) and the website demo, so all three make the same decisions.
//
//   1. route   every event gets a classifier score. Below `drop_below` it is done: not
//              escalated, no cost, unless it is an error-like event of a kind never seen
//              before, which Jev always sees once. A small random share of the rest is still
//              sent to Jev as an audit, which is how missed escalations (false negatives) get found.
//              A template Jev or a person escalated recently also always goes to Jev, and so
//              does anything whose kind hasn't earned suppression yet (routing.ts).
//   2. plan    the events headed for Jev are grouped by template. Templates Jev ruled on in
//              the last `ttl` reuse that verdict. Otherwise at most `perTemplate` examples
//              per template go to Jev, and the rest follow their example's verdict.
//   3. apply   Jev's flags are expanded to the followers, verdicts are cached, and every
//              event Jev saw becomes a training label.
import type { Route } from "./classifier.ts";
import type { Decision, FlagDraft, Severity } from "../types.ts";

export type FullRoute = Route | "audit" | "novel" | "known" | "review" | "classifier";

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
 * escalated recently. `review`: an event the classifier may not drop yet, because its kind
 * hasn't earned suppression or its protection expired (see routing.ts). All three reach Jev
 * whatever the score, so the classifier can never drop the next instance of something that
 * was escalated.
 */
export function routeEvent(score: number | null, o: RouteOptions, novel = false, known = false, review = false): FullRoute {
  if (score === null) return o.hasJev ? "jev" : "drop";
  if (!o.hasJev) return score >= o.threshold ? "classifier" : "drop";
  if (score >= o.escalateAbove) return "auto";
  if (score >= o.dropBelow) return "jev";
  if (known) return "known";
  if (novel && o.novelGuard !== false) return "novel";
  if (review) return "review";
  return o.auditRate > 0 && (o.rand ?? Math.random)() < o.auditRate ? "audit" : "drop";
}

export interface Pending {
  id: string;
  template: string;
  score: number | null;
  route: FullRoute;
  /** Level and status class, e.g. `e5` for an error with a 5xx. Verdicts never cross buckets. */
  severity?: string;
  /** How many of this template arrived in the last minute (all of them, dropped included). */
  rate?: number;
  /** Errors from the template's service in the last 10 minutes. */
  serviceErrors?: number;
}

/** The unit a verdict is about: the same message at the same severity. */
export const verdictKey = (p: Pick<Pending, "template" | "severity">) => `${p.template}#${p.severity ?? ""}`;

/** `e5`, `w4`, `i`, ...: the level (debug/info `i`, warn `w`, error and worse `e`) and status class. */
export function severityBucket(level: number, status: number): string {
  const l = Number.isNaN(level) ? "?" : level >= 3 ? "e" : level === 2 ? "w" : "i";
  return Number.isNaN(status) ? l : `${l}${Math.floor(status / 100)}`;
}

/**
 * A cached "no" stops applying once the template runs twice as fast as when it was given, and
 * at least 5 more a minute: a growing failure gets a fresh look at each doubling, which costs
 * a few calls per burst. (Earned suppression, which lasts longer, uses 5x: routing.ts.)
 */
export const NEGATIVE_GROWTH = 2;
export const NEGATIVE_GROWTH_MIN = 5;

export interface Verdict {
  escalate: boolean;
  /** The flag later events of this template are added to, while the verdict lasts. */
  flagId?: string;
  until: number;
  /** The template's 1-minute rate when the verdict was given. */
  rate?: number;
  /** The highest classifier score among the events it was given for. */
  score?: number;
}

/** A cached "no" stops applying to an event the classifier scores this much higher (log-odds). */
export const NEGATIVE_SCORE_SHIFT = 2;
const logit = (p: number) => Math.log(Math.min(Math.max(p, 1e-9), 1 - 1e-9) / (1 - Math.min(Math.max(p, 1e-9), 1 - 1e-9)));

/** Recent verdicts by template and severity, so a burst of the same error costs one Jev call. */
export class VerdictCache {
  #map = new Map<string, Verdict>();
  readonly ttlMs: number;
  readonly max: number;
  constructor(ttlMs: number, max = 50_000) {
    this.ttlMs = ttlMs;
    this.max = max;
  }

  /**
   * The verdict for `key`, unless it expired. A "no" also ends when the template is now
   * bursting, and doesn't apply to an event the classifier scores far above the ones it was
   * given for: both mean the situation changed (the "no" is kept for the others).
   */
  get(key: string, now: number, rate?: number, score?: number | null): Verdict | undefined {
    const v = this.#map.get(key);
    if (!v) return undefined;
    const base = v.rate ?? 0;
    const burst = !v.escalate && rate !== undefined && rate > Math.max(NEGATIVE_GROWTH * base, base + NEGATIVE_GROWTH_MIN);
    if (v.until < now || burst) {
      this.#map.delete(key);
      return undefined;
    }
    if (!v.escalate && score != null && v.score !== undefined && logit(score) > logit(v.score) + NEGATIVE_SCORE_SHIFT) return undefined;
    return v;
  }

  set(key: string, escalate: boolean, now: number, flagId?: string, rate?: number, score?: number): void {
    if (this.ttlMs <= 0) return;
    this.#map.delete(key);
    this.#map.set(key, { escalate, flagId, until: now + this.ttlMs, rate, score });
    if (this.#map.size > this.max) for (const k of [...this.#map.keys()].slice(0, this.max / 10)) this.#map.delete(k);
  }

  delete(key: string): void {
    this.#map.delete(key);
  }

  /** Drop every verdict about a template, at any severity. */
  deleteTemplate(template: string): void {
    for (const k of this.#map.keys()) if (k.startsWith(`${template}#`)) this.#map.delete(k);
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

/** Routes that exist to get a second look: a cached "no" must not answer for them. */
// `known` events may use a recent "no": Jev looked at the escalated kind again and said it is
// fine for now, and the "no" still ends on a burst, a score jump, or after its TTL.
const BYPASS_NEGATIVE = new Set<FullRoute>(["audit", "novel", "review"]);

export function planBatch(items: Pending[], cache: VerdictCache, now: number, perTemplate = 3): Plan {
  const plan: Plan = { ask: [], followers: new Map(), cached: [], direct: new Map() };
  const byKey = new Map<string, Pending[]>();
  for (const it of items) {
    const key = verdictKey(it);
    if (it.route === "auto" || it.route === "classifier") {
      const v = cache.get(key, now, it.rate, it.score);
      if (v?.escalate) {
        plan.cached.push({ item: it, verdict: v });
        continue;
      }
      const g = plan.direct.get(key) ?? [];
      g.push(it);
      plan.direct.set(key, g);
      continue;
    }
    if (it.route === "drop") continue;
    const v = cache.get(key, now, it.rate, it.score);
    if (v && (v.escalate || !BYPASS_NEGATIVE.has(it.route))) {
      plan.cached.push({ item: it, verdict: v });
      continue;
    }
    const g = byKey.get(key) ?? [];
    g.push(it);
    byKey.set(key, g);
  }
  for (const group of byKey.values()) {
    // A kind sent only for review (it hasn't earned suppression, or its protection expired)
    // needs one look; the classifier's uncertain cases get up to `perTemplate`.
    const examples = group.slice(0, group.every((g) => g.route === "review") ? 1 : perTemplate);
    const rest = group.slice(examples.length);
    examples.forEach((ex, i) => {
      // Spread the followers over the examples so each verdict covers its share.
      const mine = rest.filter((_, j) => j % examples.length === i);
      plan.ask.push({ item: ex, similar: mine.length });
      if (mine.length) plan.followers.set(ex.id, mine);
    });
  }
  return plan;
}

export interface Label {
  id: string;
  y: 0 | 1;
  route: FullRoute;
  /** Took its example's judgment without being shown: weaker evidence. */
  follower: boolean;
}

export interface Outcome {
  /** New flags, each with its examples' followers added. */
  flags: (FlagDraft & { templates: string[]; via: "decider" | "classifier" })[];
  /** Events added to flags that already exist (cached positives, or alerts that update one), by flag id. */
  attach: Map<string, string[]>;
  /** Training labels: only from explicit judgments (or citation in an alert), never from silence. */
  labels: Label[];
  /**
   * Verdicts to cache, by verdict key: escalate with an index into `flags` or an existing flag
   * id, or a "no" when every example of the key was explicitly judged benign.
   */
  verdicts: Map<string, { escalate: boolean; flag?: number | string; judged?: boolean }>;
  /** Templates with an event judged relevant: they keep reaching Jev (route known). */
  relevant: Set<string>;
  /** Verdict keys with an example judged relevant: no longer suppressed (routing.ts). */
  relevantKeys: Set<string>;
}

/**
 * Combine the decider's answer for the asked examples with the rest of the plan. Accepts a
 * Decision with judgments, or v0 flag drafts (which give positive labels for cited events
 * and nothing else).
 */
export function applyVerdicts(plan: Plan, answer: FlagDraft[] | Decision, maxFollowerLabels = 10): Outcome {
  const decision = Array.isArray(answer) ? { flags: answer } : answer;
  const out: Outcome = { flags: [], attach: new Map(), labels: [], verdicts: new Map(), relevant: new Set(), relevantKeys: new Set() };
  const byId = new Map(plan.ask.map((a) => [a.item.id, a.item]));
  const cited = new Set<string>();
  const attach = (flagId: string, ids: string[]) => out.attach.set(flagId, [...(out.attach.get(flagId) ?? []), ...ids]);
  for (const d of decision.flags) {
    const ids = new Set<string>();
    const templates = new Set<string>();
    const keys = new Set<string>();
    for (const id of d.event_ids) {
      const it = byId.get(id);
      if (!it) continue;
      ids.add(id);
      templates.add(it.template);
      keys.add(verdictKey(it));
      cited.add(id);
      for (const f of plan.followers.get(id) ?? []) ids.add(f.id);
    }
    if (!ids.size) continue;
    if (d.update) {
      attach(d.update, [...ids]);
      for (const k of keys) out.verdicts.set(k, { escalate: true, flag: d.update });
      continue;
    }
    const { update: _, ...draft } = d;
    const index = out.flags.push({ ...draft, event_ids: [...ids], templates: [...templates], via: "decider" }) - 1;
    for (const k of keys) out.verdicts.set(k, { escalate: true, flag: index });
  }
  const judged = new Map((decision.judgments ?? []).map((j) => [j.event_id, j.relevance]));
  const benignByKey = new Map<string, boolean>();
  for (const { item } of plan.ask) {
    const key = verdictKey(item);
    const rel = cited.has(item.id) ? "relevant" : judged.get(item.id);
    benignByKey.set(key, (benignByKey.get(key) ?? true) && rel === "benign");
    if (rel !== "relevant" && rel !== "benign") continue; // uncertain or silent: no label
    const y = rel === "relevant" ? 1 : 0;
    if (y) {
      out.relevant.add(item.template);
      out.relevantKeys.add(key);
    }
    out.labels.push({ id: item.id, y, route: item.route, follower: false });
    for (const f of (plan.followers.get(item.id) ?? []).slice(0, maxFollowerLabels)) out.labels.push({ id: f.id, y, route: f.route, follower: true });
  }
  for (const [key, allBenign] of benignByKey) if (allBenign && !out.verdicts.has(key)) out.verdicts.set(key, { escalate: false, judged: true });
  for (const { item, verdict } of plan.cached) {
    if (verdict.escalate && verdict.flagId) attach(verdict.flagId, [item.id]);
  }
  for (const [key, group] of plan.direct) {
    const top = Math.max(...group.map((g) => g.score ?? 0));
    const template = group[0]!.template;
    out.flags.push({
      reason: `Classifier escalation (score ${top.toFixed(2)}): ${group.length}× ${template.split("|").slice(1).join(": ").slice(0, 120)}`,
      severity: severityFromScore(top),
      event_ids: group.map((g) => g.id),
      templates: [template],
      via: "classifier",
    });
    out.verdicts.set(key, { escalate: true, flag: out.flags.length - 1 });
  }
  return out;
}

/**
 * How a label came about and how much it counts in training. Audit samples stand for the
 * dropped traffic they were drawn from (inverse propensity, capped); followers took their
 * example's judgment without being shown, so they count less.
 */
export function labelProvenance(l: Pick<Label, "route" | "follower">, auditRate: number): { provenance: string; weight: number } {
  if (l.follower) return { provenance: "follower", weight: 0.2 };
  switch (l.route) {
    case "audit":
      return { provenance: "audit", weight: auditRate > 0 ? Math.min(1 / auditRate, 10) : 1 };
    case "novel":
    case "known":
    case "review":
      return { provenance: l.route, weight: 1 };
    default:
      return { provenance: "threshold", weight: 1 };
  }
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
