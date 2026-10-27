// Replay benchmark streams through cloudfriend's triage, causally, and measure per incident:
//
//   withheld    no event of the incident reached Jev (stage 1's miss)
//   dismissed   its events reached Jev, but no alert containing one followed (stage 2's miss)
//   detected    an alert containing one of its events; time to detect is from that alert
//
// plus the share of the stream Jev read, alerts with no incident event, misses by situation
// (new, transition, sustained, recurring, single-event), and exact bounds. "Incident event"
// means the dataset's weak label (docs/benchmarks.md): these numbers are weak.
//
//   node ml/evaluate.ts --data data/prepared/re3 --model models/base.json --split eval \
//     [--jev] [--budget 10] [--decider oracle] [--out results/eval-re3.json] [--labels-out labels.csv]
//
// The cascade runs as the server does (src/triage/sim.ts): batches go out when due, Jev's
// answers take effect only after their recorded latency, and its prompt carries the same
// context and open alerts. Baselines in the same pass: the classifier alone at its best-F1
// threshold, and a keyword rule (any error-like line), neither of which asks Jev.
//
// Each case runs on its own; a GAIA day is warmed on the day before it (featurizer only).
// `--windows 30m:12` replays only each GAIA day's incident windows (padded by 30 minutes)
// and 12 random quiet hours, to spend less on Jev. Jev replies are cached on disk by prompt
// hash (--cache), so reruns cost nothing.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { JEV } from "../src/adapters/deciders/jev.ts";
import { parseCsvLine } from "../src/training.ts";
import { labelProvenance, severityBucket, type FullRoute } from "../src/triage/cascade.ts";
import { Classifier, type ClassifierFile } from "../src/triage/classifier.ts";
import { FEATURE_NAMES, Featurizer } from "../src/triage/features.ts";
import { RoutingState } from "../src/triage/routing.ts";
import { CascadeSim, type SimFlag } from "../src/triage/sim.ts";
import { bootstrap, lowerBound, upperBound } from "../src/stats.ts";
import type { CloudfriendEvent } from "../src/types.ts";
import { Jev } from "./jev.ts";
import { loadCases, readStream, type Case } from "./streams.ts";

const DAY = 86_400_000;
const { values: args } = parseArgs({
  options: {
    data: { type: "string", multiple: true },
    model: { type: "string" },
    split: { type: "string", default: "eval" },
    jev: { type: "boolean", default: false },
    // "jev" (cached or live calls) or "oracle": answers from the dataset's weak labels, with a
    // 3 s latency, for free runs that still let suppression be earned (sizing, stage-1 recall).
    decider: { type: "string", default: "jev" },
    budget: { type: "string", default: "10" },
    cache: { type: "string", default: "data/jev-cache" },
    out: { type: "string" },
    cases: { type: "string" },
    "batch-size": { type: "string", default: "100" },
    "batch-wait": { type: "string", default: "10000" },
    "audit-wait": { type: "string", default: "300000" },
    "decider-concurrency": { type: "string", default: "2" },
    "verdict-ttl": { type: "string", default: "900000" },
    "audit-rate": { type: "string", default: "0.002" },
    "novel-guard": { type: "string", default: "on" },
    "escalated-ttl": { type: "string", default: String(7 * DAY) },
    "escalated-memory": { type: "string", default: String(90 * DAY) },
    "suppression-ttl": { type: "string", default: String(30 * DAY) },
    concurrency: { type: "string", default: "6" },
    strategies: { type: "string", default: "cascade,classifier,keyword" },
    windows: { type: "string" },
    safety: { type: "string" },
    // Write the cascade's Jev labels as a training CSV (the server's training loop, offline).
    "labels-out": { type: "string" },
    // Write every judgment the decider made (with its event) and a uniform sample of dropped
    // events, for people to review (ml/review-samples.ts). --compare-model keeps only drops
    // that model would make too: the two models' shared blind spot.
    "samples-out": { type: "string" },
    "drops-per-case": { type: "string", default: "40" },
    "compare-model": { type: "string" },
  },
});
if (!args.data?.length || !args.model) {
  console.error("usage: node ml/evaluate.ts --data <prepared dir> --model <model.json> [--split eval] [--jev] [--out file]");
  process.exit(2);
}

