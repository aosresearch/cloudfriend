// Default decider: one chat completion per batch through OpenRouter (or any
// OpenAI-compatible endpoint via OPENROUTER_BASE_URL).
//
//   OPENROUTER_API_KEY        required
//   OPENROUTER_MODEL          default anthropic/claude-haiku-5.5
//   OPENROUTER_BASE_URL       default https://openrouter.ai/api/v1
//   CLOUDFRIEND_DECIDER_INSTRUCTIONS extra context for the model, e.g. "Checkout is our most important flow."
//   CLOUDFRIEND_EVENT_CHARS         max characters of each event shown to the model (default 1500)
import { compactJson } from "../../compact.ts";
import {
  defineDecider,
  SEVERITIES,
  type CloudfriendEvent,
  type Decision,
  type DeciderContext,
  type FlagDraft,
  type Judgment,
  type Severity,
} from "../../types.ts";

export const SYSTEM_PROMPT = `You are cloudfriend, a triage filter on a live stream of events from production systems: errors, logs, analytics events and alerts. You make two separate decisions about the numbered events you are shown.

1. A judgment for every event: is it relevant, meaning a problem or a symptom of a problem that a person or an automated agent should know about? Judge each event on its own merits, even if it is a duplicate of something already reported.
- "relevant": new or unusual errors, error spikes or repeated failures, regressions after a deploy, crashes, outages, data loss or corruption, security problems (bursts of auth failures, suspicious access, secrets or card data in logs), and failures in money or growth paths such as checkout, payments and signup. A service process that crashes, is killed or exits with an error (SIGTERM, SIGKILL, non-zero exit, crash loop) is a crash unless the events show a planned deploy.
- "benign": routine info logs, expected or handled conditions, normal user analytics, health checks, "resolved" notices that don't suggest flapping.
- "uncertain": you can't tell from what is shown. Prefer this to guessing.

2. Alerts: which relevant events should notify someone now. Group events with the same likely cause into one alert. If they continue an open alert listed below, put that alert's id in "update" instead of raising a new one. Relevant events need not all be in an alert; isolated minor ones can stay unalerted.

Each event line may carry context counted over everything the system received, including events not shown: seen_total, last_1m / last_10m / last_hour (how many of this kind recently), usual_per_hour, first_seen_min_ago, service_errors_10m. similar_in_batch counts near-identical events this one stands for.

For each alert give:
- reason: one specific sentence (max 160 characters) saying what happened and why it matters. Include counts, services or error names.
- severity: "critical" (outage, data loss, security breach, money lost right now), "high" (user-facing breakage that needs attention today), "medium" (should be investigated), or "low" (worth knowing).
- events: the bracketed numbers of the events behind it.
- update: optional, the id of the open alert these events continue.

Reply with JSON only, no prose, with exactly one judgment per event:
{"judgments":[{"event":0,"relevance":"benign"},{"event":1,"relevance":"relevant"}],"alerts":[{"reason":"...","severity":"high","events":[1]}]}`;

export function buildPrompt(events: CloudfriendEvent[], env: NodeJS.ProcessEnv, openFlags: DeciderContext["openFlags"] = []): string {
  const maxChars = Number(env.CLOUDFRIEND_EVENT_CHARS) || 1500;
  const lines: string[] = [];
  if (openFlags?.length) {
    lines.push("Open alerts:");
    for (const f of openFlags.slice(0, 20)) lines.push(`- ${f.id} (${f.severity}) ${f.reason}`);
    lines.push("");
  }
  lines.push(`${events.length} events, oldest first:`, "");
  events.forEach((e, i) => {
    const meta = [`source=${e.source}`, `received_at=${e.received_at}`];
    if (e.type) meta.push(`type=${e.type}`);
    if (e.group_key) meta.push(`group=${e.group_key}`);
    if (e.triage) {
      // The classifier's score is deliberately not shown: the decider is the classifier's
      // teacher, and its verdicts must not lean on the student's guess.
      if (e.triage.similar) meta.push(`similar_in_batch=${e.triage.similar}`);
      const c = e.triage.context;
      if (c) for (const [k, v] of Object.entries(c)) meta.push(`${k}=${v}`);
    }
    lines.push(`[${i}] ${meta.join(" ")}`, compactJson(e.data, { maxChars }), "");
  });
  return lines.join("\n");
}

const RELEVANCE = new Set(["relevant", "benign", "uncertain"]);

/** An event index as the model wrote it: an integer, or a string of digits. Nothing else. */
function eventIndex(v: unknown, n: number): number | null {
  const i = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(i) && i >= 0 && i < n ? i : null;
}

/**
 * Read a reply in the current format ({judgments, alerts}) or the v0 one ({flags}). Invalid
 * entries are dropped; an event without a valid judgment simply has none.
 */
