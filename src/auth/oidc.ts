import * as oauth from "oauth4webapi";
import type { OidcConfig } from "./config.ts";

// Authorization code flow with PKCE (S256), state and nonce, using oauth4webapi for discovery, the token
// request and ID token validation (iss, aud, azp, exp/iat with 30 s tolerance, nonce), plus an explicit
// JWKS signature check. Nothing here touches storage; routes.ts maps the claims to a user.

/** What must survive the round trip through the provider. Kept in a short-lived HttpOnly cookie. */
export interface OidcTransaction {
  state: string;
  nonce: string;
  verifier: string;
  /** ms since epoch, to expire stale transactions. */
  createdAt: number;
}

export interface OidcClaims {
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

/** A failure the user should see as "access denied" rather than "something broke". */
export class OidcDeniedError extends Error {}

const TIMEOUT_MS = 10_000;
const DISCOVERY_TTL_MS = 6 * 3600_000;

export class OidcProvider {
  readonly #config: OidcConfig;
  readonly #client: oauth.Client;
  #as: { at: number; value: Promise<oauth.AuthorizationServer> } | null = null;
  #clientAuth: oauth.ClientAuth | null = null;

  constructor(config: OidcConfig) {
    this.#config = config;
    this.#client = { client_id: config.clientId };
  }

  get label(): string {
    return this.#config.label;
  }

  #http() {
    return { signal: () => AbortSignal.timeout(TIMEOUT_MS), [oauth.allowInsecureRequests]: this.#config.allowInsecure };
  }

  /** Discovery is cached (and retried on the next request if it failed). Keys are cached by oauth4webapi per AS object. */
  authorizationServer(now = Date.now()): Promise<oauth.AuthorizationServer> {
    if (!this.#as || now - this.#as.at > DISCOVERY_TTL_MS) {
      const value = this.#discover();
      value.catch(() => {
        if (this.#as?.value === value) this.#as = null;
      });
      this.#as = { at: now, value };
    }
    return this.#as.value;
  }

  async #discover(): Promise<oauth.AuthorizationServer> {
    const configured = this.#config.issuer;
    const response = await oauth.discoveryRequest(configured, { algorithm: "oidc", ...this.#http() });
    // Auth0 issuers end in "/", others don't; accept the issuer as the provider spells it when it differs
    // from the configured one only by a trailing slash. The ID token's iss is checked against that value.
    let expected = configured;
    try {
      const doc = (await response.clone().json()) as { issuer?: unknown };
      if (typeof doc.issuer === "string" && doc.issuer.replace(/\/+$/, "") === configured.href.replace(/\/+$/, "")) {
        expected = new URL(doc.issuer);
      }
    } catch {
      // processDiscoveryResponse reports the real problem.
    }
    const as = await oauth.processDiscoveryResponse(expected, response);
    if (!as.authorization_endpoint || !as.token_endpoint || !as.jwks_uri) {
      throw new Error("OIDC discovery document lacks authorization_endpoint, token_endpoint or jwks_uri");
    }
    const methods = as.token_endpoint_auth_methods_supported;
    this.#clientAuth =
      !methods || methods.includes("client_secret_basic")
        ? oauth.ClientSecretBasic(this.#config.clientSecret)
        : methods.includes("client_secret_post")
          ? oauth.ClientSecretPost(this.#config.clientSecret)
          : (() => {
              throw new Error(`OIDC provider supports neither client_secret_basic nor client_secret_post (${methods.join(", ")})`);
            })();
    return as;
  }

  /** Builds the provider URL to redirect to, and the transaction to remember until the callback. */
  async start(now = Date.now()): Promise<{ url: URL; tx: OidcTransaction }> {
    const as = await this.authorizationServer(now);
    const tx: OidcTransaction = {
      state: oauth.generateRandomState(),
      nonce: oauth.generateRandomNonce(),
      verifier: oauth.generateRandomCodeVerifier(),
      createdAt: now,
    };
    const url = new URL(as.authorization_endpoint!);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.#config.clientId);
    url.searchParams.set("redirect_uri", this.#config.redirectUri);
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", tx.state);
    url.searchParams.set("nonce", tx.nonce);
    url.searchParams.set("code_challenge", await oauth.calculatePKCECodeChallenge(tx.verifier));
    url.searchParams.set("code_challenge_method", "S256");
    return { url, tx };
  }

  /** Validates the callback, redeems the code and verifies the ID token. Throws on any mismatch. */
  async finish(callbackParams: URLSearchParams, tx: OidcTransaction): Promise<OidcClaims> {
    const as = await this.authorizationServer();
    // Checks state (and iss when the provider advertises RFC 9207), and turns ?error= into an exception.
    const params = oauth.validateAuthResponse(as, this.#client, callbackParams, tx.state);
    const response = await oauth.authorizationCodeGrantRequest(as, this.#client, this.#clientAuth!, params, this.#config.redirectUri, tx.verifier, this.#http());
    const result = await oauth.processAuthorizationCodeResponse(as, this.#client, response, {
      expectedNonce: tx.nonce,
      requireIdToken: true,
    });
    // oauth4webapi trusts the TLS channel for code-flow ID tokens by default; verify the signature against the JWKS too.
    await oauth.validateApplicationLevelSignature(as, response, this.#http());
    const claims = oauth.getValidatedIdTokenClaims(result);
    if (!claims) throw new Error("token response has no ID token");

    const email = typeof claims.email === "string" && claims.email.includes("@") ? claims.email.trim().toLowerCase() : null;
    const emailVerified = claims.email_verified === true || claims.email_verified === "true";
    const name =
      typeof claims.name === "string" && claims.name.trim()
        ? claims.name.trim()
        : [claims.given_name, claims.family_name].filter((x) => typeof x === "string" && x).join(" ") || null;

    const domains = this.#config.allowedDomains;
    if (domains) {
      if (!email) throw new OidcDeniedError("no email in ID token");
      if (!emailVerified) throw new OidcDeniedError(`email ${email} is not verified by the provider`);
      const domain = email.slice(email.lastIndexOf("@") + 1);
      if (!domains.includes(domain)) throw new OidcDeniedError(`email domain ${domain} is not allowed`);
    }
    return { issuer: claims.iss, subject: claims.sub, email, emailVerified, name };
  }
}
