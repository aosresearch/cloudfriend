// Posts each flag to a Slack incoming webhook.
//
// As a destination (multi-workspace), its settings come from the destination's config:
//   { "url": "https://hooks.slack.com/services/...", "min_severity"?: "low" | "medium" | "high" | "critical" }
// Without a config (v0, one install), from the environment:
//   SLACK_WEBHOOK_URL   https://hooks.slack.com/services/... (the action is off when unset)
//   SLACK_MIN_SEVERITY  only post flags at or above this severity (default low)
//
// Sends go through src/net/outbound.ts. Errors carry the status only ("slack replied 404"),
// never the reply body.
import { compactJson } from "../../compact.ts";
import { allowPrivateDestinations, checkDestinationUrl, outboundFetch } from "../../net/outbound.ts";
import { defineAction, SEVERITIES, type ActionContext, type Flag, type CloudfriendEvent, type Severity } from "../../types.ts";

const ICON: Record<Severity, string> = {
  low: ":large_blue_circle:",
  medium: ":large_yellow_circle:",
  high: ":large_orange_circle:",
  critical: ":red_circle:",
};

export const SLACK_TEST_TEXT = "cloudfriend test message — your destination works";

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function slackMessage(flag: Flag, events: CloudfriendEvent[]) {
  const sources = [...new Set(events.map((e) => e.source))].join(", ") || "unknown";
  const title = `${ICON[flag.severity]} *${flag.severity.toUpperCase()}*  ${escape(flag.reason)}`;
  const blocks: object[] = [
    { type: "section", text: { type: "mrkdwn", text: title } },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${flag.event_ids.length} event${flag.event_ids.length === 1 ? "" : "s"} from ${escape(sources)} · flag \`${flag.id}\``,
        },
      ],
    },
  ];
  const sample = events[0];
  if (sample) {
    const json = compactJson(sample.data, { maxChars: 600, maxDepth: 4, maxString: 200 }).replace(/```/g, "'''");
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "```" + escape(json) + "```" } });
  }
  return { text: `[${flag.severity}] ${flag.reason}`, blocks };
}

/** Where to post and what to skip: the destination's config when there is one, else the environment. */
function settings(ctx: Pick<ActionContext, "env" | "config">): { url: string; minSeverity: string } {
  if (ctx.config) {
    const { url, min_severity } = ctx.config;
    if (typeof url !== "string" || !url) throw new Error("destination has no url");
    return { url, minSeverity: typeof min_severity === "string" ? min_severity : "low" };
  }
  if (!ctx.env.SLACK_WEBHOOK_URL) throw new Error("SLACK_WEBHOOK_URL is not set");
  return { url: ctx.env.SLACK_WEBHOOK_URL, minSeverity: ctx.env.SLACK_MIN_SEVERITY ?? "low" };
}

async function post(url: string, payload: object, ctx: Pick<ActionContext, "env" | "signal">): Promise<void> {
  const res = await outboundFetch(
    url,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: ctx.signal },
    { allowPrivate: allowPrivateDestinations(ctx.env) },
  );
  // Status only: the body of a reply from an address someone typed must never reach an error.
  if (!res.ok) throw new Error(`slack replied ${res.status}`);
}

export default defineAction({
  enabled: (env) => Boolean(env.SLACK_WEBHOOK_URL),

  async run(flag, ctx) {
    const { url, minSeverity } = settings(ctx);
    const min = SEVERITIES.indexOf(minSeverity.toLowerCase() as Severity);
    if (SEVERITIES.indexOf(flag.severity) < min) return;
    await post(url, slackMessage(flag, ctx.events), ctx);
  },

  async validate(config, { env }) {
    const allowPrivate = allowPrivateDestinations(env);
    const raw = typeof config.url === "string" ? config.url.trim() : "";
    if (!raw) throw new Error("url is required");
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error("url is not a valid URL");
    }
    if (!allowPrivate && (u.protocol !== "https:" || u.hostname !== "hooks.slack.com")) {
      throw new Error("use a Slack incoming webhook URL (https://hooks.slack.com/...)");
    }
    const check = await checkDestinationUrl(raw, { allowPrivate });
    if (!check.ok) throw new Error(`destination refused: ${check.error}`);
    u.hash = "";
    const out: Record<string, unknown> = { url: u.href };
    if (config.min_severity != null && config.min_severity !== "") {
      const sev = String(config.min_severity).toLowerCase();
      if (!SEVERITIES.includes(sev as Severity)) throw new Error(`min_severity must be one of ${SEVERITIES.join(", ")}`);
      out.min_severity = sev;
    }
    return out;
  },

  async test(ctx) {
    await post(settings(ctx).url, { text: SLACK_TEST_TEXT }, ctx);
  },
});
