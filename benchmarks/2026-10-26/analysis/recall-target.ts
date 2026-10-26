import fs from "node:fs";
import { Classifier } from "../../../src/triage/classifier.ts";
import { Featurizer } from "../../../src/triage/features.ts";
import { readStream } from "../../../ml/streams.ts";
const load = (p: string) => new Classifier(JSON.parse(fs.readFileSync(p, "utf8")));
const D = "data/distill";
const m0 = load("data/models/gaia-only.json");
const models: Record<string, Classifier> = { "recall 0.98": load(`${D}/m1-fp.json`), "recall 0.995": load(`${D}/m1-fp995.json`) };
const fmt = (v: number) => (Number.isNaN(v) ? "" : Number.isInteger(v) ? String(v) : v.toPrecision(6));
const rows = fs.readFileSync(`${D}/fp-held.csv`, "utf8").trim().split(/\r?\n/).slice(1).map((l) => {
  const p = l.split(","); return { c: p[0]!, t: Number(p[1]), y: Number(p[2]), key: `${p[1]}|${p.slice(4).join(",")}`, x: p.slice(4).map((v) => (v === "" ? NaN : Number(v))) };
});
const cases = [...new Set(rows.map((r) => r.c))];
const info = new Map<string, { template: string; novel: boolean }>();
for (const c of cases) {
  const f = new Featurizer();
  for await (const e of readStream("data/prepared/re3", c)) {
    const o = f.featurize({ source: e.source, received_at: e.t, data: e.data });
    info.set(`${c}|${e.t}|${o.values.map(fmt).join(",")}`, { template: o.template, novel: o.novel });
  }
}
let matched = 0;
for (const r of rows) if (info.has(`${r.c}|${r.key}`)) matched++;
console.log(`labels ${rows.length}, matched to templates ${matched}`);
for (const [name, m] of Object.entries(models)) for (const guard of [false, true]) {
  const c = { pos: 0, posReach: 0, fp: 0, fpReach: 0 };
  for (const cs of cases) {
    const esc = new Set<string>();
    for (const r of rows.filter((x) => x.c === cs).sort((a, b) => a.t - b.t)) {
      const i = info.get(`${r.c}|${r.key}`);
      const reach = m.score(r.x) >= m.file.drop_below || (guard && i && (esc.has(i.template) || i.novel));
      if (r.y) { c.pos++; if (reach) { c.posReach++; if (i) esc.add(i.template); } }
      if (!r.y && m0.score(r.x) >= m0.file.drop_below) { c.fp++; if (reach) c.fpReach++; }
    }
  }
  console.log(`${name.padEnd(13)} ${guard ? "+ escalated/novel rule" : "classifier only      "}: Jev escalations reaching Jev ${c.posReach}/${c.pos} (${(100 * c.posReach / c.pos).toFixed(1)}%), stage-1 false positives still sent ${c.fpReach}/${c.fp} (${(100 * c.fpReach / c.fp).toFixed(1)}%)`);
}
const m = models["recall 0.98"]!;
for (const cs of cases) {
  const esc = new Set<string>(); const seen = new Map<string, number>();
  for (const r of rows.filter((x) => x.c === cs).sort((a, b) => a.t - b.t)) {
    const i = info.get(`${r.c}|${r.key}`)!; const s = m.score(r.x);
    const reach = s >= m.file.drop_below || esc.has(i.template) || i.novel;
    if (r.y && reach) esc.add(i.template);
    if (r.y && !reach) console.log("MISSED", cs, `score=${s.toExponential(2)}`, `m0=${m0.score(r.x).toExponential(2)}`, `earlierLabels=${seen.get(i.template) ?? 0}`, i.template.slice(0, 140));
    seen.set(i.template, (seen.get(i.template) ?? 0) + 1);
  }
}
