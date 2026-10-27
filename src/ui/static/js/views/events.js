// Event list with filters (route, source, since) and paging.
import { api, wsPath } from "../api.js";
import { h, replace, timeEl, fmtScore, eventSummary, fmtNumber } from "../dom.js";
import { routeBadge, judgmentBadge, badge, emptyState, loading, ROUTE_NAMES, ROUTES } from "../components.js";
import { navigate, wsHash, hashFor } from "../app.js";

const SINCE = [["", "Any time"], ["1h", "Last hour"], ["24h", "Last 24 hours"], ["7d", "Last 7 days"]];
let sourceNames = { ws: null, list: [], map: new Map() };

export async function render(ctx) {
  const { ws, query } = ctx;
  ctx.setTitle("Events");
  const listEl = h("div", null, loading());
  const summary = h("p", { class: "summary", "aria-live": "polite" });
  replace(ctx.main, h("div", { class: "page-head" }, h("h1", null, "Events"), summary), listEl);

  const sources = await loadSources(ws, ctx.signal, true);

  const go = (patch) => navigate(hashFor(`w/${encodeURIComponent(ws)}/events`, { ...query, ...patch }));
  const route = h("select", { id: "ev-route" }, h("option", { value: "" }, "Any route"), ROUTE_NAMES.map((r) => h("option", { value: r, selected: query.route === r, title: ROUTES[r].text }, r)));
  const source = h(
    "select",
    { id: "ev-source" },
    h("option", { value: "" }, "Any source"),
    sources.map((s) => h("option", { value: s.id, selected: query.source === s.id }, s.revoked_at ? `${s.name} (revoked)` : s.name)),
    query.source && !sources.some((s) => s.id === query.source) ? h("option", { value: query.source, selected: true }, query.source) : null,
  );
  const since = h("select", { id: "ev-since" }, SINCE.map(([v, l]) => h("option", { value: v, selected: (query.since ?? "") === v }, l)));
  route.addEventListener("change", () => go({ route: route.value }));
  source.addEventListener("change", () => go({ source: source.value }));
  since.addEventListener("change", () => go({ since: since.value }));
  const filtered = query.route || query.source || query.since;
  const filters = h(
    "form",
    { class: "filters", role: "search", "aria-label": "Filter events", onsubmit: (e) => e.preventDefault() },
    h("div", { class: "field inline" }, h("label", { for: "ev-route" }, "Route"), route),
    h("div", { class: "field inline" }, h("label", { for: "ev-source" }, "Source"), source),
    h("div", { class: "field inline" }, h("label", { for: "ev-since" }, "Since"), since),
    filtered ? h("a", { class: "btn small ghost", href: wsHash(ws, "events") }, "Clear filters") : null,
  );
  listEl.before(filters);
  if (query.route && ROUTES[query.route]) filters.after(h("p", { class: "hint route-hint" }, routeBadge(query.route), " ", ROUTES[query.route].text));

  const all = [];
  let next = null;
  const more = h("button", { type: "button", class: "btn" }, "Load more");
  const loadPage = async () => {
    const res = await api(wsPath(ws, "events"), { query: { route: query.route, source: query.source, since: query.since, limit: 50, before: next }, signal: ctx.signal });
    all.push(...res.events);
    next = res.next;
    replace(summary, `${fmtNumber(all.length)}${next ? "+" : ""} event${all.length === 1 ? "" : "s"}${filtered ? " matching" : ""}, newest first`);
    replace(
      listEl,
      all.length ? eventList(ws, all) : emptyState(filtered ? "No events match these filters." : "No events yet.", filtered ? "" : h("p", null, "Connect a source or send a test exception from ", h("a", { href: wsHash(ws, "setup") }, "Setup"), ".")),
      next ? h("div", { class: "actions center" }, more) : null,
    );
  };
  more.addEventListener("click", async () => {
    more.disabled = true;
    more.textContent = "Loading…";
    try {
      await loadPage();
    } finally {
      more.disabled = false;
      more.textContent = "Load more";
    }
  });
  await loadPage();
}

/** Load the workspace's sources and remember their names for sourceLabel(). */
export async function loadSources(ws, signal, force = false) {
  if (!force && sourceNames.ws === ws) return sourceNames.list;
  const { sources } = await api(wsPath(ws, "sources"), { signal });
  sourceNames = { ws, list: sources, map: new Map(sources.map((s) => [s.id, s.name])) };
  return sources;
}

export function sourceLabel(ws, source) {
  return (sourceNames.ws === ws && sourceNames.map.get(source)) || source;
}

export function eventList(ws, events) {
  return h(
    "ul",
    { class: "rows events", "aria-label": "Events" },
    events.map((e) =>
      h(
        "li",
        null,
        h(
          "a",
          { class: "row", href: wsHash(ws, "events", e.id) },
          h("span", { class: "row-lead" }, routeBadge(e.route)),
          h("span", { class: "row-main" }, h("span", { class: "row-title mono" }, eventSummary(e.data))),
          h(
            "span",
            { class: "row-meta" },
            h("span", { title: "Source" }, sourceLabel(ws, e.source)),
            e.severity ? h("span", { title: "Severity" }, e.severity) : null,
            h("span", { title: "Classifier score", class: "mono" }, fmtScore(e.score)),
            judgmentBadge(e.judgment),
            e.flag_id ? badge("flagged", "flagged") : null,
            !e.decided ? badge("undecided", "plain") : null,
            timeEl(e.received_at),
          ),
        ),
      ),
    ),
  );
}
