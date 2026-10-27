import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { Hono } from "hono";
import { hashPassword, loadAuthConfig, MemoryAuthStore, registerAuthRoutes, SESSION_COOKIE } from "../src/auth/index.ts";
import { OIDC_TX_COOKIE } from "../src/auth/routes.ts";

process.env.CLOUDFRIEND_LOG ??= "silent";

const CLIENT_ID = "cloudfriend-test";
const CLIENT_SECRET = "s3cret/with+odd=chars";
const PUBLIC_URL = "http://cf.test:8080";
const REDIRECT_URI = `${PUBLIC_URL}/auth/oidc/callback`;

const b64u = (v: Buffer | string) => Buffer.from(v).toString("base64url");

interface TokenTweaks {
  sub?: string;
  email?: string | null;
  email_verified?: boolean | string;
  name?: string;
  nonce?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
  /** Sign with a key that is not in the JWKS (same kid). */
  wrongKey?: boolean;
}

/** A minimal OIDC provider: discovery, authorize (auto-approves), token (checks client auth and PKCE), JWKS. */
class FakeIdp {
  server!: http.Server;
  issuer = "";
  readonly kid = "test-key-1";
  readonly key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  readonly otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  /** Claims for the next authorization. */
  next: TokenTweaks = {};
  readonly codes = new Map<string, { clientId: string; redirectUri: string; nonce: string; challenge: string; tweaks: TokenTweaks }>();
  readonly tokenRequests: URLSearchParams[] = [];

  async start() {
    this.server = http.createServer((req, res) => this.handle(req, res).catch((err) => {
      res.writeHead(500).end(String(err));
    }));
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop() {
    return new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url!, this.issuer);
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

    if (url.pathname === "/.well-known/openid-configuration") {
      return send(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/oauth/token`,
        jwks_uri: `${this.issuer}/.well-known/jwks.json`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/.well-known/jwks.json") {
      return send(200, { keys: [{ ...this.key.publicKey.export({ format: "jwk" }), kid: this.kid, alg: "RS256", use: "sig" }] });
    }
    if (url.pathname === "/authorize") {
      const q = url.searchParams;
      if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge") || !q.get("nonce")) {
        return send(400, { error: "invalid_request" });
      }
      if (!q.get("scope")?.split(" ").includes("openid")) return send(400, { error: "invalid_scope" });
      const code = randomBytes(16).toString("hex");
      this.codes.set(code, { clientId: q.get("client_id")!, redirectUri: q.get("redirect_uri")!, nonce: q.get("nonce")!, challenge: q.get("code_challenge")!, tweaks: this.next });
      const back = new URL(q.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state")!);
      res.writeHead(302, { location: back.href }).end();
      return;
    }
    if (url.pathname === "/oauth/token" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      this.tokenRequests.push(form);
      const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
      const [id, secret] = basic
        ? Buffer.from(basic[1]!, "base64").toString().split(":").map((s) => decodeURIComponent(s.replace(/\+/g, "%20")))
        : [form.get("client_id"), form.get("client_secret")];
      if (id !== CLIENT_ID || secret !== CLIENT_SECRET) return send(401, { error: "invalid_client" });
      const grant = this.codes.get(form.get("code") ?? "");
      this.codes.delete(form.get("code") ?? "");
      if (!grant || form.get("grant_type") !== "authorization_code" || form.get("redirect_uri") !== grant.redirectUri) {
        return send(400, { error: "invalid_grant" });
      }
      const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
      if (challenge !== grant.challenge) return send(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      return send(200, { access_token: "at_" + randomBytes(8).toString("hex"), token_type: "Bearer", expires_in: 3600, id_token: this.idToken(grant.nonce, grant.tweaks) });
    }
    send(404, { error: "not found" });
  }

  idToken(nonce: string, t: TokenTweaks): string {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: t.iss ?? this.issuer,
      sub: t.sub ?? "google-oauth2|1001",
      aud: t.aud ?? CLIENT_ID,
      iat: now,
      exp: t.exp ?? now + 600,
      nonce: t.nonce ?? nonce,
      email: t.email === undefined ? "jo@example.com" : t.email,
      email_verified: t.email_verified ?? true,
      name: t.name ?? "Jo Example",
    };
    if (claims.email === null) delete claims.email;
    const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: this.kid }));
    const body = b64u(JSON.stringify(claims));
    const key: KeyObject = t.wrongKey ? this.otherKey.privateKey : this.key.privateKey;
    return `${head}.${body}.${b64u(sign("sha256", Buffer.from(`${head}.${body}`), key))}`;
  }
}

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
    failedWith(await t.signIn(), "sso_denied");
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
    failedWith(await t.signIn(), "sso_denied");
    assert.equal(t.store.identities.size, 0);

    idp.next = { sub: "s1", email_verified: true };
    const ok = await t.signIn();
    assert.equal((await t.me(t.session(ok)!)).user.id, "usr_admin");
    assert.equal(t.store.users.size, 1);
    assert.equal(t.store.identities.size, 1);
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
