import { api } from "../api.js";
import { h, replace, timeEl } from "../dom.js";
import { field, notice, withBusy, loading, badge } from "../components.js";
import { loadMe, navigate, wsHash } from "../app.js";

export async function render(ctx) {
  ctx.setTitle("Workspaces");
  replace(ctx.main, h("h1", null, "Workspaces"), loading());
  const { workspaces } = await api("workspaces", { signal: ctx.signal });
  const first = workspaces.length === 0;

  const name = h("input", { type: "text", required: true, autocomplete: "off", maxlength: "80", placeholder: "e.g. Acme production" });
  const out = h("div");
  const submit = h("button", { type: "submit", class: "btn primary" }, first ? "Create workspace" : "Create");
  const form = h("form", { class: "form inline-form", novalidate: true }, field("Workspace name", name, "A workspace has its own sources, destinations, events and queue."), out, h("div", { class: "actions" }, submit));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!name.value.trim()) {
      replace(out, notice("error", "Give the workspace a name."));
      name.focus();
      return;
    }
    const res = await withBusy(submit, "Creating…", () => api("workspaces", { method: "POST", body: { name: name.value.trim() } }), out);
    if (res?.workspace) {
      await loadMe();
      navigate(wsHash(res.workspace.id, "setup"));
    }
  });

  if (first) {
    replace(
      ctx.main,
      h("h1", null, "Create your first workspace"),
      h("p", { class: "lead" }, "Start with one workspace per product or environment. Next you'll connect a source, add somewhere for alerts to go, and send a test exception."),
      h("div", { class: "card" }, form),
    );
    name.focus();
    return;
  }

  replace(
    ctx.main,
    h("h1", null, "Workspaces"),
    h(
      "ul",
      { class: "rows", "aria-label": "Your workspaces" },
      workspaces.map((w) =>
        h(
          "li",
          null,
          h(
            "a",
            { class: "row", href: wsHash(w.id) },
            h("span", { class: "row-main" }, h("strong", null, w.name)),
            h("span", { class: "row-meta" }, badge(w.role === "owner" ? "Owner" : "Member", "plain"), h("span", { class: "muted" }, "created ", timeEl(w.created_at))),
          ),
        ),
      ),
    ),
    h("section", { class: "section" }, h("h2", null, "New workspace"), h("div", { class: "card" }, form)),
  );
}
