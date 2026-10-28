// The holdout: GAIA Aug 15-21, untouched until a candidate is frozen.
//
//   node ml/holdout.ts freeze --roles roles.json --arm baseline=models/base.json --arm candidate=<model.json> \
//     --out freeze.json [--set decider=oracle ...] [--unavailable-case <case>=<evidence of absence>]
//   git add freeze.json && git commit            # the freeze must be committed before the run
//   node ml/holdout.ts run --freeze freeze.json --roles roles.json --data data/prepared/gaia21 --out results/holdout \
//     [--safety reviewed-ids.txt] [--concurrency 1]
//
// `freeze` records each arm's model hash and every ml/evaluate.ts setting the arms run with
// (HOLDOUT_SETTINGS in ml/roles.ts: the cautious oracle, audit off). A weak-label-oracle
// sensitivity run needs its own freeze, committed before the holdout is looked at. A holdout
// case whose source data is verifiably absent is recorded at freeze time with its evidence; that
// is not a way to skip a day, and a case recorded as absent that turns up in the data fails.
//
// `run` refuses unless freeze.json and roles.json are committed and unchanged, the freeze is
// complete, each model still has its frozen hash, and every other holdout case is in the data.
// It then replays the holdout days with each arm (oracle decider: no Jev calls), at most
// --concurrency arms at once, and writes each arm's results and review samples. --safety adds a
// must-reach report and changes nothing else. Nothing is tuned here.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { checkCommitted, checkFreeze, HOLDOUT_SETTINGS, loadRoles, sha256File, type Freeze } from "./roles.ts";

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
    // Arms replayed at once (each is a full day-by-day replay; memory bounds this).
    concurrency: { type: "string", default: "1" },
    // freeze: a holdout case whose source data is verifiably absent, as <case>=<evidence>.
    "unavailable-case": { type: "string", multiple: true },
    // run: must-reach ids to report (does not change the frozen settings).
    safety: { type: "string" },
  },
});


if (cmd === "freeze") {
  if (!args.roles || !args.arm?.length || !args.out) throw new Error("usage: holdout.ts freeze --roles <roles.json> --arm name=model.json ... --out freeze.json");
  loadRoles(args.roles);
  const roles = loadRoles(args.roles);
  const settings = { ...HOLDOUT_SETTINGS };
  for (const s of args.set ?? []) {
    const [k, v] = s.split("=") as [string, string];
    if (!(k in HOLDOUT_SETTINGS)) throw new Error(`--set ${k}: not a frozen setting`);
    settings[k] = v;
  }
  const unavailable: Record<string, string> = {};
  for (const u of args["unavailable-case"] ?? []) {
    const i = u.indexOf("=");
    const [c, why] = [u.slice(0, i), u.slice(i + 1).trim()];
    if (i < 0 || !why) throw new Error(`--unavailable-case ${u}: give <case>=<evidence of its absence>`);
    if (roles.cases[c] !== "holdout") throw new Error(`--unavailable-case ${c}: not a holdout case`);
    unavailable[c] = why;
  }
  const freeze: Freeze = {
    frozen_at: new Date().toISOString(),
    roles_sha256: sha256File(args.roles),
    arms: args.arm.map((a) => {
      const [name, model] = a.split("=") as [string, string];
      return { name, model, model_sha256: sha256File(model) };
    }),
    settings,
    ...(Object.keys(unavailable).length ? { unavailable } : {}),
  };
  fs.writeFileSync(args.out, JSON.stringify(freeze, null, 1) + "\n");
  console.log(`wrote ${args.out}; commit it before running the holdout`);
} else if (cmd === "run") {
  if (!args.freeze || !args.roles || !args.data || !args.out) throw new Error("usage: holdout.ts run --freeze freeze.json --roles roles.json --data <gaia21> --out <dir>");
  checkCommitted(args.freeze, args.roles);
  const f = JSON.parse(fs.readFileSync(args.freeze, "utf8")) as Freeze;
  for (const a of f.arms) {
    if (sha256File(a.model) !== a.model_sha256) throw new Error(`${a.model} changed since the freeze`);
    checkFreeze(args.freeze, a.model, args.roles);
  }
  fs.mkdirSync(args.out, { recursive: true });
  const runArm = (a: Freeze["arms"][number]) =>
    new Promise<void>((resolve, reject) => {
      const argv = [
        "--disable-warning=ExperimentalWarning", "--import", "./ml/no-network.ts", "ml/evaluate.ts",
        "--data", args.data!, "--model", a.model, "--split", "holdout", "--freeze", args.freeze!, "--roles", args.roles!,
        ...Object.entries(f.settings).flatMap(([k, v]) => [`--${k}`, v]),
        ...(args.safety ? ["--safety", args.safety] : []),
        "--samples-out", path.join(args.out!, `samples-${a.name}`), "--out", path.join(args.out!, `${a.name}.json`),
      ];
      const log = fs.openSync(path.join(args.out!, `${a.name}.log`), "w");
      const p = spawn(process.execPath, argv, { stdio: ["ignore", log, log] });
      p.on("exit", (code) => (fs.closeSync(log), code === 0 ? resolve() : reject(new Error(`${a.name} exited ${code}`))));
    });
  const queue = [...f.arms];
  await Promise.all(Array.from({ length: Math.max(1, Number(args.concurrency)) }, async () => {
    while (queue.length) await runArm(queue.shift()!);
  }));
  console.log(`holdout replays written to ${args.out}`);
} else {
  console.error("usage: node ml/holdout.ts freeze|run ...");
  process.exit(2);
}
