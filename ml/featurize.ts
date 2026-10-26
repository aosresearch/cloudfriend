// Replay prepared streams through the featurizer and write training rows as CSV, so that
// Python trains on exactly the numbers the server computes.
//
//   node ml/featurize.ts --data data/prepared/re3 --data data/prepared/gaia --out data/features
//
// Writes <out>/{train,valid,eval}.csv with columns: case, t, y, w, f0..fN. Every event goes
// through the featurizer (its rate features need the full history), but only a sample of the
// plain negatives is written: all positives, all error-like negatives, and `--keep` of the
// rest, weighted up by 1/keep so the class balance stays honest.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { FEATURE_NAMES, FEATURIZER_VERSION, Featurizer } from "../src/triage/features.ts";
import { loadCases, readStream, type Case } from "./streams.ts";

const { values: args } = parseArgs({
  options: {
    data: { type: "string", multiple: true },
    out: { type: "string" },
    keep: { type: "string", default: "0.05" },
    // Rows from a stream's first minutes describe a featurizer that has seen almost nothing;
    // in the benchmarks those minutes are always healthy, which would teach "new = fine".
    warmup: { type: "string", default: "180000" },
    seed: { type: "string", default: "1" },
  },
});
if (!args.data?.length || !args.out) {
  console.error("usage: node ml/featurize.ts --data <prepared dir> [--data ...] --out <dir> [--keep 0.05]");
  process.exit(2);
}
const keep = Number(args.keep);
const warmup = Number(args.warmup);
let seed = Number(args.seed) >>> 0 || 1;
const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);

fs.mkdirSync(args.out, { recursive: true });
const header = ["case", "t", "y", "w", ...FEATURE_NAMES].join(",") + "\n";
const files = Object.fromEntries(
  (["train", "valid", "eval"] as const).map((s) => {
    const fd = fs.openSync(path.join(args.out!, `${s}.csv`), "w");
    fs.writeSync(fd, header);
    return [s, fd];
  }),
) as Record<Case["split"], number>;

const fmt = (v: number) => (Number.isNaN(v) ? "" : Number.isInteger(v) ? String(v) : v.toPrecision(6));
const stats: Record<string, { events: number; rows: number; positives: number }> = {};

for (const dir of args.data) {
  const cases = loadCases(dir);
  const chains = new Map<string, Featurizer>();
  for (const c of cases) {
    const f = c.chain ? (chains.get(c.chain) ?? chains.set(c.chain, new Featurizer()).get(c.chain)!) : new Featurizer();
    const st = (stats[c.split] ??= { events: 0, rows: 0, positives: 0 });
    let buf = "";
    const chainStart = c.chain ? cases.find((x) => x.chain === c.chain)!.start_ms : c.start_ms;
    let first: number | null = null;
    for await (const e of readStream(dir, c.id)) {
      const out = f.featurize({ source: e.source, received_at: e.t, data: e.data });
      st.events++;
      first ??= c.chain ? chainStart : e.t;
      if (e.t - first < warmup) continue;
      let w = 1;
      if (!e.y && !out.errorish) {
        if (rand() >= keep) continue;
        w = 1 / keep;
      }
      st.rows++;
      st.positives += e.y;
      buf += `${c.id},${e.t},${e.y},${fmt(w)},${out.values.map(fmt).join(",")}\n`;
      if (buf.length > 1 << 20) {
        fs.writeSync(files[c.split], buf);
        buf = "";
      }
    }
    fs.writeSync(files[c.split], buf);
    console.log(`${c.id} (${c.split}) templates=${f.templateCount}`);
  }
}
for (const fd of Object.values(files)) fs.closeSync(fd);
fs.writeFileSync(
  path.join(args.out, "meta.json"),
  JSON.stringify({ featurizer_version: FEATURIZER_VERSION, feature_names: FEATURE_NAMES, keep, stats }, null, 1),
);
console.log(JSON.stringify(stats));
