// Regression scenarios: event sequences, with the history that comes before them, run
// through the complete triage pipeline. A scenario answers "did we break a known must-catch
// situation?": each event it marks `must_reach` has to reach the decider through the real
// featurizer, classifier, routing rules, verdict cache and batching (sim.ts), with the
// decider's answers scripted. Score-only results are reported too, as a diagnostic.
//
// A scenario is JSON:
//
//   {
//     "name": "returning-after-expiry",
//     "situation": "a problem escalated a week ago comes back on day 8",
//     "jev": [{ "match": "payment failed", "relevance": "relevant" }],   // otherwise benign
//     "routing": { "suppressionTtlMs": 0 },                               // optional overrides
//     "steps": [
//       { "at": "0s",  "every": "2s", "events": [{ "data": {...}, "repeat": 20 }] },
//       { "at": "8d",  "events": [{ "data": {...}, "must_reach": true }] },
//       { "restart": true }
//     ]
//   }
//
// `at` is from the start of the scenario; events of a step are `every` apart (default 1s);
// `repeat` copies an event, replacing `{i}` in its strings with the copy's number. `restart`
// saves and restores the featurizer and rebuilds routing from the labels, as a server restart.
// `human` is a person's verdict on the kind of the events matching it (as the feedback
// endpoints apply it). A `jev` rule with `min_rate` applies only when the event's template
// ran at least that often in the last minute: the decider sees those counts.
import fs from "node:fs";
import path from "node:path";
import { severityBucket } from "./cascade.ts";
import type { Classifier } from "./classifier.ts";
import { Featurizer } from "./features.ts";
import { RoutingState, type LabelFact, type RoutingOptions } from "./routing.ts";
import { CascadeSim, type SimEvent, type SimHooks } from "./sim.ts";
import { parseDuration } from "../config.ts";
import type { Judgment } from "../types.ts";

export interface ScenarioEvent {
  source?: string;
  data: Record<string, unknown>;
  repeat?: number;
  must_reach?: boolean;
  /** With `repeat`: must every copy reach the decider (default), or at least one? */
  reach?: "all" | "any";
}

export interface ScenarioStep {
  at?: string;
  every?: string;
  events?: ScenarioEvent[];
  restart?: boolean;
  human?: { match: string; escalate: boolean };
}

export interface Scenario {
  name: string;
  situation?: string;
  jev?: { match: string; relevance: "relevant" | "benign" | "uncertain"; min_rate?: number }[];
  routing?: Partial<RoutingOptions>;
  steps: ScenarioStep[];
}

export interface ScenarioCheck {
  scenario: string;
  event: string;
  message: string;
  route: string;
  reached: boolean;
  /** Would the classifier's score alone have sent it to the decider? */
  by_score: boolean;
}

export interface ScenarioResult {
  name: string;
  passed: boolean;
  checks: ScenarioCheck[];
  asked: number;
}

export interface ScenarioOptions {
  routing: RoutingOptions;
  novelGuard?: boolean;
  /** How long the scripted decider takes to answer. */
  latencyMs?: number;
}

const START = Date.UTC(2026, 0, 5, 9, 0, 0);

/** The built-in pack: one scenario per known must-catch situation (regression/*.json). */
export const BUILTIN_SCENARIOS = path.join(import.meta.dirname, "..", "..", "regression");

/** Every *.json scenario in these directories (missing ones are skipped). */
export function loadScenarios(...dirs: (string | null | undefined)[]): Scenario[] {
  const out: Scenario[] = [];
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      const sc = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Scenario;
      if (!sc.name || !Array.isArray(sc.steps)) throw new Error(`${path.join(dir, f)}: a scenario needs a name and steps`);
      out.push(sc);
    }
  }
  return out;
}

