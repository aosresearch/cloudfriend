// Record benchmark replays for the website demo (cloudfriend.dev/demo).
//
//   node ml/export-demo.ts --model models/base.json --out ../cloudfriend-website/public/demo \
//     --scenario re3:data/prepared/re3:re3-ob-adservice_f5-1 \
//     --scenario gaia:data/prepared/gaia:gaia-2021-08-12@14:00-15:00
//
// Each scenario replays a real case through the same featurizer, classifier, routing rules
// and causal batching the server runs (src/triage/sim.ts), asks Jev about the events that
// reach it inside the recorded window (recorded calls, cached in --cache), and writes
// <out>/<id>.json with that window of the stream: the events (routine lines sampled), every
// Jev call with its examples and answer, and the flags that would have gone to Slack. Before
// the window, the routing state learns from the dataset's labels instead (no Jev calls), so
// the system isn't brand new when the window starts. The page plays these back; nothing in it
// is invented.
//
// Offline by default: a call without a valid recording stops the export. `--live --budget <usd>`
// is the only way to call Jev; an API key in the environment never does.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { severityBucket } from "../src/triage/cascade.ts";
import { Classifier, type ClassifierFile } from "../src/triage/classifier.ts";
import { extractEntities, Featurizer } from "../src/triage/features.ts";
import { RoutingState } from "../src/triage/routing.ts";
import { CascadeSim } from "../src/triage/sim.ts";
import type { CloudfriendEvent, FlagDraft } from "../src/types.ts";
import { Jev } from "./jev.ts";
import { loadCases, readStream, type Case } from "./streams.ts";

const DAY = 86_400_000;
const { values: args } = parseArgs({
  options: {
    model: { type: "string" },
    out: { type: "string" },
    scenario: { type: "string", multiple: true },
    cache: { type: "string", default: "data/jev-cache" },
    live: { type: "boolean", default: false },
    budget: { type: "string" },
    "audit-rate": { type: "string", default: "0.002" },
    "max-shown": { type: "string", default: "1200" },
  },
});
if (!args.model || !args.out || !args.scenario?.length) {
  console.error("usage: node ml/export-demo.ts --model <model.json> --out <dir> --scenario <name>:<prepared dir>:<case>[@HH:MM-HH:MM] ...");
  process.exit(2);
}

const model = new Classifier(JSON.parse(fs.readFileSync(args.model, "utf8")) as ClassifierFile);
const mf = model.file;
const jev = new Jev({ mode: args.live ? "live" : "offline", budget: args.budget === undefined ? undefined : Number(args.budget), dir: args.cache! });
const WAIT = 10_000;
const routing = { verdictTtlMs: 15 * 60_000, escalatedTtlMs: 7 * DAY, escalatedMemoryMs: 90 * DAY, suppressionTtlMs: 30 * DAY };

interface Shown {
  id: string;
  t: number;
  source: string;
  service: string;
  level: string;
  text: string;
  raw: string;
  score: number;
  route: string;
  y: 0 | 1;
}

const LEVELS = ["debug", "info", "warn", "error", "fatal"];

