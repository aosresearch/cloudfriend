// Leave one fault group out: how often does stage 1 withhold an incident it has never seen
// the like of? For each RCAEval RE3 fault group (one system, service and fault type, with its
// repetitions), train a model without that group, then replay the group's cases through the
// cascade with that model and the oracle decider (ml/evaluate.ts --decider oracle: no Jev
// calls). Each incident counts once; the result is a withheld rate with an exact bound.
//
//   node ml/lofo.ts --features data/features-v2 --data data/prepared/re3 --out data/results/lofo \
//     [--groups 're3-ob-'] [--jev-labels data/relabel/labels.csv] [--concurrency 3]
//
// --features holds re3/ and gaia/ {train,valid}.csv from ml/featurize.ts. Each fold fits on the
// RE3 train-split rows of the other groups and GAIA's fit days, and calibrates on the RE3
// valid-split rows of the other groups and GAIA's calibration days: the roles in --roles
// (benchmarks/<date>/roles.json), checked row by row. RE3 eval-split rows are never used for
// fitting or calibrating. --jev-labels adds Jev's labels of other groups' fit cases.
// Labels are the datasets' weak labels: the result is weak too.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { upperBound } from "../src/stats.ts";
import { loadRoles, roleOf } from "./roles.ts";
import { loadCases } from "./streams.ts";

const { values: args } = parseArgs({
  options: {
    features: { type: "string" },
    data: { type: "string" },
    out: { type: "string" },
    groups: { type: "string" },
    "jev-labels": { type: "string" },
    "weak-weight": { type: "string", default: "1" },
    python: { type: "string", default: process.env.CLOUDFRIEND_PYTHON ?? "python3" },
    concurrency: { type: "string", default: "3" },
    recall: { type: "string", default: "0.995" },
    roles: { type: "string" },
  },
});
if (!args.features || !args.data || !args.out || !args.roles) {
  console.error("usage: node ml/lofo.ts --features <dir> --data <prepared re3> --roles roles.json --out <dir>");
  process.exit(2);
}
const roles = loadRoles(args.roles);
const featurizerVersion = JSON.parse(fs.readFileSync(path.join(args.features, "re3", "meta.json"), "utf8")).featurizer_version as number;
const EXCLUDE = "^(tok_|svc_new$|svc_count$|svc_age$|svc_templates$|all_m1$|all_h1$)";
const groupOf = (caseId: string) => caseId.replace(/-\d+$/, "");
const cases = loadCases(args.data);
const only = args.groups ? new RegExp(args.groups) : null;
const groups = [...new Set(cases.map((c) => groupOf(c.id)))].filter((g) => !only || only.test(g)).sort();
const work = path.join(args.out, "work");
fs.mkdirSync(work, { recursive: true });

/** The column of a CSV header (featurize.ts writes id, case, t, y, w, ...; older files lack id). */
const column = (header: string, name: string) => {
  const i = header.split(",").indexOf(name);
  if (i < 0) throw new Error(`no ${name} column`);
  return i;
};

// Split the RE3 rows by group once, so each fold is a concatenation. Each row's case must
// have the role of the part it goes to.
async function splitByGroup(file: string, part: "fit" | "calib") {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let header = "";
  let iCase = 0;
  const fds = new Map<string, number>();
  const want = part === "fit" ? "fit" : "calibrate";
  for await (const line of rl) {
    if (!header) {
      header = line;
      iCase = column(header, "case");
      continue;
    }
    const caseId = line.split(",", iCase + 1)[iCase]!;
    if (roleOf(roles, caseId) !== want) throw new Error(`${caseId} is ${roleOf(roles, caseId)}, not ${want}: it can't be in ${file}`);
    const g = groupOf(caseId);
    let fd = fds.get(g);
    if (fd === undefined) fds.set(g, (fd = fs.openSync(path.join(work, `${g}.${part}.csv`), "a")));
    fs.writeSync(fd, line + "\n");
  }
  for (const fd of fds.values()) fs.closeSync(fd);
  return header;
}

