import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import {
  AuthConfigError,
  ensureBootstrapAdmin,
  FIRST_BOOT_ADMIN_EMAIL,
  hashPassword,
  loadAuthConfig,
  MemoryAuthStore,
  registerAuthRoutes,
  SESSION_COOKIE,
  type AuthEnv,
  type LoginLimits,
} from "../src/auth/index.ts";
import { DEFAULT_LOGIN_LIMITS } from "../src/auth/rate-limit.ts";
import { clientAddress, parseTrustedProxies } from "../src/auth/client-ip.ts";
import { hashSessionToken } from "../src/auth/sessions.ts";

process.env.CLOUDFRIEND_LOG ??= "silent";

const json = (res: Response) => res.json() as Promise<any>;
const CSRF = { "x-cloudfriend-csrf": "1" };
const HOUR = 3600_000;

interface Cookie {
  name: string;
  value: string;
  attrs: Record<string, string | true>;
}

function parseSetCookies(res: Response): Cookie[] {
  return res.headers.getSetCookie().map((line) => {
    const [pair, ...rest] = line.split(";").map((s) => s.trim());
    const eq = pair!.indexOf("=");
    const attrs: Record<string, string | true> = {};
    for (const a of rest) {
      const i = a.indexOf("=");
      attrs[(i < 0 ? a : a.slice(0, i)).toLowerCase()] = i < 0 ? true : a.slice(i + 1);
    }
    return { name: pair!.slice(0, eq), value: pair!.slice(eq + 1), attrs };
  });
}

const sessionCookie = (res: Response) => parseSetCookies(res).find((c) => c.name === SESSION_COOKIE);

async function setup(opts: { env?: Record<string, string>; limits?: Partial<LoginLimits> } = {}) {
  const store = new MemoryAuthStore();
  const clock = { t: Date.parse("2026-10-27T12:00:00Z") };
  const config = loadAuthConfig(opts.env ?? {});
  const app = new Hono();
  const loginLimits: LoginLimits = {
    ip: { free: 50, baseMs: 1000, maxMs: 60_000, forgetAfterMs: HOUR },
    email: { free: 3, baseMs: 1000, maxMs: 60_000, forgetAfterMs: HOUR },
    maxEntries: 1000,
    maxInFlightPerIp: 8,
    maxInFlightPerEmail: 2,
    ...opts.limits,
  };
  const auth = registerAuthRoutes(app, {
    store,
    config,
    now: () => clock.t,
    clientIp: (c) => c.req.header("x-test-ip") ?? "10.0.0.1",
    loginLimits,
    listWorkspaces: async (userId) =>
      [...store.members].flatMap(([id, m]) => (m.has(userId) ? [{ id, name: `Workspace ${id}`, role: m.get(userId)! }] : [])),
  });
  const scoped = new Hono<AuthEnv>();
  scoped.get("/things", (c) => c.json({ user: c.get("user").id, role: c.get("role") }));
  scoped.post("/things", (c) => c.json({ ok: true, role: c.get("role") }));
  app.use("/api/w/:ws/*", auth.requireMember((c) => c.req.param("ws")));
  app.route("/api/w/:ws", scoped);
  app.get("/api/private", auth.requireUser, (c) => c.json({ ok: true }));

  const user = { id: "usr_alice", email: "alice@example.com", name: "Alice", password: "correct horse battery" };
  await store.createUser({ id: user.id, email: user.email, name: user.name, password_hash: await hashPassword(user.password), created_at: new Date(clock.t) });

  const request = (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; cookie?: string } = {}) =>
    app.request(path, {
      method: init.method ?? "GET",
      headers: {
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.cookie ? { cookie: `${SESSION_COOKIE}=${init.cookie}` } : {}),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
    });
  const login = (email: string, password: string, headers: Record<string, string> = {}) =>
    request("/api/login", { method: "POST", headers: { ...CSRF, ...headers }, body: { email, password } });

  return { app, store, clock, auth, user, request, login };
}

