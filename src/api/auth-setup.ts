// Boot-time wiring of sign-in: settings, the bootstrap admin, the default workspace's owner and
// session housekeeping. The routes themselves are registered by createApp (src/server.ts).
import { DEFAULT_WORKSPACE, type DB } from "../db.ts";
import { errMsg, log } from "../log.ts";
import { ensureBootstrapAdmin, loadAuthConfig, PgAuthStore, Sessions, type AuthConfig, type AuthStore, type BootstrapResult } from "../auth/index.ts";

export interface AuthSetup {
  config: AuthConfig;
  store: AuthStore;
  bootstrap: BootstrapResult;
  /**
   * The bootstrap admin's generated password on first boot (no users, no CLOUDFRIEND_ADMIN_*),
   * else null. Print it once; it is stored only as a hash.
   */
  generatedPassword: string | null;
  /** Stops the hourly session pruning. */
  stop(): void;
}

const PRUNE_EVERY_MS = 3600_000;

/**
 * Call once at boot, after migrations. Throws AuthConfigError on bad or partial settings, so a
 * misconfigured server fails at start rather than at the first sign-in.
 * - Makes sure the bootstrap admin exists (ensureBootstrapAdmin).
 * - Makes that admin owner of ws_default when it has no owner yet, so the first person to sign
 *   in sees the workspace that the ingest secrets and admin API already use.
 * - Prunes expired sessions now and every hour.
 */
export async function setupAuth(db: DB, env: Record<string, string | undefined> = process.env, opts: { pruneEveryMs?: number } = {}): Promise<AuthSetup> {
  const config = loadAuthConfig(env);
  const store = new PgAuthStore(db);
  const bootstrap = await ensureBootstrapAdmin(store, config);
  if (bootstrap.userId) {
    const added = await db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       SELECT $1, $2, 'owner' WHERE NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND role = 'owner')
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [DEFAULT_WORKSPACE, bootstrap.userId],
    );
    if (added.rowCount) log.info("bootstrap admin is the owner of the default workspace", { email: bootstrap.email, workspace: DEFAULT_WORKSPACE });
  }
  if (bootstrap.mode === "env" && bootstrap.created) log.info("created the admin from CLOUDFRIEND_ADMIN_EMAIL", { email: bootstrap.email });
  if (bootstrap.passwordUpdated) log.info("admin password changed to CLOUDFRIEND_ADMIN_PASSWORD; their sessions were signed out", { email: bootstrap.email });

  const sessions = new Sessions(store, { ttlMs: config.sessionTtlMs, renewEveryMs: config.sessionRenewEveryMs });
  const prune = () =>
    sessions
      .prune()
      .then((n) => void (n && log.info("expired sessions removed", { sessions: n })))
      .catch((err) => log.warn("session pruning failed", { error: errMsg(err) }));
  await prune();
  const timer = setInterval(() => void prune(), opts.pruneEveryMs ?? PRUNE_EVERY_MS);
  timer.unref();

  return {
    config,
    store,
    bootstrap,
    generatedPassword: bootstrap.mode === "generated" ? bootstrap.password : null,
    stop: () => clearInterval(timer),
  };
}
