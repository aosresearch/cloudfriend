// The escalation queue: open and acknowledged flags, most severe first; plus a history tab.
import { api, wsPath } from "../api.js";
import { h, replace, timeEl, fmtNumber } from "../dom.js";
import { severityBadge, statusBadge, emptyState, loading, STATUS_LABELS, SEVERITIES, badge } from "../components.js";
import { navigate, wsHash, hashFor } from "../app.js";

const HISTORY_STATUSES = ["", "resolved", "confirmed", "false_positive", "open", "acknowledged"];

export async function render(ctx) {
  const { ws, query } = ctx;
  const history = query.view === "history";
  ctx.setTitle(history ? "Flag history" : "Queue");

  const tabs = h(
    "nav",
    { class: "tabs", "aria-label": "Queue views" },
    h("a", { href: wsHash(ws, "queue"), "aria-current": history ? null : "page" }, "Needs attention"),
    h("a", { href: hashFor(`w/${encodeURIComponent(ws)}/queue`, { view: "history" }), "aria-current": history ? "page" : null }, "All flags"),
  );
  const listEl = h("div", null, loading());
  const summary = h("p", { class: "summary", "aria-live": "polite" });
  const head = h("div", { class: "page-head" }, h("h1", null, history ? "All flags" : "Queue"), summary);
  replace(ctx.main, head, tabs, listEl);

  if (!history) {
    const load = async () => {
      const { flags } = await api(wsPath(ws, "queue"), { signal: ctx.signal });
      const counts = SEVERITIES.map((s) => [s, flags.filter((f) => f.severity === s).length]).filter(([, n]) => n);
      replace(summary, flags.length ? counts.map(([s, n], i) => [i ? " · " : "", `${n} ${s}`]) : "", flags.length ? ` · ${flags.filter((f) => f.status === "acknowledged").length} acknowledged` : "");
      replace(
        listEl,
        flags.length
          ? flagList(ws, flags)
          : emptyState(
              "Nothing needs attention.",
              h("p", null, "Alerts Jev raises land here, most severe first. To check the pipeline end to end, send a test exception from ", h("a", { href: wsHash(ws, "setup") }, "Setup"), "."),
            ),
      );
    };
    await load();
    ctx.poll(load, 15_000);
    return;
  }

  const status = h(
    "select",
    { id: "flag-status" },
    HISTORY_STATUSES.map((s) => h("option", { value: s, selected: (query.status ?? "") === s }, s ? STATUS_LABELS[s] : "Any status")),
  );
  status.addEventListener("change", () => navigate(hashFor(`w/${encodeURIComponent(ws)}/queue`, { view: "history", status: status.value })));
  tabs.after(h("div", { class: "filters" }, h("div", { class: "field inline" }, h("label", { for: "flag-status" }, "Status"), status)));

  const all = [];
  const more = h("button", { type: "button", class: "btn" }, "Load more");
  let next = null;
  const loadPage = async () => {
    const res = await api(wsPath(ws, "flags"), { query: { status: query.status, limit: 50, before: next }, signal: ctx.signal });
    all.push(...res.flags);
    next = res.next;
    replace(summary, `${fmtNumber(all.length)}${next ? "+" : ""} flags`);
    replace(listEl, all.length ? flagList(ws, all) : emptyState("No flags match."), next ? h("div", { class: "actions center" }, more) : null);
  };
  more.addEventListener("click", async () => {
    more.disabled = true;
    try {
      await loadPage();
    } finally {
      more.disabled = false;
    }
  });
  await loadPage();
}

export function flagList(ws, flags) {
  return h(
    "ul",
    { class: "rows flags", "aria-label": "Flags" },
    flags.map((f) =>
      h(
        "li",
        null,
        h(
          "a",
          { class: `row sev-row sev-row-${f.severity}`, href: wsHash(ws, "flags", f.id) },
          h("span", { class: "row-lead" }, severityBadge(f.severity)),
          h("span", { class: "row-main" }, h("span", { class: "row-title" }, f.reason)),
          h(
            "span",
            { class: "row-meta" },
            statusBadge(f.status),
            h("span", null, `${fmtNumber(f.event_count)} event${f.event_count === 1 ? "" : "s"}`),
            f.users?.length ? h("span", null, `${f.users.length} user${f.users.length === 1 ? "" : "s"}`) : null,
            f.decider && f.decider !== "jev" ? badge(`by ${f.decider}`, "plain") : null,
            timeEl(f.created_at),
          ),
        ),
      ),
    ),
  );
}
