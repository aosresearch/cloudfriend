// A signed-in client of the dashboard API, as the UI uses it (src/ui/static/js/api.js): the session
// cookie on every request, the CSRF header on every state-changing one.
import { SESSION_COOKIE } from "../src/auth/index.ts";

export type Fetcher = (path: string, init: RequestInit) => Response | Promise<Response>;

export interface Reply {
  status: number;
  json: any;
  res: Response;
}

export class Client {
  cookie = "";
  readonly #fetch: Fetcher;

  constructor(fetcher: Fetcher) {
    this.#fetch = fetcher;
  }

  async call(method: string, path: string, body?: unknown, opts: { csrf?: boolean; auth?: boolean } = {}): Promise<Reply> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.auth !== false && this.cookie) headers.cookie = this.cookie;
    if (method !== "GET" && method !== "HEAD" && opts.csrf !== false) headers["x-cloudfriend-csrf"] = "1";
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await this.#fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json, res };
  }

  get = (path: string) => this.call("GET", path);
  post = (path: string, body?: unknown) => this.call("POST", path, body);

  async login(email: string, password: string): Promise<Reply> {
    const r = await this.call("POST", "/api/login", { email, password });
    const set = r.res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    if (r.status === 200 && set) this.cookie = set.split(";")[0]!;
    return r;
  }
}

/** Polls `fn` until it returns something truthy. */
export async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 15_000, every = 50): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, every));
  }
}