export async function runScenario(sc: Scenario, model: Classifier, o: ScenarioOptions): Promise<ScenarioResult> {
  const rules = (sc.jev ?? []).map((r) => ({ re: new RegExp(r.match, "i"), relevance: r.relevance, minRate: r.min_rate ?? 0 }));
  const relevanceOf = (data: unknown, rate = 0) => rules.find((r) => r.re.test(JSON.stringify(data)) && rate >= r.minRate)?.relevance ?? "benign";
  const routing = { ...o.routing, ...sc.routing };
  const events = new Map<string, SimEvent & { data: Record<string, unknown>; mustReach: boolean; group?: string; message: string; route?: string; byScore: boolean }>();
  const reached = new Set<string>();
  const labels: LabelFact[] = [];
  const latencyMs = o.latencyMs ?? 3000;

  const hooks: SimHooks = {
    async decide(asked) {
      const judgments: Judgment[] = asked.map(({ item }) => ({ event_id: item.id, relevance: relevanceOf(events.get(item.id)!.data, item.rate) }));
      const hot = judgments.filter((j) => j.relevance === "relevant").map((j) => j.event_id);
      return { latencyMs, decision: { judgments, flags: hot.length ? [{ reason: "scripted alert", severity: "high", event_ids: hot }] : [] } };
    },
    reached(ids) {
      for (const id of ids) reached.add(id);
    },
    outcome({ out, at, answered }) {
      if (!answered) return;
      for (const l of out.labels) {
        const e = events.get(l.id)!;
        const provenance = l.follower ? "follower" : l.route;
        labels.push({ template: e.template, severity: e.severity ?? null, y: l.y, source: "jev", provenance, at, rate: e.rate ?? null, serviceErrors: e.serviceErrors ?? null });
      }
    },
  };
  const f = model.file;
  const simOptions = { route: { dropBelow: f.drop_below, escalateAbove: f.escalate_above, threshold: f.threshold, hasJev: true, auditRate: 0, novelGuard: o.novelGuard ?? true } };

  // The model's feature version: a v2 model is tested as it runs, with v2 features.
  const version = f.featurizer_version;
  let featurizer = new Featurizer({ version });
  let sim = new CascadeSim(new RoutingState(routing), simOptions, hooks);
  let n = 0;
  let last = START;
  for (const step of sc.steps) {
    if (step.restart) {
      last = await sim.finish(last);
      const restored = new Featurizer({ version });
      restored.restore(JSON.parse(JSON.stringify(featurizer.snapshot())));
      featurizer = restored;
      const state = new RoutingState(routing);
      state.rebuild(labels.filter((l) => l.at >= last - state.horizonMs));
      sim = new CascadeSim(state, simOptions, hooks);
      continue;
    }
    if (step.human) {
      const re = new RegExp(step.human.match, "i");
      const seen = [...events.values()].filter((e) => re.test(JSON.stringify(e.data)));
      for (const k of new Map(seen.map((e) => [`${e.template}#${e.severity}`, e])).values()) {
        sim.state.personSaid(k.template, k.severity, step.human.escalate, last, k);
        labels.push({ template: k.template, severity: k.severity ?? null, y: step.human.escalate ? 1 : 0, source: "human", provenance: "human", at: last, rate: k.rate ?? null, serviceErrors: k.serviceErrors ?? null });
      }
      continue;
    }
    const t0 = START + parseDuration(step.at ?? "0s");
    const every = parseDuration(step.every ?? "1s");
    let i = 0;
    for (const [j, ev] of (step.events ?? []).entries()) {
      const group = ev.reach === "any" ? `${sc.steps.indexOf(step)}.${j}` : undefined;
      for (let r = 0; r < (ev.repeat ?? 1); r++) {
        const t = Math.max(t0 + i++ * every, last);
        last = t;
        const data = fill(ev.data, r) as Record<string, unknown>;
        const x = featurizer.featurize({ source: ev.source ?? "app", received_at: t, data });
        const ctx = featurizer.context(x.template);
        const score = model.score(x.values);
        const id = `${sc.name}:${++n}`;
        const e = {
          id, t, score, template: x.template, severity: severityBucket(x.level, x.status), novel: x.novel,
          rate: ctx?.last_1m, serviceErrors: ctx?.service_errors_10m,
          data, mustReach: ev.must_reach === true, group, message: x.text.slice(0, 120), byScore: score >= f.drop_below,
        };
        events.set(id, e);
        (e as { route?: string }).route = await sim.push(e);
      }
    }
  }
  await sim.finish(last);
  // One check per must-reach event, or per group of copies of which any one may reach.
  const checks: ScenarioCheck[] = [];
  const groups = new Map<string, ScenarioCheck>();
  for (const e of events.values()) {
    if (!e.mustReach) continue;
    const c = { scenario: sc.name, event: e.id, message: e.message, route: e.route ?? "?", reached: reached.has(e.id), by_score: e.byScore };
    if (!e.group) {
      checks.push(c);
      continue;
    }
    const g = groups.get(e.group);
    if (!g) {
      groups.set(e.group, c);
      checks.push(c);
    } else if (!g.reached && c.reached) Object.assign(g, { event: c.event, route: c.route, reached: true, by_score: g.by_score || c.by_score });
    else g.by_score ||= c.by_score;
  }
  return { name: sc.name, passed: checks.every((c) => c.reached), checks, asked: [...events.keys()].filter((id) => reached.has(id)).length };
}

/** Run every scenario. The suite passes only if every must-reach event of every scenario does. */
export async function runSuite(scenarios: Scenario[], model: Classifier, o: ScenarioOptions) {
  const results: ScenarioResult[] = [];
  for (const sc of scenarios) results.push(await runScenario(sc, model, o));
  const checks = results.flatMap((r) => r.checks);
  return {
    passed: results.every((r) => r.passed),
    scenarios: results.length,
    must_reach: checks.length,
    reached: checks.filter((c) => c.reached).length,
    reached_by_score: checks.filter((c) => c.by_score).length,
    failures: checks.filter((c) => !c.reached),
    results,
  };
}

function fill(v: unknown, i: number): unknown {
  if (typeof v === "string") return v.replaceAll("{i}", String(i));
  if (Array.isArray(v)) return v.map((x) => fill(x, i));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, i)]));
  return v;
}
