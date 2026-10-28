// Tests the self-hosted release the way people run it: the repository's docker-compose.yml with a
// .env made from .env.example, `docker compose up -d`, the dashboard API, and a mock OpenRouter
// (answering like Jev) and a mock webhook receiver on the host. Run with `npm run test:docker`
// (needs a Docker daemon with Compose v2.24 or later). Set CLOUDFRIEND_IMAGE to test an existing
// image instead of building one.
//
// Every project gets a unique name, and its containers, networks and volumes are removed at the end.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Client } from "../dashboard-client.ts";
import { mockServer } from "../helpers.ts";
import { ComposeProject, docker, type EnvValues } from "./compose.ts";

const IMAGE = process.env.CLOUDFRIEND_IMAGE ?? "cloudfriend:test";
const RUN = randomBytes(3).toString("hex");
const WS = "/api/w/ws_default";
// Docker Desktop forwards host.docker.internal to the host's loopback. On Linux it is the bridge
// gateway, so the mocks have to listen on all interfaces there.
const MOCK_HOST = process.platform === "linux" ? "0.0.0.0" : "127.0.0.1";
// Characters that would break a connection URL: compose passes the password apart from it.
const PG_PASSWORD = `t@st:pw/${RUN}?x%`;

/** Poll until `fn` returns something truthy; errors count as "not yet". */
async function eventually<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out${last ? `: ${last}` : ""}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** What the decider was shown: the text of each numbered event, past the open-alerts list. */
function promptEvents(body: string): string[] {
  const prompt: string = JSON.parse(body).messages[1].content;
  return prompt.slice(prompt.indexOf("events, oldest first")).split(/^\[\d+\] /m).slice(1);
}

const ALERTS: [RegExp, string, string][] = [
  [/TypeError/, "New TypeError in checkout", "high"],
  [/CloudfriendTestError/, "Test exception from the dashboard", "low"],
  [/crash-test/, "Recovered after crash", "medium"],
];

type Reply = Promise<{ status: number; json: any }>;

/** The reply's JSON, after checking its status. */
async function ok(r: Reply, status = 200): Promise<any> {
  const res = await r;
  assert.equal(res.status, status, JSON.stringify(res.json));
  return res.json;
}

/** Highest lease epoch a worker logged for the default workspace. */
const claimedEpoch = (logs: string) => Math.max(0, ...[...logs.matchAll(/workspace claimed workspace=ws_default epoch=(\d+)/g)].map((m) => Number(m[1])));

