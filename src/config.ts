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
  /** Classifier, grouping, verdict cache and labels in front of the decider. */
  triage: boolean;
  /** Model file to load instead of the active (or built-in) one. */
  modelPath: string | null;
  auditRate: number;
  auditWaitMs: number;
  verdictTtlMs: number;
  perTemplate: number;
  novelGuard: boolean;
  knownTtlMs: number;
  /** 0 turns scheduled retraining off. */
  retrainIntervalMs: number;
  retrainMinLabels: number;
  /** How long a trained candidate runs in shadow before it may be promoted. 0 promotes at once. */
  shadowPeriodMs: number;
  /** Directory with a human-labelled safety set the gate must pass, or null. */
  safetySet: string | null;
  incidentWindowMs: number;
  humanLabelWeight: number;
  recallTarget: number;
  python: string;
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

function num(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number from ${min} to ${max}, got ${JSON.stringify(raw)}`);
  return n;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "on", "yes"].includes(raw)) return true;
  if (["0", "false", "off", "no"].includes(raw)) return false;
  throw new Error(`${name} must be on or off, got ${JSON.stringify(env[name])}`);
}

function list(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim() === "") return null;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const sync = (env.CLOUDFRIEND_SYNCHRONOUS ?? "FULL").toUpperCase();
  if (sync !== "FULL" && sync !== "NORMAL") throw new Error("CLOUDFRIEND_SYNCHRONOUS must be FULL or NORMAL");
  return {
    port: int(env, "PORT", 8080, 0),
    host: env.HOST || "0.0.0.0",
    dataDir: path.resolve(env.CLOUDFRIEND_DATA_DIR || "./data"),
    adminKey: env.CLOUDFRIEND_ADMIN_KEY ?? "",
    commitWindowMs: duration(env, "CLOUDFRIEND_COMMIT_WINDOW", "2ms"),
    synchronous: sync,
    maxQueue: int(env, "CLOUDFRIEND_MAX_QUEUE", 1_000_000),
    maxBodyBytes: int(env, "CLOUDFRIEND_MAX_BODY_BYTES", 1_048_576),
    batchSize: int(env, "CLOUDFRIEND_BATCH_SIZE", 100),
    batchWaitMs: duration(env, "CLOUDFRIEND_BATCH_WAIT", "10s"),
    deciderConcurrency: int(env, "CLOUDFRIEND_DECIDER_CONCURRENCY", 2),
    retentionMs: duration(env, "CLOUDFRIEND_RETENTION", "7d"),
    cleanupIntervalMs: duration(env, "CLOUDFRIEND_CLEANUP_INTERVAL", "1m"),
    decider: env.CLOUDFRIEND_DECIDER || "jev",
    actions: list(env.CLOUDFRIEND_ACTIONS),
    adapterDir: env.CLOUDFRIEND_ADAPTER_DIR ? path.resolve(env.CLOUDFRIEND_ADAPTER_DIR) : null,
    pollMs: duration(env, "CLOUDFRIEND_POLL_INTERVAL", "200ms"),
    triage: bool(env, "CLOUDFRIEND_TRIAGE", true),
    modelPath: env.CLOUDFRIEND_MODEL ? path.resolve(env.CLOUDFRIEND_MODEL) : null,
    auditRate: num(env, "CLOUDFRIEND_AUDIT_RATE", 0.01, 0, 1),
    auditWaitMs: duration(env, "CLOUDFRIEND_AUDIT_WAIT", "5m"),
    verdictTtlMs: duration(env, "CLOUDFRIEND_VERDICT_TTL", "15m"),
    perTemplate: int(env, "CLOUDFRIEND_EXAMPLES_PER_TEMPLATE", 3),
    novelGuard: bool(env, "CLOUDFRIEND_NOVEL_ERRORS", true),
    knownTtlMs: /^(off|0)$/i.test(env.CLOUDFRIEND_ESCALATED_TTL ?? "") ? 0 : duration(env, "CLOUDFRIEND_ESCALATED_TTL", "7d"),
    retrainIntervalMs: /^(off|0)$/i.test(env.CLOUDFRIEND_RETRAIN_INTERVAL ?? "") ? 0 : duration(env, "CLOUDFRIEND_RETRAIN_INTERVAL", "24h"),
    retrainMinLabels: int(env, "CLOUDFRIEND_RETRAIN_MIN_LABELS", 200),
    shadowPeriodMs: /^(off|0)$/i.test(env.CLOUDFRIEND_SHADOW_PERIOD ?? "") ? 0 : duration(env, "CLOUDFRIEND_SHADOW_PERIOD", "24h"),
    safetySet: env.CLOUDFRIEND_SAFETY_SET ? path.resolve(env.CLOUDFRIEND_SAFETY_SET) : null,
    incidentWindowMs: duration(env, "CLOUDFRIEND_INCIDENT_WINDOW", "30m"),
    humanLabelWeight: num(env, "CLOUDFRIEND_HUMAN_LABEL_WEIGHT", 5, 0, 1000),
    recallTarget: num(env, "CLOUDFRIEND_RECALL_TARGET", 0.995, 0.5, 1),
    python: env.CLOUDFRIEND_PYTHON || "python3",
  };
}
