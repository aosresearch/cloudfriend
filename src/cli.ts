// `sieve` command line. Works on the database directly, so it needs no admin key:
//   sieve serve
//   sieve secrets create <name> [--source <source>]
//   sieve secrets list
//   sieve secrets revoke <id>
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { dbPath, openDb } from "./db.ts";
import { errMsg } from "./log.ts";
import { Secrets } from "./secrets.ts";

const USAGE = `Usage:
  sieve serve                                   start the server
  sieve secrets create <name> [--source <src>]  create an ingest secret (shown once)
  sieve secrets list                            list secrets
  sieve secrets revoke <id>                     revoke a secret immediately

The database is $SIEVE_DATA_DIR/sieve.db (default ./data/sieve.db).`;

export async function cli(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { source: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
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
  if (cmd !== "secrets" || !sub) {
    console.error(USAGE);
    return 2;
  }

  const config = loadConfig();
  const db = openDb(dbPath(config.dataDir), { synchronous: config.synchronous });
  const secrets = new Secrets(db);
  try {
    switch (sub) {
      case "create": {
        if (!arg) throw new Error("usage: sieve secrets create <name> [--source <source>]");
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
        if (!arg) throw new Error("usage: sieve secrets revoke <id>");
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
