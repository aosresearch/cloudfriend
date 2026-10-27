// The dashboard's first-run flow (test/dashboard-flow.ts, also run against the dev mock in
// test/ui.test.ts) against the real server over HTTP: Postgres, intake, the worker with the
// classifier on, a fake decider and a fake destination.
import { serve } from "@hono/node-server";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { hashPassword } from "../src/auth/index.ts";
import type { ActionAdapter, Decision } from "../src/types.ts";
import { assetsLoad, firstRunFlow } from "./dashboard-flow.ts";
import { fakeDecider, makeCloudfriend, type TestCloudfriend } from "./helpers.ts";

const ADMIN = { email: "admin@example.com", password: "a long enough password" };

let cf: TestCloudfriend;
let server: ReturnType<typeof serve>;
let baseUrl = "";
const delivered: string[] = [];

before(async () => {
  // Judges the dashboard's test exceptions relevant and alerts on them; everything else is benign.
  const decider = fakeDecider((events): Decision => {
    const tests = events.filter((e) => (e.data as { cloudfriend_test?: boolean } | null)?.cloudfriend_test === true);
    return {
      flags: tests.length ? [{ reason: "Test exception sent from the setup page", severity: "low", event_ids: tests.map((e) => e.id) }] : [],
      judgments: events.map((e) => ({ event_id: e.id, relevance: tests.includes(e) ? "relevant" : "benign" })),
      record: { model: "fake", prompt: `judge ${events.map((e) => e.id).join(", ")}`, response: "{}" },
    };
  });
  // The destination: accepts tests and deliveries, sends nothing anywhere.
  const webhook: ActionAdapter = {
    async validate(config) {
      return config;
    },
    async test() {},
    async run(flag) {
      delivered.push(flag.id);
    },
  };
  cf = await makeCloudfriend({
    decider: decider.adapter,
    actions: { webhook },
    config: { triage: true, batchWaitMs: 50, pollMs: 20 },
    env: { CLOUDFRIEND_ADMIN_EMAIL: ADMIN.email, CLOUDFRIEND_ADMIN_PASSWORD: ADMIN.password },
  });
  // Someone else's workspace, for the 403 check.
  await cf.db.query("INSERT INTO workspaces (id, name, created_at) VALUES ('ws_other', 'Someone else', $1)", [Date.now()]);
  await cf.auth.store.createUser({ id: "usr_other", email: "other@example.com", name: null, password_hash: await hashPassword("another long password"), created_at: new Date() });
  await cf.db.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws_other', 'usr_other', 'owner')");
  cf.worker.start();
  server = serve({ fetch: cf.app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await cf?.close(0).catch(() => {});
});

describe("dashboard API on the real server (design/api-contract.md)", () => {
  it("serves index.html and every asset it loads, following module imports", async () => {
    await assetsLoad(baseUrl);
  });

  it("signs in, checks CSRF, and runs the first-run flow end to end", async () => {
    await firstRunFlow({
      baseUrl,
      login: ADMIN,
      foreignWorkspace: "ws_other",
    });
    assert.ok(delivered.length >= 1, "the fake destination got the alert");
  });
});