describe(`docker compose with ${IMAGE}`, { timeout: 900_000 }, () => {
  let deciderMode: "ok" | "fail" = "ok";
  let jev: Awaited<ReturnType<typeof mockServer>>;
  let receiver: Awaited<ReturnType<typeof mockServer>>;
  const projects: ComposeProject[] = [];

  const baseEnv = (): EnvValues => ({
    POSTGRES_PASSWORD: PG_PASSWORD,
    JEV_API_KEY: "sk-or-test",
    // The mock receiver runs on the host, a private address from inside the container.
    CLOUDFRIEND_ALLOW_PRIVATE_DESTINATIONS: "on",
    OPENROUTER_BASE_URL: `http://host.docker.internal:${jev.port}/api/v1`,
    CLOUDFRIEND_BATCH_WAIT: "300ms",
  });

  const project = (suffix: string, env: EnvValues = {}) => {
    const p = new ComposeProject(`cftest-${RUN}-${suffix}`, { image: IMAGE, build: !process.env.CLOUDFRIEND_IMAGE, env: { ...baseEnv(), ...env } });
    projects.push(p);
    return p;
  };

  /** Requests the receiver got for real flags (not destination tests). */
  const deliveries = () => receiver.requests.filter((r) => r.headers["x-cloudfriend-flag-id"] && !r.headers["x-cloudfriend-test"]);

  /** Sends the setup page's test exception and waits for its event to be decided. */
  const testEvent = async (http: Client, timeoutMs = 30_000) => {
    const { queue_id } = await ok(http.post(`${WS}/test-event`));
    return decided(http, queue_id, timeoutMs);
  };
  const decided = (http: Client, queueId: string, timeoutMs = 30_000) =>
    eventually(async () => {
      const r = await ok(http.get(`${WS}/test-event/${queueId}`));
      return r.event?.decided && r.event;
    }, timeoutMs);

  before(async () => {
    await docker("version", "--format", "{{.Server.Version}}");
    jev = await mockServer((req) => {
      if (deciderMode === "fail") return { status: 503, body: { error: { message: "upstream unavailable" } } };
      // Answers like Jev: a judgment for every event shown, and alerts for the ones that matter.
      const events = promptEvents(req.body);
      const judgments = events.map((text, i) => ({ event: i, relevance: ALERTS.some(([re]) => re.test(text)) ? "relevant" : "benign" }));
      const alerts = ALERTS.flatMap(([re, reason, severity]) => {
        const hit = events.flatMap((text, i) => (re.test(text) ? [i] : []));
        return hit.length ? [{ reason, severity, events: hit }] : [];
      });
      return {
        body: {
          choices: [{ message: { content: JSON.stringify({ judgments, alerts }) } }],
          usage: { prompt_tokens: 900, completion_tokens: 60, cost: 0.0012 },
        },
      };
    }, MOCK_HOST);
    receiver = await mockServer(undefined, MOCK_HOST);
  });

  after(async () => {
    for (const p of projects) await p.destroy();
    await jev?.close();
    await receiver?.close();
  });

  describe("all in one (the default)", () => {
    let p: ComposeProject;
    let base = "";
    let http: Client;
    let password = "";
    let source: { id: string; endpoint_url: string; secret: string };

    const connect = async () => {
      base = await p.baseUrl();
      await eventually(async () => (await fetch(`${base}/healthz`)).ok);
    };
    /** A source's endpoint as the dashboard shows it, on whatever host port this run got. */
    const ingest = (body: object, opts: { query?: string; src?: typeof source; headers?: Record<string, string> } = {}) => {
      const src = opts.src ?? source;
      return fetch(src.endpoint_url.replace(/^https?:\/\/[^/]+/, base) + (opts.query ?? ""), {
        method: "POST",
        headers: { ...(opts.query ? {} : { authorization: `Bearer ${src.secret}` }), "content-type": "application/json", ...opts.headers },
        body: JSON.stringify(body),
      });
    };
    /** Every event, once all accepted requests are parsed (so counts can't race the worker). */
    const settledEvents = async () => {
      await eventually(async () => ((await (await fetch(`${base}/healthz`)).json()) as any).queued === 0);
      return (await ok(http.get(`${WS}/events?limit=1000`))).events as any[];
    };
    const flags = async () => (await ok(http.get(`${WS}/flags?limit=1000`))).flags as any[];

    before(async () => {
      // A short lease, so the tests don't wait 30 s whenever a process could not release it
      // (a kill, or `docker compose restart` stopping Postgres at the same time as the app).
      p = project("all", { CLOUDFRIEND_LEASE_TTL: "5s", CLOUDFRIEND_LEASE_RENEW: "1s" });
      if (!process.env.CLOUDFRIEND_IMAGE) await p.compose("build", "cloudfriend");
    });

    it("starts with docker compose up: Postgres healthy and private, the app healthy and non-root", async () => {
      await p.up();
      await connect();
      const app = await p.container("cloudfriend");
      const db = await p.container("postgres");
      assert.equal(await p.inspect(app, "{{.State.Health.Status}}"), "healthy");
      assert.equal(await p.inspect(db, "{{.State.Health.Status}}"), "healthy");
      assert.match(await p.inspect(db, "{{.Config.Image}}"), /^postgres:\d+\.\d+$/, "Postgres is pinned to an exact version");
      assert.equal(await p.inspect(db, "{{json .HostConfig.PortBindings}}"), "{}", "Postgres is not published to the host");
      assert.equal(await p.inspect(app, "{{.HostConfig.RestartPolicy.Name}}"), "unless-stopped");
      assert.equal(await p.compose("exec", "-T", "cloudfriend", "id", "-u"), "1000");
      const files = await p.compose("exec", "-T", "cloudfriend", "sh", "-c", "ls src/migrations src/ui/static node_modules");
      assert.match(files, /001_init\.sql/);
      assert.match(files, /index\.html/);
      assert.doesNotMatch(files, /sqlite/i);
      const page = await fetch(`${base}/`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /app\.js/, "the dashboard is served");
      assert.match(await p.logs("cloudfriend"), /cloudfriend listening .*role=all .*decider=jev/);
    });

    it("prints a generated admin password once, which signs in and sees the default workspace", async () => {
      const logs = await p.logs("cloudfriend");
      assert.equal(logs.match(/First boot: created a dashboard admin/g)?.length, 1, logs);
      assert.match(logs, /email:\s+admin@localhost/);
      password = /password:\s+(\S+)/.exec(logs)?.[1] ?? "";
      assert.ok(password.length >= 12, "a generated password is printed");

      http = new Client((path, init) => fetch(base + path, init));
      assert.equal((await http.call("POST", "/api/login", { email: "admin@localhost", password }, { csrf: false })).status, 403, "login needs the CSRF header");
      assert.equal((await http.login("admin@localhost", "not the password")).status, 401);
      assert.equal((await http.login("admin@localhost", password)).status, 200);
      const me = await ok(http.get("/api/me"));
      assert.equal(me.user.email, "admin@localhost");
      assert.ok(me.workspaces.some((w: any) => w.id === "ws_default" && w.role === "owner"), JSON.stringify(me.workspaces));
    });

    it("turns a Sentry webhook into a flag at a webhook destination and in the queue, judged by Jev", async () => {
      const created = await ok(http.post(`${WS}/sources`, { name: "sentry-prod", kind: "sentry" }), 201);
      source = { ...created.source, secret: created.secret };
      assert.match(source.endpoint_url, new RegExp(`/in/${source.id}$`));

      const dst = await ok(http.post(`${WS}/destinations`, { name: "receiver", kind: "webhook", url: `http://host.docker.internal:${receiver.port}/hook` }), 201);
      assert.deepEqual(await ok(http.post(`${WS}/destinations/${dst.destination.id}/test`)), { ok: true });
      assert.ok(receiver.requests.some((r) => r.headers["x-cloudfriend-test"] === "1"), "the destination test reached the receiver");

      const issue = {
        action: "created",
        installation: { uuid: "i" },
        data: { issue: { id: "4711", title: "TypeError: Cannot read properties of undefined (reading 'total')", culprit: "checkout/cart.ts", level: "error" } },
      };
      // Sentry can't set an Authorization header, so the secret goes in the query string.
      const res = await ingest(issue, { query: `?secret=${source.secret}`, headers: { "sentry-hook-resource": "issue" } });
      assert.equal(res.status, 202);

      const delivery = await eventually(async () => deliveries().find((r) => JSON.parse(r.body).flag.reason === "New TypeError in checkout"));
      const flagId = delivery.headers["x-cloudfriend-flag-id"] as string;
      const queue = (await ok(http.get(`${WS}/queue`))).flags;
      assert.ok(queue.some((f: any) => f.id === flagId && f.severity === "high"), "the flag is in the queue");
      const detail = await eventually(async () => {
        const d = await ok(http.get(`${WS}/flags/${flagId}`));
        return d.deliveries.length && d.deliveries.every((x: any) => x.status === "ok") && d;
      });
      assert.deepEqual(detail.deliveries.map((d: any) => d.destination_name), ["receiver"]);
      const [ev] = detail.events;
      assert.equal(ev.source, source.id);
      assert.equal(ev.judgment, "relevant");
      assert.equal(ev.flag_id, flagId);
      assert.equal(typeof ev.decision_id, "string");
      const usage = await ok(http.get(`${WS}/usage`));
      assert.ok(usage.jev_calls >= 1 && usage.jev_spend_usd > 0, JSON.stringify(usage));
    });

    it("takes a test exception from the setup page through to a decided event", async () => {
      const ev = await testEvent(http);
      assert.ok(ev.route);
      assert.equal(ev.judgment, "relevant");
      assert.ok(ev.flag_id, "the test exception alerted");
      await eventually(async () => deliveries().some((r) => r.headers["x-cloudfriend-flag-id"] === ev.flag_id));
    });

    it("keeps events, flags and sessions across docker compose restart", async () => {
      const events = (await settledEvents()).length;
      const flagCount = (await flags()).length;
      const started = Date.now();
      await p.compose("restart");
      assert.ok(Date.now() - started < 20_000, `restart took ${Date.now() - started}ms; shutdown waited on something`);
      await connect();
      assert.equal((await settledEvents()).length, events);
      assert.equal((await flags()).length, flagCount);
      assert.equal((await http.get("/api/me")).status, 200, "still signed in");
      assert.equal((await ingest({ level: "info", message: "after restart" })).status, 202, "the source secret still works");
      assert.equal((await settledEvents()).length, events + 1, "and its event is processed");
      assert.equal((await p.logs("cloudfriend")).match(/First boot: created a dashboard admin/g)?.length, 1, "no second admin password");
    });

    it("keeps everything when the containers are replaced (the volumes persist)", async () => {
      const events = (await settledEvents()).length;
      const flagCount = (await flags()).length;
      const old = [await p.container("cloudfriend"), await p.container("postgres")];
      await p.compose("down"); // containers and network go; the named volumes stay
      assert.deepEqual(await p.containers("cloudfriend"), []);
      await p.up();
      await connect();
      const now = [await p.container("cloudfriend"), await p.container("postgres")];
      assert.ok(now.every((id) => !old.includes(id)), "new containers");
      assert.doesNotMatch(await p.logs("cloudfriend"), /First boot/);
      assert.equal((await settledEvents()).length, events);
      assert.equal((await flags()).length, flagCount);
      assert.equal((await http.get("/api/me")).status, 200, "still signed in");
      assert.equal((await http.login("admin@localhost", password)).status, 200, "the generated password still works");
      assert.equal((await ingest({ level: "info", message: "new container" })).status, 202);
    });

    it("loses no accepted event when the app container is killed, and processes them on start", async () => {
      const crash = await ok(http.post(`${WS}/sources`, { name: "crash", kind: "json" }), 201);
      const src = { ...crash.source, secret: crash.secret };
      // A slow worker poll, so the kill lands while requests are still raw rows in the queue table.
      p.setEnv({ CLOUDFRIEND_POLL_INTERVAL: "2s" });
      await p.up(); // recreates the app container with the new setting
      await connect();
      deciderMode = "fail"; // and nothing that did get parsed can be decided before the crash
      const N = 50;
      const results = await Promise.all(Array.from({ length: N }, (_, n) => ingest({ level: "error", message: `crash-test worker died ${n}`, n }, { src })));
      assert.ok(results.every((r) => r.status === 202));
      const { queued } = (await (await fetch(`${base}/healthz`)).json()) as any;
      assert.ok(queued > 0, "some accepted requests are still unparsed at the moment of the kill");
      const app = await p.container("cloudfriend");
      await docker("kill", "--signal", "KILL", app); // no graceful shutdown, no flush
      assert.equal(await p.inspect(app, "{{.State.ExitCode}}"), "137");

      deciderMode = "ok";
      p.setEnv({ CLOUDFRIEND_POLL_INTERVAL: null });
      await p.up();
      await connect();
      const events = await eventually(async () => {
        const list = (await ok(http.get(`${WS}/events?source=${src.id}&limit=1000`))).events as any[];
        return list.length >= N && list.every((e) => e.decided) && list;
      }, 60_000);
      assert.equal(events.length, N, "every accepted event is there, none twice");
      assert.deepEqual(events.map((e) => e.data.n).sort((a, b) => a - b), [...Array(N).keys()]);
      assert.ok(events.some((e) => e.flag_id), "the crash events were judged and alerted on");
    });

    it("restarts the app by itself when its process dies", async () => {
      const app = await p.container("cloudfriend");
      const restarts = Number(await p.inspect(app, "{{.RestartCount}}"));
      // SIGKILL the Node process inside the container, as the kernel's OOM killer would.
      const killMain =
        "const fs=require('fs');for(const p of fs.readdirSync('/proc')){if(!/^\\d+$/.test(p)||+p===process.pid)continue;" +
        "try{if(fs.readFileSync('/proc/'+p+'/cmdline','utf8').includes('src/main.ts'))process.kill(+p,'SIGKILL')}catch{}}";
      await p.compose("exec", "-T", "cloudfriend", "node", "-e", killMain).catch(() => {});
      await eventually(
        async () => Number(await p.inspect(app, "{{.RestartCount}}")) > restarts && (await p.inspect(app, "{{.State.Health.Status}}")) === "healthy",
        90_000,
      );
      await connect();
      assert.equal((await http.get("/api/me")).status, 200);
    });

    it("rides out a Postgres restart without crashing", async () => {
      const app = await p.container("cloudfriend");
      const startedAt = await p.inspect(app, "{{.State.StartedAt}}");
      await p.compose("restart", "postgres");
      const ev = await testEvent(http, 60_000);
      assert.ok(ev.flag_id);
      assert.equal(await p.inspect(app, "{{.State.StartedAt}}"), startedAt, "the app kept running");
      assert.equal(await p.inspect(app, "{{.State.Status}}"), "running");
    });

    it("exits 0 on docker compose stop, well within the grace period", async () => {
      const app = await p.container("cloudfriend");
      const started = Date.now();
      await p.compose("stop", "cloudfriend");
      assert.equal(await p.inspect(app, "{{.State.ExitCode}}"), "0");
      assert.ok(Date.now() - started < 8_000, `took ${Date.now() - started}ms`);
      assert.match(await p.logs("cloudfriend"), /shutting down signal=SIGTERM/);
    });
  });

  describe("split web and worker (CLOUDFRIEND_ROLE=web, COMPOSE_PROFILES=split)", () => {
    let p: ComposeProject;
    let http: Client;

    before(() => {
      p = project("split", {
        CLOUDFRIEND_ROLE: "web",
        COMPOSE_PROFILES: "split",
        CLOUDFRIEND_LEASE_TTL: "4s",
        CLOUDFRIEND_LEASE_RENEW: "1s",
      });
    });

    it("runs web and worker on one fresh database, with one first-boot admin between them", async () => {
      await p.up();
      const services = (await p.compose("ps", "--format", "{{.Service}}")).split("\n").sort();
      assert.deepEqual(services, ["cloudfriend", "postgres", "worker"]);
      assert.match(await p.logs("cloudfriend"), /CLOUDFRIEND_ROLE=web/);
      assert.match(await p.logs("worker"), /CLOUDFRIEND_ROLE=worker/);
      assert.equal(await p.inspect(await p.container("worker"), "{{.State.Health.Status}}"), "healthy");

      // Both processes boot on the empty database at once; exactly one of them creates the admin.
      const logs = await p.logs();
      assert.equal(logs.match(/First boot: created a dashboard admin/g)?.length, 1, logs);
      const password = /password:\s+(\S+)/.exec(logs)![1]!;
      const base = await p.baseUrl();
      http = new Client((path, init) => fetch(base + path, init));
      assert.equal((await http.login("admin@localhost", password)).status, 200);
    });

    it("processes events end to end: web takes them in, the worker decides and delivers", async () => {
      await ok(http.post(`${WS}/destinations`, { name: "receiver", kind: "webhook", url: `http://host.docker.internal:${receiver.port}/split` }), 201);
      const ev = await testEvent(http);
      assert.equal(ev.judgment, "relevant");
      assert.ok(ev.flag_id);
      await eventually(async () => deliveries().some((r) => r.url === "/split" && r.headers["x-cloudfriend-flag-id"] === ev.flag_id));
      assert.ok(claimedEpoch(await p.logs("worker")) >= 1, "the worker holds the workspace");
      assert.equal(claimedEpoch(await p.logs("cloudfriend")), 0, "web never claims a workspace");
    });

    it("hands the work to a new worker once a killed worker's lease expires", async () => {
      const old = await p.container("worker");
      const epoch = claimedEpoch(await p.logs("worker"));
      await docker("kill", "--signal", "KILL", old); // its lease is not released
      await p.compose("rm", "-f", "worker");
      const { queue_id } = await ok(http.post(`${WS}/test-event`));
      await p.up();
      const fresh = await p.container("worker");
      assert.notEqual(fresh, old);
      const ev = await decided(http, queue_id);
      assert.ok(ev.flag_id);
      assert.equal(claimedEpoch(await p.logs("worker")), epoch + 1, "the new worker took the lease over");
      await eventually(async () => deliveries().some((r) => r.url === "/split" && r.headers["x-cloudfriend-flag-id"] === ev.flag_id));
    });
  });
});
