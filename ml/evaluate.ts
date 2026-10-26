// Replay benchmark streams through cloudfriend's triage and measure what matters:
//
//   RCAEval RE3   did we escalate after the fault was injected, how fast, how many false
//                 escalations before it, and how much of the stream reached Jev
//   GAIA          false escalations per day outside the injected incidents, incidents
//                 caught, and how well flagged events link to the same users elsewhere
//
//   node ml/evaluate.ts --data data/prepared/re3 --model models/base.json --split eval \
//     [--jev] [--budget 10] [--out results/eval-re3.json] [--trace results/traces]
//
// Strategies, all computed in one pass over each stream:
//   cascade     classifier -> Jev on the uncertain events (real Jev calls with --jev)
//   classifier  classifier alone at its best-F1 threshold
//   keyword     escalate anything that reads like an error (a typical alert rule)
//   jev-all     every event to Jev, with the same grouping and verdict cache; only counted,
//               never called, because it is the expensive thing the cascade avoids
//
// Jev replies are cached on disk by prompt hash (--cache), so reruns cost nothing.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { JEV } from "../src/adapters/deciders/jev.ts";
import { Jev } from "./jev.ts";
import { applyVerdicts, planBatch, routeEvent, VerdictCache, type FullRoute, type Pending } from "../src/triage/cascade.ts";
import { Classifier, type ClassifierFile } from "../src/triage/classifier.ts";
import { extractEntities, FEATURE_NAMES, Featurizer } from "../src/triage/features.ts";
import type { CloudfriendEvent, FlagDraft } from "../src/types.ts";
import { loadCases, readStream, type Case } from "./streams.ts";

const { values: args } = parseArgs({
  options: {
    data: { type: "string", multiple: true },
    model: { type: "string" },
    split: { type: "string", default: "eval" },
    jev: { type: "boolean", default: false },
    budget: { type: "string", default: "10" },
    cache: { type: "string", default: "data/jev-cache" },
    out: { type: "string" },
    trace: { type: "string" },
    cases: { type: "string" },
    "batch-size": { type: "string", default: "100" },
    "batch-wait": { type: "string", default: "10000" },
    "audit-wait": { type: "string", default: "300000" },
    "verdict-ttl": { type: "string", default: "900000" },
    "audit-rate": { type: "string", default: "0.002" },
    "novel-guard": { type: "string", default: "on" },
    concurrency: { type: "string", default: "6" },
    strategies: { type: "string", default: "cascade,classifier,keyword,jev-all" },
    // Write the cascade's Jev labels as a training CSV (the server's training loop, offline).
    "labels-out": { type: "string" },
  },
});
if (!args.data?.length || !args.model) {
  console.error("usage: node ml/evaluate.ts --data <prepared dir> --model <model.json> [--split eval] [--jev]");
  process.exit(2);
}

const classifier = new Classifier(JSON.parse(fs.readFileSync(args.model, "utf8")) as ClassifierFile);
const BATCH = Number(args["batch-size"]);
const WAIT = Number(args["batch-wait"]);
const AUDIT_WAIT = Number(args["audit-wait"]);
const TTL = Number(args["verdict-ttl"]);
const AUDIT = Number(args["audit-rate"]);
const NOVEL = args["novel-guard"] !== "off";
const STRATEGIES = args.strategies!.split(",") as StrategyName[];
type StrategyName = "cascade" | "classifier" | "keyword" | "jev-all";

const jev = new Jev(args.jev!, Number(args.budget), args.cache!);

// --- one strategy over one stream -------------------------------------------------------

interface SimFlag {
  id: string;
  created: number;
  reason: string;
  severity: string;
  events: string[];
  templates: string[];
  positives: number;
  attached: number;
  via: "jev" | "classifier" | "keyword" | "fallback";
}

interface EventInfo {
  t: number;
  y: 0 | 1;
  source: string;
  data: unknown;
  score: number;
  template: string;
  values?: number[];
}

