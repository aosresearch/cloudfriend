// GET /api/w/:ws/usage and GET /api/w/:ws/stats.
import type { Hono } from "hono";
import type { AuthEnv } from "../auth/index.ts";
import { all, one } from "../db.ts";
import { WS, wsOf, type DashboardDeps } from "./deps.ts";
import { parseTime } from "./http.ts";

export function registerUsage(app: Hono<AuthEnv>, deps: DashboardDeps): void {
  const { db } = deps;

  app.get(`${WS}/usage`, async (c) => {
    const ws = wsOf(c);
    const day = new Date().toISOString().slice(0, 10);
    const [usage, settings, backlog] = await Promise.all([
      one<{ events: number; jev_calls: number; jev_spend_usd: number }>(db, "SELECT events, jev_calls, jev_spend_usd FROM usage WHERE workspace_id = $1 AND day = $2", [ws, day]),
      one<{ settings: Record<string, unknown> }>(db, "SELECT settings FROM workspaces WHERE id = $1", [ws]),
      // Waiting to be parsed, plus parsed and waiting to be decided. Both are partial-index scans.
      one<{ n: number }>(
        db,
        `SELECT (SELECT count(*) FROM queue WHERE workspace_id = $1 AND status = 'new') + (SELECT count(*) FROM events WHERE workspace_id = $1 AND NOT decided) AS n`,
        [ws],
      ),
    ]);
    const raw = settings?.settings?.jev_budget_usd;
    const budget = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
    const spend = usage?.jev_spend_usd ?? 0;
    const exhausted = budget !== null && spend >= budget;
    const classifier = !!deps.triage?.classifier;
    const decider = deps.decider && !exhausted ? "jev" : classifier ? "classifier" : "none";
    return c.json({
      day,
      events: usage?.events ?? 0,
      backlog: backlog?.n ?? 0,
      jev_calls: usage?.jev_calls ?? 0,
      jev_spend_usd: Math.round(spend * 1e6) / 1e6,
      jev_budget_usd: budget,
      budget_exhausted: exhausted,
      decider,
    });
  });

  app.get(`${WS}/stats`, async (c) => {
    const ws = wsOf(c);
    const since = parseTime(c.req.query("since") || "24h")!;
    const [routes, flags] = await Promise.all([
      all<{ route: string; n: number }>(
        db,
        "SELECT coalesce(route, 'none') AS route, count(*) AS n FROM events WHERE workspace_id = $1 AND received_at >= $2 GROUP BY 1",
        [ws, since],
      ),
      one<{ n: number }>(db, "SELECT count(*) AS n FROM flags WHERE workspace_id = $1 AND created_at >= $2", [ws, since]),
    ]);
    return c.json({
      routes: Object.fromEntries(routes.map((r) => [r.route, r.n])),
      events: routes.reduce((a, r) => a + r.n, 0),
      flags: flags?.n ?? 0,
    });
  });
}
