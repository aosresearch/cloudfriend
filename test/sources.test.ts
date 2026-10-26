import assert from "node:assert/strict";
import { describe, it } from "node:test";
import json from "../src/adapters/sources/json.ts";
import posthog from "../src/adapters/sources/posthog.ts";
import sentry from "../src/adapters/sources/sentry.ts";
import type { SourceAdapter } from "../src/types.ts";

const ctx = { source: "x", received_at: new Date() };
const parse = (a: SourceAdapter, body: string | object) =>
  a.parse(new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)), ctx);

describe("json source", () => {
  it("makes one event from an object", () => {
    assert.deepEqual(parse(json, { a: 1 }), [{ data: { a: 1 } }]);
  });
  it("makes one event per array item", () => {
    assert.deepEqual(parse(json, [{ a: 1 }, "two"]), [{ data: { a: 1 } }, { data: "two" }]);
  });
  it("makes one event per NDJSON line", () => {
    assert.deepEqual(parse(json, '{"a":1}\n{"a":2}\n'), [{ data: { a: 1 } }, { data: { a: 2 } }]);
  });
  it("keeps non-JSON bodies as raw text", () => {
    assert.deepEqual(parse(json, "ERROR disk full"), [{ data: { raw: "ERROR disk full" } }]);
  });
  it("drops empty bodies", () => {
    assert.deepEqual(parse(json, "  "), []);
  });
});

describe("sentry source", () => {
  it("reads issue webhooks", () => {
    const [e] = parse(sentry, { action: "created", data: { issue: { id: "123", title: "TypeError" } } });
    assert.equal(e!.type, "issue.created");
    assert.equal(e!.id, "123");
    assert.equal(e!.group_key, "issue:123");
  });
  it("reads issue alert (event_alert) webhooks", () => {
    const [e] = parse(sentry, {
      action: "triggered",
      data: { event: { event_id: "abc", issue_id: "9", title: "boom" }, triggered_rule: "r" },
    });
    assert.deepEqual({ type: e!.type, id: e!.id, group_key: e!.group_key }, {
      type: "event_alert.triggered",
      id: "abc",
      group_key: "issue:9",
    });
  });
  it("reads error webhooks", () => {
    const [e] = parse(sentry, { action: "created", data: { error: { event_id: "e1", issue_id: "5" } } });
    assert.equal(e!.type, "error.created");
    assert.equal(e!.group_key, "issue:5");
  });
  it("reads metric alert webhooks", () => {
    const [e] = parse(sentry, { action: "critical", data: { metric_alert: { id: "77" } } });
    assert.equal(e!.type, "metric_alert.critical");
    assert.equal(e!.group_key, "metric_alert:77");
  });
  it("reads the legacy WebHooks plugin format", () => {
    const [e] = parse(sentry, {
      id: "4242",
      project_name: "web",
      culprit: "app.js",
      message: "x",
      level: "error",
      event: { event_id: "ev" },
    });
    assert.equal(e!.type, "alert");
    assert.equal(e!.group_key, "issue:4242");
  });
  it("drops installation lifecycle webhooks", () => {
    assert.deepEqual(parse(sentry, { action: "created", data: { installation: { uuid: "u" } }, installation: { uuid: "u" } }), []);
  });
  it("keeps the whole payload as data", () => {
    const body = { action: "created", data: { issue: { id: "1", extra: [1, 2] } }, actor: { name: "a" } };
    assert.deepEqual(parse(sentry, body)[0]!.data, body);
  });
  it("accepts verify() when no client secret is configured", () => {
    assert.equal(sentry.verify!({ source: "sentry", headers: {}, query: {}, body: new Uint8Array() }), true);
  });
});

describe("posthog source", () => {
  it("reads the webhook destination format", () => {
    const [e] = parse(posthog, { event: { uuid: "u1", event: "signup_failed", properties: {} }, person: { id: "p" } });
    assert.deepEqual({ id: e!.id, type: e!.type, group_key: e!.group_key }, {
      id: "u1",
      type: "signup_failed",
      group_key: "event:signup_failed",
    });
  });
  it("groups exceptions by fingerprint, falling back to exception type", () => {
    const [a] = parse(posthog, { event: "$exception", properties: { $exception_fingerprint: "fp1" } });
    const [b] = parse(posthog, { event: "$exception", properties: { $exception_list: [{ type: "TypeError" }] } });
    assert.equal(a!.group_key, "exception:fp1");
    assert.equal(b!.group_key, "exception:TypeError");
  });
  it("splits capture batches into one event each", () => {
    const events = parse(posthog, { api_key: "k", batch: [{ event: "a" }, { event: "b" }] });
    assert.deepEqual(events.map((e) => e.type), ["a", "b"]);
    assert.deepEqual(events[0]!.data, { event: "a" });
  });
  it("accepts legacy action webhooks", () => {
    assert.deepEqual(parse(posthog, { text: "[Action] fired" }), [{ data: { text: "[Action] fired" } }]);
  });
});
