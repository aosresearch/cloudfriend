// POSTs each flag as JSON: { "flag": {...}, "events": [...] }.
//
//   WEBHOOK_URL      where to send flags (the action is off when unset)
//   WEBHOOK_SECRET   optional; adds `x-cloudfriend-signature: sha256=<hex HMAC of the body>`
//
// Delivery is at-least-once. Use `flag.id` (also sent as `x-cloudfriend-flag-id`) to ignore repeats.
import { createHmac } from "node:crypto";
import { defineAction } from "../../types.ts";

export default defineAction({
  enabled: (env) => Boolean(env.WEBHOOK_URL),

  async run(flag, { events, env, signal }) {
    const body = JSON.stringify({ flag, events });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "cloudfriend",
      "x-cloudfriend-flag-id": flag.id,
    };
    if (env.WEBHOOK_SECRET) {
      headers["x-cloudfriend-signature"] = "sha256=" + createHmac("sha256", env.WEBHOOK_SECRET).update(body).digest("hex");
    }
    const res = await fetch(env.WEBHOOK_URL!, { method: "POST", headers, body, signal });
    if (!res.ok) throw new Error(`webhook replied ${res.status}: ${(await res.text()).slice(0, 200)}`);
  },
});