const labelsOut = args["labels-out"] ? fs.openSync(args["labels-out"], "w") : null;
if (labelsOut) fs.writeSync(labelsOut, ["case", "t", "y", "w", ...FEATURE_NAMES].join(",") + "\n");
const fmt = (v: number) => (Number.isNaN(v) ? "" : Number.isInteger(v) ? String(v) : v.toPrecision(6));

class Sim {
  flags: SimFlag[] = [];
  routed: Record<string, number> = {};
  asked = 0;
  calls = 0;
  unavailable = 0;
  labels = { pos: 0, neg: 0 };
  #pending: Pending[] = [];
  #oldest = 0;
  /** Audit samples aren't urgent: a batch of only audits waits AUDIT_WAIT, as in the server. */
  #oldestUrgent: number | null = null;
  #cache = new VerdictCache(TTL);
  #flagById = new Map<string, SimFlag>();
  #n = 0;
  #rand: () => number;

  readonly name: StrategyName;
  readonly info: Map<string, EventInfo>;
  readonly caseId: string;
  constructor(name: StrategyName, info: Map<string, EventInfo>, caseId: string) {
    this.name = name;
    this.info = info;
    this.caseId = caseId;
    this.#rand = seeded(caseId);
  }

  route(score: number, errorish: boolean, novel: boolean): FullRoute {
    switch (this.name) {
      case "keyword":
        return errorish ? "classifier" : "drop";
      case "classifier":
        return routeEvent(score, { dropBelow: 0, escalateAbove: 2, threshold: classifier.file.threshold, hasJev: false, auditRate: 0 });
      case "jev-all":
        return "jev";
      case "cascade":
        return routeEvent(score, {
          dropBelow: classifier.file.drop_below,
          escalateAbove: classifier.file.escalate_above,
          threshold: classifier.file.threshold,
          hasJev: true,
          auditRate: AUDIT,
          novelGuard: NOVEL,
          rand: this.#rand,
        }, novel);
    }
  }

