import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DB } from "./db.ts";

export interface SecretInfo {
  id: string;
  name: string;
  /** null means the secret works for every source. */
  source: string | null;
  /** First characters of the secret, so people can tell secrets apart. */
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface CreatedSecret extends SecretInfo {
  /** The plain secret. Only returned at creation, never stored. */
  secret: string;
}

interface SecretRow {
  id: string;
  name: string;
  source: string | null;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());

function toInfo(r: SecretRow): SecretInfo {
  return {
    id: r.id,
    name: r.name,
    source: r.source,
    prefix: r.prefix,
    created_at: iso(r.created_at)!,
    last_used_at: iso(r.last_used_at),
    revoked_at: iso(r.revoked_at),
  };
}

/** Ingest secrets are 256-bit random tokens, so a plain SHA-256 is enough to store them. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Constant-time string comparison, for the admin key. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export const SOURCE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Every ingest secret starts with this, so a leaked one is easy to recognize. */
const PREFIX = "cloudfriend_";

export class Secrets {
  #db: DB;
  #byHash;
  #touch;

  constructor(db: DB) {
    this.#db = db;
    this.#byHash = db.prepare("SELECT id, source FROM secrets WHERE hash = ? AND revoked_at IS NULL");
    this.#touch = db.prepare("UPDATE secrets SET last_used_at = ? WHERE id = ?");
  }

  create(name: string, source: string | null = null): CreatedSecret {
    name = name.trim();
    if (!name || name.length > 128) throw new Error("name must be 1-128 characters");
    if (source !== null && !SOURCE_NAME.test(source)) throw new Error("source must match " + SOURCE_NAME);
    const secret = PREFIX + randomBytes(32).toString("base64url");
    const row: SecretRow = {
      id: "sec_" + randomBytes(8).toString("hex"),
      name,
      source,
      prefix: secret.slice(0, PREFIX.length + 6),
      created_at: Date.now(),
      last_used_at: null,
      revoked_at: null,
    };
    this.#db
      .prepare("INSERT INTO secrets (id, name, source, hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(row.id, row.name, row.source, hashSecret(secret), row.prefix, row.created_at);
    return { ...toInfo(row), secret };
  }

  list(): SecretInfo[] {
    const rows = this.#db
      .prepare("SELECT id, name, source, prefix, created_at, last_used_at, revoked_at FROM secrets ORDER BY created_at")
      .all() as unknown as SecretRow[];
    return rows.map(toInfo);
  }

  /** Returns false if no active secret has this id. */
  revoke(id: string): boolean {
    const res = this.#db
      .prepare("UPDATE secrets SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(Date.now(), id);
    return res.changes > 0;
  }

  count(): number {
    return (this.#db.prepare("SELECT count(*) AS n FROM secrets").get() as { n: number }).n;
  }

  /** Check a presented secret against a source. Returns the secret id, or null. */
  check(secret: string, source: string): string | null {
    if (!secret.startsWith(PREFIX)) return null;
    const row = this.#byHash.get(hashSecret(secret)) as { id: string; source: string | null } | undefined;
    if (!row) return null;
    if (row.source !== null && row.source !== source) return null;
    return row.id;
  }

  /** Record use. Called from inside the intake commit, so it costs no extra fsync. */
  touch(ids: Iterable<string>, at: number): void {
    for (const id of ids) this.#touch.run(at, id);
  }
}
