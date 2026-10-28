// Postgres is the server's only stateful component. One small pool per process; the schema is
// versioned SQL in src/migrations/, applied at boot.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { errMsg, log } from "./log.ts";

export type DB = pg.Pool;
/** The pool, or a client inside a transaction: anything that can run a query. */
export type Queryable = pg.Pool | pg.PoolClient;

/** This release has one workspace. Every data row carries its id; the next makes it many. */
export const DEFAULT_WORKSPACE = "ws_default";

const MIGRATIONS = path.join(import.meta.dirname, "migrations");
/** Any constant works, as long as nothing else in the database takes the same advisory lock. */
const MIGRATION_LOCK = 0x636c6f7564;

const INT8 = 20;
const NUMERIC = 1700;
/**
 * bigint (ids, epoch ms, counts) and numeric (sums of them) come back as JS numbers rather
 * than strings: every value cloudfriend stores in them stays far below 2^53.
 */
const types = {
  getTypeParser: ((oid: number, format?: "text" | "binary") =>
    oid === INT8 || oid === NUMERIC ? (v: string) => Number(v) : pg.types.getTypeParser(oid, format)) as pg.CustomTypesConfig["getTypeParser"],
};

export interface OpenOptions {
  /** Connections in the pool (CLOUDFRIEND_DB_POOL). */
  max?: number;
}

/** Connect, bring the schema up to date, and make sure the default workspace exists. */
export async function openDb(url: string, opts: OpenOptions = {}): Promise<DB> {
  const db = new pg.Pool({ connectionString: url, max: opts.max ?? 10, types });
  // An idle client can lose its connection (a restarted server, a dropped socket). Without a
  // listener that is an unhandled 'error' event and kills the process; the pool replaces it.
  db.on("error", (err) => log.warn("idle database connection failed", { error: errMsg(err) }));
  // The pool listens only while a client is idle. One that is checked out (a transaction between
  // two queries) would crash the process the same way; its next query fails instead, and the
  // caller sees that.
  db.on("connect", (client) => client.on("error", (err) => log.debug("database connection lost", { error: errMsg(err) })));
  try {
    await migrate(db);
    await db.query("INSERT INTO workspaces (id, name, created_at) VALUES ($1, 'default', $2) ON CONFLICT (id) DO NOTHING", [DEFAULT_WORKSPACE, Date.now()]);
  } catch (err) {
    await db.end().catch(() => {});
    throw err;
  }
  return db;
}

/** The migration files, in order: `NNN_name.sql`. */
export function migrations(): { version: number; name: string; sql: string }[] {
  return fs
    .readdirSync(MIGRATIONS)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort()
    .map((f) => ({ version: Number(f.split("_")[0]), name: f, sql: fs.readFileSync(path.join(MIGRATIONS, f), "utf8") }));
}

/**
 * Apply the migrations not applied yet, in one transaction under an advisory lock: when
 * several processes boot at once, one migrates and the others wait, then find nothing to do.
 */
async function migrate(db: DB): Promise<void> {
  await tx(db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await c.query<{ version: number }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version));
    for (const m of migrations()) {
      if (done.has(m.version)) continue;
      await c.query(m.sql);
      await c.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [m.version, m.name]);
      log.info("database migrated", { migration: m.name });
    }
  });
}

/**
 * Run `fn` in a transaction on a client of its own. Nothing inside may wait on the network
 * other than the database: a transaction holds its locks until it ends.
 */
export async function tx<T>(db: DB, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  let broken: Error | undefined;
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (err) {
    // A failed ROLLBACK means the connection itself is gone: drop it instead of reusing it.
    await c.query("ROLLBACK").catch((e: Error) => (broken = e));
    throw err;
  } finally {
    c.release(broken);
  }
}

/** All rows of a query. */
export async function all<T>(q: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await q.query(sql, params)).rows as T[];
}

/** The first row of a query, if any. */
export async function one<T>(q: Queryable, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await q.query(sql, params)).rows[0] as T | undefined;
}

/** Rows a statement changed. */
export async function run(q: Queryable, sql: string, params: unknown[] = []): Promise<number> {
  return (await q.query(sql, params)).rowCount ?? 0;
}

/** Node socket errors that mean the database can't be reached right now. */
const UNREACHABLE = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH"]);

/**
 * Whether `err` means the database is unavailable for a while (restarting, refusing or dropping
 * connections) rather than that the query was wrong. Callers answer 503 with Retry-After, so
 * people and senders retry instead of seeing an internal error.
 */
export function isDatabaseUnavailable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") {
    // 08xxx connection exception; 57P01-57P03 shutting down, crashed, starting up; 53300 too many connections.
    if (code.startsWith("08") || ["57P01", "57P02", "57P03", "53300"].includes(code) || UNREACHABLE.has(code)) return true;
  }
  return /Connection terminated|connection error|timeout exceeded when trying to connect/i.test(err.message);
}

/**
 * Postgres text can't hold NUL. Untrusted strings (hints, templates, decider replies) lose it
 * rather than fail the whole transaction they are written in, again on every retry.
 */
export const pgText = <T extends string | null | undefined>(s: T): T => (typeof s === "string" && s.includes("\0") ? (s.replaceAll("\0", "") as T) : s);
