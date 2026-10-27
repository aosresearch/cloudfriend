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

  it("puts a workspace on every data table", async () => {
    const db = await openDb(await freshDatabase());
    try {
      const { rows } = await db.query(
        `SELECT table_name FROM information_schema.tables t
         WHERE table_schema = 'public' AND table_name NOT IN ('workspaces', 'schema_migrations')
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

  it("fails fast without a database URL", () => {
    assert.throws(() => loadConfig({}), /CLOUDFRIEND_DATABASE_URL is not set/);
    assert.equal(loadConfig({ DATABASE_URL: "postgres://x" }).databaseUrl, "postgres://x");
    assert.equal(loadConfig({ DATABASE_URL: "postgres://x", CLOUDFRIEND_DATABASE_URL: "postgres://y" }).databaseUrl, "postgres://y");
  });
});
