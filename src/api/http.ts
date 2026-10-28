// Small helpers shared by the HTTP routes: errors that become `{ error }` replies, body and
// query parsing, and the API's JSON shapes for rows.
import type { Context } from "hono";
import { parseDuration } from "../config.ts";

/** Thrown from a route: `app.onError` replies `{ error: message }` with this status. */
export class HttpError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 413 | 503;
  constructor(status: HttpError["status"], message: string) {
    super(message);
    this.status = status;
  }
}

export class BadRequest extends HttpError {
  constructor(message: string) {
    super(400, message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);

/** The parsed JSON body, which must be an object. */
export async function jsonObject(c: Context, hint: string): Promise<Record<string, unknown>> {
  let v: unknown;
  try {
    v = await c.req.json();
  } catch {
    throw new BadRequest(`body must be JSON: ${hint}`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new BadRequest(`body must be a JSON object: ${hint}`);
  return v as Record<string, unknown>;
}

/** Like jsonObject, but an empty body is `{}`. */
export async function optionalJsonObject(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new BadRequest("body must be JSON");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new BadRequest("body must be a JSON object");
  return v as Record<string, unknown>;
}

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;

export function parseLimit(value: string | undefined, def = DEFAULT_LIMIT): number {
  if (value === undefined || value === "") return def;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new BadRequest("limit must be a positive integer");
  return Math.min(n, MAX_LIMIT);
}

/** Accepts ISO 8601, epoch milliseconds, or a duration meaning "that long ago" (`1h`, `30m`, `7d`). */
export function parseTime(value: string | undefined, now = Date.now()): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (/^\d+(\.\d+)?(ms|s|m|h|d)$/.test(value)) {
    const t = now - parseDuration(value);
    if (!Number.isSafeInteger(t)) throw new BadRequest(`invalid time: ${value}`);
    return t;
  }
  const t = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  // Out of range (e.g. 30 digits) is as invalid as unparseable: no stored time is near it.
  if (!Number.isSafeInteger(t)) throw new BadRequest(`invalid time: ${value} (use ISO 8601, epoch ms, or e.g. 1h)`);
  return t;
}

/** A positive bigint id from a path or query value, or the error. */
export function parseId(value: string | undefined, what: string): number {
  const n = value !== undefined && /^\d{1,15}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw notFound(what);
  return n;
}

export const iso = (ms: number | null | undefined): string | null => (ms == null ? null : new Date(ms).toISOString());

/** A trimmed, non-empty string field of at most `max` characters, without control characters. */
export function nameField(v: unknown, field: string, max: number): string {
  if (typeof v !== "string" || !v.trim()) throw new BadRequest(`${field} is required`);
  const s = v.trim();
  if (s.length > max) throw new BadRequest(`${field} is too long (${max} characters at most)`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new BadRequest(`${field} must not contain control characters`);
  return s;
}
