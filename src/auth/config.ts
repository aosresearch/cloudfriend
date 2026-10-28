import { parseDuration } from "../config.ts";
import { parseTrustedProxies, TrustedProxiesError, type TrustedProxies } from "./client-ip.ts";

export interface OidcConfig {
  issuer: URL;
  clientId: string;
  clientSecret: string;
  /** `CLOUDFRIEND_PUBLIC_URL` + `/auth/oidc/callback`. Register exactly this at the provider. */
  redirectUri: string;
  /** Lowercased email domains allowed to sign in, or null for any. */
  allowedDomains: string[] | null;
  label: string;
  /** Plain http is accepted only for a loopback issuer (local development and tests). */
  allowInsecure: boolean;
}

export interface AuthConfig {
  /** `CLOUDFRIEND_PUBLIC_URL` without a trailing slash, or null. */
  publicUrl: URL | null;
  /** From `CLOUDFRIEND_ADMIN_EMAIL` + `CLOUDFRIEND_ADMIN_PASSWORD`, or null. */
  bootstrapAdmin: { email: string; password: string } | null;
  /** `CLOUDFRIEND_SESSION_TTL`, default 30 days. Idle sessions expire after this long. */
  sessionTtlMs: number;
  /** A session's expiry is pushed forward at most this often (default 1 hour). */
  sessionRenewEveryMs: number;
  oidc: OidcConfig | null;
  /** `CLOUDFRIEND_TRUSTED_PROXIES`: whose X-Forwarded-For names the client, for login rate limiting (client-ip.ts). */
  trustedProxies: TrustedProxies | null;
}

export class AuthConfigError extends Error {}

export const DEFAULT_OIDC_LABEL = "Sign in with SSO";
export const OIDC_CALLBACK_PATH = "/auth/oidc/callback";
export const MIN_ADMIN_PASSWORD_LENGTH = 12;

const OIDC_REQUIRED = ["CLOUDFRIEND_OIDC_ISSUER", "CLOUDFRIEND_OIDC_CLIENT_ID", "CLOUDFRIEND_OIDC_CLIENT_SECRET"] as const;
const OIDC_OPTIONAL = ["CLOUDFRIEND_OIDC_ALLOWED_DOMAINS", "CLOUDFRIEND_OIDC_LABEL"] as const;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Loose check: something@domain, no spaces. The address is never used to send mail. */
export function looksLikeEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email);
}

