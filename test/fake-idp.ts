// A minimal OIDC provider for tests (auth-oidc.test.ts, auth-pg.test.ts).
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export const CLIENT_ID = "cloudfriend-test";
export const CLIENT_SECRET = "s3cret/with+odd=chars";
export const PUBLIC_URL = "http://cf.test:8080";
export const REDIRECT_URI = `${PUBLIC_URL}/auth/oidc/callback`;

const b64u = (v: Buffer | string) => Buffer.from(v).toString("base64url");

export interface TokenTweaks {
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
export class FakeIdp {
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
