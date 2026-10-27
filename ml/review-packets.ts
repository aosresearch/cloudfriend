// Review packets: what a reviewer (a person, or an assistant) needs to judge an event, and
// nothing that would steer them.
//
//   node ml/review-packets.ts --data data/prepared/re3 --data data/prepared/gaia \
//     --items benchmarks/review/jev-audit.csv:audit --items benchmarks/review/drops.csv:drops \
//     --items benchmarks/safety-set/candidates.csv:safety --evidence data/evidence \
//     --labels data/r3/relabel/pilot.csv --labels data/r3/relabel/re3.csv \
//     --trace trace.json --out review/ [--batch 60] [--seed 1]
//
// Items: the rows of each --items CSV (by their `id`, `<case>:<index>`), plus a priority set:
//   conflict-labels   events whose label CSVs (--labels) disagree at the same case and time
//   conflict-direct   events Jev answered both relevant and benign (evidence.csv)
//   benign-positive   weak positives Jev called benign
//   inconsistent      messages (service and text) Jev answered both ways, on different events
//   miss-positive     the labelled events behind the incidents in --trace (old and new labels)
// Identical messages of one service within one minute of a case become one packet.
//
// Each packet shows the system, the event as it arrived, the same service's previous lines
// (2 minutes, up to 20) and a sample of all services within 30 seconds (up to 30), with
// repeats collapsed. It hides Jev's answer, the weak label, any score and when the fault was
// injected. Writes <out>/items.csv (packet, event ids, where each came from) and
// <out>/batch-NN.md, about --batch packets each, in a fixed shuffled order.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { compactJson } from "../src/compact.ts";
import { parseCsvLine } from "../src/training.ts";
import { loadCases, readStream, type Case } from "./streams.ts";

const { values: args } = parseArgs({
  options: {
    data: { type: "string", multiple: true },
    items: { type: "string", multiple: true },
    evidence: { type: "string" },
    labels: { type: "string", multiple: true },
    trace: { type: "string" },
    out: { type: "string" },
    batch: { type: "string", default: "60" },
    seed: { type: "string", default: "1" },
  },
});
if (!args.data?.length || !args.out) {
  console.error("usage: node ml/review-packets.ts --data <prepared dir> ... --items <csv>:<name> ... --out <dir>");
  process.exit(2);
}

const SYSTEMS: Record<string, string> = {
  "online-boutique": "Online Boutique: an e-commerce demo of about ten microservices (frontend, cart, checkout, payment, currency, email, ads, recommendations, shipping)",
  "sock-shop": "Sock Shop: an e-commerce demo of microservices (front-end, carts, orders, payment, user, catalogue, shipping)",
  "train-ticket": "Train Ticket: a railway booking system of many microservices (auth, route, order, travel, seat, payment, ...)",
  gaia: "GAIA MicroSS: a QR-code login system of microservices (webservice, mobservice, logservice, dbservice, redisservice), two instances each",
};

function readCsv(file: string): Record<string, string>[] {
  const [header, ...lines] = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const cols = parseCsvLine(header!);
  return lines.map((l) => Object.fromEntries(parseCsvLine(l).map((v, i) => [cols[i]!, v])));
}
const csv = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
let seed = Number(args.seed) >>> 0 || 1;
const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const shuffle = <T>(xs: T[]) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};

const cases = new Map<string, { dir: string; c: Case }>();
for (const dir of args.data) for (const c of loadCases(dir)) cases.set(c.id, { dir, c });