type StrategyName = "cascade" | "classifier" | "keyword";
const STRATEGIES = args.strategies!.split(",") as StrategyName[];
const classifier = new Classifier(JSON.parse(fs.readFileSync(args.model, "utf8")) as ClassifierFile);
const m = classifier.file;
const jev = new Jev(args.jev!, Number(args.budget), args.cache!);
const N = (k: keyof typeof args) => Number(args[k]);
const routing = {
  verdictTtlMs: N("verdict-ttl"),
  escalatedTtlMs: N("escalated-ttl"),
  escalatedMemoryMs: N("escalated-memory"),
  suppressionTtlMs: N("suppression-ttl"),
};
const simBase = { batchSize: N("batch-size"), batchWaitMs: N("batch-wait"), auditWaitMs: N("audit-wait"), concurrency: N("decider-concurrency") };
const labelsOut = args["labels-out"] ? fs.openSync(args["labels-out"], "w") : null;
if (labelsOut) fs.writeSync(labelsOut, ["case", "t", "y", "w", ...FEATURE_NAMES].join(",") + "\n");
const fmt = (v: number) => (Number.isNaN(v) ? "" : Number.isInteger(v) ? String(v) : v.toPrecision(6));
const compare = args["compare-model"] ? new Classifier(JSON.parse(fs.readFileSync(args["compare-model"], "utf8")) as ClassifierFile) : null;
const csvCell = (v: unknown) => {
  const t = String(v ?? "");
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
let judgmentsOut: number | null = null;
let dropsOut: number | null = null;
if (args["samples-out"]) {
  fs.mkdirSync(args["samples-out"], { recursive: true });
  judgmentsOut = fs.openSync(path.join(args["samples-out"], "judgments.csv"), "w");
  fs.writeSync(judgmentsOut, "id,case,time,source,service,message,route,score,weak_label,jev\n");
  dropsOut = fs.openSync(path.join(args["samples-out"], "drops.csv"), "w");
  fs.writeSync(dropsOut, "id,case,time,source,service,message,score,compare_score,weak_label\n");
}
const messageOf = (data: unknown) => {
  const d = data as Record<string, unknown>;
  return String(d?.message ?? d?.msg ?? JSON.stringify(data)).replace(/\s+/g, " ").slice(0, 300);
};
const serviceOf = (data: unknown) => {
  const d = data as Record<string, unknown>;
  return String(d?.service ?? d?.container_name ?? "");
};

/** Must-reach ids of a labelled safety set (benchmarks/safety-set), as `<case>:<event index>`. */
const safetyIds = new Set<string>();
if (args.safety) {
  const [header, ...lines] = fs.readFileSync(path.join(args.safety, "candidates.csv"), "utf8").split(/\r?\n/).filter(Boolean);
  const cols = parseCsvLine(header!);
  for (const l of lines) {
    const c = parseCsvLine(l);
    if (c[cols.indexOf("label")]?.trim().toLowerCase() === "must_reach") safetyIds.add(c[cols.indexOf("id")]!);
  }
}

interface EventInfo {
  t: number;
  source: string;
  data: unknown;
  template: string;
  values?: number[];
}

/** Where an incident event stood when it arrived. */
type Situation = "new" | "transition" | "sustained" | "recurring" | "single";

interface Positive {
  id: string;
  t: number;
  template: string;
  situation: Situation;
  incidents: string[];
  reached: number | null;
}

function seeded(s: string) {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => ((h = (Math.imul(h, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** GAIA: the incident windows (padded) and some random quiet hours of a day. */
function windowsOf(c: Case, spec: string | undefined): [number, number][] | null {
  if (!spec || !c.incidents) return null;
  const [pad, quiet] = spec.split(":");
  const padMs = parseDurationMs(pad ?? "30m");
  const w: [number, number][] = c.incidents.map((i) => [i.start_ms - padMs, i.end_ms + 5 * 60_000 + padMs]);
  const rand = seeded(c.id);
  for (let tries = 0, n = 0; n < Number(quiet ?? 0) && tries < 200; tries++) {
    const s = c.start_ms + Math.floor(rand() * 23) * 3_600_000;
    if (w.some(([a, b]) => s < b && s + 3_600_000 > a)) continue;
    w.push([s, s + 3_600_000]);
    n++;
  }
  return w.sort((a, b) => a[0] - b[0]);
}

function parseDurationMs(v: string): number {
  const x = /^(\d+)(ms|s|m|h|d)?$/.exec(v);
  if (!x) throw new Error(`bad duration ${v}`);
  return Number(x[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: DAY }[x[2] ?? "ms"]!;
}

async function runCase(dir: string, c: Case) {
  const featurizer = new Featurizer();
  // A GAIA day continues the one before it: warm up on that day. The featurizer sees all of
  // it; the routing state (earned suppression, escalations) learns from the weak labels, as
  // an oracle decider would have taught it, so the day doesn't start as a new system.
  const warmState = new RoutingState(routing);
  if (c.chain) {
    const prev = loadCases(dir).filter((x) => x.chain === c.chain && x.start_ms < c.start_ms).at(-1);
    if (prev) {
      const pos = new Set<string>();
      const warm = new CascadeSim(warmState, {
        ...simBase,
        route: { dropBelow: m.drop_below, escalateAbove: m.escalate_above, threshold: m.threshold, hasJev: true, auditRate: 0, novelGuard: args["novel-guard"] !== "off" },
      }, {
        decide: async (asked) => ({ latencyMs: 3000, decision: { flags: [], judgments: asked.map(({ item }) => ({ event_id: item.id, relevance: pos.has(item.id) ? ("relevant" as const) : ("benign" as const) })) } }),
      });
      let k = 0;
      for await (const e of readStream(dir, prev.id)) {
        const f = featurizer.featurize({ source: e.source, received_at: e.t, data: e.data });
        const id = `w${k++}`;
        if (e.y) pos.add(id);
        const ctx = featurizer.context(f.template);
        await warm.push({ id, t: e.t, score: classifier.score(f.values), template: f.template, severity: severityBucket(f.level, f.status), novel: f.novel, rate: ctx?.last_1m, serviceErrors: ctx?.service_errors_10m });
      }
      await warm.finish(prev.end_ms);

    }
  }
  const windows = windowsOf(c, args.windows);
  const inScope = (t: number) => !windows || windows.some(([a, b]) => t >= a && t <= b);

  const info = new Map<string, EventInfo>();
  const positives = new Map<string, Positive>();
  const tplCount = new Map<string, number>();
  const tplHistory = new Map<string, { count: number; errors: number; lastError: number }>();
  const labels = { pos: 0, neg: 0 };
  const escalatedKinds = { events: 0, by_score: 0 };
  const safety: { id: string; reached: boolean; route: string }[] = [];
  const reachedAt = new Map<string, number>();

  const sims = new Map<StrategyName, CascadeSim>();
  for (const name of STRATEGIES) {
    const cascade = name === "cascade";
    const state = cascade ? warmState : new RoutingState({ verdictTtlMs: routing.verdictTtlMs, escalatedTtlMs: 0, suppressionTtlMs: 0 });
    sims.set(
      name,
      new CascadeSim(
        state,
        {
          ...simBase,
          learn: cascade,
          idPrefix: `${c.id}#${name}`,
          route: { dropBelow: m.drop_below, escalateAbove: m.escalate_above, threshold: m.threshold, hasJev: cascade, auditRate: N("audit-rate"), novelGuard: args["novel-guard"] !== "off", rand: seeded(c.id) },
        },
        {
          route: name === "keyword" ? (e, r) => (keywordHit.has(e.id) ? "classifier" : r === "classifier" ? "drop" : r) : undefined,
          decide: cascade && args.decider === "oracle"
            ? async (asked) => {
                const hot = asked.filter(({ item }) => positives.has(item.id)).map(({ item }) => item.id);
                return {
                  latencyMs: 3000,
                  decision: {
                    judgments: asked.map(({ item }) => ({ event_id: item.id, relevance: positives.has(item.id) ? ("relevant" as const) : ("benign" as const) })),
                    flags: hot.length ? [{ reason: "oracle", severity: "high" as const, event_ids: hot }] : [],
                  },
                };
              }
            : cascade
            ? async (asked, openFlags, start) => {
                const events: CloudfriendEvent[] = asked.map(({ item, similar }) => {
                  const e = info.get(item.id)!;
                  return {
                    id: item.id,
                    source: e.source,
                    received_at: new Date(e.t).toISOString(),
                    data: e.data,
                    triage: { score: item.score ?? 0, similar, context: featurizer.context(item.template, Math.max(start, e.t)) ?? undefined },
                  };
                });
                const res = await jev.ask(events, openFlags.map((f) => ({ id: f.id, reason: f.reason, severity: f.severity })));
                if (res && judgmentsOut !== null) {
                  const byItem = new Map(asked.map((a) => [a.item.id, a.item]));
                  let rows = "";
                  for (const j of res.judgments ?? []) {
                    const e = info.get(j.event_id)!;
                    const it = byItem.get(j.event_id)!;
                    rows += [`${c.id}:${j.event_id}`, c.id, new Date(e.t).toISOString(), e.source, serviceOf(e.data), messageOf(e.data), it.route, (it.score ?? 0).toFixed(4), positives.has(j.event_id) ? 1 : 0, j.relevance].map(csvCell).join(",") + "\n";
                  }
                  fs.writeSync(judgmentsOut, rows);
                }
                return res ? { decision: { flags: res.flags, judgments: res.judgments }, latencyMs: res.call.latency_ms } : null;
              }
            : undefined,
          reached: cascade
            ? (ids, _how, t) => {
                for (const id of ids) {
                  if (!reachedAt.has(id)) reachedAt.set(id, t);
                  const p = positives.get(id);
                  if (p && p.reached === null) p.reached = t;
                }
              }
            : undefined,
          outcome: cascade
            ? ({ out, answered }) => {
                if (!answered) return;
                for (const l of out.labels) {
                  l.y ? labels.pos++ : labels.neg++;
                  const e = info.get(l.id);
                  if (labelsOut && e?.values) fs.writeSync(labelsOut, `${c.id},${e.t},${l.y},${labelProvenance(l, N("audit-rate")).weight},${e.values.map(fmt).join(",")}\n`);
                }
              }
            : undefined,
        },
      ),
    );
  }
  const keywordHit = new Set<string>();
  const drops: string[] = [];
  let dropSeen = 0;
  const dropRand = seeded(`${c.id}:drops`);
  const routes = new Map<string, FullRoute>();
  let n = 0;
  let events = 0;
  let last = c.start_ms;
  for await (const e of readStream(dir, c.id)) {
    const f = featurizer.featurize({ source: e.source, received_at: e.t, data: e.data });
    const id = String(n++);
    const h = tplHistory.get(f.template) ?? { count: 0, errors: 0, lastError: -Infinity };
    tplCount.set(f.template, (tplCount.get(f.template) ?? 0) + 1);
    if (inScope(e.t)) {
      events++;
      last = e.t;
      const score = classifier.score(f.values);
      const ctx = featurizer.context(f.template);
      info.set(id, { t: e.t, source: e.source, data: e.data, template: f.template, values: labelsOut ? [...f.values] : undefined });
      if (f.errorish) keywordHit.add(id);
      if (e.y) {
        const situation: Situation = h.count === 0 ? "new" : h.errors === 0 ? "transition" : h.errors >= 5 && e.t - h.lastError <= 30 * 60_000 ? "sustained" : "recurring";
        positives.set(id, { id, t: e.t, template: f.template, situation, incidents: e.inc ?? [], reached: null });
      }
      const sim = { id, t: e.t, score, template: f.template, severity: severityBucket(f.level, f.status), novel: f.novel, rate: ctx?.last_1m, serviceErrors: ctx?.service_errors_10m };
      const cascade = sims.get("cascade");
      if (cascade && cascade.state.escalated.status(f.template, e.t) === "protected") {
        escalatedKinds.events++;
        if (score >= m.drop_below) escalatedKinds.by_score++;
      }
      for (const [name, s] of sims) {
        const r = await s.push(sim);
        if (name === "cascade") routes.set(id, r);
      }
      // Reservoir sample of what the cascade dropped (and the other model would drop too).
      if (dropsOut !== null && routes.get(id) === "drop") {
        const other = compare ? compare.score(f.values) : null;
        if (!compare || other! < compare.file.drop_below) {
          dropSeen++;
          const row = [`${c.id}:${id}`, c.id, new Date(e.t).toISOString(), e.source, f.service, f.text.replace(/\s+/g, " ").slice(0, 300), score.toFixed(4), other === null ? "" : other.toFixed(4), e.y].map(csvCell).join(",");
          const k = Number(args["drops-per-case"]);
          if (drops.length < k) drops.push(row);
          else {
            const j = Math.floor(dropRand() * dropSeen);
            if (j < k) drops[j] = row;
          }
        }
      }
      if (safetyIds.has(`${c.id}:${id}`)) safety.push({ id, reached: false, route: routes.get(id) ?? "?" });
      if (info.size > 200_000) prune(info, [...sims.values()], e.t);
    }
    h.count++;
    if (f.errorish) {
      h.errors++;
      h.lastError = e.t;
    }
    tplHistory.set(f.template, h);
  }
  let end = last;
  for (const s of sims.values()) end = Math.max(end, await s.finish(last + N("batch-wait")));
  for (const p of positives.values()) if ((tplCount.get(p.template) ?? 0) <= 2) p.situation = "single";
  if (dropsOut !== null && drops.length) fs.writeSync(dropsOut, drops.join("\n") + "\n");
  for (const s of safety) s.reached = reachedAt.has(s.id);

  const perStrategy: Record<string, unknown> = {};
  for (const [name, s] of sims) perStrategy[name] = summarize(c, name, s, events, positives, windows);
  const cs = perStrategy.cascade as ReturnType<typeof summarize> | undefined;
  console.log(
    `${c.id.padEnd(36)} events=${events} pos=${positives.size} ` +
      (cs ? `to_jev=${(cs.share_to_jev * 100).toFixed(2)}% alerts=${cs.flags} ` + incidentLine(cs) : "") +
      ` | jev $${jev.spent.toFixed(3)} calls=${jev.calls} cached=${jev.cachedCalls}`,
  );
  return { case: c, events, positives: positives.size, labels, escalated_kinds: escalatedKinds, safety, perStrategy, end };
}

function incidentLine(s: ReturnType<typeof summarize>) {
  return s.incidents.map((i) => (i.detected ? "D" : i.withheld ? "W" : i.dismissed ? "X" : "-")).join("") + ` pre=${s.flags_before_fault ?? "-"}`;
}

/** Forget events no strategy can still need: older than the batch window and not in a flag. */
function prune(info: Map<string, EventInfo>, sims: CascadeSim[], now: number) {
  const keep = new Set<string>();
  for (const s of sims) {
    for (const f of s.flags) for (const id of f.events.slice(0, 50)) keep.add(id);
    for (const id of s.pendingIds()) keep.add(id);
  }
  for (const [id, e] of info) if (e.t < now - N("batch-wait") * 6 && !keep.has(id)) info.delete(id);
}

/** The incidents of a case: an RE3 fault, or the GAIA incidents in scope. */
function incidentsOf(c: Case, windows: [number, number][] | null) {
  if (c.inject_ms !== undefined) return [{ id: c.id, kind: String(c.fault ?? ""), start: c.inject_ms, service: String(c.service ?? "") }];
  return (c.incidents ?? [])
    .filter((i) => !windows || windows.some(([a, b]) => i.start_ms >= a && i.start_ms <= b))
    .map((i) => ({ id: i.id, kind: i.kind, start: i.start_ms, service: i.service }));
}

function summarize(c: Case, name: StrategyName, s: CascadeSim, events: number, positives: Map<string, Positive>, windows: [number, number][] | null) {
  const isPos = (id: string) => positives.has(id);
  const flagIds = (f: SimFlag) => [...f.events, ...f.additions.flatMap((a) => a.ids)];
  // When each flag first contained an event of each incident.
  const alertAt = new Map<string, number>();
  for (const f of s.flags) {
    const mark = (ids: string[], t: number) => {
      for (const id of ids) {
        const p = positives.get(id);
        if (!p) continue;
        for (const inc of p.incidents.length ? p.incidents : [c.id]) if (!alertAt.has(inc) || alertAt.get(inc)! > t) alertAt.set(inc, t);
      }
    };
    mark(f.events, f.created);
    for (const a of f.additions) mark(a.ids, a.t);
  }
  const incidents = incidentsOf(c, windows).map((inc) => {
    const ps = [...positives.values()].filter((p) => (p.incidents.length ? p.incidents.includes(inc.id) : c.inject_ms !== undefined));
    const reached = ps.filter((p) => p.reached !== null);
    const alert = alertAt.get(inc.id);
    return {
      id: inc.id,
      kind: inc.kind,
      service: inc.service,
      positives: ps.length,
      reached: reached.length,
      detectable: ps.length > 0,
      withheld: name === "cascade" && ps.length > 0 && reached.length === 0,
      dismissed: name === "cascade" && reached.length > 0 && alert === undefined,
      detected: alert !== undefined,
      ttd_s: alert !== undefined ? (alert - inc.start) / 1000 : null,
      first_reached_s: reached.length ? (Math.min(...reached.map((p) => p.reached!)) - inc.start) / 1000 : null,
    };
  });
  const situations: Record<string, { positives: number; withheld: number }> = {};
  for (const p of positives.values()) {
    const x = (situations[p.situation] ??= { positives: 0, withheld: 0 });
    x.positives++;
    if (name === "cascade" && p.reached === null) x.withheld++;
  }
  const alertsWithIncident = s.flags.filter((f) => flagIds(f).some(isPos)).length;
  return {
    events,
    routed: s.routed,
    asked_jev: s.asked,
    jev_calls: s.calls,
    share_to_jev: s.asked / Math.max(events, 1),
    jev_unavailable: s.unavailable,
    flags: s.flags.length,
    flags_with_incident_event: alertsWithIncident,
    flags_without_incident_event: s.flags.length - alertsWithIncident,
    flags_before_fault: c.inject_ms !== undefined ? s.flags.filter((f) => f.created < c.inject_ms!).length : undefined,
    positives_reached: name === "cascade" ? [...positives.values()].filter((p) => p.reached !== null).length : undefined,
    situations,
    incidents,
  };
}

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

// --- main -------------------------------------------------------------------------------

const only = args.cases ? new RegExp(args.cases) : null;
const all: Awaited<ReturnType<typeof runCase>>[] = [];
for (const dir of args.data) {
  const cases = loadCases(dir).filter((c) => (args.split === "all" || c.split === args.split) && (!only || only.test(c.id)));
  all.push(...(await pool(cases, N("concurrency"), (c) => runCase(dir, c))));
}

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null);
const rate = (k: number, n: number) => ({ k, n, rate: n ? k / n : null, upper95: n ? upperBound(k, n) : null });
/** RE3 cases of one (system, service, fault) are repetitions: resample by group. */
const groupOf = (id: string) => id.replace(/-\d+$/, "");

const aggregate: Record<string, unknown> = {};
for (const s of STRATEGIES) {
  const rs = all.map((r) => ({ r, x: r.perStrategy[s] as ReturnType<typeof summarize> }));
  const events = rs.reduce((a, { x }) => a + x.events, 0);
  const incidents = rs.flatMap(({ r, x }) => x.incidents.filter((i) => i.detectable).map((i) => ({ ...i, group: r.case.chain ? i.kind : groupOf(r.case.id) })));
  const detected = incidents.filter((i) => i.detected).length;
  const withheld = incidents.filter((i) => i.withheld).length;
  const dismissed = incidents.filter((i) => i.dismissed).length;
  const byGroup = new Map<string, typeof incidents>();
  for (const i of incidents) byGroup.set(i.group, [...(byGroup.get(i.group) ?? []), i]);
  const groups = [...byGroup.values()];
  const situations: Record<string, { positives: number; withheld: number }> = {};
  for (const { x } of rs) for (const [k, v] of Object.entries(x.situations)) {
    const y = (situations[k] ??= { positives: 0, withheld: 0 });
    y.positives += v.positives;
    y.withheld += v.withheld;
  }
  const positives = rs.reduce((a, { r }) => a + r.positives, 0);
  const reachedPos = rs.reduce((a, { x }) => a + (x.positives_reached ?? 0), 0);
  aggregate[s] = {
    events,
    asked_jev: rs.reduce((a, { x }) => a + x.asked_jev, 0),
    jev_calls: rs.reduce((a, { x }) => a + x.jev_calls, 0),
    share_to_jev: rs.reduce((a, { x }) => a + x.asked_jev, 0) / Math.max(events, 1),
    flags: rs.reduce((a, { x }) => a + x.flags, 0),
    flags_without_incident_event: rs.reduce((a, { x }) => a + x.flags_without_incident_event, 0),
    flags_before_fault: rs.reduce((a, { x }) => a + (x.flags_before_fault ?? 0), 0),
    incidents: incidents.length,
    detected: rate(detected, incidents.length),
    detected_ci95_by_group: bootstrap(groups, (gs) => gs.flat().filter((i) => i.detected).length / Math.max(gs.flat().length, 1)),
    ...(s === "cascade"
      ? {
          withheld: rate(withheld, incidents.length),
          // Incidents that left only a trace in the logs (1-3 labelled events) apart from the rest.
          withheld_by_size: {
            "1-3": rate(incidents.filter((i) => i.positives <= 3 && i.withheld).length, incidents.filter((i) => i.positives <= 3).length),
            "4+": rate(incidents.filter((i) => i.positives > 3 && i.withheld).length, incidents.filter((i) => i.positives > 3).length),
          },
          dismissed: rate(dismissed, incidents.length),
          positives_reached: { k: reachedPos, n: positives, lower95: lowerBound(reachedPos, positives) },
          situations,
        }
      : {}),
    median_ttd_s: median(incidents.filter((i) => i.ttd_s !== null).map((i) => i.ttd_s!)),
    median_first_reached_s: s === "cascade" ? median(incidents.filter((i) => i.first_reached_s !== null).map((i) => i.first_reached_s!)) : undefined,
  };
}
const escalatedKinds = all.reduce((a, r) => ({ events: a.events + r.escalated_kinds.events, by_score: a.by_score + r.escalated_kinds.by_score }), { events: 0, by_score: 0 });
const safety = all.flatMap((r) => r.safety.map((x) => ({ case: r.case.id, ...x })));
const summary = {
  model: { path: args.model, trained_at: m.trained_at, drop_below: m.drop_below, threshold: m.threshold, trees: classifier.gbdt.numTrees },
  split: args.split,
  settings: { ...simBase, ...routing, decider: args.decider, audit_rate: N("audit-rate"), novel_guard: args["novel-guard"] !== "off", windows: args.windows ?? null },
  labels: "weak (dataset heuristics): see docs/benchmarks.md",
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
  aggregate,
  // Later events of a kind Jev had judged relevant (protected when they arrived), and how
  // many of them the classifier's score alone would have sent: the rule's share of recall.
  escalated_kinds: escalatedKinds,
  safety_set: args.safety ? { must_reach: safety.length, reached: safety.filter((x) => x.reached).length, missed: safety.filter((x) => !x.reached) } : null,
  cases: all.map((r) => ({ id: r.case.id, split: r.case.split, events: r.events, positives: r.positives, labels: r.labels, ...r.perStrategy })),
};
console.log(JSON.stringify({ aggregate, escalated_kinds: escalatedKinds, jev: summary.jev }, null, 1));
if (args.out) {
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(summary, null, 1));
}
