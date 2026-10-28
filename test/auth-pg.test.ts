// The auth module on Postgres (src/auth/pg-store.ts): the AuthStore contract, checked against the
// in-memory store as the reference, then sign-in, sessions, OIDC provisioning and memberships through
// the routes, and the boot wiring (setupAuth).
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { Hono } from "hono";
import { setupAuth } from "../src/api/auth-setup.ts";
import { listWorkspaces } from "../src/api/workspaces.ts";
import {
  EmailTakenError,
  FIRST_BOOT_ADMIN_EMAIL,
  hashPassword,
  IdentityTakenError,
  loadAuthConfig,
  MemoryAuthStore,
  PgAuthStore,
  registerAuthRoutes,
  SESSION_COOKIE,
  type AuthEnv,
  type AuthStore,
  type Role,
} from "../src/auth/index.ts";
import { hashSessionToken } from "../src/auth/sessions.ts";
import { DEFAULT_WORKSPACE, openDb, type DB } from "../src/db.ts";
import { CLIENT_ID, CLIENT_SECRET, FakeIdp, PUBLIC_URL } from "./fake-idp.ts";
import { freshDatabase } from "./pg.ts";
import "./helpers.ts";

const HOUR = 3600_000;
const CSRF = { "x-cloudfriend-csrf": "1" };
const pools: DB[] = [];
after(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end()));
});

async function newDb(): Promise<DB> {
  const db = await openDb(await freshDatabase(), { max: 4 });
  pools.push(db);
  return db;
}

async function addWorkspace(db: DB, id: string): Promise<void> {
  await db.query("INSERT INTO workspaces (id, name, created_at) VALUES ($1, $1, $2) ON CONFLICT DO NOTHING", [id, Date.now()]);
}

/** Both stores, with a way to set memberships (written by the workspaces code, not the AuthStore). */
const stores: { name: string; make(): Promise<{ store: AuthStore; member(ws: string, user: string, role: Role): Promise<void> }> }[] = [
  {
    name: "MemoryAuthStore",
    async make() {
      const store = new MemoryAuthStore();
      return { store, member: async (ws, user, role) => store.setMembership(ws, user, role) };
    },
  },
  {
    name: "PgAuthStore",
    async make() {
      const db = await newDb();
      return {
        store: new PgAuthStore(db),
        async member(ws, user, role) {
          await addWorkspace(db, ws);
          await db.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)", [ws, user, role]);
        },
      };
    },
  },
];

const user = (id: string, email: string, password_hash: string | null = null) => ({ id, email, name: null, password_hash, created_at: new Date("2026-10-27T12:00:00Z") });

