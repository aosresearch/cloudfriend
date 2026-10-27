// Shared types. Adapter authors only need the types in the "Adapters" section.

/** An event as cloudfriend stores it and hands it to deciders and the read API. */
export interface CloudfriendEvent {
  /** cloudfriend's own id for the event, unique and never reused. */
  id: string;
  /** The source name from the ingest URL, e.g. `sentry` for `POST /in/sentry`. */
  source: string;
  /** When cloudfriend accepted the request, ISO 8601. */
  received_at: string;
  /** The raw payload, exactly as the source adapter parsed it. */
  data: unknown;
  /** Optional hints a source adapter pulled out. Deciders must not depend on them. */
  external_id?: string;
  type?: string;
  group_key?: string;
  /** Triage results, when the classifier ran: user id found in the event, score and route. */
  user?: string;
  score?: number;
  route?: string;
  /**
   * Set when the classifier passed this event on to the decider: its score (deciders should
   * not show it to a model they learn from), how many near-identical events in this batch
   * share its verdict, and what is known about its kind of event (counts include events the
   * classifier dropped).
   */
  triage?: { score: number; similar: number; context?: TemplateContext | null };
}

export interface TemplateContext {
  seen_total: number;
  last_1m: number;
  last_10m: number;
  last_hour: number;
  usual_per_hour: number;
  first_seen_min_ago: number;
  service_events_10m?: number;
  service_errors_10m?: number;
}

export type Severity = "low" | "medium" | "high" | "critical";
export const SEVERITIES: readonly Severity[] = ["low", "medium", "high", "critical"];

/** What a decider returns: a reason, a severity and the events behind it. */
export interface FlagDraft {
  reason: string;
  severity: Severity;
  event_ids: string[];
  /** Id of an open flag these events continue: they are added to it and nobody is notified again. */
  update?: string;
}

/**
 * Whether one event deserves attention, separate from whether to notify about it. A
 * duplicate symptom of an open incident is `relevant` even though it raises no new flag.
 * Only explicit judgments become training labels; `uncertain` or a missing judgment never does.
 */
export interface Judgment {
  event_id: string;
  relevance: "relevant" | "benign" | "uncertain";
}

/** What a decider returns: flags, optionally a judgment per event, and a record of the call. */
export interface Decision {
  flags: FlagDraft[];
  judgments?: Judgment[];
  /** Kept with the labels it produced, so every label can be traced to the exact call. */
  record?: { model?: string; prompt?: string; response?: string };
}

/** A stored flag. `id` is stable, so receivers can use it to ignore repeat deliveries. */
export interface Flag extends FlagDraft {
  id: string;
  created_at: string;
  /** The decider that raised it, or `classifier` when the classifier escalated on its own. */
  decider: string;
  /** Where it is in the queue: open, acknowledged, resolved, confirmed or false_positive. */
  status?: string;
  /** Events behind the flag, including ones added later by a cached verdict. */
  event_count?: number;
  /** User ids found in the flag's events, for linking to other sources. */
  users?: string[];
  updated_at?: string;
  note?: string | null;
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/** The request as a source adapter's `verify` sees it. */
export interface IncomingRequest {
  source: string;
  /** Header names are lower-case. */
  headers: Record<string, string>;
  query: Record<string, string>;
  body: Uint8Array;
}

/** One event as a source adapter's `parse` returns it. Only `data` is required. */
export interface ParsedEvent {
  data: unknown;
  id?: string;
  type?: string;
  group_key?: string;
}

export interface SourceContext {
  source: string;
  received_at: Date;
}

/**
 * A source adapter. `verify` runs in the request path before the reply, so it must be
 * cheap (no network, no JSON parsing). `parse` runs later in the worker.
 * cloudfriend has already checked the ingest secret before `verify` is called.
 */
export interface SourceAdapter {
  verify?(req: IncomingRequest): boolean;
  /** Turn one request body into zero or more events. Return `[]` to drop it. */
  parse(body: Uint8Array, ctx: SourceContext): ParsedEvent[];
}

/** A decider looks at a batch of events and flags the ones that matter. */
export interface DeciderAdapter {
  /** Return false to stay disabled, e.g. when a required env var is missing. */
  enabled?(env: NodeJS.ProcessEnv): boolean;
  /** Return flag drafts (v0) or a Decision with per-event judgments. */
  decide(events: CloudfriendEvent[], ctx: DeciderContext): Promise<FlagDraft[] | Decision>;
}

export interface DeciderContext {
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  /** Flags still in the queue, so the decider can say an event continues one instead of raising another. */
  openFlags?: { id: string; reason: string; severity: Severity }[];
}

/** Accept both decider return shapes. */
export function toDecision(out: FlagDraft[] | Decision): Decision {
  if (Array.isArray(out)) return { flags: out };
  if (out && Array.isArray(out.flags)) return out;
  throw new Error("decide() must return an array of flags or { flags, judgments }");
}

/** An action does something with each flag. Throw (or return false) to have it retried. */
export interface ActionAdapter {
  /** Return false to stay disabled, e.g. when its URL isn't configured. */
  enabled?(env: NodeJS.ProcessEnv): boolean;
  run(flag: Flag, ctx: ActionContext): Promise<boolean | void>;
}

export interface ActionContext {
  /** The events linked to the flag that are still within the retention window (at most 50). */
  events: CloudfriendEvent[];
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

// Identity helpers so adapter files get type checking without importing interfaces by name.
export const defineSource = (a: SourceAdapter): SourceAdapter => a;
export const defineDecider = (a: DeciderAdapter): DeciderAdapter => a;
export const defineAction = (a: ActionAdapter): ActionAdapter => a;
