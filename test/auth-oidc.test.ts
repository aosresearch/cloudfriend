import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { Hono } from "hono";
import { hashPassword, loadAuthConfig, MemoryAuthStore, registerAuthRoutes, SESSION_COOKIE } from "../src/auth/index.ts";
import { OIDC_TX_COOKIE } from "../src/auth/routes.ts";
import { CLIENT_ID, CLIENT_SECRET, FakeIdp, PUBLIC_URL, REDIRECT_URI } from "./fake-idp.ts";

process.env.CLOUDFRIEND_LOG ??= "silent";

const idp = new FakeIdp();
before(() => idp.start());
after(() => idp.stop());
beforeEach(() => {
  idp.next = {};
});

function setup(extraEnv: Record<string, string> = {}) {
  const store = new MemoryAuthStore();
  const app = new Hono();
  const config = loadAuthConfig({
    CLOUDFRIEND_PUBLIC_URL: PUBLIC_URL,
    CLOUDFRIEND_OIDC_ISSUER: idp.issuer,
    CLOUDFRIEND_OIDC_CLIENT_ID: CLIENT_ID,
    CLOUDFRIEND_OIDC_CLIENT_SECRET: CLIENT_SECRET,
    ...extraEnv,
  });
  registerAuthRoutes(app, { store, config, listWorkspaces: async () => [] });

  /** Starts sign-in on the app, lets the fake provider approve it, and returns what the callback needs. */
  async function authorize() {
    const res = await app.request(`${PUBLIC_URL}/auth/oidc/login`);
    assert.equal(res.status, 302);
    const providerUrl = new URL(res.headers.get("location")!);
    const tx = res.headers.getSetCookie().find((c) => c.startsWith(`${OIDC_TX_COOKIE}=`))!;
    assert.match(tx, /HttpOnly/);
    assert.match(tx, /SameSite=Lax/);
    assert.match(tx, /Path=\/auth\/oidc/);
    const approved = await fetch(providerUrl, { redirect: "manual" });
    assert.equal(approved.status, 302, await approved.clone().text());
    const callback = new URL(approved.headers.get("location")!);
    return { providerUrl, callback, txCookie: tx.split(";")[0]! };
  }

  async function callback(url: URL, txCookie: string | null) {
    assert.equal(url.origin + url.pathname, REDIRECT_URI);
    return app.request(url.href, { headers: txCookie ? { cookie: txCookie } : {} });
  }

  async function signIn() {
    const { callback: url, txCookie } = await authorize();
    return callback(url, txCookie);
  }

  const session = (res: Response) =>
    res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(";")[0]!.slice(SESSION_COOKIE.length + 1);
  const me = async (token: string) => (await app.request("/api/me", { headers: { cookie: `${SESSION_COOKIE}=${token}` } })).json() as Promise<any>;

  return { app, store, authorize, callback, signIn, session, me };
}

