// Jev for the benchmark scripts: real calls through OpenRouter, cached on disk by prompt
// hash so reruns are free, and stopped at a budget.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildPrompt, complete, SYSTEM_PROMPT } from "../src/adapters/deciders/openrouter.ts";
import { JEV } from "../src/adapters/deciders/jev.ts";
import type { CloudfriendEvent, FlagDraft } from "../src/types.ts";

export interface JevCall {
  model: string;
  latency_ms: number;
  cost: number;
  cached: boolean;
}

export class Jev {
  /** Details of the most recent call, for callers that record them (the demo export). */
  last: JevCall | null = null;
  spent = 0;
  calls = 0;
  cachedCalls = 0;
  skipped = 0;
  promptTokens = 0;
  completionTokens = 0;
  latencies: number[] = [];
  models = new Map<string, number>();
  #env: NodeJS.ProcessEnv = { ...process.env, CLOUDFRIEND_EVENT_CHARS: process.env.CLOUDFRIEND_EVENT_CHARS ?? "800" };
  readonly live: boolean;
  readonly budget: number;
  readonly dir: string;
  constructor(live: boolean, budget: number, dir: string) {
    this.live = live;
    this.budget = budget;
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  /** Flags for these events, or null when Jev is unavailable (dry run or out of budget). */
  async ask(events: CloudfriendEvent[]): Promise<FlagDraft[] | null> {
    const prompt = buildPrompt(events, this.#env);
    const model = this.#env.JEV_MODEL || JEV.model;
    const key = crypto.createHash("sha256").update(model + "\0" + SYSTEM_PROMPT + "\0" + prompt).digest("hex");
    const file = path.join(this.dir, key.slice(0, 2), key + ".json");
    if (fs.existsSync(file)) {
      const hit = JSON.parse(fs.readFileSync(file, "utf8"));
      this.cachedCalls++;
      this.#count(hit);
      this.last = { model: hit.model, latency_ms: hit.latency_ms, cost: hit.usage?.cost ?? 0, cached: true };
      return hit.flags.map((f: any) => ({ ...f, event_ids: f.events.map((i: number) => events[i]!.id) }));
    }
    if (!this.live || this.spent >= this.budget) {
      this.skipped++;
      this.promptTokens += Math.round(prompt.length / 3.5);
      this.last = null;
      return null;
    }
    const started = Date.now();
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await complete(events, this.#env, AbortSignal.timeout(240_000), JEV);
        const latency = Date.now() - started;
        const idx = new Map(events.map((e, i) => [e.id, i]));
        const record = {
          model: res.model,
          usage: res.usage,
          latency_ms: latency,
          flags: res.flags.map((f) => ({ reason: f.reason, severity: f.severity, events: f.event_ids.map((id) => idx.get(id)) })),
        };
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(record));
        this.calls++;
        this.spent += res.usage.cost ?? 0;
        this.latencies.push(latency);
        this.#count(record);
        this.last = { model: res.model, latency_ms: latency, cost: res.usage.cost ?? 0, cached: false };
        return res.flags;
      } catch (err) {
        if (attempt >= 3) {
          console.error(`jev call failed, treating as unavailable: ${(err as Error).message}`);
          this.skipped++;
          return null;
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

