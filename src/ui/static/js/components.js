// Shared UI pieces: badges, copy buttons, dialogs, notices, and the source/destination forms used by
// both the setup checklist and the management pages.
import { api, ApiError, wsPath } from "./api.js";
import { h, replace, uid, timeEl, fmtAbs } from "./dom.js";

// --- vocabulary ----------------------------------------------------------------------------------

export const ROUTES = {
  drop: { label: "drop", text: "Dropped by the classifier: a low score, and this kind of event was judged benign before. No cost." },
  jev: { label: "jev", text: "Scored at or above the drop threshold, so it went to Jev." },
  review: { label: "review", text: "A low score, but this kind of event hasn't been judged benign yet (or it changed), so Jev looks once." },
  novel: { label: "novel", text: "An error-like event with a message template never seen before. Jev sees it once." },
  known: { label: "known", text: "Its template was escalated in the last 7 days, so Jev always sees it." },
  audit: { label: "audit", text: "A random sample of what would be dropped. Jev checks it to measure what the classifier misses." },
  auto: { label: "auto", text: "Scored above the escalate threshold and escalated without asking Jev." },
  classifier: { label: "classifier", text: "No Jev available, so the classifier escalated it on its own score." },
};
export const ROUTE_NAMES = Object.keys(ROUTES);
export const JEV_ROUTES = new Set(["jev", "review", "novel", "known", "audit"]);

export const JUDGMENTS = {
  relevant: "Worth a person's attention.",
  benign: "Not something a person needs to act on.",
  uncertain: "Jev couldn't tell. No training label is made.",
};

export const SEVERITIES = ["critical", "high", "medium", "low"];
export const STATUS_LABELS = {
  open: "Open",
  acknowledged: "Acknowledged",
  resolved: "Resolved",
  confirmed: "Confirmed",
  false_positive: "False positive",
};
export const SOURCE_KINDS = {
  json: { label: "Any HTTP JSON", text: "Logs, scripts, your own services: any JSON body, array or NDJSON." },
  sentry: { label: "Sentry", text: "Issue and error webhooks from a Sentry internal integration." },
  posthog: { label: "PostHog", text: "An HTTP webhook destination in PostHog, e.g. for $exception events." },
};

// --- badges --------------------------------------------------------------------------------------

export function badge(text, kind = "", title) {
  return h("span", { class: `badge ${kind}`.trim(), title }, text);
}
export const severityBadge = (s) => badge(s ?? "unknown", `sev sev-${s}`);
export const statusBadge = (s) => badge(STATUS_LABELS[s] ?? s, `status status-${s}`);
export function routeBadge(route) {
  if (!route) return badge("pending", "route route-pending", "Not parsed yet");
  return badge(route, `route route-${route}`, ROUTES[route]?.text);
}
export function judgmentBadge(j) {
  if (!j) return null;
  return badge(j, `judgment judgment-${j}`, JUDGMENTS[j]);
}

// --- small building blocks -----------------------------------------------------------------------

/** A definition list: kv([["Label", value], ...]). Falsy rows are skipped. */
export function kv(rows, cls = "") {
  return h("dl", { class: `kv ${cls}`.trim() }, rows.filter(Boolean).map(([k, v]) => [h("dt", null, k), h("dd", null, v ?? h("span", { class: "muted" }, "–"))]));
}

export function loading(text = "Loading…") {
  return h("p", { class: "loading", role: "status" }, text);
}

export function emptyState(title, ...body) {
  return h("div", { class: "empty" }, h("p", { class: "empty-title" }, title), body.map((b) => (typeof b === "string" ? h("p", null, b) : b)));
}

export function notice(kind, ...children) {
  return h("div", { class: `notice notice-${kind}`, role: kind === "error" ? "alert" : "status" }, children);
}

export function errorText(err) {
  if (err instanceof ApiError) return err.message;
  return err?.message || String(err);
}

