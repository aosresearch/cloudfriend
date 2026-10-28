// One table of Jev's direct judgments, per event, rebuilt from the recorded calls.
//
//   node ml/evidence.ts --cache data/jev-cache --data data/prepared/re3 --data data/prepared/gaia \
//     --out evidence/   [--event-chars 800]
//
// Every recorded call (ml/jev.ts) holds the exact prompt and Jev's reply, with judgments by
// position in the prompt. Each prompt event is matched back to the event it was made from: the
// case whose time range holds its received_at, then the stream event at that millisecond whose
// data renders to the same prompt text. Identical events at the same millisecond can't be told
// apart; they get the first unmatched one, and are marked `ambiguous`.
//
// Writes:
//   <out>/shown.csv      one row per (call, prompt position): the event id, its answer
//                        (`missing` when the reply gave none), whether an alert of that call
//                        named it, its group size, and the call
//   <out>/evidence.csv   one row per event:
//     status         relevant | benign      direct answers that agree
//                    conflict               direct answers that disagree
//                    uncertain | missing    no direct relevant/benign answer
//     authoritative  1 when status is relevant or benign
//   <out>/summary.json   counts, and the prompt events that matched nothing
//
// Followers (events standing behind a shown example) are not in it: nobody judged them. Only
// authoritative rows may become training labels; conflicts go to review (ml/review-packets.ts).
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { compactJson } from "../src/compact.ts";
import { BENCHMARK_EVENT_CHARS, type JevRecord } from "./jev.ts";
import { loadCases, readStream, type Case } from "./streams.ts";

const { values: args } = parseArgs({
  options: {
    cache: { type: "string" },
    data: { type: "string", multiple: true },
    out: { type: "string" },
    "event-chars": { type: "string", default: BENCHMARK_EVENT_CHARS },
  },
});
if (!args.cache || !args.data?.length || !args.out) {
  console.error("usage: node ml/evidence.ts --cache <jev cache> --data <prepared dir> [--data ...] --out <dir>");
  process.exit(2);
}
const maxChars = Number(args["event-chars"]);

interface PromptEvent {
  call: string;
  pos: number;
  source: string;
  t: number;
  similar: number;
  text: string;
  answer: string;
  inAlert: boolean;
}

/** The events of a recorded prompt, with Jev's answer for each. */
export function promptEvents(key: string, rec: JevRecord): PromptEvent[] {
  const user = rec.prompt.slice(rec.prompt.indexOf("\n\n---\n\n") + 7);
  const lines = user.split("\n");
  const answer = new Map((rec.judgments ?? []).map((j) => [j.event, j.relevance]));
  const alerted = new Set(rec.flags.flatMap((f) => f.events));
  const out: PromptEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\[(\d+)\] source=(\S+) received_at=(\S+)(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const pos = Number(m[1]);
    const similar = /similar_in_batch=(\d+)/.exec(m[4]!);
    out.push({
      call: key, pos, source: m[2]!, t: Date.parse(m[3]!), similar: similar ? Number(similar[1]) : 1,
      text: lines[i + 1] ?? "", answer: answer.get(pos) ?? "missing", inAlert: alerted.has(pos),
    });
  }
  return out;
}

const csv = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Every recorded prompt event.
const shown: PromptEvent[] = [];
for (const d of fs.readdirSync(args.cache).sort()) {
  const sub = path.join(args.cache, d);
  if (!fs.statSync(sub).isDirectory()) continue;
  for (const f of fs.readdirSync(sub).sort()) {
    if (!f.endsWith(".json")) continue;
    shown.push(...promptEvents(path.basename(f, ".json"), JSON.parse(fs.readFileSync(path.join(sub, f), "utf8"))));
  }
}

// Which case holds each event: the one whose time range covers it.
const cases: { dir: string; c: Case }[] = args.data.flatMap((dir) => loadCases(dir).map((c) => ({ dir, c })));
const caseOf = (t: number) => cases.filter(({ c }) => t >= c.start_ms && t <= c.end_ms);
const wanted = new Map<string, Map<number, PromptEvent[]>>();
const unplaced: PromptEvent[] = [];
for (const e of shown) {
  const hits = caseOf(e.t);
  if (!hits.length) unplaced.push(e);
  for (const { c } of hits) {
    const m = wanted.get(c.id) ?? wanted.set(c.id, new Map()).get(c.id)!;
    (m.get(e.t) ?? m.set(e.t, []).get(e.t)!).push(e);
  }
}