function run(cmd: string, argv: string[], log: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = fs.openSync(log, "w");
    const p = spawn(cmd, argv, { stdio: ["ignore", out, out] });
    p.on("exit", (code) => (fs.closeSync(out), code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}; see ${log}`))));
  });
}

const marker = path.join(work, ".split-done");
let header = "";
if (!fs.existsSync(marker)) {
  for (const f of fs.readdirSync(work)) fs.rmSync(path.join(work, f));
  header = await splitByGroup(path.join(args.features, "re3", "train.csv"), "fit");
  header = await splitByGroup(path.join(args.features, "re3", "valid.csv"), "calib");
  fs.writeFileSync(marker, header);
} else header = fs.readFileSync(marker, "utf8");

const jevRows = new Map<string, string[]>();
if (args["jev-labels"]) {
  const rl = readline.createInterface({ input: fs.createReadStream(args["jev-labels"]), crlfDelay: Infinity });
  let first = true;
  for await (const line of rl) {
    if (first) {
      first = false;
      continue;
    }
    const caseId = line.split(",", column(header, "case") + 1)[column(header, "case")]!;
    if (roleOf(roles, caseId) !== "fit") continue;
    const g = groupOf(caseId);
    (jevRows.get(g) ?? jevRows.set(g, []).get(g)!).push(line);
  }
}

/** Rows of a weak-label CSV with their weight scaled, so Jev's labels can count for more. */
function appendScaled(fd: number, file: string, scale: number) {
  const text = fs.readFileSync(file, "utf8");
  if (scale === 1) return fs.writeSync(fd, text.endsWith("\n") ? text : text + "\n");
  const iw = column(header, "w");
  let out = "";
  for (const line of text.split("\n")) {
    if (!line) continue;
    const c = line.split(",");
    c[iw] = String(Number(c[iw]) * scale);
    out += c.join(",") + "\n";
    if (out.length > 1 << 22) (fs.writeSync(fd, out), (out = ""));
  }
  fs.writeSync(fd, out);
}

async function fold(g: string) {
  const dir = path.join(args.out!, g);
  const result = path.join(dir, "eval.json");
  if (fs.existsSync(result)) return JSON.parse(fs.readFileSync(result, "utf8"));
  fs.mkdirSync(dir, { recursive: true });
  const weak = Number(args["weak-weight"]);
  const write = (name: string, part: "fit" | "calib", gaia: string) => {
    const file = path.join(dir, name);
    const fd = fs.openSync(file, "w");
    fs.writeSync(fd, header + "\n");
    for (const other of new Set(cases.map((c) => groupOf(c.id)))) {
      if (other === g) continue;
      const f = path.join(work, `${other}.${part}.csv`);
      if (fs.existsSync(f)) appendScaled(fd, f, weak);
      if (part === "fit") for (const r of jevRows.get(other) ?? []) fs.writeSync(fd, r + "\n");
    }
    const gaiaFile = path.join(args.features!, "gaia", gaia);
    const gaiaText = fs.readFileSync(gaiaFile, "utf8");
    const gh = gaiaText.slice(0, gaiaText.indexOf("\n"));
    if (gh !== header) throw new Error(`${gaiaFile} has other columns than the RE3 rows`);
    const gc = column(gh, "case");
    const want = part === "fit" ? "fit" : "calibrate";
    for (const c of new Set(gaiaText.split("\n").slice(1).filter(Boolean).map((l) => l.split(",", gc + 1)[gc]!))) {
      if (roleOf(roles, c) !== want) throw new Error(`${c} is ${roleOf(roles, c)}, not ${want}: it can't be in ${gaiaFile}`);
    }
    const rows = gaiaText.slice(gaiaText.indexOf("\n") + 1);
    if (weak === 1) fs.writeSync(fd, rows);
    else {
      // The same down-weighting as the RE3 weak rows.
      const iw = column(gh, "w");
      let out = "";
      for (const line of rows.split("\n")) {
        if (!line) continue;
        const c = line.split(",");
        c[iw] = String(Number(c[iw]) * weak);
        out += c.join(",") + "\n";
        if (out.length > 1 << 22) (fs.writeSync(fd, out), (out = ""));
      }
      fs.writeSync(fd, out);
    }
    fs.closeSync(fd);
    return file;
  };
  const train = write("train.csv", "fit", "train.csv");
  const valid = write("valid.csv", "calib", "valid.csv");
  const model = path.join(dir, "model.json");
  await run(args.python!, [
    "ml/train.py", "--train", train, "--valid", valid, "--out", model, "--featurizer-version", String(featurizerVersion),
    "--recall", args.recall!, "--roles", args.roles!, "--exclude", EXCLUDE, "--note", `LOFO without ${g}`,
  ], path.join(dir, "train.log"));
  fs.rmSync(train);
  fs.rmSync(valid);
  await run(process.execPath, [
    "--disable-warning=ExperimentalWarning", "ml/evaluate.ts", "--data", args.data!, "--model", model, "--split", "all",
    "--cases", `^${g.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+$`, "--decider", "oracle", "--strategies", "cascade", "--out", result,
  ], path.join(dir, "eval.log"));
  return JSON.parse(fs.readFileSync(result, "utf8"));
}

