// Sources: list, create, rotate secret, revoke.
import { api, wsPath } from "../api.js";
import { h, replace, timeEl, fmtAbs } from "../dom.js";
import { sourceForm, sourceSecretPanel, sourceSetupHints, copyButton, confirmDialog, notice, errorText, loading, emptyState, badge, SOURCE_KINDS } from "../components.js";
import { wsHash, hashFor } from "../app.js";

export async function render(ctx) {
  const { ws } = ctx;
  ctx.setTitle("Sources");
  replace(ctx.main, h("h1", null, "Sources"), loading());
  let sources = (await api(wsPath(ws, "sources"), { signal: ctx.signal })).sources;

  const top = h("div", { "aria-live": "polite" });
  const listEl = h("div");
  const newBtn = h("button", { type: "button", class: "btn primary" }, "New source");
  const formSlot = h("div");

  newBtn.addEventListener("click", () => {
    if (formSlot.firstChild) return replace(formSlot), (newBtn.textContent = "New source");
    newBtn.textContent = "Cancel";
    replace(
      formSlot,
      h(
        "section",
        { class: "card", "aria-label": "New source" },
        h("h2", null, "New source"),
        sourceForm(ws, ({ source, secret }) => {
          sources = [...sources, source];
          replace(formSlot);
          newBtn.textContent = "New source";
          showSecret(source, secret, false);
          draw();
        }),
      ),
    );
    formSlot.querySelector("input")?.focus();
  });

  function showSecret(source, secret, rotated) {
    const done = h("button", { type: "button", class: "btn" }, "I've stored the secret");
    done.addEventListener("click", () => replace(top));
    replace(top, h("section", { class: "card highlight" }, h("h2", null, rotated ? `New secret for ${source.name}` : `Source ${source.name} created`), sourceSecretPanel(source, secret, { rotated }), h("div", { class: "actions" }, done)));
    top.scrollIntoView({ block: "start" });
    top.querySelector(".secret-panel button")?.focus();
  }

  async function rotate(src, btn) {
    const ok = await confirmDialog({
      title: `Rotate the secret for ${src.name}?`,
      body: ["A new secret is created and shown once. The old one keeps working for 24 hours, so you can update the sender without losing events."],
      confirmLabel: "Rotate secret",
    });
    if (!ok) return;
    btn.disabled = true;
    try {
      const res = await api(wsPath(ws, "sources", src.id, "rotate"), { method: "POST" });
      sources = sources.map((s) => (s.id === src.id ? res.source : s));
      draw();
      showSecret(res.source, res.secret, true);
    } catch (err) {
      if (err?.status !== 401) replace(top, notice("error", errorText(err)));
      btn.disabled = false;
    }
  }

  async function revoke(src, btn) {
    const ok = await confirmDialog({
      title: `Revoke ${src.name}?`,
      body: ["Its endpoint stops accepting events at once, with every secret it has. Senders still using it get 401. Events already received are kept.", "This can't be undone; create a new source to start again."],
      confirmLabel: "Revoke source",
      danger: true,
    });
    if (!ok) return;
    btn.disabled = true;
    try {
      await api(wsPath(ws, "sources", src.id), { method: "DELETE" });
      sources = (await api(wsPath(ws, "sources"))).sources;
      replace(top, notice("ok", `Revoked ${src.name}.`));
      draw();
    } catch (err) {
      if (err?.status !== 401) replace(top, notice("error", errorText(err)));
      btn.disabled = false;
    }
  }

  function card(src) {
    const revoked = !!src.revoked_at;
    const rotateBtn = h("button", { type: "button", class: "btn small" }, "Rotate secret");
    const revokeBtn = h("button", { type: "button", class: "btn small danger-text" }, "Revoke");
    rotateBtn.addEventListener("click", () => rotate(src, rotateBtn));
    revokeBtn.addEventListener("click", () => revoke(src, revokeBtn));
    return h(
      "li",
      { class: `item ${revoked ? "is-revoked" : ""}`.trim() },
      h(
        "div",
        { class: "item-head" },
        h("h3", null, src.name),
        badge(SOURCE_KINDS[src.kind]?.label ?? src.kind, "plain"),
        revoked ? badge("Revoked", "status status-resolved", `Revoked ${fmtAbs(src.revoked_at)}`) : null,
        h("div", { class: "spacer" }),
        revoked ? null : h("div", { class: "actions tight" }, rotateBtn, revokeBtn),
      ),
      h(
        "dl",
        { class: "kv compact" },
        h("dt", null, "Endpoint"),
        h("dd", { class: "endpoint" }, h("code", { class: "break" }, src.endpoint_url), revoked ? null : copyButton(src.endpoint_url)),
        h("dt", null, "Secret"),
        h("dd", null, h("code", null, `${src.secret_prefix}…`)),
        h("dt", null, "Last event"),
        h("dd", null, timeEl(src.last_used_at, "no events yet"), " ", src.last_used_at ? h("a", { href: hashFor(`w/${encodeURIComponent(ws)}/events`, { source: src.id }) }, "View events") : null),
        h("dt", null, revoked ? "Revoked" : "Created"),
        h("dd", null, timeEl(revoked ? src.revoked_at : src.created_at)),
      ),
      revoked ? null : h("details", { class: "disclosure" }, h("summary", null, "Setup instructions"), sourceSetupHints(src, null)),
    );
  }

  function draw() {
    const active = sources.filter((s) => !s.revoked_at);
    const revoked = sources.filter((s) => s.revoked_at);
    replace(
      listEl,
      active.length ? h("ul", { class: "items" }, active.map(card)) : emptyState("No active sources.", "Create one to get an endpoint URL and a secret."),
      revoked.length ? h("details", { class: "disclosure section" }, h("summary", null, `Revoked sources (${revoked.length})`), h("ul", { class: "items" }, revoked.map(card))) : null,
    );
  }

  draw();
  replace(
    ctx.main,
    h("div", { class: "page-head" }, h("h1", null, "Sources"), newBtn),
    h("p", { class: "lead" }, "Each source is an endpoint URL with its own secret. To check the whole path, send a test exception from ", h("a", { href: wsHash(ws, "setup") }, "Setup"), "."),
    top,
    formSlot,
    listEl,
  );
}