interface Match {
  id: string;
  case: Case;
  service: string;
  message: string;
  y: number;
  ambiguous: boolean;
}
const matched = new Map<PromptEvent, Match>();
for (const { dir, c } of cases) {
  const want = wanted.get(c.id);
  if (!want) continue;
  // Stream events at the wanted milliseconds, with their rendering, in stream order.
  const at = new Map<number, { i: number; text: string; data: unknown; y: number }[]>();
  let i = 0;
  for await (const e of readStream(dir, c.id)) {
    const idx = i++;
    if (!want.has(e.t)) continue;
    (at.get(e.t) ?? at.set(e.t, []).get(e.t)!).push({ i: idx, text: compactJson(e.data, { maxChars }), data: e.data, y: e.y });
  }
  for (const [t, es] of want) {
    const candidates = at.get(t) ?? [];
    // Per call, each stream event can stand for one prompt event only.
    const used = new Map<string, Set<number>>();
    for (const e of es) {
      const same = candidates.filter((x) => x.text === e.text);
      if (!same.length) continue;
      const u = used.get(e.call) ?? used.set(e.call, new Set()).get(e.call)!;
      const pick = same.find((x) => !u.has(x.i)) ?? same[0]!;
      u.add(pick.i);
      const d = pick.data as Record<string, unknown>;
      const service = String(d?.service ?? d?.container_name ?? d?.serviceName ?? "");
      const message = String(d?.message ?? d?.msg ?? e.text).replace(/\s+/g, " ").slice(0, 300);
      matched.set(e, { id: `${c.id}:${pick.i}`, case: c, service, message, y: pick.y, ambiguous: same.length > 1 });
    }
  }
  console.log(`${c.id}: ${[...want.values()].reduce((a, x) => a + x.length, 0)} prompt events`);
}

fs.mkdirSync(args.out, { recursive: true });
const shownRows = ["id,case,time,source,service,message,weak_label,jev,in_alert,similar,call,pos,ambiguous"];
const byId = new Map<string, { m: Match; es: PromptEvent[] }>();
const unmatched: PromptEvent[] = [];
for (const e of shown) {
  const m = matched.get(e);
  if (!m) {
    unmatched.push(e);
    continue;
  }
  shownRows.push([m.id, m.case.id, new Date(e.t).toISOString(), e.source, m.service, m.message, m.y, e.answer, e.inAlert ? 1 : 0, e.similar, e.call, e.pos, m.ambiguous ? 1 : 0].map(csv).join(","));
  const x = byId.get(m.id) ?? byId.set(m.id, { m, es: [] }).get(m.id)!;
  x.es.push(e);
}
fs.writeFileSync(path.join(args.out, "shown.csv"), shownRows.join("\n") + "\n");

const rows = [
  ["id", "dataset", "case", "split", "time", "source", "service", "message", "weak_label", "status", "authoritative", "relevant", "benign", "uncertain", "missing", "shown", "in_alert", "ambiguous", "calls"].join(","),
];
const status: Record<string, Record<string, number>> = {};
for (const [id, { m, es }] of [...byId].sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))) {
  const n = (a: string) => es.filter((e) => e.answer === a).length;
  const rel = n("relevant");
  const ben = n("benign");
  const st = rel && ben ? "conflict" : rel ? "relevant" : ben ? "benign" : n("uncertain") ? "uncertain" : "missing";
  const s = (status[m.case.split] ??= {});
  s[st] = (s[st] ?? 0) + 1;
  rows.push(
    [
      id, m.case.dataset, m.case.id, m.case.split, new Date(es[0]!.t).toISOString(), es[0]!.source, m.service, m.message, m.y, st,
      st === "relevant" || st === "benign" ? 1 : 0, rel, ben, n("uncertain"), n("missing"), es.length, es.some((e) => e.inAlert) ? 1 : 0,
      m.ambiguous ? 1 : 0, [...new Set(es.map((e) => e.call))].join(" "),
    ].map(csv).join(","),
  );
}
fs.writeFileSync(path.join(args.out, "evidence.csv"), rows.join("\n") + "\n");
const summary = {
  calls: new Set(shown.map((e) => e.call)).size,
  prompt_events: shown.length,
  matched: shown.length - unmatched.length,
  unmatched: unmatched.length,
  unplaced: unplaced.length,
  ambiguous: [...matched.values()].filter((m) => m.ambiguous).length,
  events: byId.size,
  status_by_split: status,
  unmatched_examples: unmatched.slice(0, 20).map((e) => ({ call: e.call, pos: e.pos, t: new Date(e.t).toISOString(), text: e.text.slice(0, 200) })),
};
fs.writeFileSync(path.join(args.out, "summary.json"), JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ ...summary, unmatched_examples: undefined }, null, 1));
