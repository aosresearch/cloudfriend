// Jev for the benchmark scripts. Offline by default: answers come only from recorded calls on
// disk, and nothing that could make a request is touched. Live calls happen only in `live`
// mode, which needs an explicit budget; an API key in the environment never turns them on.
//
// Every call is recorded with its exact prompt and raw reply, under a key that hashes all of
// what decides the answer (CACHE_KEY_VERSION 2): the model asked for, the effective system
// prompt (operator instructions included), the user prompt (events, context, open alerts),
// the request parameters, the reply schema version and the event length limit. A replay with
// any of those changed misses instead of reusing an answer to a different question.
//
// `ask` returns what happened, typed:
//   recorded     a valid recorded answer
//   live         a new call (live mode only)
//   miss         no record for this exact request (offline, or a live run that cannot call)
//   invalid      a record exists but is unusable: unreadable, or it doesn't match its request
//   unavailable  live mode, but the budget is spent or the call kept failing
// Only `recorded` and `live` are Jev's answers. Callers decide what a miss means
// (ml/evaluate.ts: stop, or censor the batch); it is never an answer.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { apiKey, chatRequest, complete, parseDecision, RESPONSE_SCHEMA_VERSION } from "../src/adapters/deciders/openrouter.ts";
import { JEV } from "../src/adapters/deciders/jev.ts";
import type { CloudfriendEvent, Decision, DeciderContext, FlagDraft, Judgment } from "../src/types.ts";

export const CACHE_KEY_VERSION = 2;
/** The event length limit the benchmark prompts use unless CLOUDFRIEND_EVENT_CHARS says otherwise. */
export const BENCHMARK_EVENT_CHARS = "800";

export interface JevCall {
  model: string;
  latency_ms: number;
  cost: number;
  cached: boolean;
}

export type JevAnswer =
  | { kind: "recorded" | "live"; decision: Decision; call: JevCall; key: string }
  | { kind: "miss"; key: string }
  | { kind: "invalid"; key: string; reason: string }
  | { kind: "unavailable"; key: string; reason: string };

export type JevMode = "offline" | "live";

export interface JevOptions {
  mode: JevMode;
  /** Live mode only, in USD; required there. */
  budget?: number;
  dir: string;
  env?: NodeJS.ProcessEnv;
}

/** What a request is, for the key and the record. */
export interface JevRequest {
  model: string;
  system: string;
  prompt: string;
  params: unknown;
  schema: number;
  event_chars: string;
}

/** JSON with object keys sorted at every level, so equal requests hash equally. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function cacheKey(r: JevRequest): string {
  return crypto.createHash("sha256").update(canonicalJson({ v: CACHE_KEY_VERSION, ...r })).digest("hex");
}

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** The exact request `ask` would make for these events. */
export function jevRequest(events: CloudfriendEvent[], env: NodeJS.ProcessEnv, openFlags: DeciderContext["openFlags"] = []): JevRequest {
  const r = chatRequest(events, env, JEV, openFlags);
  return { model: r.model, system: r.system, prompt: r.prompt, params: r.params, schema: RESPONSE_SCHEMA_VERSION, event_chars: env.CLOUDFRIEND_EVENT_CHARS ?? "" };
}

/** What is stored per call. Flags and judgments refer to events by their index in the prompt. */
export interface JevRecord {
  key_version: number;
  request: { model: string; system_sha256: string; params: unknown; schema: number; event_chars: string };
  model: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  latency_ms: number;
  flags: { reason: string; severity: string; events: number[]; update?: string }[];
  judgments?: { event: number; relevance: string }[];
  /** System prompt, a separator, then the user prompt: exactly what was sent. */
  prompt: string;
  response: string;
  /** Set by ml/rekey-cache.ts on records moved from an older key. */
  migrated?: unknown;
}

export const fullPrompt = (r: Pick<JevRequest, "system" | "prompt">) => `${r.system}\n\n---\n\n${r.prompt}`;

const RELEVANCE = new Set(["relevant", "benign", "uncertain"]);
const SEVERITY = new Set(["low", "medium", "high", "critical"]);

/**
 * Check a record against the request it is filed under and turn it into a decision, or say
 * why it can't be used. The stored decision must also be what its raw reply parses to.
 */
export function readRecord(rec: JevRecord, req: JevRequest, events: CloudfriendEvent[], openFlagIds: Set<string>): { decision: Decision } | { reason: string } {
  if (rec?.key_version !== CACHE_KEY_VERSION) return { reason: `key version ${rec?.key_version ?? "none"}` };
  if (rec.prompt !== fullPrompt(req)) return { reason: "the recorded prompt differs from the request" };
  if (rec.request?.model !== req.model || rec.request.system_sha256 !== sha256(req.system) || canonicalJson(rec.request.params) !== canonicalJson(req.params)) {
    return { reason: "the recorded request settings differ" };
  }
  if (rec.request.schema !== req.schema || rec.request.event_chars !== req.event_chars) return { reason: "the recorded schema or event limit differs" };
  const n = events.length;
  const okIndex = (i: unknown) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < n;
  if (!Array.isArray(rec.flags)) return { reason: "no flags array" };
  for (const f of rec.flags) {
    if (typeof f?.reason !== "string" || !SEVERITY.has(f.severity) || !Array.isArray(f.events) || !f.events.length || !f.events.every(okIndex)) {
      return { reason: "a flag is malformed" };
    }
  }
  if (rec.judgments !== undefined) {
    if (!Array.isArray(rec.judgments)) return { reason: "judgments is not an array" };
    for (const j of rec.judgments) if (!okIndex(j?.event) || !RELEVANCE.has(j.relevance)) return { reason: "a judgment is malformed" };
  }
  const flags: FlagDraft[] = rec.flags.map((f) => ({ reason: f.reason, severity: f.severity as FlagDraft["severity"], event_ids: f.events.map((i) => events[i]!.id), ...(f.update ? { update: f.update } : {}) }));
  const judgments: Judgment[] | undefined = rec.judgments?.map((j) => ({ event_id: events[j.event]!.id, relevance: j.relevance as Judgment["relevance"] }));
  let parsed: Decision;
  try {
    parsed = parseDecision(rec.response, events, openFlagIds);
  } catch (err) {
    return { reason: `the raw reply doesn't parse: ${(err as Error).message.slice(0, 100)}` };
  }
  if (canonicalJson({ f: parsed.flags, j: parsed.judgments ?? null }) !== canonicalJson({ f: flags, j: judgments ?? null })) {
    return { reason: "the stored decision differs from its raw reply" };
  }
  return { decision: { flags, judgments } };
}

