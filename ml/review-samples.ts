// Human-review samples from ml/evaluate.ts --samples-out, so that people, not Jev, decide:
//
//   jev-audit.csv   Jev's judgments, stratified by what it said (relevant, benign, uncertain):
//                   is Jev itself right? This is the evidence for the "dismissed" failure
//                   rate, which no comparison between models can give.
//   drops.csv       a uniform sample of what the classifier (and, with --compare-model, the
//                   previous model too) dropped: how often is something important dropped?
//
//   node ml/review-samples.ts --in data/results/samples --out benchmarks/review --judgments 200 --drops 300
//
// Both get a blank `label` column (relevant | benign | unsure) and `notes`. The weak label and
// Jev's answer are left out of the drop sample, so they don't steer the reviewer; the audit
// sample shows Jev's answer, since checking it is the point.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseCsvLine } from "../src/training.ts";

const { values: args } = parseArgs({
  options: {
    in: { type: "string", multiple: true },
    out: { type: "string" },
    judgments: { type: "string", default: "200" },
    drops: { type: "string", default: "300" },
    seed: { type: "string", default: "1" },
  },
});
if (!args.in?.length || !args.out) {
  console.error("usage: node ml/review-samples.ts --in <samples dir> [--in ...] --out <dir>");
  process.exit(2);
}
let seed = Number(args.seed) >>> 0 || 1;
const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const shuffle = <T>(xs: T[]) => {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
  return xs;
};
const csv = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function read(file: string): Record<string, string>[] {
  if (!fs.existsSync(file)) return [];
  const [header, ...lines] = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const cols = parseCsvLine(header!);
  return lines.map((l) => Object.fromEntries(parseCsvLine(l).map((v, i) => [cols[i]!, v])));
}

const judgments = args.in.flatMap((d) => read(path.join(d, "judgments.csv")));
const drops = args.in.flatMap((d) => read(path.join(d, "drops.csv")));

// Stratify by Jev's answer, a third each where there are enough; one row per message.
const want = Number(args.judgments);
const byAnswer = new Map<string, Record<string, string>[]>();
for (const j of shuffle(judgments)) (byAnswer.get(j.jev!) ?? byAnswer.set(j.jev!, []).get(j.jev!)!).push(j);
const picked: Record<string, string>[] = [];
const seen = new Set<string>();
const order = ["relevant", "benign", "uncertain"];
for (let round = 0; picked.length < want && order.some((k) => byAnswer.get(k)?.length); round++) {
  for (const k of order) {
    const q = byAnswer.get(k);
    while (q?.length) {
      const j = q.shift()!;
      const key = `${j.service}|${j.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(j);
      break;
    }
    if (picked.length >= want) break;
  }
}
const dropPick = shuffle(drops).slice(0, Number(args.drops));

fs.mkdirSync(args.out, { recursive: true });
const write = (name: string, cols: string[], rows: Record<string, string>[]) =>
  fs.writeFileSync(path.join(args.out!, name), [[...cols, "label", "notes"].join(","), ...rows.map((r) => [...cols.map((c) => csv(r[c] ?? "")), "", ""].join(","))].join("\n") + "\n");
write("jev-audit.csv", ["id", "case", "time", "source", "service", "message", "jev"], picked.sort((a, b) => a.id!.localeCompare(b.id!)));
write("drops.csv", ["id", "case", "time", "source", "service", "message"], dropPick.sort((a, b) => a.id!.localeCompare(b.id!)));
const count = (rs: Record<string, string>[], k: string) => Object.fromEntries([...new Set(rs.map((r) => r[k]!))].map((v) => [v, rs.filter((r) => r[k] === v).length]));
console.log(`jev-audit.csv: ${picked.length} of ${judgments.length} judgments`, count(picked, "jev"));
console.log(`drops.csv: ${dropPick.length} of ${drops.length} sampled drops`);
