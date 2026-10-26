// `cloudfriend` command line. Works on the database directly, so it needs no admin key:
//   cloudfriend serve
//   cloudfriend secrets create <name> [--source <source>]
//   cloudfriend secrets list
//   cloudfriend secrets revoke <id>
//   cloudfriend train [--dry-run]
//   cloudfriend model
//   cloudfriend labels import <file.ndjson>
//   cloudfriend labels stats
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { importLabels, type ImportedLabel } from "./feedback.ts";
import { Trainer } from "./training.ts";
import { BUILTIN_MODEL, Triage } from "./triage/runtime.ts";
import { loadConfig } from "./config.ts";
import { dbPath, openDb } from "./db.ts";
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
  cloudfriend labels import <file.ndjson>             add labelled events, one JSON per line:
                                                      {"source","data","received_at","escalate"}
  cloudfriend labels stats                            count labels by source and verdict

The database is $CLOUDFRIEND_DATA_DIR/cloudfriend.db (default ./data/cloudfriend.db).`;

export async function cli(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      source: { type: "string" },
      json: { type: "boolean" },
      "dry-run": { type: "boolean" },
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
  if (!["secrets", "train", "model", "labels"].includes(cmd) || ((cmd === "secrets" || cmd === "labels") && !sub)) {
    console.error(USAGE);
    return 2;
  }

  const config = loadConfig();
  const db = openDb(dbPath(config.dataDir), { synchronous: config.synchronous });
  if (cmd !== "secrets") {
    try {
      return await mlCommand(cmd, sub, arg, values, config, db);
    } catch (err) {
      console.error(`error: ${errMsg(err)}`);
      return 1;
    } finally {
      db.close();
    }
  }
  const secrets = new Secrets(db);
  try {
    switch (sub) {
      case "create": {
        if (!arg) throw new Error("usage: cloudfriend secrets create <name> [--source <source>]");
        const s = secrets.create(arg, values.source ?? null);
        if (values.json) console.log(JSON.stringify(s));
        else {
          console.log(`Created secret ${s.id} (${s.name}${s.source ? `, source ${s.source} only` : ", any source"}).`);
          console.log("It is shown only once:\n");
          console.log(`  ${s.secret}\n`);
        }
        return 0;
      }
      case "list": {
        const list = secrets.list();
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
        if (!secrets.revoke(arg)) throw new Error(`no active secret with id ${arg}`);
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
    db.close();
  }
}

async function mlCommand(
  cmd: string,
  sub: string | undefined,
  arg: string | undefined,
  values: { json?: boolean; "dry-run"?: boolean },
  config: ReturnType<typeof loadConfig>,
  db: ReturnType<typeof openDb>,
): Promise<number> {
  const out = (v: unknown) => console.log(JSON.stringify(v, null, values.json ? undefined : 2));
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
    console.log(`Imported ${importLabels(db, items)} labels.`);
    return 0;
  }
  if (cmd === "labels") {
    out(db.prepare("SELECT source, CASE y WHEN 1 THEN 'escalate' ELSE 'ignore' END AS verdict, count(*) AS n FROM labels GROUP BY 1, 2").all());
    return 0;
  }
  const triage = new Triage(db, { auditRate: 0, verdictTtlMs: 0, perTemplate: 3, novelGuard: true, hasJev: true });
  const active = path.join(config.dataDir, "models", "active.json");
  for (const f of [config.modelPath, active, BUILTIN_MODEL]) if (f && fs.existsSync(f) && triage.load(f)) break;
  if (cmd === "model") {
    const history = db.prepare("SELECT id, created_at, status, labels, report FROM models ORDER BY created_at DESC LIMIT 10").all() as { report: string; status: string }[];
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
  });
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
