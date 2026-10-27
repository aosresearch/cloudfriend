// Serves the dashboard (src/ui/static/) at /. Routing in the UI is in the URL hash, so any other
// GET that isn't an API, ingest, sign-in or health path gets index.html.
import fs from "node:fs/promises";
import path from "node:path";
import type { Context, Hono } from "hono";

export const UI_DIR = path.join(import.meta.dirname, "..", "ui", "static");

/** The dashboard runs with no inline scripts or styles (src/ui/CONTRACT-NOTES.md). */
export const UI_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** Paths that never fall back to the app. */
const NOT_UI = /^\/(api|in|auth)(\/|$)|^\/healthz$/;

function uiHeaders(c: Context): void {
  c.header("content-security-policy", UI_CSP);
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "same-origin");
}

async function stat(file: string) {
  try {
    const s = await fs.stat(file);
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}

/** Register last: it answers every GET no other route took. */
export function registerUi(app: Hono<any>, dir = UI_DIR): void {
  const root = path.resolve(dir);
  app.get("*", async (c) => {
    const p = c.req.path;
    if (NOT_UI.test(p)) return c.notFound();
    let rel: string;
    try {
      rel = decodeURIComponent(p);
    } catch {
      return c.notFound();
    }
    if (rel.includes("\0")) return c.notFound();
    if (rel.endsWith("/")) rel += "index.html";
    const resolved = path.resolve(root, "." + rel);
    let file = resolved.startsWith(root + path.sep) ? resolved : null;
    let st = file ? await stat(file) : null;
    if (!st) {
      // A missing asset is a 404; anything else is a page of the app.
      if (path.extname(rel)) return c.notFound();
      file = path.join(root, "index.html");
      st = await stat(file);
      if (!st) return c.notFound();
    }
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    uiHeaders(c);
    // No hashed file names, so every file is revalidated; the ETag makes that a 304.
    c.header("cache-control", "no-cache");
    c.header("etag", etag);
    if (c.req.header("if-none-match") === etag) return c.body(null, 304);
    c.header("content-type", TYPES[path.extname(file!)] ?? "application/octet-stream");
    return c.body(new Uint8Array(await fs.readFile(file!)));
  });
}
