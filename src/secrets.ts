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

/** The secret a request presented, and where its events go. */
export interface SecretMatch {
  id: string;
  workspace_id: string;
  /**
   * The source the events are filed under: the source id for a source's secret, else the
   * `/in/<name>` path segment (legacy secrets).
   */
  source: string;
  /** The source adapter to parse with (the source's kind), or null for legacy secrets (adapter named like the source). */
  adapter: string | null;
}

/** A new random ingest secret and what is stored of it. */
export function mintSecret(): { secret: string; hash: string; prefix: string } {
  const secret = PREFIX + randomBytes(32).toString("base64url");
  return { secret, hash: hashSecret(secret), prefix: secret.slice(0, PREFIX.length + 6) };
}

/**
 * Store a new secret for a source (sources.id). Returns the plain secret, which is never
 * stored. Call inside the transaction that creates or rotates the source.
 */
export async function insertSourceSecret(q: Queryable, ws: string, sourceId: string, name: string, now = Date.now()): Promise<{ id: string; secret: string; prefix: string }> {
  const { secret, hash, prefix } = mintSecret();
  const id = "sec_" + randomBytes(8).toString("hex");
  await q.query(
    "INSERT INTO secrets (id, workspace_id, name, source, source_id, hash, prefix, created_at) VALUES ($1, $2, $3, NULL, $4, $5, $6, $7)",
    [id, ws, name, sourceId, hash, prefix, now],
  );
  return { id, secret, prefix };
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
    const { secret, hash, prefix } = mintSecret();
    const row: SecretRow = {
      id: "sec_" + randomBytes(8).toString("hex"),
      name,
      source,
      prefix,
      created_at: Date.now(),
      last_used_at: null,
      revoked_at: null,
    };
    await q.query(
      "INSERT INTO secrets (id, workspace_id, name, source, hash, prefix, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [row.id, this.#ws, row.name, row.source, hash, row.prefix, row.created_at],
    );
    return { ...toInfo(row), secret };
  }

  async list(): Promise<SecretInfo[]> {
    const rows = await all<SecretRow>(
      this.#db,
      "SELECT id, name, source, prefix, created_at, last_used_at, revoked_at FROM secrets WHERE workspace_id = $1 AND source_id IS NULL ORDER BY created_at, id",
      [this.#ws],
    );
    return rows.map(toInfo);
  }

  /** Returns false if no active secret has this id. */
  async revoke(id: string): Promise<boolean> {
    return (await run(this.#db, "UPDATE secrets SET revoked_at = $1 WHERE id = $2 AND workspace_id = $3 AND revoked_at IS NULL AND source_id IS NULL", [Date.now(), id, this.#ws])) > 0;
  }

  async count(): Promise<number> {
    return (await one<{ n: number }>(this.#db, "SELECT count(*) AS n FROM secrets WHERE workspace_id = $1", [this.#ws]))!.n;
  }

  /**
   * Check a presented secret against the `/in/<segment>` it was sent to. Returns where the
   * events go, or null. The hash is unique across workspaces, so the secret alone names the
   * workspace.
   * - A source's secret (secrets.source_id) works only on `/in/<that source id>`, while the
   *   source is not revoked and the secret has not expired (rotation leaves the old one 24 h).
   * - A legacy secret (source_id NULL) works as before: on any name, or only on its `source`.
   *   It never works on a source id: those take the source's own secrets.
   */
  async check(secret: string, segment: string, now = Date.now()): Promise<SecretMatch | null> {
    if (!secret.startsWith(PREFIX)) return null;
    const row = await one<{ id: string; workspace_id: string; source: string | null; source_id: string | null; kind: string | null; source_revoked: number | null; segment_is_source: boolean }>(
      this.#db,
      `SELECT s.id, s.workspace_id, s.source, s.source_id, src.kind, src.revoked_at AS source_revoked,
              EXISTS (SELECT 1 FROM sources WHERE id = $2) AS segment_is_source
       FROM secrets s LEFT JOIN sources src ON src.id = s.source_id
       WHERE s.hash = $1 AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > $3)`,
      [hashSecret(secret), segment, now],
    );
    if (!row) return null;
    if (row.source_id !== null) {
      if (row.source_id !== segment || row.source_revoked !== null) return null;
      return { id: row.id, workspace_id: row.workspace_id, source: row.source_id, adapter: row.kind };
    }
    if (row.segment_is_source) return null;
    if (row.source !== null && row.source !== segment) return null;
    return { id: row.id, workspace_id: row.workspace_id, source: segment, adapter: null };
  }

  /** Record use. Called from inside the intake commit, so it costs no extra round of fsync. */
  static async touch(c: Queryable, ids: Iterable<string | null | undefined>, at: number): Promise<void> {
    // Sorted, so concurrent commits lock the rows in the same order.
    const sorted = [...new Set([...ids].filter((id): id is string => !!id))].sort();
    if (sorted.length) await c.query("UPDATE secrets SET last_used_at = $1 WHERE id = ANY($2::text[])", [at, sorted]);
  }
}
