// Postgres for the tests, without Docker. TEST_DATABASE_URL names a server to use (its user
// needs CREATEDB); without it, a throwaway cluster is started from the local Postgres
// binaries (initdb, pg_ctl) in a temporary directory on a free port, and removed afterwards.
// Every test gets a database of its own (`freshDatabase`), so tests never see each other's rows.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import pg from "pg";

/** Where to find initdb and pg_ctl: $PG_BIN, Homebrew, or the PATH. */
function pgBin(name: string): string {
  for (const dir of [process.env.PG_BIN, "/opt/homebrew/bin", "/usr/local/bin", "/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/14/bin"]) {
    if (dir && fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  return name;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

export interface Cluster {
  url: string;
  stop(): void;
}

/**
 * Start a throwaway cluster. Durability is switched off (fsync, synchronous_commit): the
 * tests kill cloudfriend, never Postgres, and it makes creating a database per test cheap.
 */
export async function startCluster(): Promise<Cluster> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudfriend-pg-"));
  const data = path.join(dir, "data");
  execFileSync(pgBin("initdb"), ["-D", data, "-U", "postgres", "--auth=trust", "--no-sync", "-E", "UTF8", "--locale=C"], { stdio: "ignore" });
  const port = await freePort();
  const opts = `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=300`;
  execFileSync(pgBin("pg_ctl"), ["-D", data, "-o", opts, "-l", path.join(dir, "log"), "-w", "-t", "60", "start"], { stdio: "ignore" });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    spawnSync(pgBin("pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"], { stdio: "ignore" });
    fs.rmSync(dir, { recursive: true, force: true });
  };
  // Never leave a server behind, however the process ends.
  process.once("exit", stop);
  return { url: `postgres://postgres@127.0.0.1:${port}/postgres`, stop };
}

let server: Promise<string> | null = null;
let admin: pg.Pool | null = null;
const created: string[] = [];
let counter = 0;

/** The server's maintenance URL: TEST_DATABASE_URL, or a cluster started for this process. */
function serverUrl(): Promise<string> {
  server ??= process.env.TEST_DATABASE_URL ? Promise.resolve(process.env.TEST_DATABASE_URL) : startCluster().then((c) => c.url);
  return server;
}

/** Create an empty database and return its URL. cloudfriend migrates it when it opens it. */
export async function freshDatabase(): Promise<string> {
  const url = await serverUrl();
  admin ??= new pg.Pool({ connectionString: url, max: 2 });
  const name = `cf_test_${process.pid}_${++counter}`;
  await admin.query(`CREATE DATABASE ${name}`);
  created.push(name);
  const u = new URL(url);
  u.pathname = "/" + name;
  return u.toString();
}

/** Drop the databases this process created. Connections still open to them are closed. */
export async function dropDatabases(): Promise<void> {
  if (!admin) return;
  for (const name of created.splice(0)) {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
  }
  await admin.end();
  admin = null;
}
