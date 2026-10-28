// Turns events into number vectors for the classifier. Pure TypeScript with no Node imports,
// so the same file runs in the server, in the training scripts and in a browser.
//
// The featurizer is stateful: it remembers how often each message template, service and
// source has been seen, so "a new kind of error, five times in the last minute" scores
// differently from "the same warning we log every few seconds". Events must be fed in
// arrival order, once each. Features describe the event against the history *before* it.
//
// Bump FEATURIZER_VERSION whenever a feature changes meaning. Models record the version
// they were trained with, and stored feature vectors with another version are not mixed in.

export const FEATURIZER_VERSION = 3;
/**
 * Versions this build can compute. A model runs with the version it was trained on.
 *   2  the RCAEval/GAIA models of October 2026
 *   3  numbers in timestamps, IPs and versions no longer count as HTTP statuses or keywords
 *      (the milliseconds in "15:27:27,503" used to read as a 503)
 */
export const SUPPORTED_FEATURIZER_VERSIONS: readonly number[] = [2, 3];

export interface FeatureInput {
  source: string;
  /** ISO 8601 or epoch ms. Used when the payload has no timestamp of its own. */
  received_at: string | number;
  data: unknown;
}

export interface Featurized {
  values: number[];
  /** `<source>|<service>|<masked message>`: events with the same key are "the same thing". */
  template: string;
  service: string;
  /** 0 debug, 1 info, 2 warn, 3 error, 4 fatal; NaN when unknown. */
  level: number;
  /** HTTP-style status code found in the event, or NaN. */
  status: number;
  /** Error words or level >= error. */
  errorish: boolean;
  /** An error-like event whose template has never been seen before. */
  novel: boolean;
  /** Event time used for the rate features, epoch ms. */
  time: number;
  text: string;
}

// --- text and field extraction ----------------------------------------------------

