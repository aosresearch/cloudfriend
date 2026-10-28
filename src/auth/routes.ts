import type { Context, Hono, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { errMsg, log } from "../log.ts";
import { newUserId } from "./bootstrap.ts";
import { DEFAULT_OIDC_LABEL, looksLikeEmail, normalizeEmail, type AuthConfig } from "./config.ts";
import { OidcDeniedError, OidcProvider, type OidcClaims, type OidcTransaction } from "./oidc.ts";
import { burnPasswordCheck, hashPassword, needsRehash, verifyPassword } from "./password.ts";
import { DEFAULT_LOGIN_LIMITS, LoginRateLimiter, type LoginLimits } from "./rate-limit.ts";
import { SESSION_COOKIE, Sessions } from "./sessions.ts";
import { EmailTakenError, IdentityTakenError, type AuthStore, type Role, type UserRecord } from "./store.ts";

export const CSRF_HEADER = "x-cloudfriend-csrf";
export const OIDC_TX_COOKIE = "cf_oidc";
const OIDC_TX_PATH = "/auth/oidc";
const OIDC_TX_TTL_MS = 10 * 60_000;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The user as the API shows it. */
export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: Role;
}

/** Hono context variables set by requireUser / requireMember. */
export type AuthEnv = { Variables: { user: AuthUser; role: Role } };

export interface AuthDeps {
  store: AuthStore;
  config: AuthConfig;
  /** Workspaces for GET /api/me. */
  listWorkspaces(userId: string): Promise<WorkspaceSummary[]>;
  /**
   * Client address for login rate limiting. Default: the TCP peer from @hono/node-server. Behind a reverse
   * proxy, pass a function that reads the proxy's header (e.g. the last X-Forwarded-For hop it appends).
   */
  clientIp?: (c: Context) => string;
  loginLimits?: LoginLimits;
  /** Clock, for tests. */
  now?: () => number;
}

export interface Auth {
  /** 401 `{ error }` unless signed in; sets `c.var.user`. */
  requireUser: MiddlewareHandler<AuthEnv>;
  /** 401 unless signed in, 403 unless a member of the workspace `getWorkspaceId` names; sets `c.var.user` and `c.var.role`. */
  requireMember(getWorkspaceId: (c: Context) => string | undefined): MiddlewareHandler<AuthEnv>;
  /** 403 for POST/PUT/PATCH/DELETE without `x-cloudfriend-csrf: 1`. Installed on /api/* by registerAuthRoutes. */
  csrfGuard: MiddlewareHandler;
  /** The signed-in user or null, without failing (renews the session like requireUser). */
  currentUser(c: Context): Promise<AuthUser | null>;
  sessions: Sessions;
  limiter: LoginRateLimiter;
  oidc: OidcProvider | null;
}

export const publicUser = (u: UserRecord): AuthUser => ({ id: u.id, email: u.email, name: u.name });

function defaultClientIp(c: Context): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "unknown";
}

export function createAuth(deps: AuthDeps): Auth {
  return build(deps).auth;
}

function build(deps: AuthDeps) {
  const { store, config } = deps;
  const now = deps.now ?? Date.now;
  const sessions = new Sessions(store, { ttlMs: config.sessionTtlMs, renewEveryMs: config.sessionRenewEveryMs, now });
  const limiter = new LoginRateLimiter(deps.loginLimits ?? DEFAULT_LOGIN_LIMITS, now);
  const oidc = config.oidc ? new OidcProvider(config.oidc) : null;
  // One lookup per request, even when several middlewares ask.
  const resolved = new WeakMap<Context, AuthUser | null>();

  async function currentUser(c: Context): Promise<AuthUser | null> {
    if (resolved.has(c)) return resolved.get(c)!;
    const token = getCookie(c, SESSION_COOKIE);
    const found = await sessions.resolve(token);
    let user: AuthUser | null = null;
    if (found) {
      user = publicUser(found.user);
      if (found.renewed) setSessionCookie(c, token!);
    } else if (token !== undefined) {
      clearSessionCookie(c);
    }
    resolved.set(c, user);
    return user;
  }

  const requireUser: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const user = await currentUser(c);
    if (!user) return c.json({ error: "not signed in" }, 401);
    c.set("user", user);
    await next();
  };

  const requireMember = (getWorkspaceId: (c: Context) => string | undefined): MiddlewareHandler<AuthEnv> =>
    async (c, next) => {
      const user = await currentUser(c);
      if (!user) return c.json({ error: "not signed in" }, 401);
      const ws = getWorkspaceId(c);
      const role = ws ? await store.getMembership(ws, user.id) : null;
      if (!role) return c.json({ error: "not a member of this workspace" }, 403);
      c.set("user", user);
      c.set("role", role);
      await next();
    };

  const csrfGuard: MiddlewareHandler = async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method) && c.req.header(CSRF_HEADER) !== "1") {
      return c.json({ error: `missing ${CSRF_HEADER} header` }, 403);
    }
    await next();
  };

  function secure(c: Context): boolean {
    if (config.publicUrl?.protocol === "https:") return true;
    try {
      return new URL(c.req.url).protocol === "https:";
    } catch {
      return false;
    }
  }

  function setSessionCookie(c: Context, token: string): void {
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      secure: secure(c),
      maxAge: Math.floor(config.sessionTtlMs / 1000),
    });
  }

  function clearSessionCookie(c: Context): void {
    deleteCookie(c, SESSION_COOKIE, { httpOnly: true, sameSite: "Lax", path: "/", secure: secure(c) });
  }

  /** After sign-in, so later middleware in the same request sees the new user. */
  function signedIn(c: Context, token: string, user: UserRecord): void {
    setSessionCookie(c, token);
    resolved.set(c, publicUser(user));
  }

  function signedOut(c: Context): void {
    clearSessionCookie(c);
    resolved.set(c, null);
  }

  const auth: Auth = { requireUser, requireMember, csrfGuard, currentUser, sessions, limiter, oidc };
  return { auth, secure, signedIn, signedOut, now };
}