describe("auth config", () => {
  it("is empty by default", () => {
    const c = loadAuthConfig({});
    assert.equal(c.oidc, null);
    assert.equal(c.bootstrapAdmin, null);
    assert.equal(c.sessionTtlMs, 30 * 24 * HOUR);
    assert.equal(c.sessionRenewEveryMs, HOUR);
  });

  it("rejects half-configured OIDC with a clear message", () => {
    assert.throws(
      () => loadAuthConfig({ CLOUDFRIEND_OIDC_ISSUER: "https://x.auth0.com/", CLOUDFRIEND_OIDC_CLIENT_ID: "abc" }),
      (err: Error) => err instanceof AuthConfigError && /half-configured/.test(err.message) && /CLOUDFRIEND_OIDC_CLIENT_SECRET missing/.test(err.message),
    );
    assert.throws(() => loadAuthConfig({ CLOUDFRIEND_OIDC_LABEL: "Okta" }), /OIDC is not configured/);
    const full = { CLOUDFRIEND_OIDC_ISSUER: "https://x.auth0.com/", CLOUDFRIEND_OIDC_CLIENT_ID: "abc", CLOUDFRIEND_OIDC_CLIENT_SECRET: "s" };
    assert.throws(() => loadAuthConfig(full), /CLOUDFRIEND_PUBLIC_URL/);
    assert.throws(() => loadAuthConfig({ ...full, CLOUDFRIEND_OIDC_ISSUER: "http://idp.example.com", CLOUDFRIEND_PUBLIC_URL: "https://cf.example.com" }), /https/);
    assert.throws(() => loadAuthConfig({ ...full, CLOUDFRIEND_PUBLIC_URL: "https://cf.example.com", CLOUDFRIEND_OIDC_ALLOWED_DOMAINS: "ok.com, not a domain" }), /invalid domains/);

    const c = loadAuthConfig({ ...full, CLOUDFRIEND_PUBLIC_URL: "https://cf.example.com/", CLOUDFRIEND_OIDC_ALLOWED_DOMAINS: "Example.com, @corp.example.org" });
    assert.equal(c.oidc!.redirectUri, "https://cf.example.com/auth/oidc/callback");
    assert.deepEqual(c.oidc!.allowedDomains, ["example.com", "corp.example.org"]);
    assert.equal(c.oidc!.label, "Sign in with SSO");
  });

  it("needs both admin variables and a long enough password", () => {
    assert.throws(() => loadAuthConfig({ CLOUDFRIEND_ADMIN_EMAIL: "a@b.c" }), /CLOUDFRIEND_ADMIN_PASSWORD is not/);
    assert.throws(() => loadAuthConfig({ CLOUDFRIEND_ADMIN_PASSWORD: "x".repeat(20) }), /CLOUDFRIEND_ADMIN_EMAIL is not/);
    assert.throws(() => loadAuthConfig({ CLOUDFRIEND_ADMIN_EMAIL: "a@b.c", CLOUDFRIEND_ADMIN_PASSWORD: "short" }), /at least 12/);
    assert.deepEqual(loadAuthConfig({ CLOUDFRIEND_ADMIN_EMAIL: " Admin@Example.COM ", CLOUDFRIEND_ADMIN_PASSWORD: "x".repeat(12) }).bootstrapAdmin, {
      email: "admin@example.com",
      password: "x".repeat(12),
    });
  });
});

describe("auth-config endpoint", () => {
  it("reports password sign-in only when OIDC is off", async () => {
    const t = await setup();
    assert.deepEqual(await json(await t.request("/api/auth-config")), { password: true, oidc: false, oidcLabel: "Sign in with SSO" });
    assert.equal((await t.request("/auth/oidc/login")).status, 404);
  });
});

