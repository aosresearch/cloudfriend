// A Docker Compose project for the Docker tests: the repository's docker-compose.yml, run the way
// a self-hoster runs it (a .env made from .env.example, `docker compose up -d`), in a temporary
// project directory with a unique project name, plus a small override for the test host.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const ROOT = path.join(import.meta.dirname, "../..");

/**
 * The environment for docker commands. Shell variables override .env during Compose interpolation,
 * so anything that could leak in from the developer's shell (COMPOSE_PROFILES, POSTGRES_PASSWORD,
 * CLOUDFRIEND_PORT, ...) is left out.
 */
function dockerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(COMPOSE_|CLOUDFRIEND_|POSTGRES_|PG|JEV_|OPENROUTER_|SLACK_|WEBHOOK_)/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

/**
 * Run a command. Async on purpose: the mock decider and receiver live in this process, so blocking
 * the event loop (execFileSync) while a container waits on them would deadlock.
 */
export async function run(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<string> {
  const started = Date.now();
  try {
    const { stdout } = await execFileAsync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: dockerEnv(), cwd: opts.cwd });
    if (process.env.TRACE_DOCKER) console.error(`[${Date.now() - started}ms] ${cmd} ${args.filter((a) => !a.startsWith("/")).join(" ")}`);
    return stdout.trim();
  } catch (err: any) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${err.stderr || err.message}`);
  }
}

export const docker = (...args: string[]) => run("docker", args);

/** Values for .env; null comments a line out. */
export type EnvValues = Record<string, string | null>;

/**
 * .env.example with `values` filled in: an existing line for the key, commented out or not, is
 * replaced; keys it doesn't mention are appended under a test section.
 */
export function envFile(values: EnvValues): string {
  const lines = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8").split("\n");
  const extra: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const line = value === null ? `# ${key}=` : `${key}=${value}`;
    const at = lines.findIndex((l) => new RegExp(`^#?\\s*${key}=`).test(l));
    if (at >= 0) lines[at] = line;
    else if (value !== null) extra.push(line);
  }
  return [...lines, ...(extra.length ? ["# --- test settings", ...extra] : [])].join("\n") + "\n";
}

export class ComposeProject {
  readonly name: string;
  readonly dir: string;
  #env: EnvValues;

  /**
   * @param image the image tag the services use. With `build`, `docker compose build` builds it
   * from this checkout; without, it must exist already (CLOUDFRIEND_IMAGE).
   */
  constructor(name: string, opts: { image: string; build: boolean; env: EnvValues }) {
    this.name = name;
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    this.#env = { ...opts.env };
    // Only what the test host needs on top of docker-compose.yml: the image tag, a random
    // loopback port instead of 8080, and host.docker.internal on Linux too (Docker Desktop has it).
    const app = (extra: string[] = []) => [
      `    image: ${opts.image}`,
      opts.build ? `    build: { context: ${JSON.stringify(ROOT)} }` : "    build: !reset null",
      `    extra_hosts: ["host.docker.internal:host-gateway"]`,
      ...extra,
    ];
    fs.writeFileSync(
      path.join(this.dir, "compose.test.yml"),
      ["services:", "  cloudfriend:", ...app([`    ports: !override ["127.0.0.1::8080"]`]), "  worker:", ...app(), ""].join("\n"),
    );
    this.#writeEnv();
  }

  #writeEnv(): void {
    fs.writeFileSync(path.join(this.dir, ".env"), envFile(this.#env));
  }

  /** Change .env, as a self-hoster edits it. Takes effect at the next `up`. */
  setEnv(values: EnvValues): void {
    Object.assign(this.#env, values);
    this.#writeEnv();
  }

  /** `docker compose ...` in this project. */
  compose(...args: string[]): Promise<string> {
    return run("docker", [
      "compose",
      "--project-name", this.name,
      "--project-directory", this.dir,
      "-f", path.join(ROOT, "docker-compose.yml"),
      "-f", path.join(this.dir, "compose.test.yml"),
      ...args,
    ]);
  }

  /** `docker compose up -d --wait`: returns once every service is running and healthy. */
  up(...args: string[]): Promise<string> {
    return this.compose("up", "-d", "--wait", "--wait-timeout", "120", ...args);
  }

  /** Container ids of a service, running or not. */
  async containers(service: string): Promise<string[]> {
    const out = await this.compose("ps", "-a", "-q", service);
    return out ? out.split("\n") : [];
  }

  async container(service: string): Promise<string> {
    const ids = await this.containers(service);
    if (ids.length !== 1) throw new Error(`expected one ${service} container, found ${ids.length}`);
    return ids[0]!;
  }

  /** The service's address on the host. */
  async baseUrl(service = "cloudfriend"): Promise<string> {
    return `http://${(await this.compose("port", service, "8080")).split("\n")[0]}`;
  }

  /** stdout and stderr of a service (or all of them), without the service-name prefix. */
  async logs(service?: string): Promise<string> {
    return this.compose("logs", "--no-color", "--no-log-prefix", ...(service ? [service] : []));
  }

  inspect(container: string, format: string): Promise<string> {
    return docker("inspect", "--format", format, container);
  }

  /** Remove every container, network and volume of the project, and its directory. */
  async destroy(): Promise<void> {
    await this.compose("down", "--volumes", "--remove-orphans", "--timeout", "2").catch((err) => console.error(String(err)));
    // Whatever `down` missed (e.g. a container started under a profile no longer in .env).
    const label = `label=com.docker.compose.project=${this.name}`;
    for (const [list, rm] of [
      [["ps", "-aq"], ["rm", "-f"]],
      [["volume", "ls", "-q"], ["volume", "rm", "-f"]],
      [["network", "ls", "-q"], ["network", "rm"]],
    ] as const) {
      const ids = (await docker(...list, "--filter", label).catch(() => "")).split("\n").filter(Boolean);
      if (ids.length) await docker(...rm, ...ids).catch((err) => console.error(String(err)));
    }
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
