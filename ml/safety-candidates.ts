// Pick events for the human-reviewed safety set (benchmarks/safety-set/README.md).
//
//   node ml/safety-candidates.ts --data data/prepared/re3 --data data/prepared/gaia \
//     --model models/base.json --out benchmarks/safety-set
//
// Replays the eval split of each dataset through the server's featurizer and classifier and
// keeps a stratified sample of the events a classifier is most likely to get wrong: rare
// incidents, failures that were already there before the fault, one-off errors, messages that
// turn from routine into errors, and dropped traffic. It makes no Jev calls and reads no
// labels from Jev. People label the result; the trainer then uses the "must_reach" rows as an
// acceptance-only check (CLOUDFRIEND_SAFETY_SET), never for training.
//
// Writes <out>/candidates.csv (for people: one row per event, label column blank) and
// <out>/candidates.features.csv (for the trainer: the featurizer's vector for each event, at the
// moment it arrived). Re-running with the same inputs and --seed gives the same rows.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Classifier, type ClassifierFile } from "../src/triage/classifier.ts";
import { FEATURE_NAMES, Featurizer, type Featurized } from "../src/triage/features.ts";
import { loadCases, readStream, type Case } from "./streams.ts";

const { values: args } = parseArgs({
  options: {
    data: { type: "string", multiple: true },
    model: { type: "string" },
    out: { type: "string" },
    split: { type: "string", default: "eval" },
    seed: { type: "string", default: "1" },
    // Rows per stratum. The total is about 300.
    transition: { type: "string", default: "50" },
    single: { type: "string", default: "50" },
    rare: { type: "string", default: "50" },
    persistent: { type: "string", default: "50" },
    "dropped-positive": { type: "string", default: "40" },
    dropped: { type: "string", default: "60" },
  },
});
if (!args.data?.length || !args.model || !args.out) {
  console.error("usage: node ml/safety-candidates.ts --data <prepared dir> [--data ...] --model <model.json> --out <dir>");
  process.exit(2);
}

const model = new Classifier(JSON.parse(fs.readFileSync(args.model, "utf8")) as ClassifierFile);
// The features are the model's version: the trainer checks the vectors against it.
const version = model.file.featurizer_version;
let seed = Number(args.seed) >>> 0 || 1;
const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);

/** GAIA incident kinds seen fewer than this many times in two weeks count as rare. */
const RARE_KIND = 50;
/** A template counts as routine once it was seen this often outside a fault, never as an error. */
const ROUTINE = 20;
/** A template counts as already failing after this many errors outside a fault. */
const PERSISTENT = 5;
/** GAIA symptoms can trail an incident's window. */
const INCIDENT_TAIL = 5 * 60_000;

type Stratum = "transition" | "single_event" | "rare_incident" | "rare_symptom" | "persistent" | "dropped_positive" | "dropped";

interface Candidate {
  id: string;
  dataset: string;
  case: string;
  t: number;
  source: string;
  service: string;
  message: string;
  stratum: Stratum;
  context: string;
  template: string;
  values: number[];
}

interface TemplateState {
  count: number;
  /** Outside a fault: events, errors, and whether any was an error. */
  outside: number;
  outsideErrors: number;
  positives: number;
  firstError: Candidate | null;
  firstPositive: Candidate | null;
  transition: boolean;
  persistent: boolean;
  droppedPositive: boolean;
  rare: Set<string>;
}

const pools: Record<Stratum, Candidate[]> = {
  transition: [], single_event: [], rare_incident: [], rare_symptom: [], persistent: [], dropped_positive: [], dropped: [],
};

for (const dir of args.data) {
  const cases = loadCases(dir);
  const kinds = new Map<string, number>();
  for (const c of cases) for (const i of c.incidents ?? []) kinds.set(i.kind, (kinds.get(i.kind) ?? 0) + 1);
  const picked = cases.filter((c) => c.split === args.split);
  // A GAIA day continues the one before it: replay that day first so the history is warm.
  const replay: { c: Case; pick: boolean }[] = [];
  for (const c of picked) {
    if (c.chain) {
      const prev = cases.filter((x) => x.chain === c.chain && x.start_ms < c.start_ms).at(-1);
      if (prev && !replay.some((r) => r.c.id === prev.id) && !picked.includes(prev)) replay.push({ c: prev, pick: false });
    }
    replay.push({ c, pick: true });
  }
  const chains = new Map<string, Featurizer>();
  for (const { c, pick } of replay) {
    const f = c.chain ? (chains.get(c.chain) ?? chains.set(c.chain, new Featurizer({ version })).get(c.chain)!) : new Featurizer({ version });
    const templates = new Map<string, TemplateState>();
    const dropped: Candidate[] = [];
    let droppedSeen = 0;
    let n = 0;
    for await (const e of readStream(dir, c.id)) {
      const out = f.featurize({ source: e.source, received_at: e.t, data: e.data });
      const i = n++;
      if (!pick) continue;
      const score = model.score(out.values);
      const fault = faultAt(c, e.t, out.service);
      let st = templates.get(out.template);
      if (!st) {
        st = { count: 0, outside: 0, outsideErrors: 0, positives: 0, firstError: null, firstPositive: null, transition: false, persistent: false, droppedPositive: false, rare: new Set() };
        templates.set(out.template, st);
      }
      st.count++;
      const make = (stratum: Stratum) => candidate(c, i, e.t, e.source, out, stratum, fault.text);
      if (!fault.inside) {
        st.outside++;
        if (out.errorish) st.outsideErrors++;
      } else if (out.errorish) {
        if (!st.transition && st.outside >= ROUTINE && st.outsideErrors === 0) {
          st.transition = true;
          pools.transition.push(make("transition"));
        }
        if (!st.persistent && st.outsideErrors >= PERSISTENT) {
          st.persistent = true;
          pools.persistent.push(make("persistent"));
        }
        for (const inc of fault.incidents) {
          if ((kinds.get(inc.kind) ?? 0) >= RARE_KIND || inc.service !== out.service || st.rare.has(inc.id)) continue;
          st.rare.add(inc.id);
          pools.rare_incident.push(make("rare_incident"));
        }
      }
      if (out.errorish && !st.firstError) st.firstError = make("single_event");
      if (e.y) {
        st.positives++;
        if (!st.firstPositive) st.firstPositive = make("rare_symptom");
        if (score < model.file.drop_below && !st.droppedPositive) {
          st.droppedPositive = true;
          pools.dropped_positive.push(make("dropped_positive"));
        }
      } else if (score < model.file.drop_below) {
        // Reservoir sample of the dropped traffic, five per case.
        droppedSeen++;
        if (dropped.length < 5) dropped.push(make("dropped"));
        else {
          const j = Math.floor(rand() * droppedSeen);
          if (j < 5) dropped[j] = make("dropped");
        }
      }
    }
    if (!pick) {
      console.log(`${c.id}: warm-up`);
      continue;
    }
    for (const st of templates.values()) {
      if (st.firstError && st.count <= 2) pools.single_event.push(st.firstError);
      if (c.dataset === "re3" && st.firstPositive && st.positives <= 10) pools.rare_symptom.push(st.firstPositive);
    }
    pools.dropped.push(...dropped);
    console.log(`${c.id}: ${n} events, ${templates.size} templates`);
  }
}

