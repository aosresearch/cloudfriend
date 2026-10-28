// DOM helpers. Everything here builds nodes with textContent; nothing ever assigns innerHTML,
// because event payloads and Jev's replies are untrusted.

/**
 * h("a", { href, class, onclick, "aria-label": "x" }, child, [children], "text")
 * Strings and numbers become text nodes; null, undefined and false are skipped.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") el.className = value;
      else if (key === "text") el.textContent = String(value);
      else if (key === "dataset") Object.assign(el.dataset, value);
      else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
      else if (key === "value" && "value" in el) el.value = value;
      else if (key === "checked" || key === "disabled" || key === "selected" || key === "hidden" || key === "required") el[key] = !!value;
      else el.setAttribute(key, value === true ? "" : String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

/** Replace an element's children. */
export function replace(el, ...children) {
  clear(el);
  return append(el, children);
}

let idCounter = 0;
export const uid = (prefix = "id") => `${prefix}-${++idCounter}`;

// --- formatting ----------------------------------------------------------------------------------

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
const dtf = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
const nf = new Intl.NumberFormat();

export function fmtNumber(n) {
  return n === null || n === undefined ? "–" : nf.format(n);
}

const LEVELS = { e: "error", w: "warning", i: "info", "?": "unknown level" };

/** The classifier's severity bucket ("e5", "w", "i2") in words: "error, 5xx", "warning", "info, 2xx". */
export function fmtSeverity(bucket) {
  if (!bucket) return null;
  const level = LEVELS[bucket[0]] ?? bucket;
  return bucket.length > 1 ? `${level}, ${bucket.slice(1)}xx` : level;
}

export function fmtMoney(n) {
  if (n === null || n === undefined) return "–";
  return `$${n < 1 && n > 0 ? n.toFixed(3) : n.toFixed(2)}`;
}

export function fmtAbs(isoString) {
  if (!isoString) return "–";
  const d = new Date(isoString);
  return Number.isNaN(d.getTime()) ? String(isoString) : dtf.format(d);
}

export function fmtRelative(isoString, now = Date.now()) {
  if (!isoString) return "never";
  const t = Date.parse(isoString);
  if (Number.isNaN(t)) return String(isoString);
  const s = Math.round((t - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return s <= 0 ? "just now" : "in a few seconds";
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(s / 86400), "day");
  return fmtAbs(isoString);
}

/** A <time> showing relative time, with the exact time on hover and for screen readers. */
export function timeEl(isoString, emptyText = "never") {
  if (!isoString) return h("span", { class: "muted" }, emptyText);
  return h("time", { datetime: isoString, title: fmtAbs(isoString) }, fmtRelative(isoString));
}

export function fmtScore(score) {
  return typeof score === "number" ? score.toFixed(3) : "–";
}

/** Pretty JSON for display; never throws. */
export function prettyJson(value) {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** If text is JSON, pretty-print it; otherwise return it as is. */
export function maybePrettyJson(text) {
  if (typeof text !== "string") return prettyJson(text);
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return text;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return text;
  }
}

/** A one-line summary of an event payload for lists. */
export function eventSummary(data) {
  if (data === null || data === undefined) return "(empty)";
  if (typeof data !== "object") return String(data).slice(0, 200);
  const pick = (o, keys) => {
    for (const k of keys) if (o && typeof o[k] === "string" && o[k]) return o[k];
    return null;
  };
  const err = data?.data?.error ?? data?.data?.event ?? data?.event_data ?? null;
  const props = data?.properties ?? null;
  const text =
    pick(data, ["message", "msg", "title", "error"]) ??
    pick(err, ["title", "message"]) ??
    pick(props, ["$exception_message", "message"]) ??
    (typeof data.event === "string" ? data.event : null) ??
    pick(data, ["raw"]) ??
    JSON.stringify(data);
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}
