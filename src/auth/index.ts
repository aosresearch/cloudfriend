// Authentication for the self-hosted dashboard: password and OIDC sign-in, cookie sessions, CSRF guard,
// workspace membership checks. See routes.ts for wiring, store.ts for the storage interface.
export { AuthConfigError, DEFAULT_OIDC_LABEL, loadAuthConfig, normalizeEmail, OIDC_CALLBACK_PATH, type AuthConfig, type OidcConfig } from "./config.ts";
export { ensureBootstrapAdmin, FIRST_BOOT_ADMIN_EMAIL, type BootstrapResult } from "./bootstrap.ts";
export { MemoryAuthStore } from "./memory-store.ts";
export { generatePassword, hashPassword, needsRehash, verifyPassword } from "./password.ts";
export { DEFAULT_LOGIN_LIMITS, LoginRateLimiter, type LoginLimits } from "./rate-limit.ts";
export {
  createAuth,
  CSRF_HEADER,
  publicUser,
  registerAuthRoutes,
  type Auth,
  type AuthDeps,
  type AuthEnv,
  type AuthUser,
  type WorkspaceSummary,
} from "./routes.ts";
export { SESSION_COOKIE, Sessions } from "./sessions.ts";
export {
  EmailTakenError,
  IdentityTakenError,
  type AuthStore,
  type IdentityRecord,
  type Role,
  type SessionRecord,
  type UserRecord,
} from "./store.ts";
