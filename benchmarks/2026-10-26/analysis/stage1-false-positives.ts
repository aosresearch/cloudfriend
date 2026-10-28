import fs from "node:fs";
import { Classifier } from "../../../src/triage/classifier.ts";
const load = (p: string) => new Classifier(JSON.parse(fs.readFileSync(p, "utf8")));
const m0 = load("data/models/gaia-only.json"), m1 = load(process.argv[3]!);
const lines = fs.readFileSync(process.argv[2]!, "utf8").trim().split("\n").slice(1);
const c = { fp: 0, fpStill: 0, tp: 0, tpStill: 0, low: 0, lowNow: 0 };
for (const l of lines) {
  const p = l.split(","); const y = Number(p[2]); const x = p.slice(4).map((v) => (v === "" ? NaN : Number(v)));
  const s0 = m0.score(x), s1 = m1.score(x); const f0 = s0 >= m0.file.drop_below, f1 = s1 >= m1.file.drop_below;
  if (f0 && !y) { c.fp++; if (f1) c.fpStill++; }
  if (y) { c.tp++; if (f1) c.tpStill++; }
  if (!f0 && !y) { c.low++; if (f1) c.lowNow++; }
}
console.log(JSON.stringify(c));
console.log(`stage-1 false positives (passed by M0, Jev said no): ${c.fp}; still passed after retraining: ${c.fpStill} (${(100 * c.fpStill / c.fp).toFixed(1)}%)`);
console.log(`Jev escalations: ${c.tp}; still passed after retraining: ${c.tpStill} (${(100 * c.tpStill / c.tp).toFixed(1)}%)`);
console.log(`audit/novel negatives M0 dropped: ${c.low}; passed after retraining: ${c.lowNow}`);
