import path from "node:path";

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  /** Empty string disables the admin API. */
  adminKey: string;
  /** Flush ingest writes every this many ms (group commit window). */
  commitWindowMs: number;
  /** `FULL` survives power loss; `NORMAL` only survives a crashed process. */
  synchronous: "FULL" | "NORMAL";
  /** Reply 503 once this many requests are queued but not yet parsed. */
  maxQueue: number;
  /** Reject request bodies above this size with 413. */
  maxBodyBytes: number;
  batchSize: number;
  batchWaitMs: number;
  deciderConcurrency: number;
  retentionMs: number;
  cleanupIntervalMs: number;
  decider: string;
  /** null means "every action whose `enabled()` says yes". */
  actions: string[] | null;
  /** Extra directory with `sources/`, `deciders/`, `actions/` subfolders of custom adapters. */
  adapterDir: string | null;
  /** How often the worker looks for new work when idle. */
  pollMs: number;
}

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse "10s", "7d", "250ms", "1.5h". A bare number is milliseconds. */
export function parseDuration(value: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/.exec(value);
  if (!m) throw new Error(`invalid duration: ${JSON.stringify(value)} (use e.g. 10s, 5m, 7d)`);
  return Math.round(Number(m[1]) * UNITS[m[2] ?? "ms"]!);
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 1): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}, got ${JSON.stringify(raw)}`);
  return n;
}

function duration(env: NodeJS.ProcessEnv, name: string, fallback: string): number {
  const raw = env[name];
  try {
    return parseDuration(raw === undefined || raw === "" ? fallback : raw);
  } catch (err) {
    throw new Error(`${name}: ${(err as Error).message}`);
  }
}

function list(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim() === "") return null;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const sync = (env.SIEVE_SYNCHRONOUS ?? "FULL").toUpperCase();
  if (sync !== "FULL" && sync !== "NORMAL") throw new Error("SIEVE_SYNCHRONOUS must be FULL or NORMAL");
  return {
    port: int(env, "PORT", 8080, 0),
    host: env.HOST || "0.0.0.0",
    dataDir: path.resolve(env.SIEVE_DATA_DIR || "./data"),
    adminKey: env.SIEVE_ADMIN_KEY ?? "",
    commitWindowMs: duration(env, "SIEVE_COMMIT_WINDOW", "2ms"),
    synchronous: sync,
    maxQueue: int(env, "SIEVE_MAX_QUEUE", 1_000_000),
    maxBodyBytes: int(env, "SIEVE_MAX_BODY_BYTES", 1_048_576),
    batchSize: int(env, "SIEVE_BATCH_SIZE", 100),
    batchWaitMs: duration(env, "SIEVE_BATCH_WAIT", "10s"),
    deciderConcurrency: int(env, "SIEVE_DECIDER_CONCURRENCY", 2),
    retentionMs: duration(env, "SIEVE_RETENTION", "7d"),
    cleanupIntervalMs: duration(env, "SIEVE_CLEANUP_INTERVAL", "1m"),
    decider: env.SIEVE_DECIDER || "openrouter",
    actions: list(env.SIEVE_ACTIONS),
    adapterDir: env.SIEVE_ADAPTER_DIR ? path.resolve(env.SIEVE_ADAPTER_DIR) : null,
    pollMs: duration(env, "SIEVE_POLL_INTERVAL", "200ms"),
  };
}
