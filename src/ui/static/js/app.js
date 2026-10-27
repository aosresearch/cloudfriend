// Entry point: session state, hash router and the app shell.
//
// Routes (all in the URL hash, so the app works from any path and the server only has to serve index.html):
//   #/signin                      #/workspaces
//   #/w/:ws                       -> setup if the workspace has no source yet, otherwise the queue
//   #/w/:ws/setup                 #/w/:ws/queue            #/w/:ws/flags/:id
//   #/w/:ws/events                #/w/:ws/events/:id       #/w/:ws/decisions/:id
//   #/w/:ws/sources               #/w/:ws/destinations     #/w/:ws/usage
import { api, ApiError, onUnauthorized, wsPath } from "./api.js";
import { h, replace, fmtMoney } from "./dom.js";
import { errorText, notice } from "./components.js";
import * as signin from "./views/signin.js";
import * as workspaces from "./views/workspaces.js";
import * as setup from "./views/setup.js";
import * as queue from "./views/queue.js";
import * as flag from "./views/flag.js";
import * as events from "./views/events.js";
import * as event from "./views/event.js";
import * as decision from "./views/decision.js";
import * as sources from "./views/sources.js";
import * as destinations from "./views/destinations.js";
import * as usage from "./views/usage.js";

const WS_VIEWS = {
  setup: { view: setup, nav: "setup" },
  queue: { view: queue, nav: "queue" },
  flags: { view: flag, nav: "queue", needsId: true },
  events: { view: events, nav: "events", detail: event },
  decisions: { view: decision, nav: "events", needsId: true },
  sources: { view: sources, nav: "sources" },
  destinations: { view: destinations, nav: "destinations" },
  usage: { view: usage, nav: "usage" },
};
const NAV = [
  ["queue", "Queue"],
  ["events", "Events"],
  ["sources", "Sources"],
  ["destinations", "Destinations"],
  ["usage", "Usage"],
  ["setup", "Setup"],
];
const LAST_WS_KEY = "cloudfriend.lastWorkspace";

export const state = {
  authConfig: null,
  me: null, // { user, workspaces }
  usage: null,
  usageWs: null,
  usageAt: 0,
};

const root = document.getElementById("app");
let current = null; // { controller }
let afterSignIn = null;
let firstRender = true;

// --- navigation ----------------------------------------------------------------------------------

export function navigate(hash, { replace: rep = false } = {}) {
  const target = hash.startsWith("#") ? hash : `#${hash}`;
  if (location.hash === target) return render();
  if (rep) {
    history.replaceState(null, "", target);
    render();
  } else location.hash = target;
}

export function hashFor(path, query) {
  const qs = new URLSearchParams(Object.entries(query ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();
  return `#/${path.replace(/^\/+/, "")}${qs ? `?${qs}` : ""}`;
}

export const wsHash = (ws, ...parts) => `#/w/${[ws, ...parts].map(encodeURIComponent).join("/")}`;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [p, qs = ""] = raw.split("?");
  const parts = p.split("/").filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  return { parts, query: Object.fromEntries(new URLSearchParams(qs)) };
}

function lastWorkspace() {
  try {
    return localStorage.getItem(LAST_WS_KEY);
  } catch {
    return null;
  }
}
function rememberWorkspace(ws) {
  try {
    localStorage.setItem(LAST_WS_KEY, ws);
  } catch {}
}

// --- session -------------------------------------------------------------------------------------

export async function loadMe() {
  try {
    state.me = await api("me");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) state.me = null;
    else throw err;
  }
  return state.me;
}

export async function signedIn() {
  await loadMe();
  const target = afterSignIn;
  afterSignIn = null;
  navigate(target && !target.startsWith("#/signin") ? target : "#/", { replace: true });
}

export async function signOut() {
  try {
    await api("logout", { method: "POST" });
  } catch {}
  state.me = null;
  state.usage = null;
  navigate("#/signin");
}

onUnauthorized(() => {
  if (!state.me) return;
  state.me = null;
  if (!location.hash.startsWith("#/signin")) afterSignIn = location.hash;
  navigate("#/signin", { replace: true });
});

// --- rendering -----------------------------------------------------------------------------------

