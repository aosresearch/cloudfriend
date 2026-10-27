// JSON client for the dashboard API (design/api-contract.md).
// Every request uses the session cookie; every state-changing one sends the CSRF header.

/** The static root (the directory holding index.html), so the app also works under a path prefix. */
export const BASE = new URL("../", import.meta.url);

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

let unauthorized = () => {};
/** Called on any 401 (except from the login request itself). */
export function onUnauthorized(fn) {
  unauthorized = fn;
}

export function apiUrl(path, query) {
  const url = new URL(`api/${path.replace(/^\/+/, "")}`, BASE);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  return url;
}

/**
 * api("me") or api(`w/${ws}/flags/${id}`, { method: "PATCH", body: {...} }).
 * Resolves to the parsed JSON (null for 204). Throws ApiError.
 */
export async function api(path, { method = "GET", body, query, signal } = {}) {
  const headers = { accept: "application/json" };
  if (method !== "GET" && method !== "HEAD") headers["x-cloudfriend-csrf"] = "1";
  if (body !== undefined) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(apiUrl(path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new ApiError(0, "Can't reach the cloudfriend server. Check that it is running, then try again.");
  }
  if (res.status === 204) return null;
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = (data && typeof data.error === "string" && data.error) || `Request failed (${res.status})`;
    if (res.status === 401 && path !== "login") unauthorized();
    throw new ApiError(res.status, message, data);
  }
  return data;
}

/** Path builder for workspace-scoped endpoints: wsPath(ws, "flags", id, "feedback"). */
export function wsPath(ws, ...parts) {
  return ["w", ws, ...parts].map((p) => encodeURIComponent(String(p))).join("/");
}