// --- the items and where they came from ----------------------------------------------------
const why = new Map<string, Set<string>>();
const add = (id: string, from: string) => (why.get(id) ?? why.set(id, new Set()).get(id)!).add(from);
for (const spec of args.items ?? []) {
  const [file, name] = spec.split(/:(?=[^:]+$)/) as [string, string];
  for (const r of readCsv(file)) add(r.id!, name);
}
/** Ids wanted by case and time instead (label CSVs carry no id). */
const byTime = new Map<string, Map<number, string>>();
/** case\0time -> the label CSVs' answers there, as file:y. */
const labelYs = new Map<string, Set<string>>();
for (const f of args.labels ?? []) {
  const ys = new Map<string, Set<string>>();
  for (const line of fs.readFileSync(f, "utf8").split("\n").slice(1)) {
    if (!line) continue;
    const [c, t, y] = line.split(",", 4);
    (ys.get(`${c}\0${t}`) ?? ys.set(`${c}\0${t}`, new Set()).get(`${c}\0${t}`)!).add(`${path.basename(f)}:${y}`);
  }
  for (const [k, v] of ys) {
    const prev = labelYs.get(k) ?? new Set<string>();
    for (const x of v) prev.add(x);
    labelYs.set(k, prev);
  }
}
for (const [k, v] of labelYs) {
  const ys = new Set([...v].map((x) => x.split(":").at(-1)));
  if (ys.size < 2) continue;
  const [c, t] = k.split("\0") as [string, string];
  (byTime.get(c) ?? byTime.set(c, new Map()).get(c)!).set(Number(t), "conflict-labels");
}
if (args.evidence) {
  const ev = readCsv(path.join(args.evidence, "evidence.csv"));
  for (const r of ev) {
    if (r.status === "conflict") add(r.id!, "conflict-direct");
    if (r.weak_label === "1" && Number(r.benign) > 0) add(r.id!, "benign-positive");
  }
  const answers = new Map<string, Set<string>>();
  for (const r of ev) {
    const k = `${r.case}|${r.service}|${r.message}`;
    const a = answers.get(k) ?? answers.set(k, new Set()).get(k)!;
    if (Number(r.relevant) > 0) a.add("relevant");
    if (Number(r.benign) > 0) a.add("benign");
  }
  for (const r of ev) if (answers.get(`${r.case}|${r.service}|${r.message}`)!.size > 1 && r.status !== "conflict") add(r.id!, "inconsistent");
}
if (args.trace) {
  const tr = JSON.parse(fs.readFileSync(args.trace, "utf8")) as { incidents: { incident: string; day: string; old: { t: number; text: string }[]; new: { t: number; text: string }[] }[] };
  for (const inc of tr.incidents) {
    for (const p of [...inc.old, ...inc.new]) (byTime.get(inc.day) ?? byTime.set(inc.day, new Map()).get(inc.day)!).set(p.t, `miss-positive:${inc.incident}`);
  }
}

// --- read the streams once, building packets -------------------------------------------------
interface Line {
  i: number;
  t: number;
  service: string;
  text: string;
}
interface Packet {
  pid: string;
  case: string;
  ids: string[];
  from: Set<string>;
  t: number;
  service: string;
  raw: string;
  text: string;
  before: Line[];
  around: Line[];
}
const wantedIdx = new Map<string, Set<number>>();
for (const id of why.keys()) {
  const k = id.lastIndexOf(":");
  const c = id.slice(0, k);
  (wantedIdx.get(c) ?? wantedIdx.set(c, new Set()).get(c)!).add(Number(id.slice(k + 1)));
}
for (const c of byTime.keys()) if (!wantedIdx.has(c)) wantedIdx.set(c, new Set());

const serviceOf = (d: any, source: string) => String(d?.service ?? d?.container_name ?? d?.serviceName ?? d?.service_name ?? source);
const textOf = (d: any) => String(d?.message ?? d?.msg ?? compactJson(d, { maxChars: 400 })).replace(/\s+/g, " ");

