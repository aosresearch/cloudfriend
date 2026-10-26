// Default decider: one chat completion per batch through OpenRouter (or any
// OpenAI-compatible endpoint via OPENROUTER_BASE_URL).
//
//   OPENROUTER_API_KEY        required
//   OPENROUTER_MODEL          default anthropic/claude-haiku-5.5
//   OPENROUTER_BASE_URL       default https://openrouter.ai/api/v1
//   CLOUDFRIEND_DECIDER_INSTRUCTIONS extra context for the model, e.g. "Checkout is our most important flow."
//   CLOUDFRIEND_EVENT_CHARS         max characters of each event shown to the model (default 1500)
import { compactJson } from "../../compact.ts";
import { defineDecider, SEVERITIES, type FlagDraft, type CloudfriendEvent, type Severity } from "../../types.ts";

export const SYSTEM_PROMPT = `You are cloudfriend, a triage filter on a live stream of events from production systems: errors, logs, analytics events and alerts. Flag only what a person or an automated agent should look at now. Most events are routine; when nothing matters, return no flags.

Flag: new or unusual errors, error spikes or repeated failures, regressions after a deploy, crashes, outages, data loss or corruption, security problems (bursts of auth failures, suspicious access), and failures in money or growth paths such as checkout, payments and signup. A service process that crashes, is killed or exits with an error (SIGTERM, SIGKILL, non-zero exit, crash loop) counts as a crash unless the events show a planned deploy.
Do not flag: routine info logs, isolated handled errors, single minor warnings, normal user analytics, or "resolved" notifications unless they suggest flapping.

Some events were pre-screened by a fast classifier. classifier_score (0 to 1) is its estimate that the event needs attention: a hint, not a verdict. similar_events_not_shown counts near-identical events that this one stands for, so a burst may be larger than it looks.

Group events with the same likely cause into one flag. For each flag give:
- reason: one specific sentence (max 160 characters) saying what happened and why it matters. Include counts, services or error names when the events show them.
- severity: "critical" (outage, data loss, security breach, money lost right now), "high" (user-facing breakage that needs attention today), "medium" (should be investigated), or "low" (worth knowing).
- events: the bracketed numbers of the events behind the flag.

Reply with JSON only, no prose: {"flags":[{"reason":"...","severity":"high","events":[0,3]}]}
If nothing needs attention reply {"flags":[]}.`;

export function buildPrompt(events: CloudfriendEvent[], env: NodeJS.ProcessEnv): string {
  const maxChars = Number(env.CLOUDFRIEND_EVENT_CHARS) || 1500;
  const lines = [`${events.length} events, oldest first:`, ""];
  events.forEach((e, i) => {
    const meta = [`source=${e.source}`, `received_at=${e.received_at}`];
    if (e.type) meta.push(`type=${e.type}`);
    if (e.group_key) meta.push(`group=${e.group_key}`);
    if (e.triage) {
      meta.push(`classifier_score=${e.triage.score.toFixed(2)}`);
      if (e.triage.similar) meta.push(`similar_events_not_shown=${e.triage.similar}`);
    }
    lines.push(`[${i}] ${meta.join(" ")}`, compactJson(e.data, { maxChars }), "");
  });
  return lines.join("\n");
}

/** Turn the model's reply into flag drafts, keeping only what is valid. */
export function parseReply(content: string, events: CloudfriendEvent[]): FlagDraft[] {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`model reply has no JSON object: ${content.slice(0, 200)}`);
  const parsed = JSON.parse(content.slice(start, end + 1));
  if (!Array.isArray(parsed?.flags)) throw new Error("model reply has no flags array");
  const out: FlagDraft[] = [];
  for (const f of parsed.flags) {
    if (!f || typeof f.reason !== "string" || !f.reason.trim()) continue;
    const idx: unknown[] = Array.isArray(f.events) ? f.events : Array.isArray(f.event_ids) ? f.event_ids : [];
    const ids = [...new Set(idx.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < events.length))].map(
      (n) => events[n]!.id,
    );
    if (!ids.length) continue;
    const sev = String(f.severity ?? "").toLowerCase();
    out.push({
      reason: f.reason.trim().slice(0, 500),
      severity: (SEVERITIES as readonly string[]).includes(sev) ? (sev as Severity) : "medium",
      event_ids: ids,
    });
  }
  return out;
}

export interface ChatDefaults {
  /** Env var holding the API key, checked before OPENROUTER_API_KEY. */
  keyVar?: string;
  /** Env var naming the model, checked before OPENROUTER_MODEL. */
  modelVar?: string;
  model: string;
  title: string;
}

export interface Completion {
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
): Promise<Completion> {
  const base = (env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const instructions = env.CLOUDFRIEND_DECIDER_INSTRUCTIONS?.trim();
  const system = instructions ? `${SYSTEM_PROMPT}\n\nContext from the operator:\n${instructions}` : SYSTEM_PROMPT;
  const model = (d.modelVar && env[d.modelVar]) || env.OPENROUTER_MODEL || d.model;
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
        { role: "user", content: buildPrompt(events, env) },
      ],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text);
  if (body.error) throw new Error(`OpenRouter error: ${JSON.stringify(body.error).slice(0, 300)}`);
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("OpenRouter reply has no message content");
  return { flags: parseReply(content, events), usage: body.usage ?? {}, model: body.model ?? model };
}

const DEFAULTS: ChatDefaults = { model: "anthropic/claude-haiku-5.5", title: "cloudfriend" };

export default defineDecider({
  enabled: (env) => Boolean(env.OPENROUTER_API_KEY),
  async decide(events, { env, signal }) {
    return (await complete(events, env, signal, DEFAULTS)).flags;
  },
});