describe("password login", () => {
  it("signs in, sets a hardened cookie, and stores only the token's hash", async () => {
    const t = await setup();
    const res = await t.login("  ALICE@example.com ", t.user.password);
    assert.equal(res.status, 200);
    assert.deepEqual(await json(res), { user: { id: t.user.id, email: t.user.email, name: "Alice" } });
    const cookie = sessionCookie(res)!;
    assert.match(cookie.value, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(cookie.attrs.httponly, true);
    assert.equal(cookie.attrs.samesite, "Lax");
    assert.equal(cookie.attrs.path, "/");
    assert.equal(cookie.attrs.secure, undefined, "no Secure over plain http without an https public URL");
    assert.equal(cookie.attrs["max-age"], String(30 * 24 * 3600));

    assert.equal(t.store.sessions.size, 1);
    const [stored] = t.store.sessions.values();
    assert.equal(stored!.token_hash, hashSessionToken(cookie.value));
    assert.ok(![...t.store.sessions.keys()].includes(cookie.value));

    const me = await t.request("/api/me", { cookie: cookie.value });
    assert.equal(me.status, 200);
    assert.deepEqual(await json(me), { user: { id: t.user.id, email: t.user.email, name: "Alice" }, workspaces: [] });
  });

  it("sets Secure when the request is https or the public URL is https", async () => {
    const t = await setup();
    const res = await t.app.request("https://cf.example.com/api/login", {
      method: "POST",
      headers: { ...CSRF, "content-type": "application/json" },
      body: JSON.stringify({ email: t.user.email, password: t.user.password }),
    });
    assert.equal(sessionCookie(res)!.attrs.secure, true);

    const behindProxy = await setup({ env: { CLOUDFRIEND_PUBLIC_URL: "https://cf.example.com" } });
    assert.equal(sessionCookie(await behindProxy.login(behindProxy.user.email, behindProxy.user.password))!.attrs.secure, true);
  });

  it("gives the same generic 401 for a wrong password and an unknown email", async () => {
    const t = await setup();
    const wrong = await t.login(t.user.email, "nope");
    const unknown = await t.login("bob@example.com", "nope");
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(await json(wrong), { error: "invalid email or password" });
    assert.deepEqual(await json(unknown), { error: "invalid email or password" });
    assert.equal(sessionCookie(wrong), undefined);
    assert.equal(t.store.sessions.size, 0);
  });

  it("rejects malformed bodies with 400", async () => {
    const t = await setup();
    assert.equal((await t.request("/api/login", { method: "POST", headers: CSRF, body: "not json" })).status, 400);
    assert.equal((await t.request("/api/login", { method: "POST", headers: CSRF, body: { email: "a@b.c" } })).status, 400);
    assert.equal((await t.request("/api/login", { method: "POST", headers: CSRF, body: null })).status, 400);
  });

  it("upgrades a weak stored hash after a successful login", async () => {
    const t = await setup();
    await t.store.setPasswordHash(t.user.id, await hashPassword(t.user.password, { logN: 10, r: 8, p: 1 }));
    assert.equal((await t.login(t.user.email, t.user.password)).status, 200);
    assert.match((await t.store.getUserById(t.user.id))!.password_hash!, /^scrypt\$15\$8\$1\$/);
  });
});

describe("login rate limiting", () => {
  it("backs off per email after repeated failures, the same for unknown emails", async () => {
    const t = await setup();
    for (const email of [t.user.email, "ghost@example.com"]) {
      for (let i = 0; i < 4; i++) assert.equal((await t.login(email, "wrong")).status, 401, `${email} attempt ${i + 1}`);
      // 3 free failures, the 4th locked the email for 1 s: even the right password is refused now.
      const limited = await t.login(email, t.user.password);
      assert.equal(limited.status, 429, email);
      assert.equal(limited.headers.get("retry-after"), "1");
      assert.deepEqual(await json(limited), { error: "too many sign-in attempts, try again later" });
    }
    // Another IP is limited too: the lock is on the email.
    assert.equal((await t.login(t.user.email, t.user.password, { "x-test-ip": "10.9.9.9" })).status, 429);

    t.clock.t += 1001;
    assert.equal((await t.login(t.user.email, "wrong")).status, 401);
    // The 5th failure doubles the lock to 2 s.
    t.clock.t += 1001;
    assert.equal((await t.login(t.user.email, t.user.password)).status, 429);
    t.clock.t += 1000;
    assert.equal((await t.login(t.user.email, t.user.password)).status, 200);
    // Success clears the email's record.
    assert.equal((await t.login(t.user.email, "wrong")).status, 401);
    assert.equal((await t.login(t.user.email, t.user.password)).status, 200);
  });

  it("backs off per IP across emails", async () => {
    const t = await setup({ limits: { ip: { free: 2, baseMs: 5000, maxMs: 60_000, forgetAfterMs: HOUR } } });
    assert.equal((await t.login("a@example.com", "x")).status, 401);
    assert.equal((await t.login("b@example.com", "x")).status, 401);
    assert.equal((await t.login("c@example.com", "x")).status, 401);
    const res = await t.login(t.user.email, t.user.password);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "5");
    assert.equal((await t.login(t.user.email, t.user.password, { "x-test-ip": "10.0.0.2" })).status, 200);
  });

  it("finds the client behind trusted proxies, and has no address for a shared or unknown peer", () => {
    assert.equal(parseTrustedProxies(""), null);
    assert.throws(() => parseTrustedProxies("10.0.0.0/33"), /not an IP address/);
    assert.throws(() => loadAuthConfig({ CLOUDFRIEND_TRUSTED_PROXIES: "proxy.local" }), (err: Error) => err instanceof AuthConfigError);
    const p = parseTrustedProxies("loopback, 10.1.0.0/16, 2001:db8::1")!;
    // Untrusted peer: itself, whatever it claims to forward.
    assert.equal(clientAddress("93.184.215.9", "151.101.1.7", p), "93.184.215.9");
    // Trusted peer: the right-most hop that isn't a trusted proxy. Hops left of it are the client's own claims.
    assert.equal(clientAddress("::ffff:127.0.0.1", "151.101.1.7", p), "151.101.1.7");
    assert.equal(clientAddress("127.0.0.1", "1.1.1.1, 151.101.1.7, 10.1.2.3", p), "151.101.1.7");
    assert.equal(clientAddress("2001:db8::1", "10.1.0.5, 10.1.0.6", p), "10.1.0.5");
    assert.equal(clientAddress("127.0.0.1", undefined, p), null);
    assert.equal(clientAddress("127.0.0.1", "garbage", p), null);
    // Not configured: a public peer is the client; a private or loopback one may be a proxy every client shares.
    assert.equal(clientAddress("93.184.215.9", "1.2.3.4", null), "93.184.215.9");
    assert.equal(clientAddress("172.17.0.1", undefined, null), null);
    assert.equal(clientAddress("::1", "1.2.3.4", null), null);
    assert.equal(clientAddress(undefined, undefined, p), null);
  });

  it("limits per client address only when there is one: a shared proxy address can't lock everyone out", async () => {
    const make = async (env: Record<string, string>) => {
      const store = new MemoryAuthStore();
      const app = new Hono();
      registerAuthRoutes(app, {
        store,
        config: loadAuthConfig(env),
        loginLimits: { ...DEFAULT_LOGIN_LIMITS, ip: { free: 2, baseMs: 5000, maxMs: 60_000, forgetAfterMs: HOUR } },
        listWorkspaces: async () => [],
      });
      await store.createUser({ id: "usr_alice", email: "alice@example.com", name: null, password_hash: await hashPassword("correct horse battery"), created_at: new Date() });
      // As @hono/node-server passes the socket.
      return (email: string, password: string, peer: string, xff?: string) =>
        app.request(
          "/api/login",
          { method: "POST", headers: { ...CSRF, "content-type": "application/json", ...(xff ? { "x-forwarded-for": xff } : {}) }, body: JSON.stringify({ email, password }) },
          { incoming: { socket: { remoteAddress: peer } } },
        );
    };

    // Behind a trusted proxy: the attacker's own address is limited, nobody else's.
    const proxied = await make({ CLOUDFRIEND_TRUSTED_PROXIES: "loopback" });
    for (const e of ["a", "b", "c"]) assert.equal((await proxied(`${e}@example.com`, "x", "127.0.0.1", "93.184.215.9")).status, 401);
    assert.equal((await proxied("alice@example.com", "correct horse battery", "127.0.0.1", "93.184.215.9")).status, 429);
    assert.equal((await proxied("d@example.com", "x", "127.0.0.1", "151.101.1.7, 93.184.215.9")).status, 429, "a forged hop doesn't escape the limit");
    assert.equal((await proxied("alice@example.com", "correct horse battery", "127.0.0.1", "151.101.1.7")).status, 200);

    // Not configured, everyone arriving from the proxy's (or Docker's) private address: per email only.
    const shared = await make({});
    for (let i = 0; i < 10; i++) assert.equal((await shared(`n${i}@example.com`, "x", "172.17.0.1", "93.184.215.9")).status, 401);
    assert.equal((await shared("alice@example.com", "correct horse battery", "172.17.0.1", "151.101.1.7")).status, 200);
    for (let i = 0; i < 6; i++) await shared("alice@example.com", "wrong", "172.17.0.1");
    assert.equal((await shared("alice@example.com", "correct horse battery", "172.17.0.1")).status, 429, "the per-email limit still applies");

    // Not configured, a public peer: it is the client.
    const direct = await make({});
    for (const e of ["a", "b", "c"]) assert.equal((await direct(`${e}@example.com`, "x", "93.184.215.9")).status, 401);
    assert.equal((await direct("alice@example.com", "correct horse battery", "93.184.215.9")).status, 429);
    assert.equal((await direct("alice@example.com", "correct horse battery", "151.101.1.7")).status, 200);
  });

  it("caps password checks in flight per email", async () => {
    const t = await setup();
    const results = await Promise.all(Array.from({ length: 6 }, () => t.login(t.user.email, "wrong")));
    const statuses = results.map((r) => r.status).sort();
    assert.ok(statuses.filter((s) => s === 401).length <= 3, `got ${statuses}`);
    assert.ok(statuses.includes(429));
  });
});