function httpUrl(name: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthConfigError(`${name} is not a valid URL: ${JSON.stringify(value)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AuthConfigError(`${name} must be an http(s) URL, got ${JSON.stringify(value)}`);
  }
  if (url.search || url.hash) throw new AuthConfigError(`${name} must not have a query string or fragment`);
  return url;
}

/** Reads the auth settings from the environment. Throws AuthConfigError with a clear message on bad or partial settings. */
export function loadAuthConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  const get = (name: string) => {
    const v = env[name]?.trim();
    return v ? v : undefined;
  };

  let publicUrl: URL | null = null;
  const rawPublic = get("CLOUDFRIEND_PUBLIC_URL");
  if (rawPublic) {
    publicUrl = httpUrl("CLOUDFRIEND_PUBLIC_URL", rawPublic);
    publicUrl.pathname = publicUrl.pathname.replace(/\/+$/, "");
  }

  // Bootstrap admin: both or neither.
  let bootstrapAdmin: AuthConfig["bootstrapAdmin"] = null;
  const adminEmail = get("CLOUDFRIEND_ADMIN_EMAIL");
  const adminPassword = env.CLOUDFRIEND_ADMIN_PASSWORD; // not trimmed: spaces may be part of a password
  if (adminEmail || adminPassword) {
    if (!adminEmail) throw new AuthConfigError("CLOUDFRIEND_ADMIN_PASSWORD is set but CLOUDFRIEND_ADMIN_EMAIL is not (set both, or neither)");
    if (!adminPassword) throw new AuthConfigError("CLOUDFRIEND_ADMIN_EMAIL is set but CLOUDFRIEND_ADMIN_PASSWORD is not (set both, or neither)");
    const email = normalizeEmail(adminEmail);
    if (!looksLikeEmail(email)) throw new AuthConfigError(`CLOUDFRIEND_ADMIN_EMAIL is not an email address: ${JSON.stringify(adminEmail)}`);
    if (adminPassword.length < MIN_ADMIN_PASSWORD_LENGTH) {
      throw new AuthConfigError(`CLOUDFRIEND_ADMIN_PASSWORD must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`);
    }
    if (adminPassword.length > 1024) throw new AuthConfigError("CLOUDFRIEND_ADMIN_PASSWORD must be at most 1024 characters");
    bootstrapAdmin = { email, password: adminPassword };
  }

  let sessionTtlMs = 30 * 24 * 3600_000;
  const rawTtl = get("CLOUDFRIEND_SESSION_TTL");
  if (rawTtl) {
    try {
      sessionTtlMs = parseDuration(rawTtl);
    } catch (err) {
      throw new AuthConfigError(`CLOUDFRIEND_SESSION_TTL: ${(err as Error).message}`);
    }
    if (sessionTtlMs < 5 * 60_000 || sessionTtlMs > 400 * 24 * 3600_000) {
      throw new AuthConfigError("CLOUDFRIEND_SESSION_TTL must be between 5m and 400d");
    }
  }

  let trustedProxies: TrustedProxies | null;
  try {
    trustedProxies = parseTrustedProxies(get("CLOUDFRIEND_TRUSTED_PROXIES"));
  } catch (err) {
    if (err instanceof TrustedProxiesError) throw new AuthConfigError(err.message);
    throw err;
  }

  return {
    publicUrl,
    bootstrapAdmin,
    sessionTtlMs,
    sessionRenewEveryMs: Math.min(3600_000, Math.floor(sessionTtlMs / 2)),
    oidc: loadOidc(get, publicUrl),
    trustedProxies,
  };
}

function loadOidc(get: (name: string) => string | undefined, publicUrl: URL | null): OidcConfig | null {
  const present = OIDC_REQUIRED.filter((n) => get(n));
  const optional = OIDC_OPTIONAL.filter((n) => get(n));
  if (!present.length) {
    if (optional.length) {
      throw new AuthConfigError(`${optional.join(" and ")} set, but OIDC is not configured (set ${OIDC_REQUIRED.join(", ")})`);
    }
    return null;
  }
  if (present.length < OIDC_REQUIRED.length) {
    const missing = OIDC_REQUIRED.filter((n) => !get(n));
    throw new AuthConfigError(
      `OIDC is half-configured: ${present.join(", ")} set but ${missing.join(", ")} missing (set all of ${OIDC_REQUIRED.join(", ")}, or none)`,
    );
  }
  if (!publicUrl) {
    throw new AuthConfigError(`OIDC needs CLOUDFRIEND_PUBLIC_URL: the redirect URI is CLOUDFRIEND_PUBLIC_URL + ${OIDC_CALLBACK_PATH}`);
  }

  const issuer = httpUrl("CLOUDFRIEND_OIDC_ISSUER", get("CLOUDFRIEND_OIDC_ISSUER")!);
  const allowInsecure = issuer.protocol === "http:";
  if (allowInsecure && !LOOPBACK.has(issuer.hostname)) {
    throw new AuthConfigError("CLOUDFRIEND_OIDC_ISSUER must be https (plain http is only allowed for localhost)");
  }

  let allowedDomains: string[] | null = null;
  const rawDomains = get("CLOUDFRIEND_OIDC_ALLOWED_DOMAINS");
  if (rawDomains) {
    allowedDomains = rawDomains.split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
    const bad = allowedDomains.filter((d) => !DOMAIN.test(d));
    if (bad.length) throw new AuthConfigError(`CLOUDFRIEND_OIDC_ALLOWED_DOMAINS has invalid domains: ${bad.join(", ")}`);
    if (!allowedDomains.length) throw new AuthConfigError("CLOUDFRIEND_OIDC_ALLOWED_DOMAINS has no domains");
  }

  return {
    issuer,
    clientId: get("CLOUDFRIEND_OIDC_CLIENT_ID")!,
    clientSecret: get("CLOUDFRIEND_OIDC_CLIENT_SECRET")!,
    redirectUri: publicUrl.href.replace(/\/+$/, "") + OIDC_CALLBACK_PATH,
    allowedDomains,
    label: get("CLOUDFRIEND_OIDC_LABEL") ?? DEFAULT_OIDC_LABEL,
    allowInsecure,
  };
}
