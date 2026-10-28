import { EmailTakenError, IdentityTakenError, type AuthStore, type IdentityRecord, type Role, type SessionRecord, type UserRecord } from "./store.ts";

/** In-memory AuthStore, for tests and single-process development. Not persistent. */
export class MemoryAuthStore implements AuthStore {
  readonly users = new Map<string, UserRecord>();
  readonly identities = new Map<string, IdentityRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  /** workspaceId -> userId -> role */
  readonly members = new Map<string, Map<string, Role>>();

  async countUsers() {
    return this.users.size;
  }

  async getUserById(id: string) {
    const u = this.users.get(id);
    return u ? { ...u } : null;
  }

  async getUserByEmail(email: string) {
    for (const u of this.users.values()) if (u.email === email) return { ...u };
    return null;
  }

  async createUser(user: UserRecord, identity?: IdentityRecord) {
    if (await this.getUserByEmail(user.email)) throw new EmailTakenError();
    if (identity && this.identities.has(idKey(identity.issuer, identity.subject))) throw new IdentityTakenError();
    this.users.set(user.id, { ...user });
    if (identity) this.identities.set(idKey(identity.issuer, identity.subject), { ...identity });
  }

  async setPasswordHash(userId: string, hash: string | null) {
    const u = this.users.get(userId);
    if (u) u.password_hash = hash;
  }

  async findUserByIdentity(issuer: string, subject: string) {
    const i = this.identities.get(idKey(issuer, subject));
    return i ? this.getUserById(i.user_id) : null;
  }

  async addIdentity(identity: IdentityRecord) {
    const key = idKey(identity.issuer, identity.subject);
    if (this.identities.has(key)) throw new IdentityTakenError();
    this.identities.set(key, { ...identity });
  }

  async createSession(session: SessionRecord) {
    this.sessions.set(session.token_hash, { ...session });
  }

  async getSession(tokenHash: string) {
    const s = this.sessions.get(tokenHash);
    const u = s && this.users.get(s.user_id);
    return s && u ? { session: { ...s }, user: { ...u } } : null;
  }

  async renewSession(tokenHash: string, expiresAt: Date, renewedAt: Date) {
    const s = this.sessions.get(tokenHash);
    if (s) {
      s.expires_at = expiresAt;
      s.renewed_at = renewedAt;
    }
  }

  async deleteSession(tokenHash: string) {
    this.sessions.delete(tokenHash);
  }

  async deleteUserSessions(userId: string) {
    for (const [k, s] of this.sessions) if (s.user_id === userId) this.sessions.delete(k);
  }

  async deleteExpiredSessions(now: Date) {
    let n = 0;
    for (const [k, s] of this.sessions) {
      if (s.expires_at <= now) {
        this.sessions.delete(k);
        n++;
      }
    }
    return n;
  }

  async getMembership(workspaceId: string, userId: string) {
    return this.members.get(workspaceId)?.get(userId) ?? null;
  }

  /** Not part of AuthStore (workspace membership is written by the workspaces code); for tests. */
  setMembership(workspaceId: string, userId: string, role: Role | null): void {
    let m = this.members.get(workspaceId);
    if (!m) this.members.set(workspaceId, (m = new Map()));
    if (role) m.set(userId, role);
    else m.delete(userId);
  }
}

const idKey = (issuer: string, subject: string) => JSON.stringify([issuer, subject]);