describe("sessions", () => {
  it("expire, and renew (sliding) at most once an hour", async () => {
    const t = await setup({ env: { CLOUDFRIEND_SESSION_TTL: "3h" } });
    const start = t.clock.t;
    const token = sessionCookie(await t.login(t.user.email, t.user.password))!.value;
    const hash = hashSessionToken(token);
    assert.equal(t.store.sessions.get(hash)!.expires_at.getTime(), start + 3 * HOUR);

    t.clock.t = start + 30 * 60_000;
    let res = await t.request("/api/me", { cookie: token });
    assert.equal(res.status, 200);
    assert.equal(sessionCookie(res), undefined, "no renewal within the hour");
    assert.equal(t.store.sessions.get(hash)!.expires_at.getTime(), start + 3 * HOUR);

    t.clock.t = start + HOUR + 1;
    res = await t.request("/api/me", { cookie: token });
    assert.equal(res.status, 200);
    const renewed = sessionCookie(res)!;
    assert.equal(renewed.value, token);
    assert.equal(renewed.attrs["max-age"], String(3 * 3600));
    assert.equal(t.store.sessions.get(hash)!.expires_at.getTime(), start + HOUR + 1 + 3 * HOUR);

    // Past the original expiry, still valid thanks to the renewal.
    t.clock.t = start + 3 * HOUR + 10;
    assert.equal((await t.request("/api/private", { cookie: token })).status, 200);

    // Idle past the renewed expiry: gone, and the cookie is cleared.
    t.clock.t = start + 7 * HOUR + 30 * 60_000;
    res = await t.request("/api/me", { cookie: token });
    assert.equal(res.status, 401);
    assert.deepEqual(await json(res), { error: "not signed in" });
    assert.equal(sessionCookie(res)!.attrs["max-age"], "0");
    assert.equal(t.store.sessions.has(hash), false);
  });

  it("logout deletes the session and clears the cookie", async () => {
    const t = await setup();
    const token = sessionCookie(await t.login(t.user.email, t.user.password))!.value;
    const res = await t.request("/api/logout", { method: "POST", headers: CSRF, cookie: token });
    assert.equal(res.status, 200);
    assert.deepEqual(await json(res), {});
    const cleared = sessionCookie(res)!;
    assert.equal(cleared.value, "");
    assert.equal(cleared.attrs["max-age"], "0");
    assert.equal(t.store.sessions.size, 0);
    assert.equal((await t.request("/api/me", { cookie: token })).status, 401);
    // Logging out again is harmless.
    assert.equal((await t.request("/api/logout", { method: "POST", headers: CSRF })).status, 200);
  });

  it("ignores garbage and unknown tokens", async () => {
    const t = await setup();
    assert.equal((await t.request("/api/me")).status, 401);
    assert.equal((await t.request("/api/me", { cookie: "garbage" })).status, 401);
    assert.equal((await t.request("/api/me", { cookie: "A".repeat(43) })).status, 401);
  });

  it("prunes expired sessions", async () => {
    const t = await setup({ env: { CLOUDFRIEND_SESSION_TTL: "1h" } });
    await t.login(t.user.email, t.user.password);
    t.clock.t += 2 * HOUR;
    await t.login(t.user.email, t.user.password);
    assert.equal(await t.auth.sessions.prune(), 1);
    assert.equal(t.store.sessions.size, 1);
  });
});

