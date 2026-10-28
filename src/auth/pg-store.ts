// AuthStore on Postgres: the users, user_identities, sessions and workspace_members tables of
// migration 002. Each method is one statement (createUser with an identity is two, in a transaction).
import type pg from "pg";
import { one, run, tx, type DB, type Queryable } from "../db.ts";
import { EmailTakenError, IdentityTakenError, type AuthStore, type IdentityRecord, type Role, type SessionRecord, type UserRecord } from "./store.ts";

const USER_COLUMNS = "id, email, name, password_hash, created_at";

/** Unique violations on the constraints the AuthStore contract names become its errors; anything else is rethrown. */
function mapUniqueViolation(err: unknown): never {
  const e = err as { code?: string; constraint?: string };
  if (e?.code === "23505") {
    if (e.constraint === "users_email_key") throw new EmailTakenError();
    if (e.constraint === "user_identities_pkey") throw new IdentityTakenError();
  }
  throw err;
}

async function insertIdentity(q: Queryable, i: IdentityRecord): Promise<void> {
  await q.query("INSERT INTO user_identities (issuer, subject, user_id, email, created_at) VALUES ($1, $2, $3, $4, $5)", [
    i.issuer,
    i.subject,
    i.user_id,
    i.email,
    i.created_at,
  ]);
}

export class PgAuthStore implements AuthStore {
  readonly #db: DB;

  constructor(db: DB) {
    this.#db = db;
  }

  async countUsers(): Promise<number> {
    return (await one<{ n: number }>(this.#db, "SELECT count(*) AS n FROM users"))!.n;
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    return (await one<UserRecord>(this.#db, `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id])) ?? null;
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    return (await one<UserRecord>(this.#db, `SELECT ${USER_COLUMNS} FROM users WHERE email = $1`, [email])) ?? null;
  }

  async createUser(user: UserRecord, identity?: IdentityRecord): Promise<void> {
    const insert = (q: Queryable) =>
      q.query("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)", [
        user.id,
        user.email,
        user.name,
        user.password_hash,
        user.created_at,
      ]);
    try {
      if (!identity) {
        await insert(this.#db);
        return;
      }
      await tx(this.#db, async (c: pg.PoolClient) => {
        await insert(c);
        await insertIdentity(c, identity);
      });
    } catch (err) {
      mapUniqueViolation(err);
    }
  }

  async setPasswordHash(userId: string, hash: string | null): Promise<void> {
    await run(this.#db, "UPDATE users SET password_hash = $2 WHERE id = $1", [userId, hash]);
  }

  async findUserByIdentity(issuer: string, subject: string): Promise<UserRecord | null> {
    return (
      (await one<UserRecord>(
        this.#db,
        `SELECT ${USER_COLUMNS.split(", ").map((c) => "u." + c).join(", ")}
         FROM user_identities i JOIN users u ON u.id = i.user_id WHERE i.issuer = $1 AND i.subject = $2`,
        [issuer, subject],
      )) ?? null
    );
  }

  async addIdentity(identity: IdentityRecord): Promise<void> {
    try {
      await insertIdentity(this.#db, identity);
    } catch (err) {
      mapUniqueViolation(err);
    }
  }

  async createSession(s: SessionRecord): Promise<void> {
    await run(this.#db, "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, renewed_at) VALUES ($1, $2, $3, $4, $5)", [
      s.token_hash,
      s.user_id,
      s.created_at,
      s.expires_at,
      s.renewed_at,
    ]);
  }

  async getSession(tokenHash: string): Promise<{ session: SessionRecord; user: UserRecord } | null> {
    const row = await one<{
      token_hash: string;
      user_id: string;
      s_created_at: Date;
      expires_at: Date;
      renewed_at: Date;
      email: string;
      name: string | null;
      password_hash: string | null;
      u_created_at: Date;
    }>(
      this.#db,
      `SELECT s.token_hash, s.user_id, s.created_at AS s_created_at, s.expires_at, s.renewed_at,
              u.email, u.name, u.password_hash, u.created_at AS u_created_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`,
      [tokenHash],
    );
    if (!row) return null;
    return {
      session: { token_hash: row.token_hash, user_id: row.user_id, created_at: row.s_created_at, expires_at: row.expires_at, renewed_at: row.renewed_at },
      user: { id: row.user_id, email: row.email, name: row.name, password_hash: row.password_hash, created_at: row.u_created_at },
    };
  }

  async renewSession(tokenHash: string, expiresAt: Date, renewedAt: Date): Promise<void> {
    await run(this.#db, "UPDATE sessions SET expires_at = $2, renewed_at = $3 WHERE token_hash = $1", [tokenHash, expiresAt, renewedAt]);
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await run(this.#db, "DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
  }

  async deleteUserSessions(userId: string): Promise<void> {
    await run(this.#db, "DELETE FROM sessions WHERE user_id = $1", [userId]);
  }

  async deleteExpiredSessions(now: Date): Promise<number> {
    return run(this.#db, "DELETE FROM sessions WHERE expires_at <= $1", [now]);
  }

  async getMembership(workspaceId: string, userId: string): Promise<Role | null> {
    return (await one<{ role: Role }>(this.#db, "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [workspaceId, userId]))?.role ?? null;
  }
}
