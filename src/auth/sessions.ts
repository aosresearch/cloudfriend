import { createHash, randomBytes } from "node:crypto";
import type { AuthStore, SessionRecord, UserRecord } from "./store.ts";

export const SESSION_COOKIE = "cf_session";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** 32 random bytes, base64url (43 characters). */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Tokens are 256-bit random, so a plain SHA-256 is enough to store them (as with ingest secrets). */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface SessionOptions {
  ttlMs: number;
  renewEveryMs: number;
  now?: () => number;
}

export interface ResolvedSession {
  user: UserRecord;
  session: SessionRecord;
  /** True when expires_at was just pushed forward, so the cookie should be sent again. */
  renewed: boolean;
}

export class Sessions {
  readonly #store: AuthStore;
  readonly #ttlMs: number;
  readonly #renewEveryMs: number;
  readonly #now: () => number;

  constructor(store: AuthStore, opts: SessionOptions) {
    this.#store = store;
    this.#ttlMs = opts.ttlMs;
    this.#renewEveryMs = opts.renewEveryMs;
    this.#now = opts.now ?? Date.now;
  }

  get ttlMs(): number {
    return this.#ttlMs;
  }

  /** Creates a session and returns the token for the cookie. */
  async create(userId: string): Promise<{ token: string; session: SessionRecord }> {
    const token = newSessionToken();
    const now = new Date(this.#now());
    const session: SessionRecord = {
      token_hash: hashSessionToken(token),
      user_id: userId,
      created_at: now,
      expires_at: new Date(now.getTime() + this.#ttlMs),
      renewed_at: now,
    };
    await this.#store.createSession(session);
    return { token, session };
  }

  /** Looks up a cookie token. Expired sessions are deleted and give null. Renews at most once per renewEveryMs. */
  async resolve(token: string | undefined): Promise<ResolvedSession | null> {
    if (!token || !TOKEN.test(token)) return null;
    const hash = hashSessionToken(token);
    const found = await this.#store.getSession(hash);
    if (!found) return null;
    const now = this.#now();
    if (found.session.expires_at.getTime() <= now) {
      await this.#store.deleteSession(hash);
      return null;
    }
    let renewed = false;
    if (now - found.session.renewed_at.getTime() >= this.#renewEveryMs) {
      const expires = new Date(now + this.#ttlMs);
      const at = new Date(now);
      await this.#store.renewSession(hash, expires, at);
      found.session = { ...found.session, expires_at: expires, renewed_at: at };
      renewed = true;
    }
    return { ...found, renewed };
  }

  async destroy(token: string | undefined): Promise<void> {
    if (token && TOKEN.test(token)) await this.#store.deleteSession(hashSessionToken(token));
  }

  prune(): Promise<number> {
    return this.#store.deleteExpiredSessions(new Date(this.#now()));
  }
}
