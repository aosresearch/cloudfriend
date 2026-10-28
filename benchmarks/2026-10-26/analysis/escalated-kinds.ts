// Replay held-out cases. "Jev escalates kind T" = Jev flagged an event of template T in the
// recorded run. Count events of escalated kinds after Jev first escalated them, and how many
// reach Jev under the retrained classifier, with and without the escalated-kind rule.
import fs from "node:fs";
import { routeEvent, EscalatedTemplates } from "../../../src/triage/cascade.ts";
import { Classifier } from "../../../src/triage/classifier.ts";
import { Featurizer } from "../../../src/triage/features.ts";
import { readStream } from "../../../ml/streams.ts";
const D = "data/distill";
const m = new Classifier(JSON.parse(fs.readFileSync(process.argv[2] ?? `${D}/m1-fp.json`, "utf8")));
const fmt = (v: number) => (Number.isNaN(v) ? "" : Number.isInteger(v) ? String(v) : v.toPrecision(6));
const rows = fs.readFileSync(`${D}/fp-held.csv`, "utf8").trim().split(/\r?\n/).slice(1).map((l) => { const p = l.split(","); return { c: p[0]!, t: Number(p[1]), y: Number(p[2]), key: `${p[1]}|${p.slice(4).join(",")}` }; });
const cases = [...new Set(rows.map((r) => r.c))];
for (const guard of [false, true]) {
  const tot = { after: 0, reach: 0, kinds: 0, kindsReached: 0, fpKinds: 0 };
  for (const cs of cases) {
    const pos = new Map(rows.filter((r) => r.c === cs && r.y).map((r) => [r.key, r.t]));
    // First pass: templates Jev escalated in the recording, and when.
    const f1 = new Featurizer(); const firstEsc = new Map<string, number>();
    for await (const e of readStream("data/prepared/re3", cs)) {
      const o = f1.featurize({ source: e.source, received_at: e.t, data: e.data });
      if (pos.has(`${e.t}|${o.values.map(fmt).join(",")}`) && !firstEsc.has(o.template)) firstEsc.set(o.template, e.t);
    }
    // Second pass: route with the retrained classifier.
    const f = new Featurizer(); const esc = new EscalatedTemplates(7 * 86_400_000); const reachedKinds = new Set<string>();
    let seed = 7; const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    for await (const e of readStream("data/prepared/re3", cs)) {
      const o = f.featurize({ source: e.source, received_at: e.t, data: e.data });
      const r = routeEvent(m.score(o.values), { dropBelow: m.file.drop_below, escalateAbove: 2, threshold: m.file.threshold, hasJev: true, auditRate: 0.01, rand }, o.novel, guard && esc.has(o.template, e.t));
      const t0 = firstEsc.get(o.template);
      if (r !== "drop" && t0 !== undefined) { esc.add(o.template, e.t); reachedKinds.add(o.template); }
      if (t0 !== undefined && e.t > t0) { tot.after++; if (r !== "drop") tot.reach++; }
    }
    tot.kinds += firstEsc.size; tot.kindsReached += reachedKinds.size;
  }
  console.log(`${guard ? "with escalated-kind rule" : "classifier only         "}: kinds Jev escalated that reach Jev at all ${tot.kindsReached}/${tot.kinds}; later events of those kinds reaching Jev ${tot.reach}/${tot.after} (${(100 * tot.reach / Math.max(tot.after, 1)).toFixed(1)}%)`);
}