describe("CSRF guard", () => {
  it("rejects state-changing /api requests without the header", async () => {
    const t = await setup();
    const token = sessionCookie(await t.login(t.user.email, t.user.password))!.value;
    t.store.setMembership("ws1", t.user.id, "owner");

    const noHeader = await t.request("/api/login", { method: "POST", body: { email: t.user.email, password: t.user.password } });
    assert.equal(noHeader.status, 403);
    assert.deepEqual(await json(noHeader), { error: "missing x-cloudfriend-csrf header" });
    assert.equal((await t.request("/api/logout", { method: "POST", cookie: token })).status, 403);
    assert.equal(t.store.sessions.size, 1, "logout without the header did nothing");
    assert.equal((await t.request("/api/w/ws1/things", { method: "POST", cookie: token, headers: { "x-cloudfriend-csrf": "yes" } })).status, 403);
    for (const method of ["PATCH", "DELETE", "PUT"]) {
      assert.equal((await t.request("/api/w/ws1/things", { method, cookie: token })).status, 403, method);
    }

    assert.equal((await t.request("/api/w/ws1/things", { method: "POST", cookie: token, headers: CSRF })).status, 200);
    assert.equal((await t.request("/api/w/ws1/things", { cookie: token })).status, 200, "GET needs no header");
  });
});

