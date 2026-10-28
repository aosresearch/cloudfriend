// One event: payload, classifier score and route, Jev's judgment, links, and "report as missed".
import { api, wsPath } from "../api.js";
import { h, replace, timeEl, fmtAbs, fmtScore, fmtSeverity, prettyJson, eventSummary } from "../dom.js";
import { routeBadge, judgmentBadge, kv, notice, loading, confirmDialog, copyButton, withBusy, ROUTES, JUDGMENTS, JEV_ROUTES } from "../components.js";
import { wsHash } from "../app.js";
import { sourceLabel, loadSources } from "./events.js";

export async function render(ctx) {
  const { ws } = ctx;
  const back = h("p", null, h("a", { href: wsHash(ws, "events"), class: "back" }, "Events"));
  replace(ctx.main, back, loading());
  const [{ event: e }] = await Promise.all([api(wsPath(ws, "events", ctx.params.id), { signal: ctx.signal }), loadSources(ws, ctx.signal).catch(() => [])]);
  ctx.setTitle(`Event ${e.id}`);

  let decidedText;
  if (!e.route) decidedText = "Pending: not parsed yet.";
  else if (!e.decided) decidedText = JEV_ROUTES.has(e.route) ? "Waiting for Jev's next batch." : "Waiting for a decision.";
  else if (e.decision_id) decidedText = h("a", { href: wsHash(ws, "decisions", e.decision_id) }, "Decided by Jev: see the prompt and reply");
  else if (JEV_ROUTES.has(e.route)) decidedText = "Decided by a reused recent verdict, without a new Jev call.";
  else decidedText = e.route === "drop" ? "Dropped by the classifier." : "Decided by the classifier.";

  const out = h("div", { "aria-live": "polite" });
  const report = h("button", { type: "button", class: "btn" }, "Report as missed");
  report.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Report this event as missed?",
      body: [
        "Say this event should have been escalated. It becomes a training label, any cached 'not relevant' verdict for its kind is cleared, and its template is treated as escalated, so Jev sees the next one.",
        "This does not raise an alert now.",
      ],
      confirmLabel: "Report as missed",
    });
    if (!ok) return;
    const res = await withBusy(report, "Reporting…", () => api(wsPath(ws, "events", e.id, "feedback"), { method: "POST", body: { escalate: true } }), out);
    if (res !== undefined) {
      replace(out, notice("ok", "Reported. Thanks: the classifier learns from this at its next training run."));
      report.disabled = true;
      report.textContent = "Reported as missed";
    }
  });

  const payload = prettyJson(e.data);
  replace(
    ctx.main,
    back,
    h("div", { class: "page-head" }, h("h1", { class: "event-title mono" }, eventSummary(e.data)), h("div", { class: "badges" }, routeBadge(e.route), judgmentBadge(e.judgment))),
    h(
      "div",
      { class: "grid-2" },
      h(
        "section",
        { class: "card" },
        h("h2", null, "Triage"),
        kv([
          ["Route", e.route ? h("span", null, routeBadge(e.route), " ", h("span", { class: "muted" }, ROUTES[e.route]?.text ?? "")) : "Pending"],
          ["Score", h("span", { class: "mono" }, fmtScore(e.score))],
          ["Severity", fmtSeverity(e.severity)],
          ["Template", e.template ? h("code", { class: "break" }, e.template) : null],
          ["Decision", decidedText],
          e.judgment !== undefined && ["Jev's judgment", e.judgment ? h("span", null, judgmentBadge(e.judgment), " ", h("span", { class: "muted" }, JUDGMENTS[e.judgment] ?? "")) : h("span", { class: "muted" }, "Not judged")],
          e.flag_id !== undefined && ["Flag", e.flag_id ? h("a", { href: wsHash(ws, "flags", e.flag_id) }, "Open the flag") : h("span", { class: "muted" }, "None")],
        ]),
      ),
      h(
        "section",
        { class: "card" },
        h("h2", null, "Event"),
        kv([
          ["Received", h("span", null, timeEl(e.received_at), h("span", { class: "muted" }, ` (${fmtAbs(e.received_at)})`))],
          ["Source", sourceLabel(ws, e.source)],
          ["Event id", h("code", null, e.id)],
        ]),
        h(
          "div",
          { class: "missed" },
          h("h3", null, "Should this have alerted?"),
          e.flag_id
            ? h("p", { class: "muted" }, "This event is already part of a flag.")
            : [h("p", { class: "muted" }, "If a person should have been told about this, report it. That is the most useful feedback for the classifier and Jev."), report, out],
        ),
      ),
    ),
    h(
      "section",
      { class: "section" },
      h("div", { class: "section-head" }, h("h2", null, "Payload"), copyButton(payload, "Copy JSON")),
      h("pre", { class: "code block payload", tabindex: "0", "aria-label": "Event payload as JSON" }, payload),
    ),
  );
}