/** Copy text to the clipboard; the button says "Copied" for a moment. */
export function copyButton(getText, label = "Copy", extraClass = "") {
  const status = h("span", { class: "visually-hidden", "aria-live": "polite" });
  const btn = h("button", { type: "button", class: `btn small ${extraClass}`.trim() }, label);
  btn.addEventListener("click", async () => {
    const text = typeof getText === "function" ? getText() : getText;
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = legacyCopy(text);
    }
    btn.textContent = ok ? "Copied" : "Select and copy";
    status.textContent = ok ? "Copied to clipboard" : "Couldn't copy. Select the text and copy it.";
    setTimeout(() => {
      btn.textContent = label;
      status.textContent = "";
    }, 1800);
  });
  return h("span", { class: "copy-wrap" }, btn, status);
}

function legacyCopy(text) {
  const ta = h("textarea", { class: "visually-hidden", readonly: true });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {}
  ta.remove();
  return ok;
}

/** A labelled value in a code box with a copy button. */
export function copyField(label, value, { secret = false, multiline = false } = {}) {
  const id = uid("copy");
  return h(
    "div",
    { class: `copy-field ${secret ? "is-secret" : ""}`.trim() },
    h("div", { class: "copy-field-head" }, h("span", { class: "copy-field-label", id }, label), copyButton(value, "Copy", "")),
    h(multiline ? "pre" : "code", { class: multiline ? "code block" : "code inline-block", "aria-labelledby": id, tabindex: "0" }, value),
  );
}

/** A modal confirm built on <dialog>. Resolves true when confirmed. */
export function confirmDialog({ title, body, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const titleId = uid("dlg");
    const cancel = h("button", { type: "button", class: "btn" }, "Cancel");
    const ok = h("button", { type: "button", class: `btn ${danger ? "danger" : "primary"}` }, confirmLabel);
    const dlg = h(
      "dialog",
      { class: "dialog", "aria-labelledby": titleId },
      h("h2", { id: titleId }, title),
      [].concat(body ?? []).map((b) => (typeof b === "string" ? h("p", null, b) : b)),
      h("div", { class: "actions" }, cancel, ok),
    );
    const done = (v) => {
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    cancel.addEventListener("click", () => done(false));
    ok.addEventListener("click", () => done(true));
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      done(false);
    });
    document.body.append(dlg);
    dlg.showModal();
    cancel.focus();
  });
}

/** Run an async action from a button: disables it, shows progress text, reports errors in `out`. */
export async function withBusy(button, busyText, fn, out) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  if (out) replace(out);
  try {
    return await fn();
  } catch (err) {
    if (err?.status === 401) return undefined;
    if (out) replace(out, notice("error", errorText(err)));
    return undefined;
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

/** A labelled form field. */
export function field(label, control, hint) {
  const id = control.id || uid("f");
  control.id = id;
  let hintEl = null;
  if (hint) {
    const hid = uid("hint");
    hintEl = h("p", { class: "hint", id: hid }, hint);
    control.setAttribute("aria-describedby", hid);
  }
  return h("div", { class: "field" }, h("label", { for: id }, label), control, hintEl);
}

/** A radio group as a fieldset of cards. options: { value: { label, text } }. */
export function radioCards(name, legend, options, value, onChange) {
  return h(
    "fieldset",
    { class: "radio-cards" },
    h("legend", null, legend),
    Object.entries(options).map(([v, o]) => {
      const id = uid(name);
      const input = h("input", { type: "radio", name, id, value: v, checked: v === value, onchange: () => onChange?.(v) });
      return h("label", { class: "radio-card", for: id }, input, h("span", { class: "radio-card-body" }, h("strong", null, o.label), o.text ? h("span", { class: "muted" }, o.text) : null));
    }),
  );
}

// --- sources -------------------------------------------------------------------------------------

/** Form to create a source. Calls onCreated({ source, secret }). */
export function sourceForm(ws, onCreated, { submitLabel = "Create source" } = {}) {
  let kind = "json";
  const name = h("input", { type: "text", required: true, autocomplete: "off", spellcheck: "false", placeholder: "e.g. sentry-prod", maxlength: "64" });
  const out = h("div");
  const submit = h("button", { type: "submit", class: "btn primary" }, submitLabel);
  const form = h(
    "form",
    { class: "form", novalidate: true },
    radioCards("kind", "Kind", SOURCE_KINDS, kind, (v) => {
      kind = v;
      if (!name.value || name.dataset.auto === "1") {
        name.value = v === "json" ? "" : `${v}-prod`;
        name.dataset.auto = "1";
      }
    }),
    field("Name", name, "Letters, digits, dots, dashes. Shown in event lists."),
    out,
    h("div", { class: "actions" }, submit),
  );
  name.addEventListener("input", () => (name.dataset.auto = "0"));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!name.value.trim()) {
      replace(out, notice("error", "Give the source a name."));
      name.focus();
      return;
    }
    const res = await withBusy(submit, "Creating…", () => api(wsPath(ws, "sources"), { method: "POST", body: { name: name.value.trim(), kind } }), out);
    if (res) onCreated(res);
  });
  return form;
}

