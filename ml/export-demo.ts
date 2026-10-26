// Record benchmark replays for the website demo (cloudfriend.dev/demo).
//
//   node ml/export-demo.ts --model models/base.json --out ../cloudfriend-website/public/demo \
//     --scenario re3:data/prepared/re3:re3-ob-adservice_f5-1 \
//     --scenario gaia:data/prepared/gaia:gaia-2021-08-12@14:00-15:00
//
// Each scenario replays a real case through the same featurizer, classifier and cascade the
// server runs, asks Jev about the events that pass the classifier (recorded calls, cached in
// --cache), and writes <out>/<id>.json with a window of the stream: the events (routine lines
// sampled), every Jev call with its examples and answer, and the flags that would have been
// sent to Slack. The page plays these back; nothing in it is invented.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { applyVerdicts, EscalatedTemplates, planBatch, routeEvent, VerdictCache, type Pending } from "../src/triage/cascade.ts";
import { Classifier, type ClassifierFile } from "../src/triage/classifier.ts";
import { extractEntities, Featurizer } from "../src/triage/features.ts";
import type { CloudfriendEvent, FlagDraft } from "../src/types.ts";
import { Jev } from "./jev.ts";
import { loadCases, readStream, type Case } from "./streams.ts";

const { values: args } = parseArgs({
  options: {
    model: { type: "string" },
    out: { type: "string" },
    scenario: { type: "string", multiple: true },
    cache: { type: "string", default: "data/jev-cache" },
    budget: { type: "string", default: "2" },
    "audit-rate": { type: "string", default: "0.002" },
    "max-shown": { type: "string", default: "1200" },
  },
});
if (!args.model || !args.out || !args.scenario?.length) {
  console.error("usage: node ml/export-demo.ts --model <model.json> --out <dir> --scenario <name>:<prepared dir>:<case>[@HH:MM-HH:MM] ...");
  process.exit(2);
}