const packets: Packet[] = [];
const notFound: string[] = [];
for (const [caseId, idxs] of wantedIdx) {
  const entry = cases.get(caseId);
  if (!entry) {
    for (const i of idxs) notFound.push(`${caseId}:${i}`);
    continue;
  }
  const times = byTime.get(caseId);
  const recent: Line[] = []; // the last 2 minutes, all services
  const open: { p: Packet; until: number }[] = [];
  const groups = new Map<string, Packet>();
  let i = 0;
  for await (const e of readStream(entry.dir, caseId)) {
    const idx = i++;
    const line: Line = { i: idx, t: e.t, service: serviceOf(e.data, e.source), text: textOf(e.data) };
    // Lines after an item fill its ±30 s window.
    for (const o of open) if (e.t <= o.until) o.p.around.push(line);
    while (open.length && e.t > open[0]!.until) open.shift();
    while (recent.length && recent[0]!.t < e.t - 120_000) recent.shift();
    const tag = times?.get(e.t);
    const from = new Set([...(why.get(`${caseId}:${idx}`) ?? []), ...(tag ? [tag] : [])]);
    if (from.size) {
      const id = `${caseId}:${idx}`;
      const g = `${line.service}|${line.text}|${Math.floor(e.t / 60_000)}`;
      const same = groups.get(g);
      if (same) {
        same.ids.push(id);
        for (const f of from) same.from.add(f);
      } else {
        const p: Packet = {
          pid: `p${String(packets.length + 1).padStart(4, "0")}`, case: caseId, ids: [id], from, t: e.t, service: line.service,
          raw: compactJson(e.data, { maxChars: 1500 }), text: line.text,
          before: recent.filter((l) => l.service === line.service).slice(-20),
          around: recent.filter((l) => l.t >= e.t - 30_000),
        };
        groups.set(g, p);
        packets.push(p);
        open.push({ p, until: e.t + 30_000 });
      }
    }
    recent.push(line);
  }
  console.log(`${caseId}: ${packets.filter((p) => p.case === caseId).length} packets`);
}

// --- write -----------------------------------------------------------------------------------
const clock = (t: number) => new Date(t).toISOString().slice(11, 23);
/** Lines with consecutive repeats of the same service and text collapsed. */
function collapse(lines: Line[], max: number, skip: number): string[] {
  const out: { l: Line; n: number }[] = [];
  for (const l of lines) {
    if (l.i === skip) continue;
    const last = out.at(-1);
    if (last && last.l.service === l.service && last.l.text === l.text) last.n++;
    else out.push({ l, n: 1 });
  }
  const pick = out.length > max ? out.filter((_, k) => k % Math.ceil(out.length / max) === 0) : out;
  return pick.map(({ l, n }) => `  ${clock(l.t)} [${l.service}] ${l.text.slice(0, 220)}${n > 1 ? `  (×${n})` : ""}`);
}
fs.mkdirSync(args.out, { recursive: true });
const order = shuffle(packets);
const size = Number(args.batch);
const nb = Math.ceil(order.length / size);
for (let b = 0; b < nb; b++) {
  const part = order.slice(b * size, (b + 1) * size);
  const md = part.map((p) => {
    const c = cases.get(p.case)!.c;
    const sys = SYSTEMS[(c.system as string) ?? c.dataset] ?? String(c.dataset);
    const center = p.ids.length ? Number(p.ids[0]!.slice(p.ids[0]!.lastIndexOf(":") + 1)) : -1;
    return [
      `## ${p.pid}`,
      `System: ${sys}`,
      `Event: service ${p.service}, ${new Date(p.t).toISOString()}${p.ids.length > 1 ? `, and ${p.ids.length - 1} identical event(s) in the same minute` : ""}`,
      "```",
      p.raw,
      "```",
      `Same service, the 2 minutes before (oldest first):`,
      ...(p.before.length ? collapse(p.before, 20, center) : ["  (nothing)"]),
      `All services, 30 seconds either side (sampled):`,
      ...collapse(p.around, 30, center),
      "",
    ].join("\n");
  });
  fs.writeFileSync(path.join(args.out, `batch-${String(b + 1).padStart(2, "0")}.md`), md.join("\n"));
}
fs.writeFileSync(
  path.join(args.out, "items.csv"),
  ["packet,batch,case,time,service,ids,from,message", ...order.map((p, k) => [p.pid, Math.floor(k / size) + 1, p.case, new Date(p.t).toISOString(), p.service, p.ids.join(" "), [...p.from].sort().join(" "), p.text.slice(0, 300)].map(csv).join(","))].join("\n") + "\n",
);
const count: Record<string, number> = {};
for (const p of packets) for (const f of p.from) count[f.split(":")[0]!] = (count[f.split(":")[0]!] ?? 0) + 1;
console.log(JSON.stringify({ packets: packets.length, events: packets.reduce((a, p) => a + p.ids.length, 0), batches: nb, by_source: count, not_found: notFound.length }, null, 1));
