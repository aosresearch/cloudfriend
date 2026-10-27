// Tests the Docker image the way people run it: `docker run` with a volume, env config,
// mock OpenRouter and Slack on the host. Run with `npm run test:docker` (needs a Docker daemon).
// Set CLOUDFRIEND_IMAGE to test an existing image instead of building one.
//
// Not yet updated for Postgres: the image now needs CLOUDFRIEND_DATABASE_URL, which this file
// does not provide, so the container exits at boot. The volume at /data holds only trained
// model files now; events, flags and secrets live in Postgres.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { mockServer, waitFor } from "../helpers.ts";

const ROOT = path.join(import.meta.dirname, "../..");
const IMAGE = process.env.CLOUDFRIEND_IMAGE ?? "cloudfriend:test";
const RUN = randomBytes(3).toString("hex");
const VOLUME = `cloudfriend-test-${RUN}`;
const ADMIN = "docker-admin-key";
// Docker Desktop forwards host.docker.internal to the host's loopback. On Linux it is the
// bridge gateway, so the mocks have to listen on all interfaces there.
const MOCK_HOST = process.platform === "linux" ? "0.0.0.0" : "127.0.0.1";

const containers: string[] = [];

const execFileAsync = promisify(execFile);

/**
 * Run a docker command. Async on purpose: the mock OpenRouter and Slack live in this process,
 * so blocking the event loop (execFileSync) while the container waits on them would deadlock.
 */
