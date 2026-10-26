// Sentry webhooks: internal integrations (issue, event_alert, error, metric_alert resources)
// and the legacy WebHooks alert plugin. Point Sentry at:
//   https://<host>/in/sentry?secret=<ingest secret>
// If SENTRY_CLIENT_SECRET is set, the `sentry-hook-signature` header must also be valid.
import { createHmac, timingSafeEqual } from "node:crypto";
import { defineSource, type ParsedEvent } from "../../types.ts";
import { parseJsonBody } from "./json.ts";

type Obj = Record<string, any>;
const str = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));

export function sentryHints(body: Obj): Omit<ParsedEvent, "data"> | null {
  const d: Obj | undefined = body.data && typeof body.data === "object" ? body.data : undefined;
  const action = str(body.action);
  const suffix = action ? "." + action : "";
  if (d?.installation || (body.installation && !d)) return null; // installation lifecycle, not an event
  if (d?.issue) {
    const issue = d.issue;
    return { type: "issue" + suffix, id: str(issue.id), group_key: issue.id ? `issue:${issue.id}` : undefined };
  }
  if (d?.event) {
    const ev = d.event;
    const issueId = str(ev.issue_id ?? ev.groupID);
    return { type: "event_alert" + suffix, id: str(ev.event_id), group_key: issueId && `issue:${issueId}` };
  }
  if (d?.error) {
    const err = d.error;
    const issueId = str(err.issue_id ?? err.groupID);
    return { type: "error" + suffix, id: str(err.event_id), group_key: issueId && `issue:${issueId}` };
  }
  if (d?.metric_alert) {
    const id = str(d.metric_alert.id);
    return { type: "metric_alert" + suffix, id, group_key: id && `metric_alert:${id}` };
  }
  if (body.event && (body.culprit !== undefined || body.project_name !== undefined)) {
    // Legacy WebHooks plugin: top-level `id` is the issue (group) id.
    const id = str(body.id);
    return { type: "alert", id: str(body.event.event_id), group_key: id && `issue:${id}` };
  }
  return { type: action };
}

export default defineSource({
  verify(req) {
    const clientSecret = process.env.SENTRY_CLIENT_SECRET;
    if (!clientSecret) return true;
    const given = req.headers["sentry-hook-signature"];
    if (!given) return false;
    const expected = createHmac("sha256", clientSecret).update(req.body).digest();
    const got = Buffer.from(given, "hex");
    return got.length === expected.length && timingSafeEqual(got, expected);
  },

  parse(body) {
    const out: ParsedEvent[] = [];
    for (const data of parseJsonBody(body)) {
      const hints = data && typeof data === "object" ? sentryHints(data as Obj) : {};
      if (hints === null) continue;
      out.push({ data, ...dropUndefined(hints) });
    }
    return out;
  },
});

function dropUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
