// The dashboard's JSON API (design/api-contract.md) and the UI it serves. createApp (src/server.ts)
// mounts it; boot code calls setupAuth first.
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { registerAuthRoutes, type Auth, type AuthEnv } from "../auth/index.ts";
import type { AuthSetup } from "./auth-setup.ts";
import { WS, type DashboardDeps } from "./deps.ts";
import { registerDestinations } from "./destinations.ts";
import { registerEvents } from "./events.ts";
import { HttpError } from "./http.ts";
import { registerSources } from "./sources.ts";
import { registerUsage } from "./usage.ts";
import { listWorkspaces, registerWorkspaces } from "./workspaces.ts";

export { setupAuth, type AuthSetup } from "./auth-setup.ts";
export { registerUi, UI_CSP, UI_DIR } from "./static.ts";
export type { DashboardDeps } from "./deps.ts";

const API_BODY_LIMIT = 64 * 1024;

/** Sign-in routes (with the CSRF guard on /api/*), then every /api route, each workspace route behind requireMember. */
export function registerDashboardApi(app: Hono<any>, auth: AuthSetup, deps: DashboardDeps): Auth {
  const api = app as Hono<AuthEnv>;
  api.use(
    "/api/*",
    bodyLimit({ maxSize: API_BODY_LIMIT, onError: () => { throw new HttpError(413, "request body too large"); } }),
    async (c, next) => {
      await next();
      c.header("x-content-type-options", "nosniff");
      if (!c.res.headers.has("cache-control")) c.header("cache-control", "no-store");
    },
  );
  const a = registerAuthRoutes(app, {
    store: auth.store,
    config: auth.config,
    listWorkspaces: (userId) => listWorkspaces(deps.db, userId),
  });
  registerWorkspaces(api, a, deps);
  api.use(`${WS}/*`, a.requireMember((c) => c.req.param("ws")));
  registerSources(api, deps);
  registerDestinations(api, deps);
  registerEvents(api, deps);
  registerUsage(api, deps);
  return a;
}