/**
 * Registers the sign-in routes and the CSRF guard for /api/*. Call it before registering other /api routes
 * (Hono runs middleware in registration order). Returns the middleware for protecting the rest of the API.
 */
export function registerAuthRoutes(app: Hono<any>, deps: AuthDeps): Auth {
  const { auth, secure, signedIn, signedOut, now } = build(deps);
  const { store, config } = deps;
  const clientIp = deps.clientIp ?? defaultClientIp;
  const home = (config.publicUrl?.pathname ?? "").replace(/\/+$/, "") + "/";

  app.use("/api/*", auth.csrfGuard);

  app.get("/api/auth-config", (c) =>
    c.json({ password: true, oidc: auth.oidc !== null, oidcLabel: config.oidc?.label ?? DEFAULT_OIDC_LABEL }),
  );

  app.post("/api/login", async (c) => {
    c.header("cache-control", "no-store");
    let body: { email?: unknown; password?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'body must be JSON: {"email": "...", "password": "..."}' }, 400);
    }
    if (typeof body?.email !== "string" || typeof body.password !== "string" || !body.email.trim() || !body.password) {
      return c.json({ error: "email and password are required" }, 400);
    }
    const email = normalizeEmail(body.email);
    const password = body.password;
    const ip = clientIp(c);

    const wait = auth.limiter.begin(ip, email);
    if (wait > 0) {
      c.header("retry-after", String(Math.ceil(wait / 1000)));
      return c.json({ error: "too many sign-in attempts, try again later" }, 429);
    }
    let user: UserRecord | null = null;
    let ok = false;
    try {
      if (looksLikeEmail(email) && password.length <= 1024) user = await store.getUserByEmail(email);
      ok = user?.password_hash ? await verifyPassword(password, user.password_hash) : await burnPasswordCheck(password);
    } finally {
      auth.limiter.finish(ip, email, ok);
    }
    if (!ok || !user) return c.json({ error: "invalid email or password" }, 401);

    if (needsRehash(user.password_hash!)) await store.setPasswordHash(user.id, await hashPassword(password));
    await auth.sessions.destroy(getCookie(c, SESSION_COOKIE));
    const { token } = await auth.sessions.create(user.id);
    signedIn(c, token, user);
    return c.json({ user: publicUser(user) });
  });

  app.post("/api/logout", async (c) => {
    c.header("cache-control", "no-store");
    await auth.sessions.destroy(getCookie(c, SESSION_COOKIE));
    signedOut(c);
    return c.json({});
  });

  app.get("/api/me", auth.requireUser, async (c) => {
    c.header("cache-control", "no-store");
    const user = c.get("user");
    return c.json({ user, workspaces: await deps.listWorkspaces(user.id) });
  });

  // --- OIDC ----------------------------------------------------------------------------

  const fail = (c: Context, code: "sso_failed" | "sso_denied" | "sso_unverified") => c.redirect(`${home}?auth_error=${code}`, 302);

  app.get("/auth/oidc/login", async (c) => {
    if (!auth.oidc) return c.json({ error: "SSO is not configured" }, 404);
    let started;
    try {
      started = await auth.oidc.start(now());
    } catch (err) {
      log.error("oidc: discovery failed", { error: errMsg(err) });
      return fail(c, "sso_failed");
    }
    const t = started.tx;
    setCookie(c, OIDC_TX_COOKIE, Buffer.from(JSON.stringify([t.state, t.nonce, t.verifier, t.createdAt])).toString("base64url"), {
      httpOnly: true,
      // Lax, not Strict: the provider's redirect back is a cross-site top-level GET.
      sameSite: "Lax",
      path: OIDC_TX_PATH,
      secure: secure(c),
      maxAge: OIDC_TX_TTL_MS / 1000,
    });
    c.header("cache-control", "no-store");
    return c.redirect(started.url.href, 302);
  });

  app.get("/auth/oidc/callback", async (c) => {
    if (!auth.oidc) return c.json({ error: "SSO is not configured" }, 404);
    c.header("cache-control", "no-store");
    const tx = readTx(getCookie(c, OIDC_TX_COOKIE), now());
    deleteCookie(c, OIDC_TX_COOKIE, { httpOnly: true, sameSite: "Lax", path: OIDC_TX_PATH, secure: secure(c) });
    if (!tx) {
      log.warn("oidc: callback without a valid sign-in transaction (expired, or started in another browser)");
      return fail(c, "sso_failed");
    }

    let claims: OidcClaims;
    try {
      claims = await auth.oidc.finish(new URL(c.req.url).searchParams, tx);
    } catch (err) {
      if (err instanceof OidcDeniedError) {
        log.warn("oidc: sign-in denied", { reason: err.message });
        return fail(c, "sso_denied");
      }
      log.warn("oidc: sign-in failed", { error: errMsg(err), code: (err as { code?: string }).code });
      return fail(c, "sso_failed");
    }

    const user = await userForClaims(store, claims, now());
    if ("denied" in user) {
      log.warn("oidc: sign-in denied", { reason: user.denied, issuer: claims.issuer, sub: claims.subject });
      return fail(c, user.code);
    }
    await auth.sessions.destroy(getCookie(c, SESSION_COOKIE));
    const { token } = await auth.sessions.create(user.id);
    signedIn(c, token, user);
    return c.redirect(home, 302);
  });

  return auth;
}

