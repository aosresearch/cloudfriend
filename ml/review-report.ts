// Compare the assistant-reviewed references with Jev's answers and the weak labels.
//
//   node ml/review-report.ts --references references.csv --evidence data/evidence/evidence.csv \
//     --data old=data/prepared/re3 --data old=data/prepared/gaia --data new=data/prepared/re3-v3 --data new=data/prepared/gaia21 \
//     --out review-report.json
//
// Per item source (the Jev audit, the sampled drops, the safety candidates, the priority sets):
// how the references split, how Jev's direct answers compare (its misses: benign where the
// reference says relevant), how the weak labels compare before and after the parsing fix, and
// for the drops, the share that mattered with an exact bound. References are assistant-reviewed,
// not human gold; `unknown` and `unsure` are counted apart, never as either side.
import fs from "node:fs";
import { parseArgs } from "node:util";
import { lowerBound, upperBound } from "../src/stats.ts";
import { parseCsvLine } from "../src/training.ts";
import { loadCases, readStream } from "./streams.ts";

const { values: args } = parseArgs({
  options: { references: { type: "string" }, evidence: { type: "string" }, data: { type: "string", multiple: true }, out: { type: "string" } },
});
if (!args.references || !args.evidence || !args.out) {
  console.error("usage: node ml/review-report.ts --references <csv> --evidence <csv> --data old=<dir> --data new=<dir> --out <json>");
  process.exit(2);
}
function readCsv(file: string): Record<string, string>[] {
  const [header, ...lines] = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const cols = parseCsvLine(header!);
  return lines.map((l) => Object.fromEntries(parseCsvLine(l).map((v, i) => [cols[i]!, v])));
}
const refs = readCsv(args.references);
const jev = new Map(readCsv(args.evidence).map((r) => [r.id!, r.status!]));

// Weak labels of the reviewed events, under the old and the corrected rules.
const weak: Record<string, Map<string, number>> = { old: new Map(), new: new Map() };
const want = new Map<string, Set<number>>();
for (const r of refs) {
  const i = r.id!.lastIndexOf(":");
  const c = r.id!.slice(0, i);
  (want.get(c) ?? want.set(c, new Set()).get(c)!).add(Number(r.id!.slice(i + 1)));
}
for (const spec of args.data ?? []) {
  const [which, dir] = spec.split("=") as ["old" | "new", string];
  for (const c of loadCases(dir)) {
    const idx = want.get(c.id);
    if (!idx) continue;
    let i = 0;
    for await (const e of readStream(dir, c.id)) {
      if (idx.has(i)) weak[which]!.set(`${c.id}:${i}`, e.y);
      i++;
    }
  }
}

const sources = ["audit", "drops", "safety", "conflict-labels", "conflict-direct", "benign-positive", "inconsistent", "miss-positive"];
const report: Record<string, unknown> = {
  method: "assistant review (two independent Claude subagents, a third on disagreement); not human gold",
  events: refs.length,
  packets: new Set(refs.map((r) => r.packet)).size,
  agreement: { packets: new Set(refs.map((r) => r.packet)).size, disagreed: new Set(refs.filter((r) => r.adjudicated).map((r) => r.packet)).size },
};
const tally = (rs: Record<string, string>[], key: (r: Record<string, string>) => string) => {
  const t: Record<string, number> = {};
  for (const r of rs) t[key(r)] = (t[key(r)] ?? 0) + 1;
  return t;
};
for (const s of sources) {
  const rs = refs.filter((r) => r.from!.split(" ").some((f) => f.split(":")[0] === s));
  if (!rs.length) continue;
  const decided = rs.filter((r) => r.label === "relevant" || r.label === "benign");
  const rel = decided.filter((r) => r.label === "relevant");
  const jevRows = decided.filter((r) => jev.has(r.id!));
  const jevSaid = (r: Record<string, string>) => jev.get(r.id!)!;
  const x: Record<string, unknown> = {
    events: rs.length,
    reference: tally(rs, (r) => r.label!),
    jev_vs_reference: jevRows.length ? tally(jevRows, (r) => `jev ${jevSaid(r)} / ref ${r.label}`) : undefined,
    weak_old_vs_reference: tally(decided.filter((r) => weak.old!.has(r.id!)), (r) => `weak ${weak.old!.get(r.id!)} / ref ${r.label}`),
    weak_new_vs_reference: tally(decided.filter((r) => weak.new!.has(r.id!)), (r) => `weak ${weak.new!.get(r.id!)} / ref ${r.label}`),
  };
  if (s === "drops") {
    // The share of dropped events that mattered: false omission, not recall.
    x.relevant_share = { k: rel.length, n: decided.length, rate: rel.length / Math.max(decided.length, 1), upper95: upperBound(rel.length, decided.length) };
  }
  if (s === "audit") {
    const jb = jevRows.filter((r) => jevSaid(r) === "benign");
    const jr = jevRows.filter((r) => jevSaid(r) === "relevant");
    x.jev_benign_but_relevant = { k: jb.filter((r) => r.label === "relevant").length, n: jb.length, upper95: upperBound(jb.filter((r) => r.label === "relevant").length, jb.length) };
    x.jev_relevant_and_relevant = { k: jr.filter((r) => r.label === "relevant").length, n: jr.length, lower95: lowerBound(jr.filter((r) => r.label === "relevant").length, jr.length) };
  }
  report[s] = x;
}
fs.writeFileSync(args.out, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