const failedWith = (res: Response, code: string) => {
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `/?auth_error=${code}`);
  assert.ok(!res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`)));
};

describe("OIDC sign-in", () => {
  it("advertises SSO in auth-config with the label", async () => {
    const t = setup({ CLOUDFRIEND_OIDC_LABEL: "Sign in with Google" });
    assert.deepEqual(await (await t.app.request("/api/auth-config")).json(), { password: true, oidc: true, oidcLabel: "Sign in with Google" });
  });

  it("runs the code flow with PKCE, state and nonce, provisions the user, and matches by (issuer, sub) after", async () => {
    const t = setup();
    const { providerUrl, callback, txCookie } = await t.authorize();
    const q = providerUrl.searchParams;
    assert.equal(providerUrl.origin + providerUrl.pathname, `${idp.issuer}/authorize`);
    assert.equal(q.get("client_id"), CLIENT_ID);
    assert.equal(q.get("redirect_uri"), REDIRECT_URI);
    assert.equal(q.get("scope"), "openid email profile");
    assert.equal(q.get("code_challenge_method"), "S256");
    assert.ok(q.get("state") && q.get("nonce") && q.get("code_challenge"));

    const res = await t.callback(callback, txCookie);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/");
    const clearedTx = res.headers.getSetCookie().find((c) => c.startsWith(`${OIDC_TX_COOKIE}=`))!;
    assert.match(clearedTx, /Max-Age=0/);
    const token = t.session(res)!;
    assert.ok(token);
    const body = await t.me(token);
    assert.equal(body.user.email, "jo@example.com");
    assert.equal(body.user.name, "Jo Example");
    assert.equal(t.store.users.size, 1);
    assert.deepEqual([...t.store.identities.values()].map((i) => [i.issuer, i.subject, i.user_id]), [[idp.issuer, "google-oauth2|1001", body.user.id]]);
    assert.equal(t.store.users.get(body.user.id)!.password_hash, null);
    // The token request authenticated with the client secret and sent the PKCE verifier.
    const form = idp.tokenRequests.at(-1)!;
    assert.ok(form.get("code_verifier"));
    assert.equal(form.get("redirect_uri"), REDIRECT_URI);

    // Second sign-in: same user, even if the provider now reports another email.
    idp.next = { email: "jo.renamed@example.com" };
    const again = await t.signIn();
    assert.equal((await t.me(t.session(again)!)).user.id, body.user.id);
    assert.equal(t.store.users.size, 1);

    // Same email but another subject is a different identity, and not verified: refused, not merged.
    idp.next = { sub: "auth0|other", email: "jo@example.com", email_verified: false };
    failedWith(await t.signIn(), "sso_unverified");
    assert.equal(t.store.users.size, 1);
  });

  it("rejects a callback whose state does not match", async () => {
    const t = setup();
    const { callback, txCookie } = await t.authorize();
    callback.searchParams.set("state", "forged");
    failedWith(await t.callback(callback, txCookie), "sso_failed");
    assert.equal(t.store.users.size, 0);
  });

  it("rejects a callback without the transaction cookie (login CSRF)", async () => {
    const t = setup();
    const { callback } = await t.authorize();
    failedWith(await t.callback(callback, null), "sso_failed");
    // And with another browser's transaction.
    const other = await t.authorize();
    const mine = await t.authorize();
    failedWith(await t.callback(mine.callback, other.txCookie), "sso_failed");
  });

  it("rejects an ID token with the wrong nonce", async () => {
    const t = setup();
    idp.next = { nonce: "replayed-nonce" };
    failedWith(await t.signIn(), "sso_failed");
    assert.equal(t.store.users.size, 0);
  });

  it("rejects an ID token for another audience", async () => {
    const t = setup();
    idp.next = { aud: "some-other-client" };
    failedWith(await t.signIn(), "sso_failed");
    idp.next = { aud: [CLIENT_ID, "some-other-client"] }; // extra audience without azp
    failedWith(await t.signIn(), "sso_failed");
    assert.equal(t.store.users.size, 0);
  });

  it("rejects an ID token from another issuer, expired, or with a bad signature", async () => {
    const t = setup();
    for (const tweaks of [{ iss: "https://evil.example.com/" }, { exp: Math.floor(Date.now() / 1000) - 3600 }, { wrongKey: true }] as const) {
      idp.next = tweaks;
      failedWith(await t.signIn(), "sso_failed");
    }
    assert.equal(t.store.users.size, 0);
  });

  it("restricts email domains and then requires a verified email", async () => {
    const t = setup({ CLOUDFRIEND_OIDC_ALLOWED_DOMAINS: "example.com,corp.example.org" });
    idp.next = { sub: "u1", email: "mallory@gmail.com" };
    failedWith(await t.signIn(), "sso_denied");
    idp.next = { sub: "u2", email: "jo@example.com", email_verified: false };
    failedWith(await t.signIn(), "sso_denied");
    idp.next = { sub: "u3", email: null };
    failedWith(await t.signIn(), "sso_denied");
    idp.next = { sub: "u4", email: "jo@mail.example.com" }; // subdomains are not included
    failedWith(await t.signIn(), "sso_denied");
    assert.equal(t.store.users.size, 0);

    idp.next = { sub: "u5", email: "Ada@Corp.Example.org" };
    const ok = await t.signIn();
    assert.equal(ok.headers.get("location"), "/");
    assert.equal((await t.me(t.session(ok)!)).user.email, "ada@corp.example.org");
  });

  it("links to an existing account with the same email only when the provider verified it", async () => {
    const t = setup();
    await t.store.createUser({ id: "usr_admin", email: "jo@example.com", name: "Jo", password_hash: await hashPassword("password password"), created_at: new Date() });

    idp.next = { sub: "s1", email_verified: false };
    failedWith(await t.signIn(), "sso_unverified");
    assert.equal(t.store.identities.size, 0);

    idp.next = { sub: "s1", email_verified: true };
    const ok = await t.signIn();
    assert.equal((await t.me(t.session(ok)!)).user.id, "usr_admin");
    assert.equal(t.store.users.size, 1);
    assert.equal(t.store.identities.size, 1);
  });

  it("refuses a first sign-in with an unverified email, so it can't claim the address for a later verified sign-in", async () => {
    const t = setup();
    // Pre-account hijack: an unverified identity must not create the account for victim@example.com
    // that the victim's verified identity would later be linked to.
    idp.next = { sub: "attacker-sub", email: "victim@example.com", email_verified: false };
    failedWith(await t.signIn(), "sso_unverified");
    assert.equal(t.store.users.size, 0);
    assert.equal(t.store.identities.size, 0);

    idp.next = { sub: "victim-sub", email: "victim@example.com", email_verified: true };
    const victim = await t.signIn();
    const me = await t.me(t.session(victim)!);
    assert.equal(me.user.email, "victim@example.com");
    assert.deepEqual([...t.store.identities.values()].map((i) => [i.subject, i.user_id]), [["victim-sub", me.user.id]]);

    // An identity that is already linked keeps signing in, whatever the provider now says about the email.
    idp.next = { sub: "victim-sub", email: "victim@example.com", email_verified: false };
    assert.equal((await t.me(t.session(await t.signIn())!)).user.id, me.user.id);
  });

  it("turns a provider error on the callback into a failed sign-in", async () => {
    const t = setup();
    const { callback, txCookie } = await t.authorize();
    const denied = new URL(REDIRECT_URI);
    denied.searchParams.set("error", "access_denied");
    denied.searchParams.set("state", callback.searchParams.get("state")!);
    failedWith(await t.callback(denied, txCookie), "sso_failed");
  });
});