  async push(id: string, now: number, score: number, errorish: boolean, novel: boolean, template: string) {
    if (this.#pending.length && (this.#pending.length >= BATCH || now - (this.#oldestUrgent ?? this.#oldest + AUDIT_WAIT - WAIT) >= WAIT)) await this.flush(now);
    const route = this.route(score, errorish, novel);
    this.routed[route] = (this.routed[route] ?? 0) + 1;
    if (route === "drop") return;
    if (!this.#pending.length) this.#oldest = now;
    if (route !== "audit" && this.#oldestUrgent === null) this.#oldestUrgent = now;
    this.#pending.push({ id, template, score, route });
  }

  async flush(now: number) {
    const batch = this.#pending;
    this.#pending = [];
    this.#oldestUrgent = null;
    if (!batch.length) return;
    const plan = planBatch(batch, this.#cache, now);
    let drafts: FlagDraft[] = [];
    let answered = true;
    if (plan.ask.length) {
      this.asked += plan.ask.length;
      this.calls += Math.ceil(plan.ask.length / BATCH);
      const events: CloudfriendEvent[] = plan.ask.map(({ item, similar }) => {
        const e = this.info.get(item.id)!;
        return {
          id: item.id,
          source: e.source,
          received_at: new Date(e.t).toISOString(),
          data: e.data,
          triage: { score: item.score ?? 0, similar },
        };
      });
      if (this.name === "cascade") {
        for (let i = 0; i < events.length; i += BATCH) {
          const part = events.slice(i, i + BATCH);
          const res = await jev.ask(part);
          if (res) drafts.push(...res);
          else {
            // Jev unavailable: fall back to the classifier's own threshold for these events.
            this.unavailable += part.length;
            answered = false;
            const hot = part.filter((e) => (e.triage?.score ?? 0) >= classifier.file.threshold);
            if (hot.length) drafts.push({ reason: "classifier fallback", severity: "medium", event_ids: hot.map((e) => e.id) });
          }
        }
      } else {
        // jev-all is only counted: treat nothing as flagged so the cache still fills.
        drafts = [];
      }
    }
    const out = applyVerdicts(plan, drafts);
    for (const l of out.labels) l.y ? this.labels.pos++ : this.labels.neg++;
    if (labelsOut && this.name === "cascade" && answered) {
      let rows = "";
      for (const l of out.labels) {
        const e = this.info.get(l.id);
        if (e?.values) rows += `${this.caseId},${e.t},${l.y},1,${e.values.map(fmt).join(",")}\n`;
      }
      if (rows) fs.writeSync(labelsOut, rows);
    }
    const ids: string[] = [];
    for (const f of out.flags) {
      const flag: SimFlag = {
        id: `${this.caseId}#${this.name}#${++this.#n}`,
        created: now,
        reason: f.reason,
        severity: f.severity,
        events: f.event_ids,
        templates: f.templates,
        positives: f.event_ids.filter((id) => this.info.get(id)?.y).length,
        attached: 0,
        via: f.reason === "classifier fallback" ? "fallback" : f.via === "decider" ? "jev" : this.name === "keyword" ? "keyword" : "classifier",
      };
      this.flags.push(flag);
      this.#flagById.set(flag.id, flag);
      ids.push(flag.id);
    }
    for (const [t, i] of out.verdicts) this.#cache.set(t, i >= 0, now, i >= 0 ? ids[i] : undefined);
    for (const [fid, evs] of out.attach) {
      const f = this.#flagById.get(fid);
      if (!f) continue;
      f.attached += evs.length;
      f.positives += evs.filter((id) => this.info.get(id)?.y).length;
    }
  }
}

function seeded(s: string) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => ((h = (Math.imul(h, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

// --- running a case ----------------------------------------------------------------------

interface CaseResult {
  case: Case;
  events: number;
  positives: number;
  perStrategy: Record<string, ReturnType<typeof summarize>>;
  users?: { flagsWithUser: number; flags: number; crossSourceLinks: number };
}

function summarize(c: Case, sim: Sim, events: number) {
  const flags = sim.flags;
  const r: Record<string, unknown> = {
    flags: flags.length,
    flags_with_true_events: flags.filter((f) => f.positives > 0).length,
    routed: sim.routed,
    asked_jev: sim.asked,
    jev_calls: sim.calls,
    share_to_jev: sim.asked / Math.max(events, 1),
    jev_unavailable: sim.unavailable,
    labels: sim.labels,
  };
  if (c.inject_ms !== undefined) {
    const after = flags.filter((f) => f.created >= c.inject_ms!);
    const first = after[0];
    r.false_flags_before_fault = flags.filter((f) => f.created < c.inject_ms!).length;
    r.detected = Boolean(first);
    r.detected_precise = after.some((f) => f.positives > 0);
    r.ttd_s = first ? (first.created - c.inject_ms) / 1000 : null;
  }
  if (c.incidents) {
    const grace = 5 * 60_000;
    const inWindow = (t: number) => c.incidents!.some((i) => t >= i.start_ms && t <= i.end_ms + grace);
    r.false_flags = flags.filter((f) => !inWindow(f.created)).length;
    r.incidents = c.incidents.length;
    r.incidents_flagged = c.incidents.filter((i) => flags.some((f) => f.created >= i.start_ms && f.created <= i.end_ms + grace)).length;
    r.false_flag_examples = flags
      .filter((f) => !inWindow(f.created))
      .slice(0, 5)
      .map((f) => ({ reason: f.reason, templates: f.templates.slice(0, 2) }));
  }
  return r;
}

async function runChain(dir: string, chain: Case[]): Promise<CaseResult[]> {
  const featurizer = new Featurizer();
  // A chain (GAIA's days) is a system that was already running: warm the featurizer's
  // history on the day before the first evaluated one, without scoring it.
  if (chain[0]?.chain) {
    const all = loadCases(dir).filter((c) => c.chain === chain[0]!.chain);
    const prev = all.filter((c) => c.start_ms < chain[0]!.start_ms).at(-1);
    if (prev) for await (const e of readStream(dir, prev.id)) featurizer.featurize({ source: e.source, received_at: e.t, data: e.data });
  }
  const results: CaseResult[] = [];
  for (const c of chain) {
    const info = new Map<string, EventInfo>();
    const sims = STRATEGIES.map((s) => new Sim(s, info, c.id));
    const users = new Map<string, Set<string>>();
    let n = 0;
    let positives = 0;
    let now = c.start_ms;
    let pruneAt = 200_000;
    for await (const e of readStream(dir, c.id)) {
      const f = featurizer.featurize({ source: e.source, received_at: e.t, data: e.data });
      const score = classifier.score(f.values);
      const id = String(n++);
      now = e.t;
      positives += e.y;
      info.set(id, { t: e.t, y: e.y, source: e.source, data: e.data, score, template: f.template, values: labelsOut ? f.values : undefined });
      if (c.incidents) {
        const u = extractEntities(e.data, f.text).user;
        if (u) (users.get(u) ?? users.set(u, new Set()).get(u)!).add(`${e.source}:${f.service}`);
      }
      for (const s of sims) await s.push(id, e.t, score, f.errorish, f.novel, f.template);
      if (info.size > pruneAt) {
        pruneInfo(info, sims, e.t);
        pruneAt = Math.max(200_000, info.size * 2);
      }
    }
    for (const s of sims) await s.flush(now + WAIT);
    const res: CaseResult = { case: c, events: n, positives, perStrategy: {} };
    for (const s of sims) res.perStrategy[s.name] = summarize(c, s, n);
    if (c.incidents) {
      const cascade = sims.find((s) => s.name === "cascade");
      if (cascade) {
        let withUser = 0;
        let links = 0;
        for (const f of cascade.flags) {
          const us = new Set(f.events.map((id) => info.get(id)).filter(Boolean).map((e) => extractEntities(e!.data).user).filter(Boolean));
          if (us.size) withUser++;
          for (const u of us) links += Math.max(0, (users.get(u!)?.size ?? 1) - 1);
        }
        res.users = { flags: cascade.flags.length, flagsWithUser: withUser, crossSourceLinks: links };
      }
    }
    if (args.trace) writeTrace(c, sims, info);
    results.push(res);
    const cs = res.perStrategy.cascade as any;
    console.log(
      `${c.id.padEnd(40)} events=${n} pos=${positives} ` +
        (cs ? `cascade: flags=${cs.flags} to_jev=${(cs.share_to_jev * 100).toFixed(2)}% ` + (c.inject_ms !== undefined ? `detected=${cs.detected} ttd=${cs.ttd_s}s pre=${cs.false_flags_before_fault}` : `false=${cs.false_flags} inc=${cs.incidents_flagged}/${cs.incidents}`) : "") +
        ` | jev $${jev.spent.toFixed(3)} calls=${jev.calls} cached=${jev.cachedCalls}`,
    );
  }
  return results;
}

/** Forget events no strategy can still need: older than the batch window and not in a flag. */
function pruneInfo(info: Map<string, EventInfo>, sims: Sim[], now: number) {
  const keep = new Set<string>();
  for (const s of sims) for (const f of s.flags) for (const id of f.events.slice(0, 50)) keep.add(id);
  for (const [id, e] of info) if (e.t < now - WAIT * 3 && !keep.has(id)) info.delete(id);
}

function writeTrace(c: Case, sims: Sim[], info: Map<string, EventInfo>) {
  fs.mkdirSync(args.trace!, { recursive: true });
  const flags = Object.fromEntries(
    sims.map((s) => [
      s.name,
      s.flags.map((f) => ({
        ...f,
        events: f.events.slice(0, 20).map((id) => {
          const e = info.get(id);
          return e ? { id, t: e.t, y: e.y, source: e.source, score: +e.score.toFixed(4), data: e.data } : { id };
        }),
        event_count: f.events.length + f.attached,
      })),
    ]),
  );
  fs.writeFileSync(path.join(args.trace!, `${c.id}.json`), JSON.stringify({ case: c, flags }));
}

// --- main -------------------------------------------------------------------------------

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

const only = args.cases ? new RegExp(args.cases) : null;
const all: CaseResult[] = [];
for (const dir of args.data) {
  const cases = loadCases(dir).filter((c) => c.split === args.split && (!only || only.test(c.id)));
  const chains = new Map<string, Case[]>();
  for (const c of cases) {
    const key = c.chain ?? c.id;
    chains.set(key, [...(chains.get(key) ?? []), c]);
  }
  const res = await pool([...chains.values()], Number(args.concurrency), (chain) => runChain(dir, chain));
  all.push(...res.flat());
}

// Aggregate.
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null);
const agg: Record<string, Record<string, unknown>> = {};
for (const s of STRATEGIES) {
  const rs = all.map((r) => ({ r, m: r.perStrategy[s] as any }));
  const events = rs.reduce((a, x) => a + x.r.events, 0);
  const re3 = rs.filter((x) => x.r.case.inject_ms !== undefined);
  const gaia = rs.filter((x) => x.r.case.incidents);
  const detectable = re3.filter((x) => x.r.positives > 0);
  const a: Record<string, unknown> = {
    events,
    asked_jev: rs.reduce((a, x) => a + x.m.asked_jev, 0),
    jev_calls: rs.reduce((a, x) => a + x.m.jev_calls, 0),
    share_to_jev: rs.reduce((a, x) => a + x.m.asked_jev, 0) / Math.max(events, 1),
    flags: rs.reduce((a, x) => a + x.m.flags, 0),
  };
  if (re3.length) {
    Object.assign(a, {
      re3_cases: re3.length,
      re3_detectable_cases: detectable.length,
      re3_detected: detectable.filter((x) => x.m.detected).length,
      re3_detected_precise: detectable.filter((x) => x.m.detected_precise).length,
      re3_median_ttd_s: median(detectable.filter((x) => x.m.detected).map((x) => x.m.ttd_s)),
      re3_false_flags_before_fault: re3.reduce((a, x) => a + x.m.false_flags_before_fault, 0),
      re3_cases_with_false_flag: re3.filter((x) => x.m.false_flags_before_fault > 0).length,
    });
  }
  if (gaia.length) {
    Object.assign(a, {
      gaia_days: gaia.length,
      gaia_false_flags_per_day: gaia.reduce((a, x) => a + x.m.false_flags, 0) / gaia.length,
      gaia_incidents: gaia.reduce((a, x) => a + x.m.incidents, 0),
      gaia_incidents_flagged: gaia.reduce((a, x) => a + x.m.incidents_flagged, 0),
    });
  }
  agg[s] = a;
}
const summary = {
  model: { path: args.model, trained_at: classifier.file.trained_at, drop_below: classifier.file.drop_below, threshold: classifier.file.threshold, trees: classifier.gbdt.numTrees },
  split: args.split,
  settings: { batch_size: BATCH, batch_wait_ms: WAIT, audit_wait_ms: AUDIT_WAIT, verdict_ttl_ms: TTL, audit_rate: AUDIT, novel_guard: NOVEL },
  jev: {
    live: args.jev,
    model: process.env.JEV_MODEL || JEV.model,
    calls: jev.calls,
    cached_calls: jev.cachedCalls,
    skipped_calls: jev.skipped,
    spent_usd: jev.spent,
    prompt_tokens: jev.promptTokens,
    completion_tokens: jev.completionTokens,
    median_latency_ms: median(jev.latencies),
    routed_to: Object.fromEntries(jev.models),
  },
  aggregate: agg,
  cases: all.map((r) => ({ id: r.case.id, split: r.case.split, events: r.events, positives: r.positives, users: r.users, ...r.perStrategy })),
};
console.log(JSON.stringify({ aggregate: agg, jev: summary.jev }, null, 1));
if (args.out) {
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(summary, null, 1));
}