async function exportScenario(spec: string) {
  const [name, dir, rest] = [spec.split(":")[0]!, spec.split(":")[1]!, spec.split(":").slice(2).join(":")];
  const [caseId, range] = rest.split("@") as [string, string | undefined];
  const c = loadCases(dir).find((x) => x.id === caseId);
  if (!c) throw new Error(`no case ${caseId} in ${dir}`);
  // A GAIA day continues the previous one; replay that first so the history is warm.
  const chain: Case[] = c.chain ? loadCases(dir).filter((x) => x.chain === c.chain && x.start_ms <= c.start_ms).slice(-2) : [c];
  let from: number;
  let to: number;
  if (range) {
    const [a, b] = range.split("-");
    const day = new Date(c.start_ms).toISOString().slice(0, 10);
    from = Date.parse(`${day}T${a}:00Z`);
    to = Date.parse(`${day}T${b}:00Z`);
  } else {
    from = c.inject_ms! - 90_000;
    to = c.inject_ms! + 120_000;
  }
  const inWindow = (t: number) => t >= from && t <= to + WAIT;

  const featurizer = new Featurizer({ version: mf.featurizer_version });
  const shown: Shown[] = [];
  const dropped: Shown[] = [];
  const calls: { t: number; model: string; latency_ms: number | null; cost: number; examples: { id: string; similar: number; score: number }[]; flags: { reason: string; severity: string; events: string[] }[]; judged: Record<string, number> }[] = [];
  const callAt = new Map<number, (typeof calls)[number]>();
  const byId = new Map<string, Shown & { data: unknown }>();
  const positives = new Set<string>();
  const seconds = new Map<number, { events: number; dropped: number; routed: number }>();
  const totals = { events: 0, dropped: 0, routed: 0, asked: 0, calls: 0, cost: 0, cached_verdicts: 0 };

  const sim = new CascadeSim(
    new RoutingState(routing),
    { route: { dropBelow: mf.drop_below, escalateAbove: mf.escalate_above, threshold: mf.threshold, hasJev: true, auditRate: Number(args["audit-rate"]), novelGuard: true, rand: seeded(name) } },
    {
      async decide(asked, openFlags, start) {
        if (!inWindow(start)) {
          // Before the window: the dataset's labels stand in for Jev, at no cost.
          return { latencyMs: 3000, decision: { flags: [], judgments: asked.map(({ item }) => ({ event_id: item.id, relevance: positives.has(item.id) ? ("relevant" as const) : ("benign" as const) })) } };
        }
        const events: CloudfriendEvent[] = asked.map(({ item, similar }) => {
          const e = byId.get(item.id)!;
          return { id: item.id, source: e.source, received_at: new Date(e.t).toISOString(), data: e.data, triage: { score: item.score ?? 0, similar, context: featurizer.context(item.template, Math.max(start, e.t)) ?? undefined } };
        });
        const ans = await jev.ask(events, openFlags.map((f) => ({ id: f.id, reason: f.reason, severity: f.severity })));
        if (ans.kind === "miss" || ans.kind === "invalid") {
          console.error(`export stopped: no valid recording for a call at ${new Date(start).toISOString()} in ${name} (${ans.kind}). --live --budget calls Jev.`);
          process.exit(3);
        }
        const res = ans.kind === "unavailable" ? null : ans;
        const drafts: FlagDraft[] = res?.decision.flags ?? [];
        const judged: Record<string, number> = {};
        for (const j of res?.decision.judgments ?? []) judged[j.relevance] = (judged[j.relevance] ?? 0) + 1;
        const call = {
          t: start,
          model: res?.call.model ?? "unavailable",
          latency_ms: res?.call.latency_ms ?? null,
          cost: res?.call.cost ?? 0,
          examples: asked.map(({ item, similar }) => ({ id: item.id, similar, score: round(item.score ?? 0) })),
          flags: drafts.map((d) => ({ reason: d.reason, severity: d.severity, events: d.event_ids })),
          judged,
        };
        calls.push(call);
        callAt.set(start + (call.latency_ms ?? 0), call);
        totals.asked += events.length;
        totals.calls++;
        totals.cost += call.cost;
        return res ? { decision: res.decision, latencyMs: res.call.latency_ms } : null;
      },
    },
  );

  let n = 0;
  let last = 0;
  for (const day of chain) {
    for await (const e of readStream(dir, day.id)) {
      if (e.t > to + WAIT * 2) break;
      const f = featurizer.featurize({ source: e.source, received_at: e.t, data: e.data });
      const score = model.score(f.values);
      const ctx = featurizer.context(f.template);
      const id = String(n++);
      if (e.y) positives.add(id);
      last = e.t;
      const rec: Shown & { data: unknown } = {
        id, t: e.t, source: e.source, service: f.service, level: Number.isNaN(f.level) ? "" : LEVELS[f.level]!,
        text: f.text.slice(0, 400), raw: JSON.stringify(e.data).slice(0, 1500), score: round(score), route: "", y: e.y, data: e.data,
      };
      byId.set(id, rec);
      rec.route = await sim.push({ id, t: e.t, score, template: f.template, severity: severityBucket(f.level, f.status), novel: f.novel, rate: ctx?.last_1m, serviceErrors: ctx?.service_errors_10m });
      if (rec.route === "drop" && !(e.t >= from && e.t <= to)) byId.delete(id);
      if (byId.size > 60_000) {
        const keep = new Set(sim.pendingIds());
        for (const k of [...byId.keys()].slice(0, 30_000)) if (!keep.has(k) && byId.get(k)!.t < from) byId.delete(k);
      }
      if (!(e.t >= from && e.t <= to)) continue;
      totals.events++;
      const sec = Math.floor((e.t - from) / 1000);
      const b = seconds.get(sec) ?? { events: 0, dropped: 0, routed: 0 };
      b.events++;
      if (rec.route === "drop") {
        b.dropped++;
        totals.dropped++;
        dropped.push(rec);
      } else {
        b.routed++;
        totals.routed++;
        shown.push(rec);
      }
      seconds.set(sec, b);
    }
  }
  await sim.finish(last + WAIT);

  // Flags raised in the window, at the time their call started (the page adds the latency).
  const flags = sim.flags
    .filter((f) => inWindow(f.created))
    .map((f) => {
      const call = callAt.get(f.created);
      const users = [...new Set(f.events.map((x) => byId.get(x)).filter(Boolean).map((e) => extractEntities(e!.data).user).filter(Boolean))] as string[];
      return {
        id: f.id,
        t: f.via === "decider" && call ? call.t : f.created,
        reason: f.reason,
        severity: f.severity,
        via: f.via,
        events: f.events.slice(0, 50),
        count: f.events.length + f.additions.reduce((a, x) => a + x.ids.length, 0),
        added: f.additions.filter((a) => inWindow(a.t)).map((a) => ({ t: a.t, n: a.ids.length })),
        users: users.slice(0, 5),
      };
    });

  // Show every event that reached the cascade, and an even sample of the routine ones.
  const room = Math.max(0, Number(args["max-shown"]) - shown.length);
  const every = Math.max(1, Math.ceil(dropped.length / Math.max(room, 1)));
  const sample = dropped.filter((_, i) => i % every === 0);
  const events = [...shown, ...sample].sort((a, b) => a.t - b.t || Number(a.id) - Number(b.id)).map(({ ...e }) => {
    delete (e as { data?: unknown }).data;
    return e;
  });
  const span = Math.ceil((to - from) / 1000);
  const timeline = Array.from({ length: span + 1 }, (_, i) => {
    const b = seconds.get(i) ?? { events: 0, dropped: 0, routed: 0 };
    return [b.events, b.dropped, b.routed];
  });
  const result = {
    id: name,
    case: c.id,
    dataset: c.dataset,
    system: (c.system as string) ?? "MicroSS (QR-code login)",
    fault: c.inject_ms !== undefined ? { service: c.service, kind: c.fault, inject_ms: c.inject_ms } : null,
    incidents: (c.incidents ?? []).filter((i) => i.end_ms >= from && i.start_ms <= to),
    from,
    to,
    routine_sample_every: every,
    model: { trained_at: mf.trained_at, drop_below: round(mf.drop_below), trees: model.gbdt.numTrees },
    totals: { ...totals, cost: Math.round(totals.cost * 1e5) / 1e5, flags: flags.length },
    timeline,
    events,
    calls: calls.filter((x) => inWindow(x.t)),
    flags,
  };
  fs.mkdirSync(args.out!, { recursive: true });
  fs.writeFileSync(path.join(args.out!, `${name}.json`), JSON.stringify(result));
  console.log(`${name}: ${totals.events} events, ${totals.routed} past the classifier, ${totals.calls} Jev calls ($${totals.cost.toFixed(3)}), ${flags.length} flags, ${events.length} shown`);
  return { id: name, case: c.id, system: result.system, fault: result.fault, flags: flags.length, events: totals.events };
}

function seeded(s: string) {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => ((h = (Math.imul(h, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

const round = (x: number) => Math.round(x * 1e4) / 1e4;

const index = [];
for (const s of args.scenario) index.push(await exportScenario(s));
fs.writeFileSync(path.join(args.out, "index.json"), JSON.stringify({ generated_at: new Date().toISOString(), scenarios: index }, null, 1));
