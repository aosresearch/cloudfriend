import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { all, DEFAULT_WORKSPACE, one, run, tx, type DB, type Queryable } from "./db.ts";

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

/** The secret a request presented, and the workspace its events belong to. */
export interface SecretMatch {
  id: string;
  workspace_id: string;
}

export class Secrets {
  #db: DB;
  #ws: string;

  constructor(db: DB, workspace = DEFAULT_WORKSPACE) {
    this.#db = db;
    this.#ws = workspace;
  }

  async create(name: string, source: string | null = null): Promise<CreatedSecret> {
    return this.#insert(this.#db, name, source);
  }

  /**
   * Create the workspace's first secret, unless it has one already. The workspace row is
   * locked meanwhile, so two processes booting at once don't both create one.
   */
  async createFirst(name: string): Promise<CreatedSecret | null> {
    return tx(this.#db, async (c) => {
      await c.query("SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE", [this.#ws]);
      if (await one(c, "SELECT 1 FROM secrets WHERE workspace_id = $1 LIMIT 1", [this.#ws])) return null;
      return this.#insert(c, name, null);
    });
  }

  async #insert(q: Queryable, name: string, source: string | null): Promise<CreatedSecret> {
    name = name.trim();
    if (!name || name.length > 128) throw new Error("name must be 1-128 characters");
    if (name.includes("\0")) throw new Error("name must not contain NUL");
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
    await q.query(
      "INSERT INTO secrets (id, workspace_id, name, source, hash, prefix, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [row.id, this.#ws, row.name, row.source, hashSecret(secret), row.prefix, row.created_at],
    );
    return { ...toInfo(row), secret };
  }

  async list(): Promise<SecretInfo[]> {
    const rows = await all<SecretRow>(
      this.#db,
      "SELECT id, name, source, prefix, created_at, last_used_at, revoked_at FROM secrets WHERE workspace_id = $1 ORDER BY created_at, id",
      [this.#ws],
    );
    return rows.map(toInfo);
  }

  /** Returns false if no active secret has this id. */
  async revoke(id: string): Promise<boolean> {
    return (await run(this.#db, "UPDATE secrets SET revoked_at = $1 WHERE id = $2 AND workspace_id = $3 AND revoked_at IS NULL", [Date.now(), id, this.#ws])) > 0;
  }

  async count(): Promise<number> {
    return (await one<{ n: number }>(this.#db, "SELECT count(*) AS n FROM secrets WHERE workspace_id = $1", [this.#ws]))!.n;
  }

  /**
   * Check a presented secret against a source. Returns the secret and its workspace, or null.
   * The hash is unique across workspaces, so the secret alone says where its events go.
   */
  async check(secret: string, source: string): Promise<SecretMatch | null> {
    if (!secret.startsWith(PREFIX)) return null;
    const row = await one<{ id: string; workspace_id: string; source: string | null }>(
      this.#db,
      "SELECT id, workspace_id, source FROM secrets WHERE hash = $1 AND revoked_at IS NULL",
      [hashSecret(secret)],
    );
    if (!row) return null;
    if (row.source !== null && row.source !== source) return null;
    return { id: row.id, workspace_id: row.workspace_id };
  }

  /** Record use. Called from inside the intake commit, so it costs no extra round of fsync. */
  static async touch(c: Queryable, ids: Iterable<string>, at: number): Promise<void> {
    // Sorted, so concurrent commits lock the rows in the same order.
    await c.query("UPDATE secrets SET last_used_at = $1 WHERE id = ANY($2::text[])", [at, [...new Set(ids)].sort()]);
  }
}
