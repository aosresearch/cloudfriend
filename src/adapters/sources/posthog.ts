// PostHog: the HTTP webhook destination ({ event, person } by default), legacy action
// webhooks ({ text }), and capture-style payloads (one event, or { batch: [...] }).
// Point PostHog at https://<host>/in/posthog with header `Authorization: Bearer <secret>`.
import { defineSource, type ParsedEvent } from "../../types.ts";
import { parseJsonBody } from "./json.ts";

type Obj = Record<string, any>;

export function posthogHints(item: Obj): Omit<ParsedEvent, "data"> {
  // Destination payloads nest the event; capture payloads are the event.
  const ev: Obj = item.event && typeof item.event === "object" ? item.event : item;
  const name = typeof ev.event === "string" ? ev.event : undefined;
  const props: Obj = ev.properties && typeof ev.properties === "object" ? ev.properties : {};
  const hints: Omit<ParsedEvent, "data"> = {};
  if (ev.uuid) hints.id = String(ev.uuid);
  if (name) hints.type = name;
  if (name === "$exception") {
    const fingerprint = props.$exception_fingerprint ?? props.$exception_issue_id;
    const kind = props.$exception_types?.[0] ?? props.$exception_list?.[0]?.type ?? props.$exception_type;
    if (fingerprint) hints.group_key = `exception:${fingerprint}`;
    else if (kind) hints.group_key = `exception:${kind}`;
  } else if (name) {
    hints.group_key = `event:${name}`;
  }
  return hints;
}

export default defineSource({
  parse(body) {
    const items: unknown[] = [];
    for (const value of parseJsonBody(body)) {
      if (value && typeof value === "object" && Array.isArray((value as Obj).batch)) items.push(...(value as Obj).batch);
      else items.push(value);
    }
    return items.map((data) => ({
      data,
      ...(data && typeof data === "object" ? posthogHints(data as Obj) : {}),
    }));
  },
});
