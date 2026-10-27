// GET/POST /api/workspaces, and the list behind GET /api/me.
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { Auth, AuthEnv, Role, WorkspaceSummary } from "../auth/index.ts";
import { all, tx, type Queryable } from "../db.ts";
import type { DashboardDeps } from "./deps.ts";
import { iso, jsonObject, nameField } from "./http.ts";

interface Row {
  id: string;
  name: string;
  role: Role;
  created_at: number;
}

async function workspacesOf(db: Queryable, userId: string): Promise<Row[]> {
  return all<Row>(
    db,
    `SELECT w.id, w.name, m.role, w.created_at FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = $1 ORDER BY w.created_at, w.id`,
    [userId],
  );
}

/** For GET /api/me. */
export async function listWorkspaces(db: Queryable, userId: string): Promise<WorkspaceSummary[]> {
  return (await workspacesOf(db, userId)).map((r) => ({ id: r.id, name: r.name, role: r.role }));
}

const view = (r: Row) => ({ id: r.id, name: r.name, role: r.role, created_at: iso(r.created_at) });

export function registerWorkspaces(app: Hono<AuthEnv>, auth: Auth, deps: DashboardDeps): void {
  const { db } = deps;

  app.get("/api/workspaces", auth.requireUser, async (c) => c.json({ workspaces: (await workspacesOf(db, c.get("user").id)).map(view) }));

  app.post("/api/workspaces", auth.requireUser, async (c) => {
    const body = await jsonObject(c, '{"name": "..."}');
    const name = nameField(body.name, "name", 80);
    const row: Row = { id: "ws_" + randomBytes(8).toString("hex"), name, role: "owner", created_at: Date.now() };
    await tx(db, async (q) => {
      await q.query("INSERT INTO workspaces (id, name, created_at) VALUES ($1, $2, $3)", [row.id, row.name, row.created_at]);
      await q.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [row.id, c.get("user").id]);
    });
    return c.json({ workspace: view(row) }, 201);
  });
}
