// The dev gate: does each arm get every reviewed must-reach event to Jev? Audits saved results
// only; it makes no replay and no inference call, and it can never approve a release.
//
//   node --import ./ml/no-network.ts ml/dev-gate-report.ts --results data/r4/dev2 \
//     --references benchmarks/2026-10-27-r4/references.csv --roles benchmarks/2026-10-27-r4/roles.json \
//     --out benchmarks/2026-10-27-r4/dev-gate-report.json
//
// --results holds ml/evaluate.ts outputs named <dataset>-<arm>[-cautious].json (the cautious
// oracle is primary, the weak-label oracle a sensitivity check) and must-reach-ids.txt, the
// requested ids. Every requested event must be reached: credential and payment-data exposures
// count like any other relevant event, and a requested event the replay never met in scope is
// unobserved, which fails as surely as a miss. Categories (exposure or symptom) are reported
// for reading, not for excusing.
//
// The output is deterministic (sorted keys, no clock) and records the sha256 of every input.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseCsvLine } from "../src/training.ts";
import { loadRoles } from "./roles.ts";

const { values: args } = parseArgs({
  options: {
    results: { type: "string" },
    references: { type: "string" },
    roles: { type: "string" },
    out: { type: "string" },
    baseline: { type: "string", default: "baseline" },
  },
});
if (!args.results || !args.references || !args.roles || !args.out) {
  console.error("usage: node ml/dev-gate-report.ts --results <dir> --references <csv> --roles <json> --out <json>");
  process.exit(2);
}

const sha256 = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function readCsv(file: string): Record<string, string>[] {
  const [header, ...lines] = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const cols = parseCsvLine(header!);
  return lines.map((l) => Object.fromEntries(parseCsvLine(l).map((v, i) => [cols[i]!, v])));
}
/** JSON with sorted keys, so the same inputs give the same bytes. */
const sorted = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v;

/** Plain-text credentials, payment data or personal records in the event: reported apart, never excused. */
const EXPOSURE =
  /longNum|"ccv"|credit_card|"password"|token generate success|token=\S{20}|eyJhbGci|LOGIN USER( NEW)? ?:\S+ __ \S+|passwards|Posting Card|Posting Customer/i;

const roles = loadRoles(args.roles);
const refs = new Map(readCsv(args.references).map((r) => [r.id!, r]));
const idsFile = path.join(args.results, "must-reach-ids.txt");
const requested = fs.readFileSync(idsFile, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).sort();
for (const id of requested) {
  const role = roles.cases[id.slice(0, id.lastIndexOf(":"))];
  if (role !== "dev") throw new Error(`${id} is a ${role ?? "roleless"} case: the dev gate takes dev cases only`);
}
const kind = (id: string) => (EXPOSURE.test(refs.get(id)?.message ?? "") ? "exposure" : refs.get(id)?.label === "unknown" ? "unknown" : "symptom");
const datasetOf = (id: string) => (id.startsWith("gaia-") ? "gaia" : "re3");

interface Run {
  dataset: string;
  arm: string;
  oracle: "oracle-cautious" | "oracle";
  file: string;
  model: { path: string; sha256: string | null; drop_below: number };
  requested: string[];
  encountered: string[] | null;
  missed: string[];
  unobserved: string[] | null;
  reached_by: Record<string, number> | null;
  events: number;
  events_sent: number;
  incidents: { detectable: number; detected: number; withheld: string[] };
}

const runs: Run[] = [];
for (const f of fs.readdirSync(args.results).filter((f) => f.endsWith(".json")).sort()) {
  const m = /^(re3|gaia)-([A-Za-z0-9_]+?)(-cautious)?\.json$/.exec(f);
  if (!m) continue;
  const r = JSON.parse(fs.readFileSync(path.join(args.results, f), "utf8"));
  const s = r.safety_set;
  if (!s) throw new Error(`${f} has no safety_set: replay it with --safety`);
  const oracle = m[3] ? "oracle-cautious" : "oracle";
  if (r.settings?.decider && r.settings.decider !== oracle) throw new Error(`${f}: decider ${r.settings.decider}, but the name says ${oracle}`);
  const req = requested.filter((id) => datasetOf(id) === m[1]);
  const missed = (s.missed as { case: string; id: string }[]).map((x) => `${x.case}:${x.id}`).sort();
  // Results from before per-id detail know how many were met, not which: their unobserved
  // events can't be named, only counted.
  const unobserved: string[] | null = Array.isArray(s.unobserved) ? [...s.unobserved].sort() : null;
  const encountered = unobserved ? req.filter((id) => !unobserved.includes(id)) : null;
  const a = r.aggregate.cascade;
  runs.push({
    dataset: m[1]!, arm: m[2]!, oracle, file: f,
    model: { path: path.basename(r.model.path), sha256: r.model.sha256 ?? null, drop_below: r.model.drop_below },
    requested: req,
    encountered,
    missed,
    unobserved: unobserved ?? null,
    reached_by: s.by ?? null,
    events: a.events,
    events_sent: a.asked_jev,
    incidents: {
      detectable: a.incidents,
      detected: a.detected.k,
      withheld: r.cases.flatMap((c: any) => c.cascade.incidents.filter((i: any) => i.withheld).map((i: any) => `${c.id}:${i.id}`)).sort(),
    },
  });
}
if (!runs.length) throw new Error(`no results in ${args.results}`);

