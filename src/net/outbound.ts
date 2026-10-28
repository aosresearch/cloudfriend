// Outbound HTTP to addresses people configure (destinations: Slack, webhooks). Everything here
// assumes the URL was typed by someone we don't trust and that we send from inside our network:
//
// - https only (http too when CLOUDFRIEND_ALLOW_PRIVATE_DESTINATIONS is on), no credentials in the URL
// - every address the host resolves to must be public, unless private destinations are allowed;
//   one private address among public ones refuses the whole host
// - the host is resolved again when connecting, every address is checked again, and the socket
//   connects only to a checked address, so DNS that changes between check and send (rebinding)
//   doesn't get through
// - redirects are never followed (a 3xx is returned like any other non-2xx status)
// - a timeout (15 s by default) covers resolve, connect, request and response
// - at most a few KB of the response body are read; the rest is discarded
//
// Errors are short and safe to show the person who typed the URL. Callers must never copy the
// response body into an error, a log line or anything a person sees: that turns this into a way
// to read internal services.
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export interface ResolvedAddress {
  address: string;
  /** 4 or 6. */
  family: number;
}

/** Resolves a host name to all its addresses (A and AAAA). Injectable for tests. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface OutboundOptions {
  /** Self-hosted escape hatch (CLOUDFRIEND_ALLOW_PRIVATE_DESTINATIONS=on): allow private and loopback addresses, and http. */
  allowPrivate: boolean;
  /** Default 15 000. */
  timeoutMs?: number;
  /** How much of the response body to read before discarding the rest. Default 4096. */
  maxResponseBytes?: number;
  /** Defaults to the system resolver (getaddrinfo, as connecting would use). */
  resolve?: Resolver;
}

/** An outbound failure. `message` is short and safe to store in last_error and show in the UI. */
export class OutboundError extends Error {
  readonly kind: "refused" | "timeout" | "network" | "aborted";
  constructor(message: string, kind: OutboundError["kind"]) {
    super(message);
    this.name = "OutboundError";
    this.kind = kind;
  }
}

const systemResolver: Resolver = async (hostname) => {
  const all = await dns.promises.lookup(hostname, { all: true, order: "verbatim" });
  return all.map((a) => ({ address: a.address, family: a.family }));
};
let defaultResolver: Resolver = systemResolver;

/** Replace the resolver used when `opts.resolve` is not given (tests only); no argument restores the system one. */
export function setDefaultResolver(resolve?: Resolver): void {
  defaultResolver = resolve ?? systemResolver;
}

/** CLOUDFRIEND_ALLOW_PRIVATE_DESTINATIONS: on, true, 1 or yes. */
export function allowPrivateDestinations(env: NodeJS.ProcessEnv): boolean {
  return ["on", "true", "1", "yes"].includes((env.CLOUDFRIEND_ALLOW_PRIVATE_DESTINATIONS ?? "").trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

// IPv4 ranges that are not public unicast (IANA special-purpose registry, plus multicast and
// reserved). Anything else is public.
const V4_NON_PUBLIC: [string, number][] = [
  ["0.0.0.0", 8], // "this network", including the unspecified 0.0.0.0
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local: cloud metadata 169.254.169.254, ECS 169.254.170.2
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.31.196.0", 24], // AS112
  ["192.52.193.0", 24], // AMT
  ["192.88.99.0", 24], // 6to4 relay anycast (deprecated)
  ["192.168.0.0", 16], // private
  ["192.175.48.0", 24], // AS112
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including broadcast 255.255.255.255
];

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);
}

const V4_RANGES = V4_NON_PUBLIC.map(([base, bits]) => {
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return { base: (v4ToInt(base) & mask) >>> 0, mask };
});

function isPublicV4Int(n: number): boolean {
  return !V4_RANGES.some((r) => ((n & r.mask) >>> 0) === r.base);
}

/** The eight 16-bit groups of an IPv6 address, or null if it isn't one. */
function v6Groups(ip: string): number[] | null {
  let s = ip.includes("%") ? ip.slice(0, ip.indexOf("%")) : ip; // zone id
  if (!net.isIPv6(s)) return null;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = v4ToInt(tail);
    s = s.slice(0, lastColon + 1) + (v4 >>> 16).toString(16) + ":" + (v4 & 0xffff).toString(16);
  }
  const halves = s.split("::");
  const parse = (part: string | undefined) => (part ? part.split(":").map((g) => parseInt(g, 16)) : []);
  const head = parse(halves[0]);
  if (halves.length === 1) return head.length === 8 ? head : null;
  const rest = parse(halves[1]);
  return [...head, ...new Array<number>(8 - head.length - rest.length).fill(0), ...rest];
}

/**
 * Whether `ip` is a public unicast address we may connect to. Anything that isn't a valid IP
 * literal is not. IPv6 must be global unicast (2000::/3) outside the special ranges; IPv6 forms
 * that carry an IPv4 address (mapped ::ffff:a.b.c.d, NAT64 64:ff9b::a.b.c.d, 6to4 2002:AABB:CCDD::)
 * are judged by that IPv4 address.
 */
