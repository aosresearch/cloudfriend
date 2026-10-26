// Posts each flag to a Slack incoming webhook.
//
//   SLACK_WEBHOOK_URL   https://hooks.slack.com/services/... (the action is off when unset)
//   SLACK_MIN_SEVERITY  only post flags at or above this severity (default low)
import { compactJson } from "../../compact.ts";
import { defineAction, SEVERITIES, type Flag, type CloudfriendEvent, type Severity } from "../../types.ts";

const ICON: Record<Severity, string> = {
  low: ":large_blue_circle:",
  medium: ":large_yellow_circle:",
  high: ":large_orange_circle:",
  critical: ":red_circle:",
};

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

export default defineAction({
  enabled: (env) => Boolean(env.SLACK_WEBHOOK_URL),

  async run(flag, { events, env, signal }) {
    const min = SEVERITIES.indexOf((env.SLACK_MIN_SEVERITY ?? "low").toLowerCase() as Severity);
    if (SEVERITIES.indexOf(flag.severity) < min) return;
    const res = await fetch(env.SLACK_WEBHOOK_URL!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(slackMessage(flag, events)),
      signal,
    });
    if (!res.ok) throw new Error(`slack replied ${res.status}: ${(await res.text()).slice(0, 200)}`);
  },
});