function curlExample(source, secret) {
  const body =
    source.kind === "posthog"
      ? '{"event":"$exception","distinct_id":"user-123","properties":{"$exception_message":"checkout failed","$exception_type":"Error"}}'
      : '{"level":"error","message":"payment provider timeout","service":"checkout","route":"/checkout"}';
  return `curl -X POST '${source.endpoint_url}' \\\n  -H 'Authorization: Bearer ${secret}' \\\n  -H 'Content-Type: application/json' \\\n  -d '${body}'`;
}

function withSecretParam(url, secret) {
  const u = new URL(url);
  u.searchParams.set("secret", secret);
  return u.toString();
}

/** Kind-specific setup steps for a source. Works without the secret (shows a placeholder). */
export function sourceSetupHints(source, secret) {
  const s = secret ?? "<secret>";
  if (source.kind === "sentry") {
    return h(
      "div",
      { class: "hints" },
      h("h4", null, "Point Sentry at this source"),
      h(
        "ol",
        null,
        h("li", null, "In Sentry, open Settings, Developer Settings, Custom Integrations, and create a new internal integration."),
        h("li", null, "Set the webhook URL to the URL below, which carries the secret as ", h("code", null, "?secret="), "."),
        h("li", null, "Turn on Alert Rule Action and subscribe to the issue and error webhooks you want."),
        h("li", null, "The legacy WebHooks alert plugin works too, with the same URL."),
      ),
      secret ? copyField("Sentry webhook URL", withSecretParam(source.endpoint_url, secret), { secret: true }) : null,
    );
  }
  if (source.kind === "posthog") {
    return h(
      "div",
      { class: "hints" },
      h("h4", null, "Point PostHog at this source"),
      h(
        "ol",
        null,
        h("li", null, "In PostHog, create an HTTP Webhook destination (for example on $exception events)."),
        h("li", null, "Set its URL to the endpoint URL above."),
        h("li", null, "Add the header ", h("code", null, `Authorization: Bearer ${s}`), "."),
        h("li", null, "The default { event, person } body works as is; batches become one event per item."),
      ),
      secret ? copyField("Authorization header", `Authorization: Bearer ${secret}`, { secret: true }) : null,
    );
  }
  return h(
    "div",
    { class: "hints" },
    h("h4", null, "Send events"),
    h(
      "p",
      null,
      "POST any JSON object, array or NDJSON to the endpoint with ",
      h("code", null, "Authorization: Bearer <secret>"),
      ". Senders that can't set headers can add ",
      h("code", null, "?secret="),
      " to the URL. A 202 reply means the event is stored.",
    ),
  );
}

/** Shows a new or rotated source's secret once, with copy buttons, curl and setup hints. */
export function sourceSecretPanel(source, secret, { rotated = false } = {}) {
  return h(
    "section",
    { class: "secret-panel", "aria-label": `Secret for ${source.name}` },
    notice(
      "warn",
      h("strong", null, rotated ? "New secret. It is shown only once." : "Copy the secret now. It is shown only once."),
      " ",
      rotated
        ? "The old secret keeps working for 24 hours, so you can update the sender without dropping events."
        : "cloudfriend stores only a hash. If you lose it, rotate the secret on the Sources page.",
    ),
    copyField("Endpoint URL", source.endpoint_url),
    copyField("Secret", secret, { secret: true }),
    copyField(source.kind === "sentry" ? "Try it by hand (checks the URL and secret)" : "Try it with curl", curlExample(source, secret), { multiline: true, secret: true }),
    sourceSetupHints(source, secret),
  );
}