function readTx(raw: string | undefined, now: number): OidcTransaction | null {
  if (!raw || raw.length > 1024) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(v) || v.length !== 4) return null;
    const [state, nonce, verifier, createdAt] = v as unknown[];
    if (typeof state !== "string" || typeof nonce !== "string" || typeof verifier !== "string" || typeof createdAt !== "number") return null;
    if (!state || !nonce || !verifier || now - createdAt > OIDC_TX_TTL_MS || createdAt > now + 60_000) return null;
    return { state, nonce, verifier, createdAt };
  } catch {
    return null;
  }
}

/**
 * Finds or provisions the user for a verified ID token. Matching is by (issuer, sub) only. A new identity
 * (first sign-in) needs an email the provider verified, whether it creates an account or links to an
 * existing one with that email; otherwise sign-in is refused (returns the reason).
 *
 * Why creation needs it too: an account's email is what later verified sign-ins (and the bootstrap admin)
 * link to. If an unverified identity could create the account for victim@example.com, the real owner's
 * verified sign-in would later be linked to the attacker's account (pre-account hijack). So every account's
 * email comes from a verified source: an admin (password) or a provider that verified it.
 */
async function userForClaims(
  store: AuthStore,
  claims: OidcClaims,
  now: number,
): Promise<UserRecord | { denied: string; code: "sso_denied" | "sso_unverified" }> {
  const linked = await store.findUserByIdentity(claims.issuer, claims.subject);
  if (linked) return linked;
  if (!claims.email) return { denied: "the provider returned no email address (request the email scope)", code: "sso_denied" };
  if (!claims.emailVerified) return { denied: `the provider did not verify the email ${claims.email}`, code: "sso_unverified" };
  const identity = { issuer: claims.issuer, subject: claims.subject, email: claims.email, created_at: new Date(now) };

  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await store.getUserByEmail(claims.email);
    if (existing) {
      try {
        await store.addIdentity({ ...identity, user_id: existing.id });
      } catch (err) {
        if (!(err instanceof IdentityTakenError)) throw err;
      }
      // Re-read: a concurrent callback may have linked this identity first (to this user or, in theory, another).
      return (await store.findUserByIdentity(claims.issuer, claims.subject)) ?? existing;
    }
    const user: UserRecord = { id: newUserId(), email: claims.email, name: claims.name, password_hash: null, created_at: new Date(now) };
    try {
      await store.createUser(user, { ...identity, user_id: user.id });
      return user;
    } catch (err) {
      if (err instanceof IdentityTakenError) {
        const winner = await store.findUserByIdentity(claims.issuer, claims.subject);
        if (winner) return winner;
      }
      if (!(err instanceof EmailTakenError) && !(err instanceof IdentityTakenError)) throw err;
      // Someone created this email concurrently: loop once to link instead.
    }
  }
  return { denied: "could not provision the user", code: "sso_denied" };
}