const byKind = (ids: string[]) => {
  const t: Record<string, number> = {};
  for (const id of ids) t[kind(id)] = (t[kind(id)] ?? 0) + 1;
  return t;
};
const pct = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 10_000) / 100 : null);

const table = runs.map((r) => {
  const base = runs.find((x) => x.dataset === r.dataset && x.oracle === r.oracle && x.arm === args.baseline);
  const notReached = [...r.missed, ...(r.unobserved ?? [])];
  const encounteredN = r.encountered ? r.encountered.length : r.requested.length - (r.unobserved?.length ?? 0);
  const missedUnknown = r.unobserved === null;
  return {
    dataset: r.dataset,
    arm: r.arm,
    oracle: r.oracle,
    primary: r.oracle === "oracle-cautious",
    result_file: r.file,
    model: r.model,
    must_reach: {
      requested: r.requested.length,
      encountered: missedUnknown ? null : encounteredN,
      reached: missedUnknown ? null : encounteredN - r.missed.length,
      missed: r.missed.length,
      missed_by_kind: byKind(r.missed),
      missed_ids: r.missed,
      unobserved: r.unobserved,
      reached_by: r.reached_by,
      all_reached: !missedUnknown && notReached.length === 0,
      note: missedUnknown ? "result predates per-id detail: unobserved requested events can't be named" : undefined,
    },
    events: r.events,
    events_sent: r.events_sent,
    incidents: r.incidents,
    vs_baseline:
      base && base !== r
        ? {
            new_misses: r.missed.filter((id) => !base.missed.includes(id)),
            fixed: base.missed.filter((id) => !r.missed.includes(id)),
            new_misses_by_kind: byKind(r.missed.filter((id) => !base.missed.includes(id))),
            events_sent_change_pct: pct(r.events_sent, base.events_sent),
            newly_withheld: r.incidents.withheld.filter((i) => !base.incidents.withheld.includes(i)),
          }
        : undefined,
  };
});

const arms = [...new Set(runs.map((r) => r.arm))].sort();
const decision = Object.fromEntries(
  arms.map((arm) => {
    const primary = table.filter((t) => t.arm === arm && t.primary);
    const pass = primary.length > 0 && primary.every((t) => t.must_reach.all_reached);
    const notReached = primary.reduce((n, t) => n + t.must_reach.missed + (t.must_reach.unobserved?.length ?? 0), 0);
    return [
      arm,
      {
        dev_must_reach_pass: pass,
        not_reached_or_unobserved: notReached,
        verdict: arm === args.baseline ? (pass ? "retained" : "retained, fails the gate, not certified") : pass ? "may proceed to a frozen holdout run" : "rejected",
      },
    ];
  }),
);

const sources: Record<string, string> = {
  [path.basename(idsFile)]: sha256(idsFile),
  references: sha256(args.references),
  roles: sha256(args.roles),
  ...Object.fromEntries(runs.map((r) => [r.file, sha256(path.join(args.results!, r.file))])),
};

const report = {
  what: "Dev must-reach gate over saved replays (ml/evaluate.ts). Assistant-reviewed references, not human gold. Exposures are inside the gate.",
  primary_oracle: "oracle-cautious",
  sensitivity_oracle: "oracle",
  requested: { total: requested.length, by_dataset: { gaia: requested.filter((id) => datasetOf(id) === "gaia").length, re3: requested.filter((id) => datasetOf(id) === "re3").length }, by_kind: byKind(requested) },
  decision,
  release: {
    can_approve: false,
    holdout: "not run",
    note: "This report audits dev results only. Passing it would allow a frozen holdout run; it never approves a release.",
  },
  runs: table,
  sources,
};
fs.writeFileSync(args.out, JSON.stringify(sorted(report), null, 1) + "\n");
for (const t of table) {
  const mr = t.must_reach;
  console.log(
    `${t.dataset.padEnd(5)} ${t.arm.padEnd(9)} ${t.oracle.padEnd(16)} must-reach ${mr.reached ?? "?"}/${mr.encountered ?? "?"} of ${mr.requested} ` +
      `missed=${mr.missed} unobserved=${mr.unobserved?.length ?? "?"} sent=${t.events_sent} detected=${t.incidents.detected}/${t.incidents.detectable}` +
      (t.vs_baseline ? ` new_misses=${t.vs_baseline.new_misses.length} sent_change=${t.vs_baseline.events_sent_change_pct}%` : ""),
  );
}
console.log(JSON.stringify(decision));
