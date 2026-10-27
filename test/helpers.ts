import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { loadAdapters, type Adapters } from "../src/adapters.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { createCloudfriend, type cloudfriend } from "../src/cloudfriend.ts";
import type { ActionAdapter, DeciderAdapter, Decision, FlagDraft, CloudfriendEvent } from "../src/types.ts";

process.env.CLOUDFRIEND_LOG ??= "silent";

export const ADMIN = "test-admin-key";

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cloudfriend-test-"));
}

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    ...loadConfig({}),
    dataDir: tempDir(),
    adminKey: ADMIN,
    batchSize: 3,
    batchWaitMs: 60_000,
    pollMs: 10,
    cleanupIntervalMs: 3_600_000,
    // The v0 tests check the pipeline without the classifier; test/triage.test.ts turns it on.
    triage: false,
    // Promote trained models at once; the shadow tests set a period.
    shadowPeriodMs: 0,
    ...over,
  };
}

/** A decider that records what it saw and returns whatever `respond` says. */
export function fakeDecider(respond: (events: CloudfriendEvent[]) => FlagDraft[] | Decision | Promise<FlagDraft[] | Decision> = () => []) {
  const calls: CloudfriendEvent[][] = [];
  const adapter: DeciderAdapter = {
    async decide(events) {
      calls.push(events);
      return respond(events);
    },
  };
  return { adapter, calls };
}

export function fakeAction(run: ActionAdapter["run"] = async () => {}) {
  const calls: { flagId: string; eventIds: string[] }[] = [];
  const adapter: ActionAdapter = {
    async run(flag, ctx) {
      calls.push({ flagId: flag.id, eventIds: ctx.events.map((e) => e.id) });
      return run(flag, ctx);
    },
  };
  return { adapter, calls };
}

let builtins: Adapters | null = null;

/** Built-in sources plus the given decider and actions (replacing the built-in ones). */
export async function testAdapters(
  decider: DeciderAdapter | null,
  actions: Record<string, ActionAdapter> = {},
): Promise<Adapters> {
  builtins ??= await loadAdapters();
  return {
    sources: builtins.sources,
    deciders: new Map(decider ? [["test", decider]] : [["test", { enabled: () => false, decide: async () => [] }]]),
    actions: new Map(Object.entries(actions)),
  };
}

export interface TestCloudfriend extends cloudfriend {
  config: Config;
  secret: string;
  post(source: string, body: string | object, headers?: Record<string, string>): Promise<Response>;
  get(path: string): Promise<Response>;
}

export async function makeCloudfriend(
  opts: { config?: Partial<Config>; decider?: DeciderAdapter | null; actions?: Record<string, ActionAdapter> } = {},
): Promise<TestCloudfriend> {
  const config = testConfig({ decider: "test", ...opts.config });
  const adapters = await testAdapters(opts.decider === undefined ? fakeDecider().adapter : opts.decider, opts.actions);
  const cloudfriend = await createCloudfriend(config, {}, adapters);
  const secret = cloudfriend.bootSecret ?? cloudfriend.secrets.create("test").secret;
  return Object.assign(cloudfriend, {
    config,
    secret,
    async post(source: string, body: string | object, headers: Record<string, string> = {}) {
      return cloudfriend.app.request(`/in/${source}`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    },
    async get(p: string) {
      return cloudfriend.app.request(p, { headers: { authorization: `Bearer ${ADMIN}` } });
    },
  });
}

export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 3_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function count(cloudfriend: cloudfriend, sql: string, ...args: (string | number)[]): number {
  return (cloudfriend.db.prepare(`SELECT count(*) AS n FROM ${sql}`).get(...args) as { n: number }).n;
}

export interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A local HTTP server that records requests and answers with `reply`. */
export async function mockServer(
  reply: (req: Recorded) => { status?: number; body?: unknown } = () => ({ status: 200, body: "ok" }),
  host = "127.0.0.1",
) {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rec = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() };
      requests.push(rec);
      const { status = 200, body = "ok" } = reply(rec);
      res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain" : "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, host, r));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