for (const { name, make } of stores) {
  describe(`AuthStore contract: ${name}`, () => {
    it("creates and finds users, and refuses a taken email", async () => {
      const { store } = await make();
      assert.equal(await store.countUsers(), 0);
      await store.createUser(user("usr_a", "a@example.com", "scrypt$x"));
      assert.equal(await store.countUsers(), 1);
      const a = (await store.getUserByEmail("a@example.com"))!;
      assert.deepEqual({ ...a }, user("usr_a", "a@example.com", "scrypt$x"));
      assert.deepEqual(await store.getUserById("usr_a"), a);
      assert.equal(await store.getUserById("usr_nope"), null);
      await assert.rejects(store.createUser(user("usr_b", "a@example.com")), EmailTakenError);
      await store.setPasswordHash("usr_a", null);
      assert.equal((await store.getUserById("usr_a"))!.password_hash, null);
    });

    it("links identities, and creates a user with an identity all or nothing", async () => {
      const { store } = await make();
      const idn = (sub: string, uid: string) => ({ issuer: "https://idp", subject: sub, user_id: uid, email: null, created_at: new Date() });
      await store.createUser(user("usr_a", "a@example.com"), idn("1", "usr_a"));
      assert.equal((await store.findUserByIdentity("https://idp", "1"))!.id, "usr_a");
      assert.equal(await store.findUserByIdentity("https://other", "1"), null);
      // The identity is taken: neither the user nor the identity is written.
      await assert.rejects(store.createUser(user("usr_b", "b@example.com"), idn("1", "usr_b")), IdentityTakenError);
      assert.equal(await store.getUserByEmail("b@example.com"), null);
      await assert.rejects(store.addIdentity(idn("1", "usr_a")), IdentityTakenError);
      await store.addIdentity(idn("2", "usr_a"));
      assert.equal((await store.findUserByIdentity("https://idp", "2"))!.id, "usr_a");
    });

    it("stores, renews and deletes sessions", async () => {
      const { store } = await make();
      await store.createUser(user("usr_a", "a@example.com"));
      const t0 = new Date("2026-10-27T12:00:00Z");
      const at = (h: number) => new Date(t0.getTime() + h * HOUR);
      await store.createSession({ token_hash: "h1", user_id: "usr_a", created_at: t0, expires_at: at(1), renewed_at: t0 });
      await store.createSession({ token_hash: "h2", user_id: "usr_a", created_at: t0, expires_at: at(5), renewed_at: t0 });
      const got = (await store.getSession("h1"))!;
      assert.equal(got.user.email, "a@example.com");
      assert.equal(got.session.expires_at.getTime(), at(1).getTime());
      await store.renewSession("h1", at(3), at(1));
      assert.equal((await store.getSession("h1"))!.session.expires_at.getTime(), at(3).getTime());
      assert.equal((await store.getSession("h1"))!.session.renewed_at.getTime(), at(1).getTime());
      assert.equal(await store.deleteExpiredSessions(at(4)), 1);
      assert.equal(await store.getSession("h1"), null);
      await store.deleteSession("h2");
      assert.equal(await store.getSession("h2"), null);
      await store.createSession({ token_hash: "h3", user_id: "usr_a", created_at: t0, expires_at: at(5), renewed_at: t0 });
      await store.deleteUserSessions("usr_a");
      assert.equal(await store.getSession("h3"), null);
    });

    it("reports memberships per workspace", async () => {
      const { store, member } = await make();
      await store.createUser(user("usr_a", "a@example.com"));
      await member("ws_1", "usr_a", "owner");
      assert.equal(await store.getMembership("ws_1", "usr_a"), "owner");
      assert.equal(await store.getMembership("ws_2", "usr_a"), null);
      assert.equal(await store.getMembership("ws_1", "usr_b"), null);
    });
  });
}