export function parseDecision(content: string, events: CloudfriendEvent[], openFlagIds: Set<string> = new Set()): Decision {
  const parsed = parseJson(content);
  const hasJudgments = Array.isArray(parsed?.judgments);
  // Judgments without alerts mean "nothing to alert on"; neither means the reply is unusable.
  const alerts = Array.isArray(parsed?.alerts) ? parsed.alerts : Array.isArray(parsed?.flags) ? parsed.flags : hasJudgments ? [] : null;
  if (!alerts) throw new Error("model reply has no alerts array");
  const flags = toDrafts(alerts, events);
  alerts.forEach((a: any, i: number) => {
    const id = typeof a?.update === "string" ? a.update.trim() : "";
    const draft = flags.find((f) => f.__index === i);
    if (draft && id && openFlagIds.has(id)) draft.update = id;
  });
  const judgments: Judgment[] = [];
  const seen = new Set<number>();
  for (const j of Array.isArray(parsed?.judgments) ? parsed.judgments : []) {
    const n = eventIndex(j?.event, events.length);
    const r = typeof j?.relevance === "string" ? j.relevance.trim().toLowerCase() : "";
    if (n === null || !RELEVANCE.has(r) || seen.has(n)) continue;
    seen.add(n);
    judgments.push({ event_id: events[n]!.id, relevance: r as Judgment["relevance"] });
  }
  return { flags: flags.map(({ __index, ...f }) => f), judgments: hasJudgments ? judgments : undefined };
}

function parseJson(content: string): any {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`model reply has no JSON object: ${content.slice(0, 200)}`);
  return JSON.parse(content.slice(start, end + 1));
}

function toDrafts(items: unknown[], events: CloudfriendEvent[]): (FlagDraft & { __index: number })[] {
  const out: (FlagDraft & { __index: number })[] = [];
  items.forEach((f: any, i) => {
    if (!f || typeof f.reason !== "string" || !f.reason.trim()) return;
    const idx: unknown[] = Array.isArray(f.events) ? f.events : Array.isArray(f.event_ids) ? f.event_ids : [];
    const ids = [...new Set(idx.map((v) => eventIndex(v, events.length)).filter((n): n is number => n !== null))].map((n) => events[n]!.id);
    if (!ids.length) return;
    const sev = String(f.severity ?? "").toLowerCase();
    out.push({
      reason: f.reason.trim().slice(0, 500),
      severity: (SEVERITIES as readonly string[]).includes(sev) ? (sev as Severity) : "medium",
      event_ids: ids,
      __index: i,
    });
  });
  return out;
}

/** Flag drafts from a reply, in either format. */
export function parseReply(content: string, events: CloudfriendEvent[]): FlagDraft[] {
  const parsed = parseJson(content);
  const items = Array.isArray(parsed?.alerts) ? parsed.alerts : Array.isArray(parsed?.flags) ? parsed.flags : null;
  if (!items) throw new Error("model reply has no flags array");
  return toDrafts(items, events).map(({ __index, ...f }) => f);
}

export interface ChatDefaults {
  /** Env var holding the API key, checked before OPENROUTER_API_KEY. */
  keyVar?: string;
  /** Env var naming the model, checked before OPENROUTER_MODEL. */
  modelVar?: string;
  model: string;
  title: string;
}

export interface Completion extends Decision {
  flags: FlagDraft[];
  /** What OpenRouter reports for the call: tokens and, when it knows, cost in USD. */
  usage: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  model: string;
}

export const apiKey = (env: NodeJS.ProcessEnv, d: Pick<ChatDefaults, "keyVar">) =>
  (d.keyVar && env[d.keyVar]) || env.OPENROUTER_API_KEY || "";

/** One chat completion over a batch of events. Throws on any failure so the batch is retried. */
export async function complete(
  events: CloudfriendEvent[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  d: ChatDefaults,
  openFlags: DeciderContext["openFlags"] = [],
): Promise<Completion> {
  const base = (env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const instructions = env.CLOUDFRIEND_DECIDER_INSTRUCTIONS?.trim();
  const system = instructions ? `${SYSTEM_PROMPT}\n\nContext from the operator:\n${instructions}` : SYSTEM_PROMPT;
  const model = (d.modelVar && env[d.modelVar]) || env.OPENROUTER_MODEL || d.model;
  const prompt = buildPrompt(events, env, openFlags);
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
    headers: {
      authorization: `Bearer ${apiKey(env, d)}`,
      "content-type": "application/json",
      "x-title": d.title,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 4000,
      response_format: { type: "json_object" },
      usage: { include: true },
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text);
  if (body.error) throw new Error(`OpenRouter error: ${JSON.stringify(body.error).slice(0, 300)}`);
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("OpenRouter reply has no message content");
  const decision = parseDecision(content, events, new Set((openFlags ?? []).map((f) => f.id)));
  return {
    ...decision,
    usage: body.usage ?? {},
    model: body.model ?? model,
    record: { model: body.model ?? model, prompt: `${system}\n\n---\n\n${prompt}`, response: content },
  };
}

const DEFAULTS: ChatDefaults = { model: "anthropic/claude-haiku-5.5", title: "cloudfriend" };

export default defineDecider({
  enabled: (env) => Boolean(env.OPENROUTER_API_KEY),
  async decide(events, { env, signal, openFlags }) {
    const { flags, judgments, record } = await complete(events, env, signal, DEFAULTS, openFlags);
    return { flags, judgments, record };
  },
});