const results: { group: string; r: any }[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: Number(args.concurrency) }, async () => {
    while (next < groups.length) {
      const g = groups[next++]!;
      const r = await fold(g);
      const a = r.aggregate.cascade;
      console.log(`${g.padEnd(32)} incidents=${a.incidents} withheld=${a.withheld.k} detected=${a.detected.k} to_jev=${(a.share_to_jev * 100).toFixed(2)}% positives_reached=${a.positives_reached.k}/${a.positives_reached.n}`);
      results.push({ group: g, r });
    }
  }),
);
results.sort((a, b) => a.group.localeCompare(b.group));
const incidents = results.flatMap(({ group, r }) => r.cases.flatMap((c: any) => c.cascade.incidents.filter((i: any) => i.detectable).map((i: any) => ({ group, ...i }))));
const withheld = incidents.filter((i) => i.withheld);
const groupsWithheld = results.filter(({ r }) => r.aggregate.cascade.withheld.k > 0).map(({ group }) => group);
const summary = {
  labels: "weak (dataset heuristics)",
  groups: results.length,
  incidents: incidents.length,
  withheld: { k: withheld.length, n: incidents.length, rate: withheld.length / Math.max(incidents.length, 1), upper95: upperBound(withheld.length, incidents.length) },
  // Repetitions of one fault aren't independent: the bound by group is the conservative one.
  groups_with_a_withheld_incident: { k: groupsWithheld.length, n: results.length, upper95: upperBound(groupsWithheld.length, results.length), which: groupsWithheld },
  positives_reached: results.reduce((a, { r }) => ({ k: a.k + r.aggregate.cascade.positives_reached.k, n: a.n + r.aggregate.cascade.positives_reached.n }), { k: 0, n: 0 }),
  share_to_jev: results.reduce((a, { r }) => a + r.aggregate.cascade.asked_jev, 0) / Math.max(results.reduce((a, { r }) => a + r.aggregate.cascade.events, 0), 1),
  withheld_incidents: withheld,
  per_group: results.map(({ group, r }) => ({ group, ...r.aggregate.cascade })),
};
fs.writeFileSync(path.join(args.out, "lofo.json"), JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ groups: summary.groups, incidents: summary.incidents, withheld: summary.withheld, groups_with_a_withheld_incident: summary.groups_with_a_withheld_incident, share_to_jev: summary.share_to_jev }, null, 1));