/** registerAuthRoutes on Postgres, with a controllable clock. */
async function pgApp(env: Record<string, string> = {}) {
  const db = await newDb();
  const store = new PgAuthStore(db);
  const clock = { t: Date.parse("2026-10-27T12:00:00Z") };
  const app = new Hono();
  const auth = registerAuthRoutes(app, { store, config: loadAuthConfig(env), now: () => clock.t, listWorkspaces: (id) => listWorkspaces(db, id) });
  const scoped = new Hono<AuthEnv>();
  scoped.get("/things", (c) => c.json({ role: c.get("role") }));
  app.use("/api/w/:ws/*", auth.requireMember((c) => c.req.param("ws")));
  app.route("/api/w/:ws", scoped);
  const alice = { id: "usr_alice", email: "alice@example.com", password: "correct horse battery" };
  await store.createUser({ ...user(alice.id, alice.email, await hashPassword(alice.password)), name: "Alice" });
  const req = (path: string, init: { method?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    app.request(path, {
      method: init.method ?? "GET",
      headers: {
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.cookie ? { cookie: `${SESSION_COOKIE}=${init.cookie}` } : {}),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  const login = async (email = alice.email, password = alice.password) => {
    const res = await req("/api/login", { method: "POST", headers: CSRF, body: { email, password } });
    const set = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    return { res, token: set?.split(";")[0]!.slice(SESSION_COOKIE.length + 1) };
  };
  return { db, store, clock, auth, alice, req, login };
}

describe("auth routes on Postgres", () => {
  it("signs in with a password, lists workspaces, and stores only the token's hash", async () => {
    const t = await pgApp();
    assert.equal((await t.login(t.alice.email, "wrong password")).res.status, 401);
    const { res, token } = await t.login(" Alice@Example.com ", t.alice.password);
    assert.equal(res.status, 200);
    assert.ok(token);
    const rows = (await t.db.query("SELECT token_hash FROM sessions")).rows;
    assert.deepEqual(rows, [{ token_hash: hashSessionToken(token!) }]);

    await addWorkspace(t.db, "ws_a");
    await t.db.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws_a', $1, 'member')", [t.alice.id]);
    const me = (await (await t.req("/api/me", { cookie: token })).json()) as any;
    assert.deepEqual(me, { user: { id: t.alice.id, email: t.alice.email, name: "Alice" }, workspaces: [{ id: "ws_a", name: "ws_a", role: "member" }] });
  });

  it("expires idle sessions, renews active ones, and logs out", async () => {
    const t = await pgApp({ CLOUDFRIEND_SESSION_TTL: "3h" });
    const start = t.clock.t;
    const { token } = await t.login();
    const expires = async () => ((await t.db.query("SELECT expires_at FROM sessions")).rows[0]?.expires_at as Date | undefined)?.getTime();
    assert.equal(await expires(), start + 3 * HOUR);
    t.clock.t = start + HOUR + 1;
    assert.equal((await t.req("/api/me", { cookie: token })).status, 200);
    assert.equal(await expires(), start + HOUR + 1 + 3 * HOUR);
    t.clock.t = start + 8 * HOUR;
    assert.equal((await t.req("/api/me", { cookie: token })).status, 401);
    assert.equal(await expires(), undefined, "the expired session was deleted");

    const second = await t.login();
    assert.equal((await t.req("/api/logout", { method: "POST", headers: CSRF, cookie: second.token })).status, 200);
    assert.equal((await t.req("/api/me", { cookie: second.token })).status, 401);
    assert.equal((await t.db.query("SELECT count(*) AS n FROM sessions")).rows[0].n, 0);

    await t.login();
    t.clock.t += 4 * HOUR;
    await t.login();
    assert.equal(await t.auth.sessions.prune(), 1);
  });

  it("checks workspace membership: 401 signed out, 403 for other workspaces", async () => {
    const t = await pgApp();
    await addWorkspace(t.db, "ws_a");
    await addWorkspace(t.db, "ws_b");
    await t.db.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws_a', $1, 'owner')", [t.alice.id]);
    const { token } = await t.login();
    assert.equal((await t.req("/api/w/ws_a/things")).status, 401);
    assert.deepEqual(await (await t.req("/api/w/ws_a/things", { cookie: token })).json(), { role: "owner" });
    assert.equal((await t.req("/api/w/ws_b/things", { cookie: token })).status, 403);
    assert.equal((await t.req("/api/w/ws_nope/things", { cookie: token })).status, 403);
  });
});

describe("OIDC sign-in on Postgres", () => {
  const idp = new FakeIdp();
  before(() => idp.start());
  after(() => idp.stop());
  beforeEach(() => {
    idp.next = {};
  });

  async function oidcApp() {
    const db = await newDb();
    const store = new PgAuthStore(db);
    const app = new Hono();
    const config = loadAuthConfig({
      CLOUDFRIEND_PUBLIC_URL: PUBLIC_URL,
      CLOUDFRIEND_OIDC_ISSUER: idp.issuer,
      CLOUDFRIEND_OIDC_CLIENT_ID: CLIENT_ID,
      CLOUDFRIEND_OIDC_CLIENT_SECRET: CLIENT_SECRET,
    });
    registerAuthRoutes(app, { store, config, listWorkspaces: (id) => listWorkspaces(db, id) });
    async function signIn() {
      const start = await app.request(`${PUBLIC_URL}/auth/oidc/login`);
      const tx = start.headers.getSetCookie().find((c) => c.startsWith("cf_oidc="))!.split(";")[0]!;
      const approved = await fetch(start.headers.get("location")!, { redirect: "manual" });
      const res = await app.request(approved.headers.get("location")!, { headers: { cookie: tx } });
      const token = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(";")[0]!.slice(SESSION_COOKIE.length + 1);
      return { res, token };
    }
    const me = async (token: string) => (await app.request("/api/me", { headers: { cookie: `${SESSION_COOKIE}=${token}` } })).json() as Promise<any>;
    return { db, store, signIn, me };
  }

  it("provisions a user on first sign-in and matches by (issuer, sub) after", async () => {
    const t = await oidcApp();
    const first = await t.signIn();
    assert.equal(first.res.status, 302);
    assert.equal(first.res.headers.get("location"), "/");
    const body = await t.me(first.token!);
    assert.equal(body.user.email, "jo@example.com");
    const ids = (await t.db.query("SELECT issuer, subject, user_id FROM user_identities")).rows;
    assert.deepEqual(ids, [{ issuer: idp.issuer, subject: "google-oauth2|1001", user_id: body.user.id }]);
    assert.equal((await t.db.query("SELECT password_hash FROM users")).rows[0].password_hash, null);

    // Same subject, new email at the provider: the same user.
    idp.next = { email: "jo.new@example.com" };
    const again = await t.signIn();
    assert.equal((await t.me(again.token!)).user.id, body.user.id);
    assert.equal((await t.db.query("SELECT count(*) AS n FROM users")).rows[0].n, 1);
  });

  it("links to an existing account only when the provider verified the email", async () => {
    const t = await oidcApp();
    await t.store.createUser(user("usr_admin", "jo@example.com", await hashPassword("password password")));
    idp.next = { email_verified: false };
    const refused = await t.signIn();
    assert.equal(refused.res.headers.get("location"), "/?auth_error=sso_unverified");
    assert.equal((await t.db.query("SELECT count(*) AS n FROM user_identities")).rows[0].n, 0);
    idp.next = {};
    const linked = await t.signIn();
    assert.equal((await t.me(linked.token!)).user.id, "usr_admin");
    assert.equal((await t.db.query("SELECT count(*) AS n FROM users")).rows[0].n, 1);
  });
});

describe("setupAuth (boot)", () => {
  const owners = async (db: DB) =>
    (await db.query("SELECT u.email, m.role FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1", [DEFAULT_WORKSPACE])).rows;

  it("generates the first admin once and makes it owner of the default workspace", async () => {
    const db = await newDb();
    const first = await setupAuth(db, {});
    first.stop();
    assert.equal(first.bootstrap.email, FIRST_BOOT_ADMIN_EMAIL);
    assert.ok(first.generatedPassword && first.generatedPassword.length >= 16);
    assert.deepEqual(await owners(db), [{ email: FIRST_BOOT_ADMIN_EMAIL, role: "owner" }]);
    const second = await setupAuth(db, {});
    second.stop();
    assert.equal(second.generatedPassword, null);
    assert.deepEqual(await owners(db), [{ email: FIRST_BOOT_ADMIN_EMAIL, role: "owner" }]);
  });

  it("uses CLOUDFRIEND_ADMIN_*, and leaves an existing owner alone", async () => {
    const db = await newDb();
    const env = { CLOUDFRIEND_ADMIN_EMAIL: "Ops@Example.com", CLOUDFRIEND_ADMIN_PASSWORD: "a long admin password" };
    const a = await setupAuth(db, env);
    a.stop();
    assert.equal(a.generatedPassword, null);
    assert.deepEqual(await owners(db), [{ email: "ops@example.com", role: "owner" }]);
    // A different admin later: created, but ws_default already has its owner.
    const b = await setupAuth(db, { ...env, CLOUDFRIEND_ADMIN_EMAIL: "new@example.com" });
    b.stop();
    assert.deepEqual(await owners(db), [{ email: "ops@example.com", role: "owner" }]);
  });

  it("fails boot rather than make an account created by SSO sign-in the admin and owner", async () => {
    const db = await newDb();
    const store = new PgAuthStore(db);
    await store.createUser(user("usr_sso", "ops@example.com"), { issuer: "https://idp.example.com", subject: "s1", user_id: "usr_sso", email: "ops@example.com", created_at: new Date() });
    await assert.rejects(setupAuth(db, { CLOUDFRIEND_ADMIN_EMAIL: "ops@example.com", CLOUDFRIEND_ADMIN_PASSWORD: "a long admin password" }), /created by SSO sign-in/);
    assert.deepEqual(await owners(db), []);
    assert.equal((await store.getUserById("usr_sso"))!.password_hash, null);
  });

  it("fails fast on bad settings, and prunes expired sessions at boot", async () => {
    const db = await newDb();
    await assert.rejects(setupAuth(db, { CLOUDFRIEND_OIDC_ISSUER: "https://idp.example.com" }), /half-configured/);
    const s = await setupAuth(db, {});
    s.stop();
    await s.store.createSession({ token_hash: "old", user_id: s.bootstrap.userId!, created_at: new Date(0), expires_at: new Date(1000), renewed_at: new Date(0) });
    const again = await setupAuth(db, {});
    again.stop();
    assert.equal(await s.store.getSession("old"), null);
  });
});