export function isPublicAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return isPublicV4Int(v4ToInt(ip));
  const g = v6Groups(ip);
  if (!g) return false;
  const v4 = (hi: number, lo: number) => ((hi << 16) | lo) >>> 0;
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  // ::/96: unspecified, loopback and the deprecated IPv4-compatible form. Never public.
  if (zero(0, 6)) return false;
  // ::ffff:0:0/96, IPv4-mapped.
  if (zero(0, 5) && g[5] === 0xffff) return isPublicV4Int(v4(g[6]!, g[7]!));
  // 64:ff9b::/96, NAT64 well-known prefix.
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return isPublicV4Int(v4(g[6]!, g[7]!));
  // 2002::/16, 6to4.
  if (g[0] === 0x2002) return isPublicV4Int(v4(g[1]!, g[2]!));
  // Outside 2000::/3: ULA fc00::/7, link-local fe80::/10, multicast ff00::/8, site-local,
  // discard 100::/64, NAT64 local-use 64:ff9b:1::/48, IPv4-translated and everything unassigned.
  if ((g[0]! & 0xe000) !== 0x2000) return false;
  // 2001::/23 IETF protocol assignments (Teredo, benchmarking, ORCHID, ...).
  if (g[0] === 0x2001 && g[1]! < 0x200) return false;
  // Documentation: 2001:db8::/32 and 3fff::/20.
  if (g[0] === 0x2001 && g[1] === 0xdb8) return false;
  if (g[0] === 0x3fff && (g[1]! & 0xf000) === 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

type Parsed = { ok: true; url: URL; host: string; literal: boolean } | { ok: false; error: string };

/** Everything that can be checked without DNS. `host` is without IPv6 brackets. */
function parseDestination(raw: unknown, allowPrivate: boolean): Parsed {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: "not a valid URL" };
  let url: URL;
  try {
    // WHATWG parsing normalizes every IPv4 notation (2130706433, 0x7f.1, 017700000001) to
    // dotted decimal, so the literal check below sees what a connection would use.
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: "not a valid URL" };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowPrivate)) {
    return { ok: false, error: allowPrivate ? "use an http or https URL" : "use an https URL" };
  }
  if (url.username || url.password) return { ok: false, error: "remove the user name and password from the URL" };
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (!host) return { ok: false, error: "not a valid URL" };
  const literal = net.isIP(host) !== 0;
  if (!allowPrivate) {
    if (literal && !isPublicAddress(host)) return { ok: false, error: "private address" };
    const name = host.replace(/\.$/, "").toLowerCase();
    if (name === "localhost" || name.endsWith(".localhost")) return { ok: false, error: "private address" };
  }
  return { ok: true, url, host, literal };
}

/** Every address `host` resolves to; throws an OutboundError when there are none or one is not allowed. */
async function resolveChecked(host: string, opts: OutboundOptions): Promise<ResolvedAddress[]> {
  let addrs: ResolvedAddress[];
  try {
    addrs = await (opts.resolve ?? defaultResolver)(host);
  } catch {
    throw new OutboundError("host not found", "network");
  }
  if (!addrs.length) throw new OutboundError("host not found", "network");
  if (!opts.allowPrivate && addrs.some((a) => !isPublicAddress(a.address))) {
    throw new OutboundError("destination refused: private address", "refused");
  }
  return addrs;
}

/**
 * Whether `url` may be used as a destination: scheme, no credentials, and (unless
 * `allowPrivate`) every address the host resolves to is public. The error is safe to show
 * the person who typed it: "not a valid URL", "use an https URL", "private address",
 * "host not found", ...
 */
