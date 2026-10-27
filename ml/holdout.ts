// The holdout: GAIA Aug 15-21, untouched until a candidate is frozen.
//
//   node ml/holdout.ts freeze --roles roles.json --arm baseline=models/base.json --arm candidate=<model.json> \
//     --out freeze.json [--set audit-rate=0 ...]
//   git add freeze.json && git commit            # the freeze must be committed before the run
//   node ml/holdout.ts run --freeze freeze.json --roles roles.json --data data/prepared/gaia21 --out results/holdout
//
// `freeze` records each arm's model hash and the ml/evaluate.ts settings every arm runs with.
// `run` refuses unless freeze.json is committed and unchanged, roles.json is the one frozen,
// and each model still has its frozen hash. It then replays the holdout days with each arm
// (oracle decider: no Jev calls), the same settings for all, and writes each arm's results and
// review samples. Nothing is tuned here; what the numbers say is for the release gates.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadRoles, sha256File, type Freeze } from "./roles.ts";

const [cmd, ...rest] = process.argv.slice(2);
const { values: args } = parseArgs({
  args: rest,
  options: {
    roles: { type: "string" },
    arm: { type: "string", multiple: true },
    set: { type: "string", multiple: true },
    out: { type: "string" },
    freeze: { type: "string" },
    data: { type: "string" },
    concurrency: { type: "string", default: "2" },
  },
});

/** Every arm runs with these, unless --set changes them at freeze time. Audit is off: the gates ask what routing alone reaches. */
const DEFAULTS: Record<string, string> = {
  decider: "oracle",
  strategies: "cascade,classifier,keyword",
  "audit-rate": "0",
  "batch-size": "100",
  "batch-wait": "10000",
  "audit-wait": "300000",
  "decider-concurrency": "2",
  "verdict-ttl": "900000",
  "novel-guard": "on",
  "escalated-ttl": String(7 * 86_400_000),
  "escalated-memory": String(90 * 86_400_000),
  "suppression-ttl": String(30 * 86_400_000),
  "drops-per-case": "60",
};

if (cmd === "freeze") {
  if (!args.roles || !args.arm?.length || !args.out) throw new Error("usage: holdout.ts freeze --roles <roles.json> --arm name=model.json ... --out freeze.json");
  loadRoles(args.roles);
  const settings = { ...DEFAULTS };
  for (const s of args.set ?? []) {
    const [k, v] = s.split("=") as [string, string];
    if (!(k in DEFAULTS)) throw new Error(`--set ${k}: not a frozen setting`);
    settings[k] = v;
  }
  const freeze: Freeze = {
    frozen_at: new Date().toISOString(),
    roles_sha256: sha256File(args.roles),
    arms: args.arm.map((a) => {
      const [name, model] = a.split("=") as [string, string];
      return { name, model, model_sha256: sha256File(model) };
    }),
    settings,
  };
  fs.writeFileSync(args.out, JSON.stringify(freeze, null, 1) + "\n");
  console.log(`wrote ${args.out}; commit it before running the holdout`);
} else if (cmd === "run") {
  if (!args.freeze || !args.roles || !args.data || !args.out) throw new Error("usage: holdout.ts run --freeze freeze.json --roles roles.json --data <gaia21> --out <dir>");
  const git = (...a: string[]) => spawnSync("git", a, { encoding: "utf8" });
  if (git("ls-files", "--error-unmatch", args.freeze).status !== 0) throw new Error(`${args.freeze} is not committed`);
  if (git("diff", "--quiet", "HEAD", "--", args.freeze, args.roles).status !== 0) throw new Error(`${args.freeze} or ${args.roles} differs from the commit`);
  const f = JSON.parse(fs.readFileSync(args.freeze, "utf8")) as Freeze;
  if (f.roles_sha256 !== sha256File(args.roles)) throw new Error("roles.json changed since the freeze");
  for (const a of f.arms) if (sha256File(a.model) !== a.model_sha256) throw new Error(`${a.model} changed since the freeze`);
  fs.mkdirSync(args.out, { recursive: true });
  const runArm = (a: Freeze["arms"][number]) =>
    new Promise<void>((resolve, reject) => {
      const argv = [
        "--disable-warning=ExperimentalWarning", "--import", "./ml/no-network.ts", "ml/evaluate.ts",
        "--data", args.data!, "--model", a.model, "--split", "holdout", "--freeze", args.freeze!, "--roles", args.roles!,
        ...Object.entries(f.settings).flatMap(([k, v]) => [`--${k}`, v]),
        "--samples-out", path.join(args.out!, `samples-${a.name}`), "--out", path.join(args.out!, `${a.name}.json`),
      ];
      const log = fs.openSync(path.join(args.out!, `${a.name}.log`), "w");
      const p = spawn(process.execPath, argv, { stdio: ["ignore", log, log] });
      p.on("exit", (code) => (fs.closeSync(log), code === 0 ? resolve() : reject(new Error(`${a.name} exited ${code}`))));
    });
  await Promise.all(f.arms.map(runArm));
  console.log(`holdout replays written to ${args.out}`);
} else {
  console.error("usage: node ml/holdout.ts freeze|run ...");
  process.exit(2);
}