function makeCtx(main, extra) {
  const controller = new AbortController();
  current?.controller.abort();
  current = { controller };
  const signal = controller.signal;
  return {
    main,
    signal,
    state,
    navigate,
    setTitle(title) {
      const ws = extra.wsInfo?.name;
      document.title = [title, ws, "cloudfriend"].filter(Boolean).join(" · ");
    },
    /** Repeat fn every ms while this view is shown; pauses while the tab is hidden. */
    poll(fn, ms) {
      let timer = null;
      const run = async () => {
        if (signal.aborted) return;
        if (!document.hidden) {
          try {
            if ((await fn()) === false) return;
          } catch (err) {
            if (err?.name === "AbortError" || err?.status === 401) return;
          }
        }
        if (!signal.aborted) timer = setTimeout(run, ms);
      };
      timer = setTimeout(run, ms);
      signal.addEventListener("abort", () => clearTimeout(timer));
    },
    refreshUsage: () => refreshUsage(extra.ws, true),
    ...extra,
  };
}

async function render() {
  const { parts, query } = parseHash();
  const top = parts[0] ?? "";
  try {
    if (!state.authConfig) state.authConfig = await api("auth-config").catch(() => ({ password: true, oidc: false }));
    if (state.me === null && top !== "signin") {
      await loadMe();
      if (!state.me) {
        afterSignIn = location.hash || null;
        return navigate("#/signin", { replace: true });
      }
    }
    if (top === "signin") {
      if (state.me) return navigate("#/", { replace: true });
      return showBare(signin, query);
    }
    if (top === "workspaces") return showBare(workspaces, query);
    if (top === "w" && parts[1]) return showWorkspace(parts[1], parts[2], parts[3], query);
    // Home: last workspace, the only workspace, or the picker.
    const list = state.me.workspaces ?? [];
    const last = lastWorkspace();
    const pick = list.find((w) => w.id === last) ?? (list.length === 1 ? list[0] : null);
    return navigate(pick ? wsHash(pick.id) : "#/workspaces", { replace: true });
  } catch (err) {
    replace(root, h("main", { class: "page", id: "main" }, notice("error", "Something went wrong loading cloudfriend: ", errorText(err)), h("button", { class: "btn", type: "button", onclick: () => render() }, "Try again")));
  }
}

async function showBare(view, query) {
  const main = h("main", { class: "page page-narrow", id: "main", tabindex: "-1" });
  const shell = h("div", { class: "bare" }, h("header", { class: "bare-head" }, brand(), state.me ? userMenu() : null), main);
  replace(root, skipLink(), shell);
  const ctx = makeCtx(main, { query });
  await runView(view, ctx);
}

async function showWorkspace(ws, section, id, query) {
  if (!section) {
    // Decide where a workspace opens: setup until it has a source.
    try {
      const { sources } = await api(wsPath(ws, "sources"));
      return navigate(wsHash(ws, sources.some((s) => !s.revoked_at) ? "queue" : "setup"), { replace: true });
    } catch (err) {
      if (err?.status === 401) return;
      return navigate(wsHash(ws, "queue"), { replace: true });
    }
  }
  if (section === "flags" && !id) return navigate(`${wsHash(ws, "queue")}?view=history`, { replace: true });
  const entry = WS_VIEWS[section];
  const wsInfo = (state.me?.workspaces ?? []).find((w) => w.id === ws) ?? null;
  if (wsInfo) rememberWorkspace(ws);
  const main = h("main", { class: "page", id: "main", tabindex: "-1" });
  const banner = h("div", { class: "banner-slot" });
  replace(root, skipLink(), topbar(ws, wsInfo, entry?.nav), banner, main);
  const view = entry ? (id && entry.detail ? entry.detail : entry.view) : null;
  const ctx = makeCtx(main, { ws, wsInfo, params: { id }, query, banner });
  if (!view || (entry.needsId && !id)) {
    ctx.setTitle("Not found");
    return replace(main, h("h1", null, "Not found"), h("p", null, "There is no such page. ", h("a", { href: wsHash(ws, "queue") }, "Go to the queue"), "."));
  }
  refreshUsage(ws).then(() => renderBanner(ctx));
  await runView(view, ctx);
}

async function runView(view, ctx) {
  ctx.main.setAttribute("aria-busy", "true");
  try {
    await view.render(ctx);
  } catch (err) {
    if (ctx.signal.aborted || err?.name === "AbortError") return;
    if (err?.status === 401) return;
    showError(ctx, err);
  } finally {
    ctx.main.removeAttribute("aria-busy");
  }
  if (!firstRender) {
    const heading = ctx.main.querySelector("h1");
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: false });
    }
  }
  firstRender = false;
}