const MESSAGE_KEYS = [
  "message", "msg", "log", "error", "err", "exception", "title", "culprit", "text", "body",
  "description", "detail", "details", "reason", "raw", "event", "summary", "status_message",
];
const SERVICE_KEYS = [
  "service", "service_name", "serviceName", "container_name", "container", "app", "application",
  "component", "logger", "logger_name", "job", "pod_name", "host", "hostname",
];
const LEVEL_KEYS = ["level", "severity", "levelname", "log_level", "loglevel", "lvl", "s"];
const STATUS_KEYS = ["status", "status_code", "statusCode", "http_status", "response_status", "code"];
const TIME_KEYS = ["timestamp", "@timestamp", "time", "ts", "datetime", "date", "created_at", "start_time"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Breadth-first search for the first scalar under one of `keys`, at most `depth` levels down. */
function findKey(data: unknown, keys: readonly string[], depth = 3): unknown {
  let level: unknown[] = [data];
  for (let d = 0; d <= depth && level.length; d++) {
    const next: unknown[] = [];
    for (const node of level) {
      if (!isObj(node)) continue;
      for (const k of keys) {
        const v = node[k];
        if (typeof v === "string" || typeof v === "number") return v;
      }
      for (const v of Object.values(node)) {
        if (isObj(v)) next.push(v);
        else if (Array.isArray(v)) for (const x of v.slice(0, 3)) if (isObj(x)) next.push(x);
      }
    }
    level = next;
  }
  return undefined;
}

/** The human-readable part of an event: its message, or its string fields joined. */
export function extractText(data: unknown, maxChars = 4000): string {
  if (typeof data === "string") return data.slice(0, maxChars);
  if (!isObj(data) && !Array.isArray(data)) return data === undefined || data === null ? "" : String(data);
  const parts: string[] = [];
  const msg = findKey(data, MESSAGE_KEYS);
  if (typeof msg === "string" && msg.trim()) parts.push(msg);
  // Sentry-style exception values carry the real error text.
  const exc = findKey(data, ["value", "type"], 5);
  if (typeof exc === "string" && !parts.includes(exc)) parts.push(exc);
  if (!parts.length) {
    const strings: string[] = [];
    const walk = (v: unknown, depth: number) => {
      if (strings.length > 40 || depth > 4) return;
      if (typeof v === "string") strings.push(v);
      else if (Array.isArray(v)) v.slice(0, 10).forEach((x) => walk(x, depth + 1));
      else if (isObj(v)) Object.values(v).forEach((x) => walk(x, depth + 1));
    };
    walk(data, 0);
    parts.push(strings.join(" "));
  }
  return parts.join("\n").slice(0, maxChars);
}

const LEVEL_WORDS: [RegExp, number][] = [
  [/^(trace|debug|verbose|d|v|t)$/i, 0],
  [/^(info|information|notice|i|n|log)$/i, 1],
  [/^(warn|warning|w)$/i, 2],
  [/^(error|err|e|severe)$/i, 3],
  [/^(fatal|critical|crit|panic|emerg|emergency|alert|f|c)$/i, 4],
];
const LEVEL_IN_TEXT = /(?:^|[\s|\[(:"'=])(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|ERR|SEVERE|CRITICAL|FATAL|PANIC)(?=$|[\s|\]):,"'])/;
const LEVEL_KV = /\blevel[=:]\s*"?(\w+)/i;

export function levelOf(data: unknown, text: string): number {
  const raw = findKey(data, LEVEL_KEYS, 2);
  if (typeof raw === "number") return raw >= 50 ? 4 : raw >= 40 ? 3 : raw >= 30 ? 2 : raw >= 20 ? 1 : 0; // syslog/pino style
  const candidates = [typeof raw === "string" ? raw : undefined, LEVEL_IN_TEXT.exec(text)?.[1], LEVEL_KV.exec(text)?.[1]];
  for (const c of candidates) {
    if (!c) continue;
    for (const [re, n] of LEVEL_WORDS) if (re.test(c)) return n;
  }
  return NaN;
}

function statusOf(data: unknown, text: string, version = FEATURIZER_VERSION): number {
  const raw = findKey(data, STATUS_KEYS, 2);
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (n >= 100 && n < 600) return n;
  if (version >= 3) return statusInText(text);
  const m = /\b(?:status(?:_code)?|code|HTTP\/\d(?:\.\d)?)["']?\s*[=: ]\s*([1-5]\d\d)\b/i.exec(text) ?? /\b([45]\d\d) (?:[A-Z][a-z]+ ?){1,3}\b/.exec(text);
  return m ? Number(m[1]) : NaN;
}

/** Numbers that are never statuses: timestamps with their fractions, IPs with ports, versions. */
const NOT_STATUS =
  /\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?|\b\d\d?:\d\d:\d\d(?:[.,]\d+)?|\[\d\d\/\w{3}\/\d{4}:\d\d:\d\d:\d\d [+-]\d{4}\]|\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b|\bv?\d+\.\d+(?:\.\d+)+\b/g;
/**
 * An HTTP status in text, only where text says it is one: after status/code, after the request
 * in an access log ("POST /cart 503 - ms", '"GET /x HTTP/1.1" 503 12'), or before its reason phrase.
 * Kept in step with ml/datasets/common.py; test/fixtures/parsing.json checks both.
 */
const STATUS_IN_TEXT = new RegExp(
  [
    `\\b(?:status(?:[_ ]?code)?|http[_ ]?code|response[_ ]?code)["']?\\s*[=:]?\\s*([1-5]\\d\\d)\\b`,
    `\\bHTTP\\/\\d(?:\\.\\d)?"?\\s+([1-5]\\d\\d)\\b`,
    `\\b(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS) \\S+ ([1-5]\\d\\d)\\b`,
    `\\breturn(?:s|ed)? ([1-5]\\d\\d)\\b`,
    `\\b([1-5]\\d\\d) (?:OK|Created|Accepted|No Content|Found|Not Modified|Bad Request|Unauthorized|Forbidden|Not Found|` +
      `Method Not Allowed|Conflict|Gone|Too Many Requests|Internal Server Error|Not Implemented|Bad Gateway|Service Unavailable|Gateway Time-?out)\\b`,
  ].join("|"),
  "i",
);

/** Text with timestamps, IPs and versions blanked, so their digits can't read as anything. */
export function withoutIncidentalNumbers(text: string): string {
  return text.replace(NOT_STATUS, " ");
}

export function statusInText(text: string): number {
  const m = STATUS_IN_TEXT.exec(withoutIncidentalNumbers(text));
  if (!m) return NaN;
  return Number(m.slice(1).find((g) => g !== undefined));
}

function serviceOf(source: string, data: unknown): string {
  const raw = findKey(data, SERVICE_KEYS, 2);
  return typeof raw === "string" && raw ? raw.slice(0, 80) : source;
}

/** Epoch ms from a number in s, ms, µs or ns, or from a date string. NaN if unknown. */
export function toEpochMs(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v > 1e17) return v / 1e6; // ns
    if (v > 1e14) return v / 1e3; // µs
    if (v > 1e11) return v; // ms
    if (v > 1e8) return v * 1e3; // s
    return NaN;
  }
  if (typeof v === "string" && v) {
    if (/^\d+(\.\d+)?$/.test(v)) return toEpochMs(Number(v));
    const t = Date.parse(v.includes("T") || v.includes("Z") ? v : v.replace(" ", "T").replace(",", ".") + "Z");
    return Number.isNaN(t) ? NaN : t;
  }
  return NaN;
}

/** A timestamp in the data further than this from the arrival time is not trusted. */
export const MAX_CLOCK_SKEW_MS = 3_600_000;

/**
 * When the event happened: the timestamp in its data, unless that is more than an hour from
 * when it arrived (a wrong clock or a local time read as UTC), else the arrival time. One bad
 * timestamp must not move the featurizer's clock and make every rate look like zero.
 */
export function eventTime(e: FeatureInput): number {
  const received = typeof e.received_at === "number" ? e.received_at : Date.parse(e.received_at);
  const fromData = toEpochMs(findKey(e.data, TIME_KEYS, 1));
  if (Number.isNaN(fromData)) return received;
  if (!Number.isNaN(received) && Math.abs(fromData - received) > MAX_CLOCK_SKEW_MS) return received;
  return fromData;
}

// --- templates ----------------------------------------------------------------------

const LEADING_TIMESTAMP = /^\s*[\[(]?\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?[\])]?\s*/;

/**
 * Mask the parts of a message that vary between occurrences of "the same" event: ids,
 * numbers, hashes, quoted values, key=value values. Multi-line messages keep their first
 * and last lines (a traceback's last line names the error).
 */
export function maskMessage(text: string, maxLen = 160): string {
  const lines = (text.length > 8000 ? text.slice(0, 8000) : text).split("\n").map((l) => l.trim()).filter(Boolean);
  let s = lines.length > 1 ? `${lines[0]!.slice(0, 600)} … ${lines[lines.length - 1]!.slice(0, 400)}` : (lines[0] ?? "").slice(0, 1000);
  s = s.replace(LEADING_TIMESTAMP, "");
  s = s
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<IP>")
    .replace(/\b\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?Z?/g, "<T>")
    .replace(/https?:\/\/[^\s"'<>]+/g, (u) => u.replace(/\?.*$/, "?<Q>").replace(/\/\d[^/\s]*/g, "/<N>"))
    .replace(/"[^"\n]{0,200}"|'[^'\n]{0,200}'/g, "<S>")
    .replace(/\b([\w.-]+)=[^\s,;&)\]}]+/g, "$1=<V>")
    // Tokens mixing letters with digits or symbols are ids, tokens, hashes.
    .replace(/[^\s<>=,;:()[\]{}|]{4,}/g, (t) =>
      /^\d+(\.\d+)?[a-zµ%]{0,3}$/i.test(t) ? t : (/\d/.test(t) && /[a-z]/i.test(t)) || /[^\w.\-/<>]/.test(t) ? "<V>" : t,
    )
    // Random letter ids (user names, short tokens): mixed case that isn't camelCase words.
    .replace(/\b[A-Za-z]{6,40}\b/g, (t) => (isRandomLetters(t) ? "<V>" : t))
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<U>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<H>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<H>")
    .replace(/\d+(?:\.\d+)?/g, "<N>")
    .replace(/(?:<[A-Z]+>[\s,;:-]*){2,}/g, "<*> ")
    .replace(/\s+/g, " ")
    .trim();
  return s.slice(0, maxLen);
}

const NAMED = /(?:Error|Exception|Warning|Timeout|Failure|Failed|Denied|Refused)$/;

/**
 * `WHeAwPqY`, `JuoeTjfH`: more than one capital and not made of words. Words here are
 * camelCase parts with at least two lowercase letters and a vowel, as in
 * `getValueFromRedis`, `GetCartAsync` or `TypeError`.
 */
function isRandomLetters(t: string): boolean {
  let upper = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c >= 65 && c <= 90) upper++;
  }
  if (upper < 2 || upper === t.length || NAMED.test(t)) return false;
  const parts = t.match(/[A-Z]?[a-z]+|[A-Z]+$/g) ?? [];
  if (parts.join("") !== t) return true;
  return !parts.every((p, i) => {
    if (/^[A-Z]+$/.test(p)) return i === parts.length - 1;
    const lower = /^[A-Z]/.test(p) ? p.length - 1 : p.length;
    return (lower >= 2 || (i === 0 && p.length >= 2)) && (p.length < 3 || /[aeiouy]/i.test(p));
  });
}

// --- keyword features -----------------------------------------------------------------

const KEYWORDS: [string, RegExp][] = [
  ["kw_error", /\berr(or)?s?\b|\berror/i],
  ["kw_exception", /exception|traceback|\bthrow|stack ?trace/i],
  ["kw_fail", /fail/i],
  ["kw_timeout", /time(d)? ?out|deadline exceeded/i],
  ["kw_refused", /refused|reset by peer|broken pipe|unreachable|no route|connection (closed|lost|aborted)/i],
  ["kw_denied", /denied|forbidden|unauthori[sz]ed|permission|not allowed|invalid token|authentication/i],
  ["kw_unavailable", /unavailable|service down|\b503\b|\b502\b|bad gateway|circuit/i], // v3: no bare numbers (KEYWORDS_V3)
  ["kw_crash", /panic|fatal|crash|segfault|core dump|killed|oom|out of memory|terminated|exit(ed)? (with )?(code|status)/i],
  ["kw_null", /null ?pointer|nonetype|undefined is not|cannot read propert|nil pointer|attributeerror|typeerror|keyerror|indexerror|valueerror/i],
  ["kw_warn", /\bwarn/i],
  ["kw_retry", /retry|retrying|backoff|attempt \d/i],
  ["kw_resource", /disk full|no space|too many (open files|connections)|memory|cpu|throttl|quota|limit exceeded|slow/i],
  ["kw_data", /corrupt|inconsisten|duplicate key|constraint|deadlock|rollback|data loss/i],
  ["kw_start", /start(ed|ing)|boot|listening|initiali[sz]|ready|profiler/i],
  ["kw_success", /success|succeeded|\bok\b|completed|done|\b200\b/i],
  ["kw_security", /attack|injection|xss|csrf|brute|suspicious|malicious|blocked/i],
];

/** v3: the same keywords without bare status numbers, which the status features carry. */
const KEYWORDS_V3: [string, RegExp][] = KEYWORDS.map(([n, re]) =>
  n === "kw_unavailable" ? [n, /unavailable|service down|bad gateway|circuit/i] : n === "kw_success" ? [n, /success|succeeded|\bok\b|completed|done/i] : [n, re],
);

const HASH_BUCKETS = 32;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// --- state ----------------------------------------------------------------------------

interface Rate {
  /** Exponentially decayed counts with time constants of 1 minute, 10 minutes and 1 hour. */
  m1: number;
  m10: number;
  h1: number;
  last: number;
}
const TAU = { m1: 60_000, m10: 600_000, h1: 3_600_000 };

const newRate = (t: number): Rate => ({ m1: 0, m10: 0, h1: 0, last: t });
function decay(r: Rate, t: number): void {
  const dt = Math.max(0, t - r.last);
  if (dt > 0) {
    r.m1 *= Math.exp(-dt / TAU.m1);
    r.m10 *= Math.exp(-dt / TAU.m10);
    r.h1 *= Math.exp(-dt / TAU.h1);
    r.last = t;
  }
}
function bump(r: Rate): void {
  r.m1 += 1;
  r.m10 += 1;
  r.h1 += 1;
}

interface TemplateState {
  count: number;
  first: number;
  rate: Rate;
}
interface ServiceState {
  count: number;
  first: number;
  all: Rate;
  errors: Rate;
  newTemplates: Rate;
  templates: number;
}

const log1p = Math.log1p;
const ratio = (a: number, b: number) => (a + 1) / (b + 1);

export const FEATURE_NAMES: readonly string[] = [
  "level", "level_known", "status", "status_5xx", "status_4xx",
  "len", "lines", "digit_ratio", "upper_ratio", "stack_frames", "errorish",
  ...KEYWORDS.map(([n]) => n),
  "tpl_new", "tpl_count", "tpl_age", "tpl_since_last", "tpl_m1", "tpl_m10", "tpl_h1", "tpl_burst", "tpl_share_svc",
  "svc_new", "svc_count", "svc_age", "svc_since_last", "svc_m1", "svc_h1", "svc_burst",
  "svc_err_m1", "svc_err_m10", "svc_err_h1", "svc_err_burst", "svc_err_share",
  "svc_newtpl_m10", "svc_newtpl_h1", "svc_templates",
  "all_m1", "all_h1", "all_burst", "all_err_m1", "all_err_burst", "all_newtpl_m10", "services_err_m1",
  ...Array.from({ length: HASH_BUCKETS }, (_, i) => `tok_${i}`),
];

export interface FeaturizerSnapshot {
  version: number;
  templates: (string | number)[][];
  services: (string | number)[][];
  global: number[];
  /** The latest event time seen, so `context()` after a restart measures from it. */
  now?: number;
}

/**
 * Counts are exponentially decayed: `last_10m` is roughly how many occurred in the last
 * 10 minutes, including events the classifier dropped.
 */
export interface TemplateContext {
  seen_total: number;
  last_1m: number;
  last_10m: number;
  last_hour: number;
  usual_per_hour: number;
  first_seen_min_ago: number;
  service_events_10m?: number;
  service_errors_10m?: number;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export interface FeaturizerOptions {
  /** Feature version to compute (SUPPORTED_FEATURIZER_VERSIONS); the latest by default. */
  version?: number;
  /** Most templates remembered; the least recently seen are forgotten first. */
  maxTemplates?: number;
  maxServices?: number;
}

export class Featurizer {
  readonly version: number;
  readonly names = FEATURE_NAMES;
  #templates = new Map<string, TemplateState>();
  #services = new Map<string, ServiceState>();
  #all = newRate(0);
  #allErrors = newRate(0);
  #allNewTemplates = newRate(0);
  /** Latest event time seen: the clock `context()` uses, so replays of old data work too. */
  #now = 0;
  #maxTemplates: number;
  #maxServices: number;

  constructor(opts: FeaturizerOptions = {}) {
    this.version = opts.version ?? FEATURIZER_VERSION;
    if (!SUPPORTED_FEATURIZER_VERSIONS.includes(this.version)) throw new Error(`featurizer v${this.version} is not supported by this build`);
    this.#maxTemplates = opts.maxTemplates ?? 100_000;
    this.#maxServices = opts.maxServices ?? 10_000;
  }

  get templateCount(): number {
    return this.#templates.size;
  }

  /** Features for `e` given everything seen so far, then remember `e`. */
  featurize(e: FeatureInput): Featurized {
    const text = extractText(e.data);
    const service = serviceOf(e.source, e.data);
    const t = eventTime(e);
    const level = levelOf(e.data, text);
    const status = statusOf(e.data, text, this.version);
    const kwText = this.version >= 3 ? withoutIncidentalNumbers(text) : text;
    const kws = (this.version >= 3 ? KEYWORDS_V3 : KEYWORDS).map(([, re]) => (re.test(kwText) ? 1 : 0));
    const errorish =
      level >= 3 || status >= 500 || kws[0]! + kws[1]! + kws[2]! + kws[3]! + kws[4]! + kws[6]! + kws[7]! + kws[8]! > 0;
    const masked = maskMessage(text);
    // The same 300-character cap as storage, so the server can look a stored template up.
    const template = `${e.source}|${service}|${masked}`.slice(0, 300);

    // Template history. Remember when each was last seen before decay() moves `last` to now.
    let tpl = this.#templates.get(template);
    const tplNew = !tpl;
    const tplLast = tpl?.rate.last ?? t;
    if (tpl) {
      this.#templates.delete(template); // re-insert below: Map order doubles as LRU order
      decay(tpl.rate, t);
    }
    // Service history.
    let svc = this.#services.get(service);
    const svcNew = !svc;
    const svcLast = svc?.all.last ?? t;
    if (svc) {
      decay(svc.all, t);
      decay(svc.errors, t);
      decay(svc.newTemplates, t);
    }
    decay(this.#all, t);
    decay(this.#allErrors, t);
    decay(this.#allNewTemplates, t);

    let servicesErr = 0;
    for (const s of this.#services.values()) {
      if (s.errors.m1 * Math.exp(-Math.max(0, t - s.errors.last) / TAU.m1) > 0.5) servicesErr++;
    }

    const tc = tpl?.count ?? 0;
    const tr = tpl?.rate ?? newRate(t);
    const sv = svc ?? { count: 0, first: t, all: newRate(t), errors: newRate(t), newTemplates: newRate(t), templates: 0 };

    let digits = 0;
    let letters = 0;
    let uppers = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 48 && c <= 57) digits++;
      else if (c >= 65 && c <= 90) (letters++, uppers++);
      else if (c >= 97 && c <= 122) letters++;
    }
    const stackFrames = (text.match(/\n\s*at |File "[^"]+", line \d+|\.(java|go|py|js|ts|rb):\d+/g) ?? []).length;

    const buckets = new Array<number>(HASH_BUCKETS).fill(0);
    for (const w of masked.toLowerCase().match(/[a-z][a-z_]{2,}/g) ?? []) buckets[fnv1a(w) % HASH_BUCKETS]! += 1;

    const values = [
      level, Number.isNaN(level) ? 0 : 1, status, status >= 500 ? 1 : 0, status >= 400 && status < 500 ? 1 : 0,
      log1p(text.length), log1p(text.split("\n").length - 1), digits / (text.length || 1), uppers / (letters || 1),
      log1p(stackFrames), errorish ? 1 : 0,
      ...kws,
      tplNew ? 1 : 0, log1p(tc), tpl ? log1p((t - tpl.first) / 1000) : -1, tpl ? log1p(Math.max(0, t - tplLast) / 1000) : -1,
      tr.m1, tr.m10, tr.h1, ratio(tr.m1, tr.h1 / 60), ratio(tr.h1, sv.all.h1),
      svcNew ? 1 : 0, log1p(sv.count), svc ? log1p((t - sv.first) / 1000) : -1, svc ? log1p(Math.max(0, t - svcLast) / 1000) : -1,
      sv.all.m1, sv.all.h1, ratio(sv.all.m1, sv.all.h1 / 60),
      sv.errors.m1, sv.errors.m10, sv.errors.h1, ratio(sv.errors.m1, sv.errors.h1 / 60), ratio(sv.errors.h1, sv.all.h1),
      sv.newTemplates.m10, sv.newTemplates.h1, log1p(sv.templates),
      this.#all.m1, this.#all.h1, ratio(this.#all.m1, this.#all.h1 / 60), this.#allErrors.m1,
      ratio(this.#allErrors.m1, this.#allErrors.h1 / 60), this.#allNewTemplates.m10, servicesErr,
      ...buckets,
    ];

    // Remember this event.
    if (!tpl) tpl = { count: 0, first: t, rate: newRate(t) };
    tpl.count++;
    bump(tpl.rate);
    this.#templates.set(template, tpl);
    if (this.#templates.size > this.#maxTemplates) this.#evict(this.#templates, this.#maxTemplates);

    if (!svc) {
      svc = sv;
      this.#services.set(service, svc);
      if (this.#services.size > this.#maxServices) this.#evict(this.#services, this.#maxServices);
    }
    svc.count++;
    bump(svc.all);
    if (errorish) bump(svc.errors);
    if (tplNew) {
      svc.templates++;
      bump(svc.newTemplates);
      bump(this.#allNewTemplates);
    }
    bump(this.#all);
    if (errorish) bump(this.#allErrors);

    if (t > this.#now) this.#now = t;
    return { values, template, service, level, status, errorish, novel: errorish && tplNew, time: t, text };
  }

  /**
   * What the featurizer knows about a template right now, for the decider's prompt: how often
   * it occurred (dropped events included), its usual rate, and how busy and how failing its
   * service is. Read-only: nothing is updated.
   */
  context(template: string, now = this.#now): TemplateContext | null {
    const tpl = this.#templates.get(template);
    if (!tpl) return null;
    const service = template.split("|")[1] ?? "";
    const svc = this.#services.get(service);
    const at = (r: Rate) => {
      const dt = Math.max(0, now - r.last);
      return { m1: r.m1 * Math.exp(-dt / TAU.m1), m10: r.m10 * Math.exp(-dt / TAU.m10), h1: r.h1 * Math.exp(-dt / TAU.h1) };
    };
    const r = at(tpl.rate);
    const ageH = Math.max((now - tpl.first) / 3_600_000, 1 / 60);
    const ctx: TemplateContext = {
      seen_total: tpl.count,
      last_1m: round1(r.m1),
      last_10m: round1(r.m10),
      last_hour: round1(r.h1),
      usual_per_hour: round1(tpl.count / ageH),
      first_seen_min_ago: round1((now - tpl.first) / 60_000),
    };
    if (svc) {
      const all = at(svc.all);
      const err = at(svc.errors);
      ctx.service_events_10m = round1(all.m10);
      ctx.service_errors_10m = round1(err.m10);
    }
    return ctx;
  }

  /** Everything the featurizer remembers, as plain JSON, to survive a restart. */
  snapshot(): FeaturizerSnapshot {
    const rate = (r: Rate) => [r.m1, r.m10, r.h1, r.last];
    return {
      version: this.version,
      templates: [...this.#templates].map(([k, v]) => [k, v.count, v.first, ...rate(v.rate)]),
      services: [...this.#services].map(([k, v]) => [k, v.count, v.first, v.templates, ...rate(v.all), ...rate(v.errors), ...rate(v.newTemplates)]),
      global: [...rate(this.#all), ...rate(this.#allErrors), ...rate(this.#allNewTemplates)],
      now: this.#now,
    };
  }

  /** Load a snapshot. Returns false (and keeps a clean state) if it is from another version. */
  restore(snap: FeaturizerSnapshot): boolean {
    if (!snap || snap.version !== this.version) return false;
    const rate = (a: number[], i: number): Rate => ({ m1: a[i]!, m10: a[i + 1]!, h1: a[i + 2]!, last: a[i + 3]! });
    this.#templates = new Map(snap.templates.map((a) => [a[0] as string, { count: a[1] as number, first: a[2] as number, rate: rate(a as number[], 3) }]));
    this.#services = new Map(
      snap.services.map((a) => [
        a[0] as string,
        { count: a[1] as number, first: a[2] as number, templates: a[3] as number, all: rate(a as number[], 4), errors: rate(a as number[], 8), newTemplates: rate(a as number[], 12) },
      ]),
    );
    this.#all = rate(snap.global, 0);
    this.#allErrors = rate(snap.global, 4);
    this.#allNewTemplates = rate(snap.global, 8);
    // Older snapshots have no clock: the latest time any rate was updated is the same thing.
    this.#now = snap.now ?? Math.max(0, this.#all.last);
    return true;
  }

  #evict<V>(map: Map<string, V>, max: number): void {
    const drop = map.size - Math.floor(max * 0.9);
    let i = 0;
    for (const k of map.keys()) {
      if (i++ >= drop) break;
      map.delete(k);
    }
  }
}

// --- entities -------------------------------------------------------------------------

export interface Entities {
  user?: string;
  trace?: string;
}

const USER_KEYS = ["user_id", "userId", "userID", "user", "user_name", "username", "uid", "customer_id", "distinct_id", "account_id"];
const TRACE_KEYS = ["trace_id", "traceId", "traceID", "trace", "request_id", "requestId", "correlation_id"];

/**
 * Pull a user id and a trace id out of an event, wherever they are: a field, a query string
 * in a URL, or `key=value` / `key: 'value'` in the message. Used to link events from different
 * sources that concern the same user.
 */
export function extractEntities(data: unknown, text = extractText(data)): Entities {
  const out: Entities = {};
  const field = (keys: string[]) => {
    const v = findKey(data, keys, 3);
    return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
  };
  const inText = (keys: string[]) => {
    const re = new RegExp(`(?:[?&\\s,{("']|^)(?:${keys.join("|")})["']?\\s*[=:]\\s*["']?([\\w.@-]{3,64})`, "i");
    return re.exec(text)?.[1];
  };
  const user = field(USER_KEYS) ?? inText(USER_KEYS);
  const trace = field(TRACE_KEYS) ?? inText(TRACE_KEYS);
  if (user) out.user = user;
  if (trace) out.trace = trace;
  return out;
}