async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/** stdout and stderr together, the way `docker logs` shows them in a terminal. */
async function logs(name: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync("docker", ["logs", name], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return stdout + stderr;
}

function inspect(name: string, format: string): Promise<string> {
  return docker("inspect", "--format", format, name);
}

/** Wait for an async check, polling every 100ms. */
async function eventually<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 20_000): Promise<T> {
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
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Split the decider prompt into the text of each numbered event. */
function promptEvents(body: string): string[] {
  const prompt: string = JSON.parse(body).messages[1].content;
  return prompt.split(/^\[\d+\] /m).slice(1);
}

describe(`docker image ${IMAGE}`, { timeout: 600_000 }, () => {
  let deciderMode: "ok" | "fail" = "ok";
  let openrouter: Awaited<ReturnType<typeof mockServer>>;
  let slack: Awaited<ReturnType<typeof mockServer>>;
  let name = "";
  let base = "";
  let secret = "";

  const env = () => ({
    CLOUDFRIEND_ADMIN_KEY: ADMIN,
    OPENROUTER_API_KEY: "sk-or-test",
    OPENROUTER_BASE_URL: `http://host.docker.internal:${openrouter.port}/api/v1`,
    SLACK_WEBHOOK_URL: `http://host.docker.internal:${slack.port}/services/T/B/X`,
    CLOUDFRIEND_BATCH_WAIT: "300ms",
  });

  /** `docker run -d -p ... -v <volume>:/data -e ...`, the README's command plus test settings. The volume holds model files. */
  async function start(opts: { volume?: boolean; env?: Record<string, string> } = {}): Promise<void> {
    name = `cloudfriend-test-${RUN}-${containers.length}`;
    const args = ["run", "-d", "--name", name, "-p", "127.0.0.1::8080", "--add-host=host.docker.internal:host-gateway"];
    if (opts.volume !== false) args.push("-v", `${VOLUME}:/data`);
    for (const [k, v] of Object.entries({ ...env(), ...opts.env })) args.push("-e", `${k}=${v}`);
    await docker(...args, IMAGE);
    containers.push(name);
    await connect();
  }

  async function connect(): Promise<void> {
    base = `http://${(await docker("port", name, "8080/tcp")).split("\n")[0]}`;
    await eventually(async () => (await fetch(`${base}/healthz`)).ok);
  }

  const api = async (p: string) => {
    const res = await fetch(base + p, { headers: { authorization: `Bearer ${ADMIN}` } });
    assert.equal(res.status, 200, `GET ${p}`);
    return (await res.json()) as any;
  };

  const ingest = (source: string, body: object, token = secret, query = "") =>
    fetch(`${base}/in/${source}${query}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  /** Event count once every accepted request has been parsed (so counts can't race the worker). */
  const settledEventCount = async () => {
    await eventually(async () => ((await (await fetch(`${base}/healthz`)).json()) as any).queued === 0);
    return (await api("/events?limit=1000")).events.length;
  };

  const slackTexts = () => slack.requests.map((r) => JSON.parse(r.body).text as string);

  before(async () => {
    await docker("version", "--format", "{{.Server.Version}}");
    if (!process.env.CLOUDFRIEND_IMAGE) {
      execFileSync("docker", ["build", "-t", IMAGE, ROOT], { stdio: ["ignore", "ignore", "inherit"] });
    }
    openrouter = await mockServer((req) => {
      if (deciderMode === "fail") return { status: 503, body: { error: { message: "upstream unavailable" } } };
      const flags: object[] = [];
      const events = promptEvents(req.body);
      const pick = (marker: string) => events.flatMap((text, i) => (text.includes(marker) ? [i] : []));
      const typeErrors = pick("TypeError");
      if (typeErrors.length) flags.push({ reason: "New TypeError in checkout", severity: "high", events: typeErrors });
      const recovered = pick("crash-test");
      if (recovered.length) flags.push({ reason: "Recovered after crash", severity: "medium", events: recovered });
      return { body: { choices: [{ message: { content: JSON.stringify({ flags }) } }] } };
    }, MOCK_HOST);
    slack = await mockServer(undefined, MOCK_HOST);
  });

  after(async () => {
    for (const c of containers) {
      try {
        await docker("rm", "-f", c);
      } catch {}
    }
    try {
      await docker("volume", "rm", "-f", VOLUME);
    } catch {}
    await openrouter?.close();
    await slack?.close();
  });

  it("starts as a non-root user and reports healthy", async () => {
    await start();
    assert.equal(await docker("exec", name, "id", "-u"), "1000");
    const health = await eventually(async () => {
      const s = await inspect(name, "{{.State.Health.Status}}");
      return s === "healthy" && s;
    });
    assert.equal(health, "healthy");
  });

  it("prints a first-boot ingest secret to the logs", async () => {
    const output = await logs(name);
    secret = /cloudfriend_[A-Za-z0-9_-]{43}/.exec(output)?.[0] ?? "";
    assert.ok(secret, `no secret in logs:\n${output}`);
    assert.match(output, /cloudfriend listening .*decider=openrouter actions=slack /);
  });

  it("turns a Sentry webhook into a flag in Slack", async () => {
    const res = await ingest(
      "sentry",
      {
        action: "created",
        installation: { uuid: "i" },
        data: {
          issue: {
            id: "4711",
            title: "TypeError: Cannot read properties of undefined (reading 'total')",
            culprit: "checkout/cart.ts",
            level: "error",
          },
        },
      },
      "",
      `?secret=${secret}`,
    );
    assert.equal(res.status, 202);
    await waitFor(() => slackTexts().includes("[high] New TypeError in checkout"), 20_000);

    const { flags } = await api("/flags");
    assert.equal(flags.length, 1);
    const detail = await api(`/flags/${flags[0].id}`);
    assert.equal(detail.events[0].group_key, "issue:4711");
    assert.deepEqual(detail.deliveries.map((d: any) => [d.action, d.status]), [["slack", "ok"]]);
  });

  it("manages secrets with the CLI through docker exec", async () => {
    const created = JSON.parse(await docker("exec", name, "cloudfriend", "secrets", "create", "posthog-prod", "--source", "posthog", "--json"));
    assert.match(created.secret, /^cloudfriend_/);
    assert.match(await docker("exec", name, "cloudfriend", "secrets", "list"), /posthog-prod\s+posthog/);

    // The running server sees a secret the CLI wrote, and its revocation, immediately.
    assert.equal((await ingest("posthog", { event: "signup" }, created.secret)).status, 202);
    assert.equal((await ingest("sentry", {}, created.secret)).status, 401, "scoped to posthog");
    await docker("exec", name, "cloudfriend", "secrets", "revoke", created.id);
    assert.equal((await ingest("posthog", { event: "signup" }, created.secret)).status, 401);
  });

  it("keeps events, flags and secrets across docker restart", async () => {
    const before = await settledEventCount();
    const started = Date.now();
    await docker("restart", name);
    assert.ok(Date.now() - started < 3_000, `restart took ${Date.now() - started}ms; shutdown waited on something`);
    await connect();
    assert.equal(await settledEventCount(), before);
    assert.equal((await api("/flags")).flags.length, 1);
    assert.equal((await ingest("myapp", { msg: "after restart" })).status, 202, "old secret still works");
    assert.equal((await logs(name)).match(/First boot/g)?.length, 1, "no second boot secret");
  });

  it("keeps everything when the container is replaced", async () => {
    const before = await settledEventCount();
    await docker("rm", "-f", name);
    await start();
    assert.doesNotMatch(await logs(name), /First boot/);
    assert.equal((await api("/flags")).flags.length, 1);
    assert.equal(await settledEventCount(), before);
    assert.equal((await ingest("myapp", { msg: "new container" })).status, 202);
  });

  it("loses no accepted event when the container is killed, and processes them on start", async () => {
    // A slow worker poll, so the kill lands while requests are still raw rows in the queue table.
    await docker("rm", "-f", name);
    await start({ env: { CLOUDFRIEND_POLL_INTERVAL: "2s" } });
    deciderMode = "fail"; // and nothing that did get parsed can be decided before the crash
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, (_, n) => ingest("crash", { marker: "crash-test", n })),
    );
    assert.ok(results.every((r) => r.status === 202));
    const { queued } = (await (await fetch(`${base}/healthz`)).json()) as any;
    assert.ok(queued > 0, "some accepted requests are still unparsed at the moment of the kill");
    await docker("kill", "--signal", "KILL", name); // no graceful shutdown, no flush
    assert.equal(await inspect(name, "{{.State.ExitCode}}"), "137");

    deciderMode = "ok";
    await docker("start", name);
    await connect();
    await waitFor(() => slackTexts().includes("[medium] Recovered after crash"), 30_000);

    const { events } = await api("/events?source=crash&limit=1000");
    assert.equal(events.length, N, "every accepted event is there, none twice");
    assert.deepEqual(events.map((e: any) => e.data.n).sort((a: number, b: number) => a - b), [...Array(N).keys()]);
    const flagged = new Set((await api("/flags?limit=1000")).flags.flatMap((f: any) => f.event_ids));
    assert.ok(events.every((e: any) => flagged.has(e.id)), "every crash event was decided and flagged");
  });

  it("exits 0 on docker stop, well within the grace period", async () => {
    const started = Date.now();
    await docker("stop", name);
    assert.equal(await inspect(name, "{{.State.ExitCode}}"), "0");
    assert.ok(Date.now() - started < 8_000, `took ${Date.now() - started}ms`);
    assert.match(await logs(name), /shutting down signal=SIGTERM/);
  });
});