describe("requireMember", () => {
  it("answers 401 signed out, 403 for non-members, 200 with the role for members", async () => {
    const t = await setup();
    t.store.setMembership("ws1", t.user.id, "member");
    t.store.setMembership("ws2", "usr_other", "owner");
    assert.equal((await t.request("/api/w/ws1/things")).status, 401);

    const token = sessionCookie(await t.login(t.user.email, t.user.password))!.value;
    const forbidden = await t.request("/api/w/ws2/things", { cookie: token });
    assert.equal(forbidden.status, 403);
    assert.deepEqual(await json(forbidden), { error: "not a member of this workspace" });
    assert.equal((await t.request("/api/w/nope/things", { cookie: token })).status, 403);

    const ok = await t.request("/api/w/ws1/things", { cookie: token });
    assert.equal(ok.status, 200);
    assert.deepEqual(await json(ok), { user: t.user.id, role: "member" });

    t.store.setMembership("ws2", t.user.id, "owner");
    assert.deepEqual(await json(await t.request("/api/w/ws2/things", { cookie: token })), { user: t.user.id, role: "owner" });
    const me = await json(await t.request("/api/me", { cookie: token }));
    assert.deepEqual(me.workspaces.map((w: any) => [w.id, w.role]).sort(), [["ws1", "member"], ["ws2", "owner"]]);
  });
});

