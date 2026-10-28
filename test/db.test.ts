import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_WORKSPACE, migrations, openDb, tx } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import "./helpers.ts";
import { freshDatabase } from "./pg.ts";

describe("database", () => {
  it("applies each migration once when several processes boot at the same time", async () => {
    const url = await freshDatabase();
    const pools = await Promise.all(Array.from({ length: 6 }, () => openDb(url, { max: 2 })));
    try {
      const db = pools[0]!;
      const applied = (await db.query("SELECT version, name FROM schema_migrations ORDER BY version")).rows;
      assert.deepEqual(applied, migrations().map((m) => ({ version: m.version, name: m.name })));
      assert.deepEqual((await db.query("SELECT id FROM workspaces")).rows, [{ id: DEFAULT_WORKSPACE }]);
      // Booting again finds nothing to do.
      const again = await openDb(url);
      await again.end();
      assert.equal((await db.query("SELECT count(*) AS n FROM schema_migrations")).rows[0].n, migrations().length);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });

  // People and their sessions span workspaces (membership is workspace_members); everything else
  // belongs to exactly one.
  it("puts a workspace on every data table", async () => {
    const db = await openDb(await freshDatabase());
    try {
      const { rows } = await db.query(
        `SELECT table_name FROM information_schema.tables t
         WHERE table_schema = 'public' AND table_name NOT IN ('workspaces', 'schema_migrations', 'users', 'user_identities', 'sessions')
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
                           WHERE c.table_schema = 'public' AND c.table_name = t.table_name AND c.column_name = 'workspace_id' AND c.is_nullable = 'NO')`,
      );
      assert.deepEqual(rows, []);
    } finally {
      await db.end();
    }
  });

  it("rolls a transaction back when its callback throws", async () => {
    const db = await openDb(await freshDatabase());
    try {
      await assert.rejects(
        tx(db, async (c) => {
          await c.query("INSERT INTO workspaces (id, name, created_at) VALUES ('ws_x', 'x', 0)");
          throw new Error("boom");
        }),
        /boom/,
      );
      assert.equal((await db.query("SELECT count(*) AS n FROM workspaces WHERE id = 'ws_x'")).rows[0].n, 0);
    } finally {
      await db.end();
    }
  });

  // As when Postgres restarts (`docker compose restart` stops both containers at once) while a
  // transaction is between two queries: the connection drops under a checked-out client.
  it("survives losing the connection of a client that is checked out", async () => {
    const db = await openDb(await freshDatabase());
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);
    try {
      await assert.rejects(
        tx(db, async (c) => {
          const pid = (await c.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
          await db.query("SELECT pg_terminate_backend($1)", [pid]);
          await new Promise((r) => setTimeout(r, 200)); // the 'error' event arrives in between
          await c.query("SELECT 1");
        }),
      );
      assert.deepEqual(uncaught, []);
      assert.equal((await db.query("SELECT 1 AS one")).rows[0].one, 1, "the pool still works");
    } finally {
      process.off("uncaughtException", onUncaught);
      await db.end();
    }
  });

  it("fails fast without a database URL", () => {
    assert.throws(() => loadConfig({}), /CLOUDFRIEND_DATABASE_URL is not set/);
    assert.equal(loadConfig({ DATABASE_URL: "postgres://x" }).databaseUrl, "postgres://x");
    assert.equal(loadConfig({ DATABASE_URL: "postgres://x", CLOUDFRIEND_DATABASE_URL: "postgres://y" }).databaseUrl, "postgres://y");
  });
});
