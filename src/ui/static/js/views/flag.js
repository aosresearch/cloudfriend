// One flag: what it is, its events and deliveries, the decisions behind it, and the actions on it.
import { api, wsPath } from "../api.js";
import { h, replace, timeEl, fmtAbs, fmtNumber } from "../dom.js";
import { severityBadge, statusBadge, badge, kv, notice, errorText, loading, emptyState, confirmDialog, STATUS_LABELS } from "../components.js";
import { wsHash } from "../app.js";
import { eventList, loadSources } from "./events.js";

export async function render(ctx) {
  const { ws } = ctx;
  const id = ctx.params.id;
  replace(ctx.main, h("p", null, h("a", { href: wsHash(ws, "queue"), class: "back" }, "Queue")), loading());
  let [data] = await Promise.all([api(wsPath(ws, "flags", id), { signal: ctx.signal }), loadSources(ws, ctx.signal).catch(() => [])]);

  const out = h("div", { "aria-live": "polite" });
  const body = h("div");

  async function act(btn, request, doneText) {
    const label = btn.textContent;
    for (const b of body.querySelectorAll(".flag-actions button")) b.disabled = true;
    btn.textContent = "Saving…";
    replace(out);
    try {
      const res = await request();
      data = { ...data, flag: res.flag };
      draw();
      replace(out, notice("ok", doneText));
    } catch (err) {
      if (err?.status === 401) return;
      replace(out, notice("error", errorText(err)));
      btn.textContent = label;
      for (const b of body.querySelectorAll(".flag-actions button")) b.disabled = false;
    }
  }
  const patch = (status) => () => api(wsPath(ws, "flags", id), { method: "PATCH", body: { status } });
  const feedback = (verdict) => () => api(wsPath(ws, "flags", id, "feedback"), { method: "POST", body: { verdict } });

  function actions(flag) {
    const btns = [];
    const open = flag.status === "open";
    const active = open || flag.status === "acknowledged";
    if (open) {
      const b = h("button", { type: "button", class: "btn primary" }, "Acknowledge");
      b.addEventListener("click", () => act(b, patch("acknowledged"), "Acknowledged. It stays in the queue until it is resolved."));
      btns.push(b);
    }
    if (active) {
      const b = h("button", { type: "button", class: "btn" }, "Resolve");
      b.addEventListener("click", () => act(b, patch("resolved"), "Resolved. It is out of the queue."));
      btns.push(b);
    }
    if (flag.status !== "confirmed") {
      const b = h("button", { type: "button", class: "btn" }, "Mark confirmed");
      b.addEventListener("click", async () => {
        const ok = await confirmDialog({
          title: "Mark this flag confirmed?",
          body: ["It was right to escalate. Its events become training labels that tell the classifier events like these matter.", "This also takes the flag out of the queue."],
          confirmLabel: "Mark confirmed",
        });
        if (ok) act(b, feedback("confirmed"), "Marked confirmed. Its events are labelled for training.");
      });
      btns.push(b);
    }
    if (flag.status !== "false_positive") {
      const b = h("button", { type: "button", class: "btn" }, "Mark false positive");
      b.addEventListener("click", async () => {
        const ok = await confirmDialog({
          title: "Mark this flag a false positive?",
          body: ["It should not have been escalated. Its events are labelled benign for training, and their templates stop being protected as known escalations.", "This also takes the flag out of the queue."],
          confirmLabel: "Mark false positive",
          danger: true,
        });
        if (ok) act(b, feedback("false_positive"), "Marked a false positive. Its events are labelled benign for training.");
      });
      btns.push(b);
    }
    return h("div", { class: "flag-actions actions" }, btns);
  }

  function draw() {
    const { flag, events, deliveries } = data;
    ctx.setTitle(flag.reason);
    const decisions = [...new Set(events.map((e) => e.decision_id).filter(Boolean))];
    const failed = deliveries.filter((d) => d.status === "failed").length;
    replace(
      body,
      h("div", { class: "page-head" }, h("h1", { class: "flag-title" }, flag.reason), h("div", { class: "badges" }, severityBadge(flag.severity), statusBadge(flag.status))),
      actions(flag),
      out,
      h(
        "div",
        { class: "grid-2" },
        h(
          "section",
          { class: "card" },
          h("h2", null, "Details"),
          kv([
            ["Status", STATUS_LABELS[flag.status] ?? flag.status],
            ["Severity", flag.severity],
            ["Raised by", flag.decider === "jev" ? "Jev" : flag.decider],
            ["Raised", h("span", null, timeEl(flag.created_at), h("span", { class: "muted" }, ` (${fmtAbs(flag.created_at)})`))],
            ["Updated", timeEl(flag.updated_at)],
            ["Events", fmtNumber(flag.event_count)],
            ["Users", flag.users?.length ? h("ul", { class: "inline-list" }, flag.users.map((u) => h("li", null, h("code", null, u)))) : null],
            ["Flag id", h("code", null, flag.id)],
          ]),
        ),
        h(
          "section",
          { class: "card" },
          h("h2", null, "Decisions"),
          decisions.length
            ? h("ul", { class: "plain-list" }, decisions.map((d) => h("li", null, h("a", { href: wsHash(ws, "decisions", d) }, "Jev's prompt and reply"), " ", h("code", { class: "muted" }, d))))
            : h("p", { class: "muted" }, flag.decider === "jev" ? "No decision is linked from the events still in retention." : "Raised without a Jev call."),
        ),
      ),
      h(
        "section",
        { class: "section" },
        h("h2", null, "Deliveries", failed ? h("span", { class: "count err" }, ` ${failed} failed`) : null),
        deliveries.length ? deliveryTable(deliveries) : emptyState("No deliveries.", "No destination was configured when this flag was raised."),
        h("p", { class: "hint" }, "Failed deliveries retry with backoff, up to 15 attempts. Check a destination with its test button on the ", h("a", { href: wsHash(ws, "destinations") }, "Destinations page"), "."),
      ),
      h(
        "section",
        { class: "section" },
        h("h2", null, "Events"),
        events.length ? eventList(ws, events) : emptyState("No events in retention.", "Events are kept for 7 days by default; the flag outlives them."),
        flag.event_count > events.length && events.length ? h("p", { class: "hint" }, `${fmtNumber(flag.event_count - events.length)} older events are past retention.`) : null,
      ),
    );
  }

  draw();
  replace(ctx.main, h("p", null, h("a", { href: wsHash(ws, "queue"), class: "back" }, "Queue")), body);
  ctx.poll(async () => {
    if (!data.deliveries.some((d) => d.status === "pending")) return;
    const fresh = await api(wsPath(ws, "flags", id), { signal: ctx.signal });
    data = { ...data, deliveries: fresh.deliveries };
    const table = body.querySelector(".deliveries");
    if (table) table.replaceWith(deliveryTable(data.deliveries));
  }, 3000);
}

function deliveryTable(deliveries) {
  return h(
    "div",
    { class: "table-wrap deliveries" },
    h(
      "table",
      null,
      h("thead", null, h("tr", null, ["Destination", "Status", "Attempts", "Last error", "Updated"].map((t) => h("th", { scope: "col" }, t)))),
      h(
        "tbody",
        null,
        deliveries.map((d) =>
          h(
            "tr",
            null,
            h("td", null, d.destination_name),
            h("td", null, badge(d.status, `delivery delivery-${d.status}`)),
            h("td", { class: "num" }, String(d.attempts)),
            h("td", null, d.last_error ? h("span", { class: "result-err" }, d.last_error) : h("span", { class: "muted" }, "–")),
            h("td", null, timeEl(d.updated_at)),
          ),
        ),
      ),
    ),
  );
}