// A template appears once in the set, in the first stratum (in this order) that has it.
const order: [Stratum, number][] = [
  ["transition", Number(args.transition)],
  ["single_event", Number(args.single)],
  ["rare_incident", Math.ceil(Number(args.rare) / 2)],
  ["rare_symptom", Math.floor(Number(args.rare) / 2)],
  ["persistent", Number(args.persistent)],
  ["dropped_positive", Number(args["dropped-positive"])],
  ["dropped", Number(args.dropped)],
];
const used = new Set<string>();
const chosen: Candidate[] = [];
for (const [stratum, want] of order) {
  const free = pools[stratum].filter((x) => !used.has(x.template));
  const got = spread(free, want);
  for (const x of got) used.add(x.template);
  chosen.push(...got);
  console.log(`${stratum}: ${got.length} of ${pools[stratum].length} candidates`);
}
chosen.sort((a, b) => a.dataset.localeCompare(b.dataset) || a.case.localeCompare(b.case) || a.t - b.t);

fs.mkdirSync(args.out, { recursive: true });
const cols = ["id", "dataset", "case", "time", "source", "service", "message", "stratum", "context", "label", "notes"];
fs.writeFileSync(
  path.join(args.out, "candidates.csv"),
  [cols.join(","), ...chosen.map((x) => [x.id, x.dataset, x.case, new Date(x.t).toISOString(), x.source, x.service, x.message, x.stratum, x.context, "", ""].map(csv).join(","))].join("\n") + "\n",
);
const fmt = (v: number) => (Number.isNaN(v) ? "" : Number.isInteger(v) ? String(v) : v.toPrecision(6));
fs.writeFileSync(
  path.join(args.out, "candidates.features.csv"),
  [["id", `featurizer_v${version}`, ...FEATURE_NAMES].join(","), ...chosen.map((x) => [x.id, "", ...x.values.map(fmt)].join(","))].join("\n") + "\n",
);
console.log(`${chosen.length} candidates written to ${args.out}`);

function candidate(c: Case, i: number, t: number, source: string, f: Featurized, stratum: Stratum, context: string): Candidate {
  return {
    id: `${c.id}:${i}`,
    dataset: c.dataset,
    case: c.id,
    t,
    source,
    service: f.service,
    message: f.text.replace(/\s+/g, " ").slice(0, 300),
    stratum,
    context,
    template: f.template,
    values: [...f.values],
  };
}

/** Where an event sits relative to the case's fault, in words a reviewer can use. */
function faultAt(c: Case, t: number, service: string) {
  if (c.inject_ms !== undefined) {
    const s = Math.round((t - c.inject_ms) / 1000);
    const what = `${c.service} ${c.fault} injected ${new Date(c.inject_ms).toISOString().slice(11, 19)}`;
    return { inside: t >= c.inject_ms, incidents: [], text: `${what}; event ${s >= 0 ? "+" : ""}${s}s` };
  }
  const incidents = (c.incidents ?? []).filter((i) => t >= i.start_ms && t <= i.end_ms + INCIDENT_TAIL);
  if (!incidents.length) return { inside: false, incidents, text: "no incident in progress" };
  const text = incidents
    .map((i) => `${i.kind} on ${i.service}${i.service === service ? " (this service)" : ""}, started ${Math.round((t - i.start_ms) / 1000)}s before`)
    .join("; ");
  return { inside: true, incidents, text: `incident: ${text}` };
}

/** Up to `want` items, spread evenly across cases, random within a case. */
function spread(items: Candidate[], want: number): Candidate[] {
  const byCase = new Map<string, Candidate[]>();
  for (const x of items) (byCase.get(x.case) ?? byCase.set(x.case, []).get(x.case)!).push(x);
  for (const xs of byCase.values()) {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [xs[i], xs[j]] = [xs[j]!, xs[i]!];
    }
  }
  const queues = [...byCase.values()];
  const out: Candidate[] = [];
  const seen = new Set<string>();
  while (out.length < want && queues.some((q) => q.length)) {
    for (const q of queues) {
      const x = q.shift();
      if (!x || seen.has(x.template)) continue;
      seen.add(x.template);
      out.push(x);
      if (out.length >= want) break;
    }
  }
  return out;
}

function csv(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