// --- destinations --------------------------------------------------------------------------------

export const DEST_KINDS = {
  slack: { label: "Slack", text: "A Slack incoming webhook URL (https://hooks.slack.com/services/…)." },
  webhook: { label: "Webhook", text: "POSTs { flag, events } as JSON to your URL, optionally signed with HMAC-SHA256." },
};

/** Form to add a destination. Calls onCreated(destination). */
export function destinationForm(ws, onCreated) {
  let kind = "slack";
  const name = h("input", { type: "text", required: true, autocomplete: "off", placeholder: "#ops-alerts" });
  const url = h("input", { type: "url", required: true, autocomplete: "off", spellcheck: "false", placeholder: "https://hooks.slack.com/services/…", inputmode: "url" });
  const signing = h("input", { type: "password", autocomplete: "new-password", spellcheck: "false" });
  const signingField = field("Signing secret (optional)", signing, "Adds x-cloudfriend-signature: sha256=<HMAC of the body> so your receiver can verify it.");
  signingField.hidden = true;
  const out = h("div");
  const submit = h("button", { type: "submit", class: "btn primary" }, "Add destination");
  const form = h(
    "form",
    { class: "form", novalidate: true },
    radioCards("dkind", "Kind", DEST_KINDS, kind, (v) => {
      kind = v;
      signingField.hidden = v !== "webhook";
      url.placeholder = v === "slack" ? "https://hooks.slack.com/services/…" : "https://example.com/hooks/cloudfriend";
      name.placeholder = v === "slack" ? "#ops-alerts" : "incident bridge";
    }),
    field("Name", name),
    field("URL", url, "Must be https. Private addresses are refused unless the server allows them."),
    signingField,
    out,
    h("div", { class: "actions" }, submit),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!name.value.trim() || !url.value.trim()) {
      replace(out, notice("error", "Name and URL are required."));
      (name.value.trim() ? url : name).focus();
      return;
    }
    const body = { name: name.value.trim(), kind, url: url.value.trim() };
    if (kind === "webhook" && signing.value) body.signing_secret = signing.value;
    const res = await withBusy(submit, "Adding…", () => api(wsPath(ws, "destinations"), { method: "POST", body }), out);
    if (res?.destination) {
      form.reset();
      onCreated(res.destination);
    }
  });
  return form;
}

/** "Send test message" with an inline ok/error result. onResult(ok) is optional. */
export function destinationTestButton(ws, dest, onResult) {
  const out = h("span", { class: "test-result", "aria-live": "polite" });
  const btn = h("button", { type: "button", class: "btn small" }, "Send test message");
  btn.addEventListener("click", async () => {
    replace(out);
    const res = await withBusy(btn, "Sending…", () => api(wsPath(ws, "destinations", dest.id, "test"), { method: "POST" }), out);
    if (!res) return;
    if (res.ok) replace(out, h("span", { class: "result-ok" }, `Delivered. Check ${dest.kind === "slack" ? "the Slack channel" : "your receiver"} for a message labelled as a test.`));
    else replace(out, h("span", { class: "result-err" }, `Failed: ${res.error ?? "unknown error"}`));
    onResult?.(!!res.ok);
  });
  return h("div", { class: "test-row" }, btn, out);
}

export function destinationSummary(d) {
  return kv([
    ["Kind", DEST_KINDS[d.kind]?.label ?? d.kind],
    ["URL", h("code", { class: "break" }, d.url_display)],
    d.kind === "webhook" && ["Signed", d.has_signing_secret ? "Yes" : "No"],
    ["Last delivery", timeEl(d.last_delivery_at)],
    d.last_error && ["Last error", h("span", { class: "result-err" }, d.last_error)],
    ["Added", h("span", { title: fmtAbs(d.created_at) }, timeEl(d.created_at))],
  ]);
}