export function showError(ctx, err) {
  if (err?.status === 403) {
    ctx.setTitle("No access");
    replace(
      ctx.main,
      h("h1", null, "No access"),
      h("p", null, "You are signed in, but you are not a member of this workspace. Ask one of its owners to add you."),
      h("p", null, h("a", { href: "#/workspaces" }, "Choose another workspace")),
    );
    return;
  }
  if (err?.status === 404) {
    ctx.setTitle("Not found");
    replace(ctx.main, h("h1", null, "Not found"), h("p", null, errorText(err), ". It may have been deleted, or it is past event retention."));
    return;
  }
  ctx.setTitle("Error");
  replace(ctx.main, h("h1", null, "Couldn't load this page"), notice("error", errorText(err)), h("button", { type: "button", class: "btn", onclick: () => render() }, "Try again"));
}

// --- shell ---------------------------------------------------------------------------------------

function skipLink() {
  return h("a", { class: "skip-link", href: "#main", onclick: (e) => (e.preventDefault(), document.getElementById("main")?.focus()) }, "Skip to content");
}

function brand() {
  return h("a", { class: "brand", href: "#/" }, h("span", { class: "brand-mark", "aria-hidden": "true" }), "cloudfriend");
}

function userMenu() {
  const email = state.me?.user?.email ?? "";
  return h("div", { class: "user" }, h("span", { class: "user-email", title: email }, email), h("button", { type: "button", class: "btn small ghost", onclick: signOut }, "Sign out"));
}

function topbar(ws, wsInfo, active) {
  const list = state.me?.workspaces ?? [];
  const select = h(
    "select",
    { class: "ws-select", "aria-label": "Workspace" },
    list.map((w) => h("option", { value: w.id, selected: w.id === ws }, w.name)),
    !wsInfo ? h("option", { value: ws, selected: true }, ws) : null,
    h("option", { value: "__all" }, "All workspaces…"),
  );
  select.addEventListener("change", () => navigate(select.value === "__all" ? "#/workspaces" : wsHash(select.value)));
  return h(
    "header",
    { class: "topbar" },
    h("div", { class: "topbar-row" }, brand(), select, h("div", { class: "spacer" }), userMenu()),
    h(
      "nav",
      { class: "nav", "aria-label": "Workspace sections" },
      h("ul", null, NAV.map(([key, label]) => h("li", null, h("a", { href: wsHash(ws, key), "aria-current": key === active ? "page" : null }, label)))),
    ),
  );
}

async function refreshUsage(ws, force = false) {
  if (!force && state.usageWs === ws && Date.now() - state.usageAt < 30_000) return state.usage;
  try {
    state.usage = await api(wsPath(ws, "usage"));
    state.usageWs = ws;
    state.usageAt = Date.now();
  } catch {
    if (state.usageWs !== ws) state.usage = null;
  }
  return state.usage;
}

/** The global banner: budget exhausted, or no decider configured. */
function renderBanner(ctx) {
  if (ctx.signal.aborted || state.usageWs !== ctx.ws) return;
  const u = state.usage;
  if (/^#\/w\/[^/]+\/usage/.test(location.hash)) return replace(ctx.banner); // the usage page explains it in full
  if (!u) return replace(ctx.banner);
  if (u.budget_exhausted) {
    return replace(
      ctx.banner,
      h(
        "div",
        { class: "banner banner-warn", role: "status" },
        h("strong", null, "Jev's daily budget is used up. "),
        `Spent ${fmtMoney(u.jev_spend_usd)} of ${fmtMoney(u.jev_budget_usd)} today. Until the budget resets, the classifier decides alone: events it scores above its threshold are escalated on route classifier, and nothing else is judged. `,
        h("a", { href: wsHash(ctx.ws, "usage") }, "See usage"),
      ),
    );
  }
  if (u.decider === "none") {
    return replace(ctx.banner, h("div", { class: "banner banner-warn", role: "status" }, h("strong", null, "No decider is configured. "), "Events are stored and scored, but nothing is judged or escalated. Set JEV_API_KEY on the server to turn Jev on."));
  }
  replace(ctx.banner);
}

window.addEventListener("hashchange", () => render());
render();