export class Jev {
  /** Details of the most recent answer, for callers that record them (the demo export). */
  last: JevCall | null = null;
  spent = 0;
  /** Live calls made. */
  calls = 0;
  recorded = 0;
  misses = 0;
  invalid = 0;
  unavailable = 0;
  promptTokens = 0;
  completionTokens = 0;
  latencies: number[] = [];
  models = new Map<string, number>();
  readonly mode: JevMode;
  readonly budget: number;
  readonly dir: string;
  #env: NodeJS.ProcessEnv;

  constructor(o: JevOptions) {
    this.mode = o.mode;
    this.dir = o.dir;
    const env = o.env ?? process.env;
    // Only what shapes the prompt and the request; the key is read from it in live mode only.
    this.#env = { ...env, CLOUDFRIEND_EVENT_CHARS: env.CLOUDFRIEND_EVENT_CHARS ?? BENCHMARK_EVENT_CHARS };
    if (o.mode === "live") {
      if (!(o.budget !== undefined && o.budget > 0)) throw new Error("live Jev calls need an explicit --budget in USD");
      if (!apiKey(this.#env, JEV)) throw new Error("live Jev calls need JEV_API_KEY or OPENROUTER_API_KEY");
      this.budget = o.budget;
    } else if (o.mode === "offline") {
      this.budget = 0;
    } else throw new Error(`unknown Jev mode ${String(o.mode)}`);
  }

  /** How the answers went, for reports. */
  get outcomes() {
    return { recorded: this.recorded, live: this.calls, miss: this.misses, invalid: this.invalid, unavailable: this.unavailable };
  }

  async ask(events: CloudfriendEvent[], openFlags: DeciderContext["openFlags"] = []): Promise<JevAnswer> {
    const req = jevRequest(events, this.#env, openFlags);
    const key = cacheKey(req);
    const file = path.join(this.dir, key.slice(0, 2), key + ".json");
    const openIds = new Set((openFlags ?? []).map((f) => f.id));
    this.last = null;
    if (fs.existsSync(file)) {
      let rec: JevRecord;
      try {
        rec = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        this.invalid++;
        return { kind: "invalid", key, reason: "unreadable record" };
      }
      const r = readRecord(rec, req, events, openIds);
      if ("reason" in r) {
        this.invalid++;
        return { kind: "invalid", key, reason: r.reason };
      }
      this.recorded++;
      this.#count(rec);
      const call = (this.last = { model: rec.model, latency_ms: rec.latency_ms, cost: rec.usage?.cost ?? 0, cached: true });
      return { kind: "recorded", decision: r.decision, call, key };
    }
    if (this.mode !== "live") {
      this.misses++;
      return { kind: "miss", key };
    }
    if (this.spent >= this.budget) {
      this.unavailable++;
      return { kind: "unavailable", key, reason: "budget spent" };
    }
    return this.#call(events, openFlags, req, key, file);
  }

  async #call(events: CloudfriendEvent[], openFlags: DeciderContext["openFlags"], req: JevRequest, key: string, file: string): Promise<JevAnswer> {
    const started = Date.now();
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await complete(events, this.#env, AbortSignal.timeout(240_000), JEV, openFlags);
        const latency = Date.now() - started;
        const idx = new Map(events.map((e, i) => [e.id, i]));
        const record: JevRecord = {
          key_version: CACHE_KEY_VERSION,
          request: { model: req.model, system_sha256: sha256(req.system), params: req.params, schema: req.schema, event_chars: req.event_chars },
          model: res.model,
          usage: res.usage,
          latency_ms: latency,
          flags: res.flags.map((f) => ({ reason: f.reason, severity: f.severity, events: f.event_ids.map((id) => idx.get(id)!), ...(f.update ? { update: f.update } : {}) })),
          judgments: res.judgments?.map((j) => ({ event: idx.get(j.event_id)!, relevance: j.relevance })),
          prompt: res.record?.prompt ?? fullPrompt(req),
          response: res.record?.response ?? "",
        };
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(record));
        this.calls++;
        this.spent += res.usage.cost ?? 0;
        this.latencies.push(latency);
        this.#count(record);
        const call = (this.last = { model: res.model, latency_ms: latency, cost: res.usage.cost ?? 0, cached: false });
        return { kind: "live", decision: { flags: res.flags, judgments: res.judgments }, call, key };
      } catch (err) {
        if (attempt >= 3) {
          console.error(`jev call failed, treating as unavailable: ${(err as Error).message}`);
          this.unavailable++;
          return { kind: "unavailable", key, reason: (err as Error).message.slice(0, 200) };
        }
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }

  #count(rec: { model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } }) {
    this.promptTokens += rec.usage?.prompt_tokens ?? 0;
    this.completionTokens += rec.usage?.completion_tokens ?? 0;
    if (rec.model) this.models.set(rec.model, (this.models.get(rec.model) ?? 0) + 1);
  }
}
