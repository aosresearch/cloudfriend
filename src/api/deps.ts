import type { Context } from "hono";
import type { AuthEnv } from "../auth/index.ts";
import type { DB } from "../db.ts";
import type { Intake } from "../intake.ts";
import type { checkDestinationUrl } from "../net/outbound.ts";
import type { Triage } from "../triage/runtime.ts";
import type { ActionAdapter, SourceAdapter } from "../types.ts";

/** What the dashboard API routes need. Built by createApp. */
export interface DashboardDeps {
  db: DB;
  intake: Intake;
  /** Source adapters by name: the kinds a source may have. */
  sources: Map<string, SourceAdapter>;
  /** Every loaded action adapter by name (enabled by env or not): the kinds a destination may have. */
  actions: Map<string, ActionAdapter>;
  /** Passed to action adapters (validate, test). */
  env: NodeJS.ProcessEnv;
  /** CLOUDFRIEND_PUBLIC_URL, for endpoint URLs; the request's origin when null. */
  publicUrl: URL | null;
  /** CLOUDFRIEND_ALLOW_PRIVATE_DESTINATIONS=on. */
  allowPrivateDestinations: boolean;
  /** The outbound address check (src/net/outbound.ts); replaceable in tests. */
  checkUrl: typeof checkDestinationUrl;
  /** The decider configured on this server, or null. For /usage. */
  decider: string | null;
  /** The triage runtime and the one workspace it belongs to: feedback updates its routing only for that workspace. */
  triage: Triage | null;
  triageWorkspace: string;
}

export type ApiContext = Context<AuthEnv>;

/** The workspace id of a /api/w/:ws/... request (membership is checked by requireMember before any handler runs). */
export const wsOf = (c: Context): string => c.req.param("ws")!;

export const WS = "/api/w/:ws";
