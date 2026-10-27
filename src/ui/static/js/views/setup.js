// Onboarding checklist: connect a source, add a destination, send a test exception and watch it.
import { api, wsPath } from "../api.js";
import { h, replace, timeEl, fmtScore } from "../dom.js";
import {
  sourceForm, sourceSecretPanel, destinationForm, destinationTestButton, copyField, notice, errorText, loading,
  routeBadge, judgmentBadge, severityBadge, ROUTES, JUDGMENTS, JEV_ROUTES, SOURCE_KINDS, DEST_KINDS, badge,
} from "../components.js";
import { wsHash } from "../app.js";

const POLL_MS = 1000;
const WATCH_LIMIT_MS = 120_000;

export async function render(ctx) {
  const { ws } = ctx;
  ctx.setTitle("Setup");
  replace(ctx.main, h("h1", null, "Set up"), loading());

  const [srcRes, dstRes, evRes] = await Promise.all([
    api(wsPath(ws, "sources"), { signal: ctx.signal }),
    api(wsPath(ws, "destinations"), { signal: ctx.signal }),
    api(wsPath(ws, "events"), { query: { limit: 1 }, signal: ctx.signal }),
  ]);
  const s = {
    sources: srcRes.sources.filter((x) => !x.revoked_at),
    destinations: dstRes.destinations,
    hasEvents: evRes.events.length > 0,
    created: null, // { source, secret } just created, shown once
    showSourceForm: false,
    showDestForm: false,
    tested: new Map(), // destination id -> ok
    run: null, // the test-exception watch
  };

  const progress = h("p", { class: "progress", "aria-live": "polite" });
  const step1 = h("li", { class: "step" });
  const step2 = h("li", { class: "step" });
  const step3 = h("li", { class: "step" });
  const done = () => [s.sources.length > 0, s.destinations.length > 0, s.hasEvents || !!s.run?.event];

  function updateProgress() {
    const d = done();
    const n = d.filter(Boolean).length;
    replace(progress, h("span", { class: "progress-bar", "aria-hidden": "true" }, h("span", { class: `progress-fill p${n}` })), `${n} of 3 done`);
    [step1, step2, step3].forEach((el, i) => el.classList.toggle("is-done", d[i]));
  }

  function stepHead(n, title, isDone, sub) {
    return h(
      "div",
      { class: "step-head" },
      h("span", { class: "step-num", "aria-hidden": "true" }, isDone ? "" : String(n)),
      h("div", null, h("h2", null, title, h("span", { class: "visually-hidden" }, isDone ? " (done)" : " (to do)")), sub ? h("p", { class: "muted" }, sub) : null),
      isDone ? badge("Done", "ok") : null,
    );
  }

  // Step 1: source ----------------------------------------------------------------------------------
  function renderStep1() {
    const isDone = s.sources.length > 0;
    let body;
    if (s.created) {
      body = [
        notice("ok", `Source ${s.created.source.name} created.`),
        sourceSecretPanel(s.created.source, s.created.secret),
        h("div", { class: "actions" }, h("button", { type: "button", class: "btn", onclick: () => ((s.created = null), (s.showSourceForm = true), renderStep1()) }, "Add another source")),
      ];
    } else if (isDone && !s.showSourceForm) {
      body = [
        h(
          "ul",
          { class: "mini-list" },
          s.sources.map((src) => h("li", null, h("strong", null, src.name), " ", badge(SOURCE_KINDS[src.kind]?.label ?? src.kind, "plain"), " ", h("span", { class: "muted" }, "last event ", timeEl(src.last_used_at)), copyField("Endpoint URL", src.endpoint_url))),
        ),
        h("p", { class: "muted" }, "A secret is shown only when it is created or rotated. To get a new one, rotate it on the ", h("a", { href: wsHash(ws, "sources") }, "Sources page"), "."),
        h("div", { class: "actions" }, h("button", { type: "button", class: "btn", onclick: () => ((s.showSourceForm = true), renderStep1()) }, "Add another source")),
      ];
    } else {
      body = [
        sourceForm(ws, ({ source, secret }) => {
          s.sources.push(source);
          s.created = { source, secret };
          s.showSourceForm = false;
          renderStep1();
          updateProgress();
          step1.querySelector(".secret-panel")?.scrollIntoView({ block: "nearest" });
          step1.querySelector(".secret-panel button")?.focus();
        }),
        isDone ? h("button", { type: "button", class: "btn ghost", onclick: () => ((s.showSourceForm = false), renderStep1()) }, "Cancel") : null,
      ];
    }
    replace(step1, stepHead(1, "Connect a source", isDone, "Where events come from: Sentry, PostHog, or anything that can POST JSON."), h("div", { class: "step-body" }, body));
  }

  // Step 2: destination -----------------------------------------------------------------------------
  function renderStep2() {
    const isDone = s.destinations.length > 0;
    const list = s.destinations.length
      ? h(
          "ul",
          { class: "mini-list" },
          s.destinations.map((d) =>
            h(
              "li",
              null,
              h("strong", null, d.name),
              " ",
              badge(DEST_KINDS[d.kind]?.label ?? d.kind, "plain"),
              " ",
              h("code", { class: "break muted" }, d.url_display),
              destinationTestButton(ws, d, (ok) => s.tested.set(d.id, ok)),
            ),
          ),
        )
      : null;
    const form = !isDone || s.showDestForm
      ? h("div", { class: "subcard" }, destinationForm(ws, (d) => {
          s.destinations.push(d);
          s.showDestForm = false;
          renderStep2();
          updateProgress();
          step2.querySelector(".test-row button")?.focus();
        }))
      : h("div", { class: "actions" }, h("button", { type: "button", class: "btn", onclick: () => ((s.showDestForm = true), renderStep2()) }, "Add another destination"));
    replace(
      step2,
      stepHead(2, "Add a destination", isDone, "Where alerts go: a Slack channel or your own webhook."),
      h(
        "div",
        { class: "step-body" },
        list,
        isDone ? h("p", { class: "muted" }, "Send a test message to check that alerts reach you. This is the check for delivery: the test exception below may, correctly, not raise an alert.") : null,
        form,
      ),
    );
  }

  // Step 3: test exception --------------------------------------------------------------------------
  const sendBtn = h("button", { type: "button", class: "btn primary" }, "Send a test exception");
  const watchOut = h("div", { class: "watch", "aria-live": "polite" });
  sendBtn.addEventListener("click", () => startRun());

  function renderStep3() {
    const isDone = s.hasEvents || !!s.run?.event;
    replace(
      step3,
      stepHead(3, "Send a test exception", isDone, "Check the whole path: stored, scored, routed, judged."),
      h(
        "div",
        { class: "step-body" },
        h(
          "p",
          null,
          "This sends a sample exception through the same path as real events. It is stored, scored by the classifier and routed. If the route goes to Jev, Jev judges it in the next batch, usually within about 10 seconds.",
        ),
        h("div", { class: "actions" }, sendBtn),
        watchOut,
      ),
    );
    renderWatch();
  }

  async function startRun() {
    sendBtn.disabled = true;
    sendBtn.textContent = "Sending…";
    const started = Date.now();
    try {
      const res = await api(wsPath(ws, "test-event"), { method: "POST", signal: ctx.signal });
      s.run = { queueId: res.queue_id, started, status: "new", event: null, flag: null, deliveries: null, error: null, timedOut: false, fallback: false };
      renderStep3();
      watch(s.run);
    } catch (err) {
      if (err?.name === "AbortError" || err?.status === 401) return;
      s.run = { started, error: errorText(err) };
      renderWatch();
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = "Send another test exception";
    }
  }

  function watch(run) {
    ctx.poll(async () => {
      if (s.run !== run) return false;
      await refreshRun(run);
      const settled = run.event?.decided && (!run.flag || (run.deliveries ?? []).every((d) => d.status !== "pending"));
      if (!settled && Date.now() - run.started > WATCH_LIMIT_MS) run.timedOut = true;
      if (run.event && !s.hasEvents) {
        s.hasEvents = true;
        updateProgress();
        renderStep3();
      } else renderWatch();
      return !(settled || run.timedOut);
    }, POLL_MS);
  }

  async function refreshRun(run) {
    if (!run.fallback) {
      try {
        const r = await api(wsPath(ws, "test-event", run.queueId), { signal: ctx.signal });
        run.status = r.status;
        if (r.event) run.event = r.event;
      } catch (err) {
        if (err?.status !== 404) throw err;
        run.fallback = true; // Server without GET test-event/:id: find the event by time instead.
      }
    }
    if (run.fallback) {
      if (run.event) run.event = (await api(wsPath(ws, "events", run.event.id), { signal: ctx.signal })).event;
      else {
        const { events } = await api(wsPath(ws, "events"), { query: { since: new Date(run.started - 2000).toISOString(), limit: 20 }, signal: ctx.signal });
        run.event = events.at(-1) ?? null;
      }
    }
    const ev = run.event;
    if (!ev?.decided) return;
    let flagId = ev.flag_id;
    if (flagId === undefined && !run.flagSearched) {
      run.flagSearched = true;
      flagId = await findFlagFor(ev, run.started);
    }
    if (flagId) {
      const detail = await api(wsPath(ws, "flags", flagId), { signal: ctx.signal });
      run.flag = detail.flag;
      run.deliveries = detail.deliveries;
    }
  }

  // Without Event.flag_id, look through flags raised since the test started.
  async function findFlagFor(ev, since) {
    const { flags } = await api(wsPath(ws, "queue"), { signal: ctx.signal });
    for (const f of flags.filter((x) => Date.parse(x.created_at) >= since - 5000)) {
      const d = await api(wsPath(ws, "flags", f.id), { signal: ctx.signal });
      if (d.events.some((e) => e.id === ev.id)) return f.id;
    }
    return null;
  }

  function renderWatch() {
    const run = s.run;
    if (!run) return replace(watchOut);
    if (run.error) return replace(watchOut, notice("error", "Couldn't send the test exception: ", run.error));
    const ev = run.event;
    const secs = Math.max(0, Math.round((Date.now() - run.started) / 1000));
    const items = [];

    items.push(tl("done", "Accepted", h("span", null, "Queued as ", h("code", null, run.queueId), ".")));

    if (!ev) items.push(tl(run.status === "failed" ? "error" : "wait", "Stored and scored", run.status === "failed" ? "The event couldn't be parsed." : "Waiting for the worker to parse it…"));
    else {
      items.push(
        tl(
          "done",
          "Stored and scored",
          h("span", null, "Stored as ", h("a", { href: wsHash(ws, "events", ev.id) }, ev.id), `, score ${fmtScore(ev.score)}, route `, routeBadge(ev.route), ". ", ev.route ? ROUTES[ev.route]?.text ?? "" : ""),
        ),
      );
    }

    const jevRoute = ev?.route && JEV_ROUTES.has(ev.route);
    if (ev && ev.route) {
      if (!ev.decided) items.push(tl("wait", "Judged", jevRoute ? "Waiting for Jev's next batch (up to about 10 seconds)…" : "Waiting for a decision…"));
      else if (jevRoute && ev.decision_id) {
        items.push(
          tl(
            "done",
            "Judged by Jev",
            h(
              "span",
              null,
              ev.judgment ? ["Jev judged it ", judgmentBadge(ev.judgment), ". ", JUDGMENTS[ev.judgment] ?? "", " "] : "Jev decided. ",
              h("a", { href: wsHash(ws, "decisions", ev.decision_id) }, "See Jev's prompt and reply"),
              ".",
            ),
          ),
        );
      } else if (jevRoute) items.push(tl("done", "Judged", "Decided without a new Jev call: a recent verdict on the same kind of event was reused."));
      else if (ev.route === "drop") items.push(tl("done", "Not sent to Jev", "The classifier dropped it as routine."));
      else items.push(tl("done", "Decided by the classifier", "Jev wasn't asked: no decider is available, or its budget is used up."));
    }

    if (ev?.decided) {
      if (run.flag) {
        items.push(
          tl("done", "Alert raised", h("span", null, severityBadge(run.flag.severity), " ", h("a", { href: wsHash(ws, "flags", run.flag.id) }, run.flag.reason))),
        );
      } else items.push(tl("done", "No alert raised", "Nothing was sent to your destinations for this event."));
    }

    let outcome = null;
    if (ev?.decided && run.flag) {
      const dels = run.deliveries ?? [];
      outcome = notice(
        "ok",
        h("strong", null, `The pipeline works, and ${run.flag.decider === "jev" ? "Jev" : "the classifier"} raised an alert. `),
        "It is in the queue and goes to every destination.",
        dels.length
          ? h("ul", { class: "deliveries-inline" }, dels.map((d) => h("li", null, `${d.destination_name}: `, badge(d.status, `delivery delivery-${d.status}`), d.last_error ? ` ${d.last_error}` : "")))
          : h("p", null, "No destinations yet, so nothing was delivered."),
        h("p", null, "You can resolve the test alert from the queue."),
      );
    } else if (ev?.decided && ev.decision_id) {
      outcome = notice(
        "info",
        h("strong", null, "The pipeline works. Jev judged the event and did not alert. "),
        "That is a correct outcome: a test exception sent from a setup page isn't something a person needs to act on, and Jev only alerts on what is worth attention. ",
        "Whether alerts reach Slack or your webhook is checked by the test message button in step 2.",
      );
    } else if (ev?.decided) {
      outcome = notice("info", h("strong", null, "The event was stored and decided. "), "Alert delivery is checked by the test message button in step 2.");
    } else if (run.timedOut) {
      outcome = notice(
        "warn",
        h("strong", null, "Still waiting after two minutes. "),
        "Jev may be failing or out of budget. Check ",
        h("a", { href: wsHash(ws, "usage") }, "Usage"),
        " for the backlog and decider status, and the server logs for decider errors.",
      );
    }

    replace(
      watchOut,
      h("h3", { class: "watch-title" }, "Test exception ", h("span", { class: "muted" }, `${secs} s`)),
      h("ol", { class: "timeline" }, items),
      outcome,
      run.fallback ? h("p", { class: "hint" }, "This server can't look up a test by its queue id, so the newest event since you clicked is shown.") : null,
    );
  }

  function tl(kind, title, body) {
    return h(
      "li",
      { class: `tl tl-${kind}` },
      h("span", { class: "tl-dot", "aria-hidden": "true" }),
      h("div", null, h("strong", null, title), h("span", { class: "visually-hidden" }, kind === "wait" ? " (in progress)" : kind === "error" ? " (failed)" : " (done)"), h("div", { class: "tl-body" }, body)),
    );
  }

  renderStep1();
  renderStep2();
  renderStep3();
  updateProgress();
  replace(
    ctx.main,
    h("div", { class: "page-head" }, h("h1", null, ctx.wsInfo ? `Set up ${ctx.wsInfo.name}` : "Set up"), progress),
    h("p", { class: "lead" }, "Three steps to a working pipeline. You can come back to this page any time from Setup."),
    h("ol", { class: "steps" }, step1, step2, step3),
    h("p", { class: "next" }, "When you're done, open the ", h("a", { href: wsHash(ws, "queue") }, "queue"), ": that is where alerts wait for a person."),
  );
}
