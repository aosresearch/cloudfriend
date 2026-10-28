// Per-workspace usage per UTC day (the `usage` table): accepted requests, decider calls and their
// cost. Written inside the transactions that do the work, so the counts match what was stored.
import { all, type Queryable } from "./db.ts";

/** The UTC day of an epoch-ms time, e.g. `2026-10-27`. */
export const utcDay = (ms: number = Date.now()): string => new Date(ms).toISOString().slice(0, 10);

/** Add accepted requests, one entry per (workspace, day). Rows are locked in a fixed order. */
export async function addEvents(c: Queryable, counts: Map<string, number>, day: string): Promise<void> {
  const ws = [...counts.keys()].sort();
  if (!ws.length) return;
  await c.query(
    `INSERT INTO usage (workspace_id, day, events) SELECT w, $1, n FROM unnest($2::text[], $3::bigint[]) AS u(w, n) ORDER BY w
     ON CONFLICT (workspace_id, day) DO UPDATE SET events = usage.events + excluded.events`,
    [day, ws, ws.map((w) => counts.get(w)!)],
  );
}

/** Count one decider call and what it cost (0 when the decider didn't report a cost). */
export async function addDeciderCall(c: Queryable, workspace: string, day: string, costUsd: number): Promise<void> {
  await c.query(
    `INSERT INTO usage (workspace_id, day, jev_calls, jev_spend_usd) VALUES ($1, $2, 1, $3)
     ON CONFLICT (workspace_id, day) DO UPDATE SET jev_calls = usage.jev_calls + 1, jev_spend_usd = usage.jev_spend_usd + excluded.jev_spend_usd`,
    [workspace, day, costUsd],
  );
}

/** Each workspace's settings and decider spend on `day`. */
export async function workspaceState(q: Queryable, workspaces: string[], day: string): Promise<Map<string, { settings: WorkspaceSettings; spend: number }>> {
  if (!workspaces.length) return new Map();
  const rows = await all<{ id: string; settings: WorkspaceSettings | null; spend: number | null }>(
    q,
    `SELECT w.id, w.settings, u.jev_spend_usd AS spend FROM workspaces w
     LEFT JOIN usage u ON u.workspace_id = w.id AND u.day = $2 WHERE w.id = ANY($1::text[])`,
    [workspaces, day],
  );
  return new Map(rows.map((r) => [r.id, { settings: r.settings ?? {}, spend: r.spend ?? 0 }]));
}

/** `workspaces.settings` as the sorter reads it. Unknown or mistyped fields are ignored. */
export interface WorkspaceSettings {
  jev_budget_usd?: unknown;
  decider_instructions?: unknown;
}

/** The workspace's daily decider budget: its own setting, else the global one; null = no cap. */
export function budgetOf(settings: WorkspaceSettings, globalUsd: number | null): number | null {
  const own = settings.jev_budget_usd;
  if (typeof own === "number" && Number.isFinite(own) && own >= 0) return own;
  return globalUsd;
}
