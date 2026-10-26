import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type DB = DatabaseSync;

const SCHEMA = `
-- Raw request bodies, appended in the request path. status: new | done | failed
CREATE TABLE IF NOT EXISTS queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT    NOT NULL,
  received_at INTEGER NOT NULL,
  body        BLOB    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'new'
);
CREATE INDEX IF NOT EXISTS queue_status_id ON queue(status, id);

-- Parsed events. decided = 1 once the decider has looked at it.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_id    INTEGER NOT NULL,
  source      TEXT    NOT NULL,
  received_at INTEGER NOT NULL,
  data        TEXT    NOT NULL,
  external_id TEXT,
  type        TEXT,
  group_key   TEXT,
  decided     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS events_pending ON events(id) WHERE decided = 0;
CREATE INDEX IF NOT EXISTS events_received ON events(received_at);
CREATE INDEX IF NOT EXISTS events_source_received ON events(source, received_at);

CREATE TABLE IF NOT EXISTS flags (
  id         TEXT    PRIMARY KEY,
  created_at INTEGER NOT NULL,
  reason     TEXT    NOT NULL,
  severity   TEXT    NOT NULL,
  event_ids  TEXT    NOT NULL,
  decider    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS flags_created ON flags(created_at);

-- Outbox: one row per (flag, action). status: pending | ok | failed
CREATE TABLE IF NOT EXISTS deliveries (
  flag_id         TEXT    NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
  action          TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error      TEXT,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (flag_id, action)
);
CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(next_attempt_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS secrets (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL,
  source       TEXT,
  hash         TEXT    NOT NULL UNIQUE,
  prefix       TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
`;

export interface OpenOptions {
  synchronous?: "FULL" | "NORMAL";
}

/** Open (and create if needed) the Sieve database. Use ":memory:" in tests. */
export function openDb(file: string, opts: OpenOptions = {}): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = ${opts.synchronous ?? "FULL"};
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
  `);
  db.exec(SCHEMA);
  return db;
}

export function dbPath(dataDir: string): string {
  return path.join(dataDir, "sieve.db");
}

/**
 * Run `fn` in a write transaction. `fn` must be synchronous: a transaction never spans an
 * `await`, which is what lets one connection serve the whole process safely.
 */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw err;
  }
}
