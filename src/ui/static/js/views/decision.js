// One Jev call: model, the events it saw, the exact prompt and the raw reply.
import { api, wsPath } from "../api.js";
import { h, replace, timeEl, fmtAbs, maybePrettyJson } from "../dom.js";
import { kv, loading, copyButton, notice } from "../components.js";
import { wsHash } from "../app.js";

export async function render(ctx) {
  const { ws } = ctx;
  const back = h("p", null, h("a", { href: wsHash(ws, "events"), class: "back" }, "Events"));
  replace(ctx.main, back, loading());
  const { decision: d } = await api(wsPath(ws, "decisions", ctx.params.id), { signal: ctx.signal });
  ctx.setTitle(`Decision ${d.id}`);
  const purged = d.prompt === null && d.response === null;
  const block = (title, text) =>
    h(
      "section",
      { class: "section" },
      h("div", { class: "section-head" }, h("h2", null, title), text !== null ? copyButton(text, "Copy") : null),
      text === null ? h("p", { class: "muted" }, "Not kept: past retention.") : h("pre", { class: "code block prompt", tabindex: "0", "aria-label": title }, text),
    );
  replace(
    ctx.main,
    back,
    h("h1", null, "Jev decision"),
    h(
      "section",
      { class: "card" },
      kv([
        ["Decider", d.decider],
        ["Model", d.model ? h("code", null, d.model) : null],
        ["When", h("span", null, timeEl(d.created_at), h("span", { class: "muted" }, ` (${fmtAbs(d.created_at)})`))],
        ["Events", h("ul", { class: "inline-list" }, (d.event_ids ?? []).map((id) => h("li", null, h("a", { href: wsHash(ws, "events", id) }, id))))],
        ["Decision id", h("code", null, d.id)],
      ]),
    ),
    purged ? notice("info", "The prompt and reply of this call are past retention and were deleted. Its labels and flags are kept.") : null,
    h("p", { class: "hint" }, "The text below is exactly what Jev was sent and what it replied, shown as plain text. Jev never sees the classifier's score."),
    block("Prompt", d.prompt),
    block("Reply", d.response === null ? null : maybePrettyJson(d.response)),
  );
}
