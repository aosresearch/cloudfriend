// `cloudfriend` command line. Works on the database directly, so it needs no admin key:
//   cloudfriend serve
//   cloudfriend secrets create <name> [--source <source>]
//   cloudfriend secrets list
//   cloudfriend secrets revoke <id>
//   cloudfriend train [--dry-run]
//   cloudfriend model
//   cloudfriend regression [--model <file>]
//   cloudfriend labels import <file.ndjson>
//   cloudfriend labels stats
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { importLabels, type ImportedLabel } from "./feedback.ts";
import { Trainer } from "./training.ts";
import { BUILTIN_MODEL, Triage } from "./triage/runtime.ts";
import { BUILTIN_SCENARIOS, loadScenarios, runSuite } from "./triage/scenarios.ts";
import { loadConfig } from "./config.ts";
import { all, DEFAULT_WORKSPACE, openDb, type DB } from "./db.ts";
import { errMsg } from "./log.ts";
import { Secrets } from "./secrets.ts";

const USAGE = `Usage:
  cloudfriend serve                                   start the server
  cloudfriend secrets create <name> [--source <src>]  create an ingest secret (shown once)
  cloudfriend secrets list                            list secrets
  cloudfriend secrets revoke <id>                     revoke a secret immediately
  cloudfriend train [--dry-run]                       train a classifier on the labels now; a
                                                      running server picks up a promoted model
  cloudfriend model                                   show the active classifier and past runs
  cloudfriend regression [--model <file>]             run the regression scenarios through the
                                                      whole pipeline with a model (default: active)
  cloudfriend labels import <file.ndjson>             add labelled events, one JSON per line:
                                                      {"source","data","received_at","escalate"}
  cloudfriend labels stats                            count labels by source and verdict

The database is $CLOUDFRIEND_DATABASE_URL (or $DATABASE_URL); model files are under
$CLOUDFRIEND_DATA_DIR/models (default ./data/models).`;

export async function cli(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      source: { type: "string" },
      json: { type: "boolean" },
      "dry-run": { type: "boolean" },
      model: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, sub, arg] = positionals;

  if (values.help || !cmd || cmd === "help") {
    console.log(USAGE);
    return 0;
  }
  if (cmd === "serve") {
    const { main } = await import("./main.ts");
    await main();
    return -1; // keep running
  }
  if (!["secrets", "train", "model", "labels", "regression"].includes(cmd) || ((cmd === "secrets" || cmd === "labels") && !sub)) {
    console.error(USAGE);
    return 2;
  }

  const config = loadConfig();
  const db = await openDb(config.databaseUrl, { max: 2 });
  if (cmd !== "secrets") {
    try {
      return await mlCommand(cmd, sub, arg, values, config, db);
    } catch (err) {
      console.error(`error: ${errMsg(err)}`);
      return 1;
    } finally {
      await db.end();
    }
  }
  const secrets = new Secrets(db, DEFAULT_WORKSPACE);
  try {
    switch (sub) {
      case "create": {
        if (!arg) throw new Error("usage: cloudfriend secrets create <name> [--source <source>]");
        const s = await secrets.create(arg, values.source ?? null);
        if (values.json) console.log(JSON.stringify(s));
        else {
          console.log(`Created secret ${s.id} (${s.name}${s.source ? `, source ${s.source} only` : ", any source"}).`);
          console.log("It is shown only once:\n");
          console.log(`  ${s.secret}\n`);
        }
        return 0;
      }
      case "list": {
        const list = await secrets.list();
        if (values.json) console.log(JSON.stringify(list));
        else if (!list.length) console.log("No secrets.");
        else {
          const rows = list.map((s) => [
            s.id,
            s.name,
            s.source ?? "*",
            s.prefix + "…",
            s.last_used_at ?? "never",
            s.revoked_at ? "revoked" : "active",
          ]);
          printTable(["ID", "NAME", "SOURCE", "PREFIX", "LAST USED", "STATUS"], rows);
        }
        return 0;
      }
      case "revoke": {
        if (!arg) throw new Error("usage: cloudfriend secrets revoke <id>");
        if (!(await secrets.revoke(arg))) throw new Error(`no active secret with id ${arg}`);
        console.log(`Revoked ${arg}.`);
        return 0;
      }
      default:
        console.error(USAGE);
        return 2;
    }
  } catch (err) {
    console.error(`error: ${errMsg(err)}`);
    return 1;
  } finally {
    await db.end();
  }
}

