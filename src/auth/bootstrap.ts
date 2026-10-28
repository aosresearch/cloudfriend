import { randomBytes } from "node:crypto";
import { AuthConfigError, type AuthConfig } from "./config.ts";
import { generatePassword, hashPassword, verifyPassword } from "./password.ts";
import { EmailTakenError, type AuthStore, type UserRecord } from "./store.ts";

export const FIRST_BOOT_ADMIN_EMAIL = "admin@localhost";

export interface BootstrapResult {
  /** "env": CLOUDFRIEND_ADMIN_EMAIL/PASSWORD; "generated": first boot, no users, no env; "none": nothing to do. */
  mode: "env" | "generated" | "none";
  userId: string | null;
  email: string | null;
  created: boolean;
  /** env mode: the stored password differed from the env and was replaced (the user's sessions were revoked). */
  passwordUpdated: boolean;
  /** generated mode only: the plain password. Print it once; it is not stored anywhere. */
  password: string | null;
}

export function newUserId(): string {
  return "usr_" + randomBytes(10).toString("hex");
}

/**
 * Makes sure an admin can sign in. Call once at startup, after migrations.
 * - With CLOUDFRIEND_ADMIN_EMAIL + CLOUDFRIEND_ADMIN_PASSWORD: that user exists and has that password.
 *   Throws AuthConfigError when the email belongs to an account created by SSO sign-in (see syncPassword).
 * - Otherwise, when there are no users at all: creates admin@localhost with a random password and returns it.
 */
export async function ensureBootstrapAdmin(store: AuthStore, config: Pick<AuthConfig, "bootstrapAdmin">): Promise<BootstrapResult> {
  const env = config.bootstrapAdmin;
  if (env) {
    const existing = await store.getUserByEmail(env.email);
    if (!existing) {
      const user = await createOrFind(store, env.email, await hashPassword(env.password));
      if (user.created) return { mode: "env", userId: user.id, email: env.email, created: true, passwordUpdated: false, password: null };
      return syncPassword(store, { id: user.id, email: env.email, password_hash: user.password_hash }, env.password);
    }
    return syncPassword(store, existing, env.password);
  }

  if ((await store.countUsers()) > 0) {
    return { mode: "none", userId: null, email: null, created: false, passwordUpdated: false, password: null };
  }
  const password = generatePassword();
  const user = await createOrFind(store, FIRST_BOOT_ADMIN_EMAIL, await hashPassword(password));
  if (!user.created) {
    // Another instance won the first-boot race; its password is the one that was printed.
    return { mode: "none", userId: user.id, email: FIRST_BOOT_ADMIN_EMAIL, created: false, passwordUpdated: false, password: null };
  }
  return { mode: "generated", userId: user.id, email: FIRST_BOOT_ADMIN_EMAIL, created: true, passwordUpdated: false, password };
}

/**
 * Gives the env admin's account the env password. An account without a password was created by SSO
 * sign-in, and is never adopted: giving it a password (and, in setupAuth, the default workspace) would hand
 * the admin's rights to whoever holds the SSO identities linked to it, and the env names an email, not
 * those identities. Boot fails instead, with a message saying what to do.
 */
async function syncPassword(store: AuthStore, user: Pick<UserRecord, "id" | "email" | "password_hash">, password: string): Promise<BootstrapResult> {
  if (user.password_hash === null) {
    throw new AuthConfigError(
      `CLOUDFRIEND_ADMIN_EMAIL ${user.email} belongs to an account created by SSO sign-in, which cloudfriend will not turn into the admin. ` +
        "Set CLOUDFRIEND_ADMIN_EMAIL to an address no one has signed in with, or unset CLOUDFRIEND_ADMIN_EMAIL and CLOUDFRIEND_ADMIN_PASSWORD.",
    );
  }
  const same = await verifyPassword(password, user.password_hash);
  if (!same) {
    await store.setPasswordHash(user.id, await hashPassword(password));
    await store.deleteUserSessions(user.id);
  }
  return { mode: "env", userId: user.id, email: user.email, created: false, passwordUpdated: !same, password: null };
}

async function createOrFind(store: AuthStore, email: string, passwordHash: string): Promise<{ id: string; created: boolean; password_hash: string | null }> {
  const user: UserRecord = { id: newUserId(), email, name: null, password_hash: passwordHash, created_at: new Date() };
  try {
    await store.createUser(user);
    return { id: user.id, created: true, password_hash: passwordHash };
  } catch (err) {
    if (!(err instanceof EmailTakenError)) throw err;
    const other = await store.getUserByEmail(email);
    if (!other) throw err;
    return { id: other.id, created: false, password_hash: other.password_hash };
  }
}
