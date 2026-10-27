// POSTs each flag as JSON: { "flag": {...}, "events": [...] }.
//
// As a destination (multi-workspace), its settings come from the destination's config:
//   { "url": "https://...", "signing_secret"?: "<at least 16 characters>" }
// Without a config (v0, one install), from the environment:
//   WEBHOOK_URL      where to send flags (the action is off when unset)
//   WEBHOOK_SECRET   optional; adds `x-cloudfriend-signature: sha256=<hex HMAC of the body>`
//
// Delivery is at-least-once. Use `flag.id` (also sent as `x-cloudfriend-flag-id`) to ignore repeats.
// Sends go through src/net/outbound.ts. Errors carry the status only ("webhook replied 500"),
// never the reply body.
import { createHmac, randomBytes } from "node:crypto";
import { allowPrivateDestinations, checkDestinationUrl, outboundFetch } from "../../net/outbound.ts";
import { defineAction, type ActionContext, type Flag } from "../../types.ts";

const MIN_SECRET = 16;

/** Where to send and how to sign: the destination's config when there is one, else the environment. */
function settings(ctx: Pick<ActionContext, "env" | "config">): { url: string; secret?: string } {
  if (ctx.config) {
    const { url, signing_secret } = ctx.config;
    if (typeof url !== "string" || !url) throw new Error("destination has no url");
    return { url, secret: typeof signing_secret === "string" && signing_secret ? signing_secret : undefined };
  }
  if (!ctx.env.WEBHOOK_URL) throw new Error("WEBHOOK_URL is not set");
  return { url: ctx.env.WEBHOOK_URL, secret: ctx.env.WEBHOOK_SECRET || undefined };
}

async function send(flag: Flag, payload: object, ctx: Pick<ActionContext, "env" | "signal" | "config">, extra: Record<string, string> = {}) {
  const { url, secret } = settings(ctx);
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-cloudfriend-flag-id": flag.id,
    ...extra,
  };
  if (secret) headers["x-cloudfriend-signature"] = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const res = await outboundFetch(url, { method: "POST", headers, body, signal: ctx.signal }, { allowPrivate: allowPrivateDestinations(ctx.env) });
  // Status only: the body of a reply from an address someone typed must never reach an error.
  if (!res.ok) throw new Error(`webhook replied ${res.status}`);
}

export default defineAction({
  enabled: (env) => Boolean(env.WEBHOOK_URL),

  async run(flag, ctx) {
    await send(flag, { flag, events: ctx.events }, ctx);
  },

  async validate(config, { env }) {
    const allowPrivate = allowPrivateDestinations(env);
    const raw = typeof config.url === "string" ? config.url.trim() : "";
    if (!raw) throw new Error("url is required");
    const check = await checkDestinationUrl(raw, { allowPrivate });
    if (!check.ok) throw new Error(`destination refused: ${check.error}`);
    const u = new URL(raw);
    u.hash = "";
    const out: Record<string, unknown> = { url: u.href };
    const secret = config.signing_secret;
    if (secret != null && secret !== "") {
      if (typeof secret !== "string") throw new Error("signing_secret must be a string");
      if (secret.length < MIN_SECRET) throw new Error(`signing_secret must be at least ${MIN_SECRET} characters`);
      out.signing_secret = secret;
    }
    return out;
  },

  async test(ctx) {
    const flag: Flag = {
      id: `flg_test_${randomBytes(8).toString("hex")}`,
      reason: "cloudfriend test message — your destination works",
      severity: "low",
      event_ids: [],
      created_at: new Date().toISOString(),
      decider: "test",
    };
    await send(flag, { test: true, flag, events: [] }, ctx, { "x-cloudfriend-test": "1" });
  },
});
