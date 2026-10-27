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

-- Training labels for the classifier: what Jev or a person decided about an event, with the
-- feature vector the classifier saw. Copied out of events so labels outlive retention.
-- source: jev | human. A human label always replaces a Jev label, never the other way round.
CREATE TABLE IF NOT EXISTS labels (
  event_id           INTEGER PRIMARY KEY,
  y                  INTEGER NOT NULL,
  source             TEXT    NOT NULL,
  route              TEXT,
  score              REAL,
  features           BLOB    NOT NULL,
  featurizer_version INTEGER NOT NULL,
  event_source       TEXT    NOT NULL,
  received_at        INTEGER NOT NULL,
  data               TEXT    NOT NULL,
  note               TEXT,
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS labels_created ON labels(created_at);

-- Every classifier cloudfriend trained or loaded. status: active | candidate | rejected | retired
CREATE TABLE IF NOT EXISTS models (
  id         TEXT    PRIMARY KEY,
  created_at INTEGER NOT NULL,
  path       TEXT    NOT NULL,
  status     TEXT    NOT NULL,
  labels     INTEGER NOT NULL DEFAULT 0,
  report     TEXT    NOT NULL
);

-- Every decider call that produced labels: the exact prompt and raw reply, for audit.
CREATE TABLE IF NOT EXISTS decisions (
  id         TEXT    PRIMARY KEY,
  created_at INTEGER NOT NULL,
  decider    TEXT    NOT NULL,
  model      TEXT,
  prompt     TEXT,
  response   TEXT,
  event_ids  TEXT    NOT NULL
);

-- Small state that should survive restarts, e.g. the featurizer's template history.
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

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

/** Open (and create if needed) the cloudfriend database. Use ":memory:" in tests. */
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
  migrate(db);
  return db;
}

/** Columns added after v0. Each is added once, to databases that don't have it yet. */
const COLUMNS: [table: string, column: string, decl: string][] = [
  // Triage: the classifier's score, where the event went, its template and feature vector.
  // route: drop | jev | audit | auto | classifier, or NULL when no triage ran.
  ["events", "score", "REAL"],
  ["events", "route", "TEXT"],
  ["events", "template", "TEXT"],
  ["events", "features", "BLOB"],
  ["events", "user_key", "TEXT"],
  // The escalation queue: open -> acknowledged -> resolved, or confirmed / false_positive by feedback.
  ["flags", "status", "TEXT NOT NULL DEFAULT 'open'"],
  ["flags", "updated_at", "INTEGER"],
  ["flags", "event_count", "INTEGER"],
  ["flags", "users", "TEXT"],
  ["flags", "note", "TEXT"],
  // The labelled event's template, so a kind of event someone escalated keeps reaching Jev.
  ["labels", "template", "TEXT"],
  // How the label came about (threshold | audit | novel | known | follower | human | import),
  // its training weight, and the decider call it came from.
  ["labels", "provenance", "TEXT"],
  ["labels", "weight", "REAL"],
  ["labels", "decision_id", "TEXT"],
  // Level and status class (e.g. e5): verdicts are cached per template and severity.
  ["events", "severity", "TEXT"],
  // What a model running in shadow would have scored the event, and the route it would have
  // taken (audits aside): `drop` means it would not have reached Jev.
  ["events", "shadow_score", "REAL"],
  ["events", "shadow_route", "TEXT"],
];

function migrate(db: DB): void {
  for (const [table, column, decl] of COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS events_user ON events(user_key) WHERE user_key IS NOT NULL");
  db.exec("CREATE INDEX IF NOT EXISTS flags_status ON flags(status, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS labels_template ON labels(template) WHERE template IS NOT NULL");
}

export function dbPath(dataDir: string): string {
  return path.join(dataDir, "cloudfriend.db");
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