describe("bootstrap admin", () => {
  it("generates admin@localhost with a strong password on first boot only", async () => {
    const t = await setup();
    t.store.users.clear();
    const first = await ensureBootstrapAdmin(t.store, loadAuthConfig({}));
    assert.equal(first.mode, "generated");
    assert.equal(first.email, FIRST_BOOT_ADMIN_EMAIL);
    assert.equal(first.created, true);
    assert.match(first.password!, /^[A-Za-z0-9_-]{32}$/);
    assert.match((await t.store.getUserByEmail(FIRST_BOOT_ADMIN_EMAIL))!.password_hash!, /^scrypt\$/);
    assert.ok(!JSON.stringify([...t.store.users.values()]).includes(first.password!));
    assert.equal((await t.login(FIRST_BOOT_ADMIN_EMAIL, first.password!)).status, 200);

    const again = await ensureBootstrapAdmin(t.store, loadAuthConfig({}));
    assert.equal(again.mode, "none");
    assert.equal(again.password, null);
    assert.equal(t.store.users.size, 1);
  });

  it("does nothing when users exist and no env is set", async () => {
    const t = await setup();
    assert.equal((await ensureBootstrapAdmin(t.store, loadAuthConfig({}))).mode, "none");
    assert.equal(await t.store.getUserByEmail(FIRST_BOOT_ADMIN_EMAIL), null);
  });

  it("creates the env admin and follows password changes in the env", async () => {
    const t = await setup();
    const env = { CLOUDFRIEND_ADMIN_EMAIL: "Root@Example.com", CLOUDFRIEND_ADMIN_PASSWORD: "first password 123" };
    const created = await ensureBootstrapAdmin(t.store, loadAuthConfig(env));
    assert.deepEqual({ ...created, userId: undefined }, { mode: "env", userId: undefined, email: "root@example.com", created: true, passwordUpdated: false, password: null });
    const token = sessionCookie(await t.login("root@example.com", "first password 123"))!.value;

    const same = await ensureBootstrapAdmin(t.store, loadAuthConfig(env));
    assert.equal(same.created, false);
    assert.equal(same.passwordUpdated, false);
    assert.equal((await t.request("/api/me", { cookie: token })).status, 200, "unchanged env keeps sessions");

    const changed = await ensureBootstrapAdmin(t.store, loadAuthConfig({ ...env, CLOUDFRIEND_ADMIN_PASSWORD: "second password 456" }));
    assert.equal(changed.passwordUpdated, true);
    assert.equal(changed.userId, created.userId);
    assert.equal((await t.request("/api/me", { cookie: token })).status, 401, "a new password signs the admin out everywhere");
    assert.equal((await t.login("root@example.com", "first password 123")).status, 401);
    assert.equal((await t.login("root@example.com", "second password 456")).status, 200);
  });

  it("refuses to make an account created by SSO sign-in the env admin", async () => {
    const t = await setup();
    // An SSO-only account (no password). Adopting it would give its linked identities the admin's password
    // and, at boot, the default workspace.
    await t.store.createUser({ id: "usr_sso", email: "boss@example.com", name: null, password_hash: null, created_at: new Date() });
    await assert.rejects(
      ensureBootstrapAdmin(t.store, loadAuthConfig({ CLOUDFRIEND_ADMIN_EMAIL: "boss@example.com", CLOUDFRIEND_ADMIN_PASSWORD: "a brand new password" })),
      (err: Error) => err instanceof AuthConfigError && /created by SSO sign-in/.test(err.message),
    );
    assert.equal((await t.store.getUserById("usr_sso"))!.password_hash, null);
  });

  it("sets a password on an existing user named by the env", async () => {
    const t = await setup();
    const res = await ensureBootstrapAdmin(t.store, loadAuthConfig({ CLOUDFRIEND_ADMIN_EMAIL: t.user.email, CLOUDFRIEND_ADMIN_PASSWORD: "a brand new password" }));
    assert.equal(res.userId, t.user.id);
    assert.equal(res.passwordUpdated, true);
    assert.equal((await t.login(t.user.email, "a brand new password")).status, 200);
  });
});
