// Usage: today's events, backlog, Jev calls and spend against the budget, and the route mix.
import { api, wsPath } from "../api.js";
import { h, replace, fmtNumber, fmtMoney } from "../dom.js";
import { loading, notice, routeBadge, ROUTES, JEV_ROUTES } from "../components.js";
import { navigate, hashFor } from "../app.js";

const WINDOWS = [["1h", "Last hour"], ["24h", "Last 24 hours"], ["7d", "Last 7 days"]];
const DECIDERS = { jev: "Jev", classifier: "Classifier only", none: "None" };

export async function render(ctx) {
  const { ws, query } = ctx;
  const since = WINDOWS.some(([v]) => v === query.since) ? query.since : "24h";
  ctx.setTitle("Usage");
  replace(ctx.main, h("h1", null, "Usage"), loading());

  const body = h("div");
  const load = async () => {
    const [u, stats] = await Promise.all([api(wsPath(ws, "usage"), { signal: ctx.signal }), api(wsPath(ws, "stats"), { query: { since }, signal: ctx.signal })]);
    ctx.state.usage = u;
    ctx.state.usageWs = ws;
    ctx.state.usageAt = Date.now();
    draw(u, stats);
  };

  const sel = h("select", { id: "usage-since" }, WINDOWS.map(([v, l]) => h("option", { value: v, selected: v === since }, l)));
  sel.addEventListener("change", () => navigate(hashFor(`w/${encodeURIComponent(ws)}/usage`, { since: sel.value })));

  function draw(u, stats) {
    const pct = u.jev_budget_usd > 0 ? Math.min(100, (u.jev_spend_usd / u.jev_budget_usd) * 100) : 0;
    const meter = h("div", { class: `meter ${u.budget_exhausted ? "is-full" : pct >= 80 ? "is-high" : ""}`.trim(), role: "meter", "aria-valuemin": "0", "aria-valuemax": String(u.jev_budget_usd), "aria-valuenow": String(u.jev_spend_usd), "aria-label": "Jev spend against the daily budget" }, h("span", { class: "meter-fill" }));
    meter.firstChild.style.width = `${pct}%`;

    const routes = Object.entries(stats.routes ?? {}).sort((a, b) => b[1] - a[1]);
    const total = stats.events || routes.reduce((n, [, c]) => n + c, 0);
    const toJev = routes.filter(([r]) => JEV_ROUTES.has(r)).reduce((n, [, c]) => n + c, 0);
    const max = Math.max(1, ...routes.map(([, c]) => c));

    replace(
      body,
      u.budget_exhausted
        ? notice(
            "warn",
            h("strong", null, "Jev's daily budget is used up. "),
            "Until it resets, the classifier decides alone. Events it scores at or above its threshold are escalated on route classifier; everything else is stored but not judged, and no training labels are made. Alerts keep flowing, but with less judgment behind them. To turn Jev back on before then, raise the budget in the server's configuration.",
          )
        : null,
      u.decider === "none" ? notice("warn", h("strong", null, "No decider is configured. "), "Events are stored and scored, but nothing is escalated.") : null,
      h(
        "div",
        { class: "tiles" },
        tile(`Events on ${u.day}`, fmtNumber(u.events)),
        tile("Backlog", fmtNumber(u.backlog), u.backlog > 0 ? "Waiting to be parsed or decided." : "Nothing waiting.", u.backlog > 1000 ? "warn" : ""),
        tile("Jev calls today", fmtNumber(u.jev_calls)),
        tile("Decider", DECIDERS[u.decider] ?? u.decider, u.budget_exhausted ? "Jev is paused: budget used up." : null, u.decider === "jev" ? "" : "warn"),
      ),
      h(
        "section",
        { class: "card" },
        h("h2", null, "Jev spend today"),
        h("p", { class: "big" }, fmtMoney(u.jev_spend_usd), h("span", { class: "muted" }, ` of ${fmtMoney(u.jev_budget_usd)} budget`)),
        meter,
        h("p", { class: "hint" }, u.budget_exhausted ? "Budget used up." : `${fmtMoney(Math.max(0, u.jev_budget_usd - u.jev_spend_usd))} left today.`),
      ),
      h(
        "section",
        { class: "section" },
        h("div", { class: "section-head" }, h("h2", null, "Routes"), h("div", { class: "field inline" }, h("label", { for: "usage-since" }, "Window"), sel)),
        h("p", { class: "muted" }, `${fmtNumber(total)} events, ${fmtNumber(stats.flags)} flags. `, total ? `${fmtNumber(toJev)} (${((toJev / total) * 100).toFixed(1)}%) were routed to Jev.` : ""),
        routes.length
          ? h(
              "ul",
              { class: "bars" },
              routes.map(([r, c]) => {
                const bar = h("span", { class: `bar-fill ${JEV_ROUTES.has(r) ? "to-jev" : ""}`.trim() });
                bar.style.width = `${(c / max) * 100}%`;
                return h(
                  "li",
                  null,
                  h("a", { href: hashFor(`w/${encodeURIComponent(ws)}/events`, { route: ROUTES[r] ? r : undefined, since }), title: ROUTES[r]?.text ?? r }, routeBadge(r === "none" ? null : r)),
                  h("span", { class: "bar", "aria-hidden": "true" }, bar),
                  h("span", { class: "num" }, fmtNumber(c)),
                );
              }),
            )
          : h("p", { class: "muted" }, "No events in this window."),
      ),
    );
  }

  await load();
  replace(ctx.main, h("h1", null, "Usage"), body);
  ctx.poll(load, 30_000);
}

function tile(label, value, sub, cls = "") {
  return h("div", { class: `tile ${cls}`.trim() }, h("p", { class: "tile-label" }, label), h("p", { class: "tile-value" }, value), sub ? h("p", { class: "tile-sub muted" }, sub) : null);
}