async function mlCommand(
  cmd: string,
  sub: string | undefined,
  arg: string | undefined,
  values: { json?: boolean; "dry-run"?: boolean; model?: string },
  config: ReturnType<typeof loadConfig>,
  db: DB,
): Promise<number> {
  const ws = DEFAULT_WORKSPACE;
  const out = (v: unknown) => console.log(JSON.stringify(v, null, values.json ? undefined : 2));
  const triage = await Triage.open(db, { auditRate: 0, verdictTtlMs: 0, perTemplate: 3, novelGuard: true, hasJev: true }, ws);
  const active = path.join(config.dataDir, "models", "active.json");
  for (const f of [values.model, config.modelPath, active, BUILTIN_MODEL]) if (f && fs.existsSync(f) && (await triage.load(f))) break;
  if (cmd === "labels" && sub === "import") {
    if (!arg) throw new Error("usage: cloudfriend labels import <file.ndjson>");
    const items = fs
      .readFileSync(arg, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l, i) => {
        const it = JSON.parse(l) as ImportedLabel;
        if (typeof it.source !== "string" || typeof it.escalate !== "boolean") throw new Error(`line ${i + 1}: needs source and escalate`);
        return it;
      });
    // Featurized with the version the model in use runs with, so the next training run can use them.
    console.log(`Imported ${await importLabels(db, ws, items, triage.featurizer.version)} labels.`);
    return 0;
  }
  if (cmd === "labels") {
    out(await all(db, "SELECT source, CASE y WHEN 1 THEN 'escalate' ELSE 'ignore' END AS verdict, count(*) AS n FROM labels WHERE workspace_id = $1 GROUP BY 1, 2", [ws]));
    return 0;
  }
  if (cmd === "regression") {
    if (!triage.classifier) throw new Error("no model to test");
    const r = await runSuite(loadScenarios(BUILTIN_SCENARIOS, config.regressionSuite), triage.classifier, {
      routing: { verdictTtlMs: config.verdictTtlMs, escalatedTtlMs: config.knownTtlMs, escalatedMemoryMs: config.escalatedMemoryMs, suppressionTtlMs: config.suppressionTtlMs },
      novelGuard: config.novelGuard,
    });
    out({ model: triage.modelPath, passed: r.passed, scenarios: r.scenarios, must_reach: r.must_reach, reached: r.reached, reached_by_score: r.reached_by_score, failures: r.failures });
    return r.passed ? 0 : 1;
  }
  if (cmd === "model") {
    const history = await all<{ report: string; status: string }>(
      db,
      "SELECT id, created_at, status, labels, report FROM models WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC LIMIT 10",
      [ws],
    );
    const f = triage.classifier?.file;
    out({
      active: f ? { path: triage.modelPath, trained_at: f.trained_at, note: f.note, drop_below: f.drop_below, threshold: f.threshold, trees: triage.classifier!.gbdt.numTrees } : null,
      history: history.map((h) => ({ ...JSON.parse(h.report), status: h.status })),
    });
    return 0;
  }
  const trainer = new Trainer(db, triage, {
    dataDir: config.dataDir,
    python: config.python,
    minLabels: config.retrainMinLabels,
    humanWeight: config.humanLabelWeight,
    recall: config.recallTarget,
    shadowPeriodMs: config.shadowPeriodMs,
    shadowMinEvidence: config.shadowMinEvidence,
    shadowMaxMs: config.shadowMaxMs,
    safetySet: config.safetySet,
    regressionSuite: config.regressionSuite,
    verdictTtlMs: config.verdictTtlMs,
    novelGuard: config.novelGuard,
    incidentWindowMs: config.incidentWindowMs,
    knownTtlMs: config.knownTtlMs,
    escalatedMemoryMs: config.escalatedMemoryMs,
    suppressionTtlMs: config.suppressionTtlMs,
  }, ws);
  const report = await trainer.train({ dryRun: values["dry-run"] });
  out(report);
  return report.status === "failed" ? 1 : 0;
}

function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  for (const r of [header, ...rows]) console.log(r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd());
}

if (import.meta.main) {
  cli(process.argv.slice(2)).then(
    (code) => {
      if (code >= 0) process.exitCode = code;
    },
    (err) => {
      console.error(`error: ${errMsg(err)}`);
      process.exitCode = 1;
    },
  );
}
