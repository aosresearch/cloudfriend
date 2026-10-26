// Default decider: one chat completion per batch through OpenRouter (or any
// OpenAI-compatible endpoint via OPENROUTER_BASE_URL).
//
//   OPENROUTER_API_KEY        required
//   OPENROUTER_MODEL          default anthropic/claude-haiku-5.5
//   OPENROUTER_BASE_URL       default https://openrouter.ai/api/v1
//   SIEVE_DECIDER_INSTRUCTIONS extra context for the model, e.g. "Checkout is our most important flow."
//   SIEVE_EVENT_CHARS         max characters of each event shown to the model (default 1500)
import { compactJson } from "../../compact.ts";
import { defineDecider, SEVERITIES, type FlagDraft, type SieveEvent, type Severity } from "../../types.ts";

export const SYSTEM_PROMPT = `You are Sieve, a triage filter on a live stream of events from production systems: errors, logs, analytics events and alerts. Flag only what a person or an automated agent should look at now. Most events are routine; when nothing matters, return no flags.

Flag: new or unusual errors, error spikes or repeated failures, regressions after a deploy, crashes, outages, data loss or corruption, security problems (bursts of auth failures, suspicious access), and failures in money or growth paths such as checkout, payments and signup.
Do not flag: routine info logs, isolated handled errors, single minor warnings, normal user analytics, or "resolved" notifications unless they suggest flapping.

Group events with the same likely cause into one flag. For each flag give:
- reason: one specific sentence (max 160 characters) saying what happened and why it matters. Include counts, services or error names when the events show them.
- severity: "critical" (outage, data loss, security breach, money lost right now), "high" (user-facing breakage that needs attention today), "medium" (should be investigated), or "low" (worth knowing).
- events: the bracketed numbers of the events behind the flag.

Reply with JSON only, no prose: {"flags":[{"reason":"...","severity":"high","events":[0,3]}]}
If nothing needs attention reply {"flags":[]}.`;

export function buildPrompt(events: SieveEvent[], env: NodeJS.ProcessEnv): string {
  const maxChars = Number(env.SIEVE_EVENT_CHARS) || 1500;
  const lines = [`${events.length} events, oldest first:`, ""];
  events.forEach((e, i) => {
    const meta = [`source=${e.source}`, `received_at=${e.received_at}`];
    if (e.type) meta.push(`type=${e.type}`);
    if (e.group_key) meta.push(`group=${e.group_key}`);
    lines.push(`[${i}] ${meta.join(" ")}`, compactJson(e.data, { maxChars }), "");
  });
  return lines.join("\n");
}

/** Turn the model's reply into flag drafts, keeping only what is valid. */
export function parseReply(content: string, events: SieveEvent[]): FlagDraft[] {
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

export default defineDecider({
  enabled: (env) => Boolean(env.OPENROUTER_API_KEY),

  async decide(events, { env, signal }) {
    const base = (env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    const instructions = env.SIEVE_DECIDER_INSTRUCTIONS?.trim();
    const system = instructions ? `${SYSTEM_PROMPT}\n\nContext from the operator:\n${instructions}` : SYSTEM_PROMPT;
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
      headers: {
        authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "content-type": "application/json",
        "x-title": "Sieve",
      },
      body: JSON.stringify({
        model: env.OPENROUTER_MODEL || "anthropic/claude-haiku-5.5",
        temperature: 0,
        max_tokens: 2000,
        response_format: { type: "json_object" },
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
    return parseReply(content, events);
  },
});
