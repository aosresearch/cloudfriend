// Destinations: list, add, test, delete.
import { api, wsPath } from "../api.js";
import { h, replace } from "../dom.js";
import { destinationForm, destinationTestButton, destinationSummary, confirmDialog, notice, errorText, loading, emptyState, badge, DEST_KINDS } from "../components.js";

export async function render(ctx) {
  const { ws } = ctx;
  ctx.setTitle("Destinations");
  replace(ctx.main, h("h1", null, "Destinations"), loading());
  let dests = (await api(wsPath(ws, "destinations"), { signal: ctx.signal })).destinations;

  const top = h("div", { "aria-live": "polite" });
  const listEl = h("div");
  const formSlot = h("div");
  const newBtn = h("button", { type: "button", class: "btn primary" }, "Add destination");
  newBtn.addEventListener("click", () => {
    if (formSlot.firstChild) return replace(formSlot), (newBtn.textContent = "Add destination");
    newBtn.textContent = "Cancel";
    replace(
      formSlot,
      h(
        "section",
        { class: "card", "aria-label": "New destination" },
        h("h2", null, "New destination"),
        destinationForm(ws, (d) => {
          dests = [...dests, d];
          replace(formSlot);
          newBtn.textContent = "Add destination";
          replace(top, notice("ok", `Added ${d.name}. Send it a test message to check that it works.`));
          draw();
          listEl.querySelector(`[data-id="${CSS.escape(d.id)}"] .test-row button`)?.focus();
        }),
      ),
    );
    formSlot.querySelector("input")?.focus();
  });

  async function remove(d, btn) {
    const ok = await confirmDialog({
      title: `Delete ${d.name}?`,
      body: ["New alerts stop going to it. Deliveries already recorded on flags are kept."],
      confirmLabel: "Delete destination",
      danger: true,
    });
    if (!ok) return;
    btn.disabled = true;
    try {
      await api(wsPath(ws, "destinations", d.id), { method: "DELETE" });
      dests = dests.filter((x) => x.id !== d.id);
      replace(top, notice("ok", `Deleted ${d.name}.`));
      draw();
    } catch (err) {
      if (err?.status !== 401) replace(top, notice("error", errorText(err)));
      btn.disabled = false;
    }
  }

  function draw() {
    replace(
      listEl,
      dests.length
        ? h(
            "ul",
            { class: "items" },
            dests.map((d) => {
              const del = h("button", { type: "button", class: "btn small danger-text" }, "Delete");
              del.addEventListener("click", () => remove(d, del));
              return h(
                "li",
                { class: "item", dataset: { id: d.id } },
                h("div", { class: "item-head" }, h("h3", null, d.name), badge(DEST_KINDS[d.kind]?.label ?? d.kind, "plain"), d.last_error ? badge("last delivery failed", "delivery delivery-failed") : null, h("div", { class: "spacer" }), del),
                destinationSummary(d),
                destinationTestButton(ws, d),
              );
            }),
          )
        : emptyState("No destinations.", "Without one, alerts still land in the queue but nobody is notified."),
    );
  }

  draw();
  replace(
    ctx.main,
    h("div", { class: "page-head" }, h("h1", null, "Destinations"), newBtn),
    h("p", { class: "lead" }, "Every alert goes to every destination, with retries. The test message checks that a destination accepts deliveries; it doesn't go through triage."),
    top,
    formSlot,
    listEl,
  );
}
