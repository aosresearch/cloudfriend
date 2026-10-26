// Shared types. Adapter authors only need the types in the "Adapters" section.

/** An event as Sieve stores it and hands it to deciders and the read API. */
export interface SieveEvent {
  /** Sieve's own id for the event, unique and never reused. */
  id: string;
  /** The source name from the ingest URL, e.g. `sentry` for `POST /in/sentry`. */
  source: string;
  /** When Sieve accepted the request, ISO 8601. */
  received_at: string;
  /** The raw payload, exactly as the source adapter parsed it. */
  data: unknown;
  /** Optional hints a source adapter pulled out. Deciders must not depend on them. */
  external_id?: string;
  type?: string;
  group_key?: string;
}

export type Severity = "low" | "medium" | "high" | "critical";
export const SEVERITIES: readonly Severity[] = ["low", "medium", "high", "critical"];

/** What a decider returns: a reason, a severity and the events behind it. */
export interface FlagDraft {
  reason: string;
  severity: Severity;
  event_ids: string[];
}

/** A stored flag. `id` is stable, so receivers can use it to ignore repeat deliveries. */
export interface Flag extends FlagDraft {
  id: string;
  created_at: string;
  decider: string;
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
 * Sieve has already checked the ingest secret before `verify` is called.
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
  decide(events: SieveEvent[], ctx: DeciderContext): Promise<FlagDraft[]>;
}

export interface DeciderContext {
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

/** An action does something with each flag. Throw (or return false) to have it retried. */
export interface ActionAdapter {
  /** Return false to stay disabled, e.g. when its URL isn't configured. */
  enabled?(env: NodeJS.ProcessEnv): boolean;
  run(flag: Flag, ctx: ActionContext): Promise<boolean | void>;
}

export interface ActionContext {
  /** The events linked to the flag that are still within the retention window (at most 50). */
  events: SieveEvent[];
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

// Identity helpers so adapter files get type checking without importing interfaces by name.
export const defineSource = (a: SourceAdapter): SourceAdapter => a;
export const defineDecider = (a: DeciderAdapter): DeciderAdapter => a;
export const defineAction = (a: ActionAdapter): ActionAdapter => a;