export async function checkDestinationUrl(url: string, opts: OutboundOptions): Promise<{ ok: true } | { ok: false; error: string }> {
  const p = parseDestination(url, opts.allowPrivate);
  if (!p.ok) return p;
  if (p.literal) return { ok: true };
  try {
    await resolveChecked(p.host, opts);
  } catch (err) {
    if (err instanceof OutboundError) return { ok: false, error: err.message.replace(/^destination refused: /, "") };
    throw err;
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function toBody(body: RequestInit["body"]): Buffer | null {
  if (body == null) return null;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError("outboundFetch: body must be a string, URLSearchParams or bytes");
}

const TLS_CODE = /^(CERT_|ERR_TLS_|ERR_SSL_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_|HOSTNAME_MISMATCH)/;

/** A safe, short error for whatever the socket or TLS layer threw. No addresses, no bodies. */
function safeError(err: unknown): OutboundError {
  if (err instanceof OutboundError) return err;
  const code = String((err as { code?: unknown } | null)?.code ?? "");
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new OutboundError("host not found", "network");
  if (code === "ECONNREFUSED") return new OutboundError("connection refused", "network");
  if (code === "ECONNRESET" || code === "EPIPE") return new OutboundError("connection reset", "network");
  if (code === "ETIMEDOUT") return new OutboundError("timed out", "timeout");
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return new OutboundError("host unreachable", "network");
  if (TLS_CODE.test(code)) return new OutboundError("TLS certificate not accepted", "network");
  if (/^[A-Z][A-Z0-9_]{1,40}$/.test(code)) return new OutboundError(`connection failed (${code})`, "network");
  return new OutboundError("connection failed", "network");
}

function abortError(signal: AbortSignal): OutboundError {
  const reason = signal.reason as { name?: string } | undefined;
  return reason?.name === "TimeoutError" ? new OutboundError("timed out", "timeout") : new OutboundError("aborted", "aborted");
}

const NULL_BODY = new Set([204, 205, 304]);

function toResponse(res: http.IncomingMessage, body: Buffer): Response {
  const status = res.statusCode ?? 0;
  const headers = new Headers();
  for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
    try {
      headers.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
    } catch {
      // skip a header the Fetch API refuses
    }
  }
  // Response only takes 200-599; the caller turns anything else into "unexpected reply".
  return new Response(NULL_BODY.has(status) ? null : body, { status, headers });
}

/**
 * Send one request to a configured destination. Resolves with the response (status, headers and
 * at most `maxResponseBytes` of body) for any status, including 3xx, which is never followed:
 * check `ok`. Rejects with an OutboundError ("destination refused: private address", "timed out",
 * "connection refused", ...) whose message is safe to show. Never copy the body into an error.
 */
export async function outboundFetch(url: string, init: RequestInit, opts: OutboundOptions): Promise<Response> {
  const p = parseDestination(url, opts.allowPrivate);
  if (!p.ok) throw new OutboundError(`destination refused: ${p.error}`, "refused");
  const body = toBody(init.body);
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  headers.set("user-agent", "cloudfriend");
  if (body) headers.set("content-length", String(body.length));
  else if (method !== "GET" && method !== "HEAD") headers.set("content-length", "0");
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxResponseBytes ?? 4096;
  const signal = init.signal ?? undefined;
  if (signal?.aborted) throw abortError(signal);

  // net calls this when connecting (never for IP literals, which parseDestination checked). It
  // resolves now, checks every address, and hands net only checked addresses, so the socket
  // can only connect to an address that passed the check, whatever DNS said earlier.
  const lookup: net.LookupFunction = (hostname, options, callback) => {
    const cb = callback as (err: Error | null, address?: string | dns.LookupAddress[], family?: number) => void;
    resolveChecked(hostname, opts).then(
      (addrs) => {
        const want = options.family === 4 || options.family === "IPv4" ? 4 : options.family === 6 || options.family === "IPv6" ? 6 : 0;
        const list = want ? addrs.filter((a) => a.family === want) : addrs;
        process.nextTick(() => {
          if (!list.length) cb(new OutboundError("host not found", "network"));
          else if (options.all) cb(null, list.map((a) => ({ address: a.address, family: a.family })));
          else cb(null, list[0]!.address, list[0]!.family);
        });
      },
      (err: unknown) => process.nextTick(() => cb(safeError(err))),
    );
  };

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let req: http.ClientRequest | undefined;
    let res: http.IncomingMessage | undefined;
    const done = (err: OutboundError | null, response?: Response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      res?.destroy(); // discard whatever is left of the body
      if (err) {
        req?.destroy();
        reject(err);
      } else {
        resolve(response!);
      }
    };
    const onAbort = () => done(abortError(signal!));
    const timer = setTimeout(() => done(new OutboundError("timed out", "timeout")), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    req = (p.url.protocol === "https:" ? https : http).request({
      protocol: p.url.protocol,
      hostname: p.host,
      port: p.url.port || undefined,
      path: p.url.pathname + p.url.search,
      method,
      headers: Object.fromEntries(headers),
      // A fresh agent per request, so no pooled socket from an earlier call (perhaps made with
      // allowPrivate) is reused. TLS verification stays on (rejectUnauthorized defaults to true).
      agent: false,
      lookup,
    });
    req.on("error", (err) => done(safeError(err)));
    req.on("response", (incoming) => {
      res = incoming;
      const chunks: Buffer[] = [];
      let size = 0;
      const finish = () => {
        if (settled) return;
        let response: Response;
        try {
          response = toResponse(incoming, Buffer.concat(chunks));
        } catch {
          return done(new OutboundError("unexpected reply", "network"));
        }
        done(null, response);
      };
      incoming.on("data", (chunk: Buffer) => {
        if (size >= maxBytes) return;
        const take = chunk.subarray(0, maxBytes - size);
        chunks.push(take);
        size += take.length;
        if (size >= maxBytes) finish();
      });
      incoming.on("end", finish);
      incoming.on("close", finish);
      incoming.on("error", finish);
    });
    req.end(body ?? undefined);
  });
}