const model = new Classifier(JSON.parse(fs.readFileSync(args.model, "utf8")) as ClassifierFile);
const jev = new Jev(Boolean(process.env.JEV_API_KEY || process.env.OPENROUTER_API_KEY), Number(args.budget), args.cache!);
const BATCH = 100;
const WAIT = 10_000;
const AUDIT_WAIT = 300_000;
const TTL = 15 * 60_000;

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
  // A GAIA day continues the previous one; replay it first so the history is warm.
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

  const featurizer = new Featurizer();
  const cache = new VerdictCache(TTL);
  const escalated = new EscalatedTemplates(7 * 86_400_000);
  const rand = seeded(name);
  const shown: Shown[] = [];
  const dropped: Shown[] = [];
  const calls: unknown[] = [];
  const flags: { id: string; t: number; reason: string; severity: string; via: string; events: string[]; count: number; added: { t: number; n: number }[]; users: string[] }[] = [];
  const byId = new Map<string, Shown & { data: unknown }>();
  const seconds = new Map<number, { events: number; dropped: number; routed: number }>();
  let pending: Pending[] = [];
  let oldest = 0;
  let oldestUrgent: number | null = null;
  let n = 0;
  const totals = { events: 0, dropped: 0, routed: 0, asked: 0, calls: 0, cost: 0, cached_verdicts: 0 };

  const flush = async (now: number) => {
    const batch = pending;
    pending = [];
    oldestUrgent = null;
    if (!batch.length) return;
    const plan = planBatch(batch, cache, now);
    const inWindow = now >= from && now <= to + WAIT;
    if (inWindow) totals.cached_verdicts += plan.cached.length;
    let drafts: FlagDraft[] = [];
    if (plan.ask.length) {
      const events: CloudfriendEvent[] = plan.ask.map(({ item, similar }) => {
        const e = byId.get(item.id)!;
        return { id: item.id, source: e.source, received_at: new Date(e.t).toISOString(), data: e.data, triage: { score: item.score ?? 0, similar } };
      });
      drafts = (await jev.ask(events)) ?? [];
      if (inWindow) {
        totals.asked += events.length;
        totals.calls++;
        totals.cost += jev.last?.cost ?? 0;
        calls.push({
          t: now,
          model: jev.last?.model ?? "unavailable",
          latency_ms: jev.last?.latency_ms ?? null,
          cost: jev.last?.cost ?? 0,
          examples: plan.ask.map(({ item, similar }) => ({ id: item.id, similar, score: round(item.score ?? 0) })),
          flags: drafts.map((d) => ({ reason: d.reason, severity: d.severity, events: d.event_ids })),
        });
      }
    }
    const out = applyVerdicts(plan, drafts);
    const ids: string[] = [];
    for (const f of out.flags) {
      const id = `flag-${flags.length + 1}`;
      ids.push(id);
      if (!inWindow) continue;
      const users = [...new Set(f.event_ids.map((x) => byId.get(x)).filter(Boolean).map((e) => extractEntities(e!.data).user).filter(Boolean))] as string[];
      flags.push({ id, t: now, reason: f.reason, severity: f.severity, via: f.via, events: f.event_ids.slice(0, 50), count: f.event_ids.length, added: [], users: users.slice(0, 5) });
    }
    out.verdicts.forEach((i, tpl) => cache.set(tpl, i >= 0, now, i >= 0 ? ids[i] : undefined));
    for (const f of out.flags) if (f.via === "decider") for (const t of f.templates) escalated.add(t, now);
    for (const [fid, evs] of out.attach) {
      const f = flags.find((x) => x.id === fid);
      if (f && inWindow) {
        f.count += evs.length;
        f.added.push({ t: now, n: evs.length });
      }
    }
  };

  for (const day of chain) {
    for await (const e of readStream(dir, day.id)) {
      if (e.t > to + WAIT * 2) break;
      const f = featurizer.featurize({ source: e.source, received_at: e.t, data: e.data });
      const score = model.score(f.values);
      const route = routeEvent(score, {
        dropBelow: model.file.drop_below,
        escalateAbove: model.file.escalate_above,
        threshold: model.file.threshold,
        hasJev: true,
        auditRate: Number(args["audit-rate"]),
        rand,
      }, f.novel, escalated.has(f.template, e.t));
      const id = String(n++);
      if (pending.length && (pending.length >= BATCH || e.t - (oldestUrgent ?? oldest + AUDIT_WAIT - WAIT) >= WAIT)) await flush(e.t);
      const inWindow = e.t >= from && e.t <= to;
      const rec: Shown & { data: unknown } = {
        id,
        t: e.t,
        source: e.source,
        service: f.service,
        level: Number.isNaN(f.level) ? "" : LEVELS[f.level]!,
        text: f.text.slice(0, 400),
        raw: JSON.stringify(e.data).slice(0, 1500),
        score: round(score),
        route,
        y: e.y,
        data: e.data,
      };
      if (route !== "drop") {
        byId.set(id, rec);
        if (!pending.length) oldest = e.t;
        if (route !== "audit" && oldestUrgent === null) oldestUrgent = e.t;
        pending.push({ id, template: f.template, score, route });
      }
      if (!inWindow) {
        if (byId.size > 50_000) for (const k of [...byId.keys()].slice(0, 25_000)) byId.delete(k);
        continue;
      }
      totals.events++;
      const sec = Math.floor((e.t - from) / 1000);
      const b = seconds.get(sec) ?? { events: 0, dropped: 0, routed: 0 };
      b.events++;
      if (route === "drop") {
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
  await flush(to + WAIT);

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
    model: { trained_at: model.file.trained_at, drop_below: round(model.file.drop_below), trees: model.gbdt.numTrees },
    totals: { ...totals, cost: Math.round(totals.cost * 1e5) / 1e5, flags: flags.length },
    timeline,
    events,
    calls,
    flags,
  };
  fs.mkdirSync(args.out!, { recursive: true });
  fs.writeFileSync(path.join(args.out!, `${name}.json`), JSON.stringify(result));
  console.log(`${name}: ${totals.events} events, ${totals.routed} past the classifier, ${totals.calls} Jev calls, ${flags.length} flags, ${events.length} shown`);
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
