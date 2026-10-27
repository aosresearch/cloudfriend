// Outbound HTTP to addresses people configure (destinations). Placeholder interface: the
// address checks (public addresses only, pinned at connect time, no redirects) land next.

export interface OutboundOptions {
  /** Self-hosted escape hatch (CLOUDFRIEND_ALLOW_PRIVATE_DESTINATIONS=on): allow private and loopback addresses. */
  allowPrivate: boolean;
  timeoutMs?: number;
}

/** Whether `url` may be used as a destination. The error is safe to show the person who typed it. */
export async function checkDestinationUrl(url: string, opts: OutboundOptions): Promise<{ ok: true } | { ok: false; error: string }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: "not a valid URL" };
  }
  if (u.protocol === "https:") return { ok: true };
  if (u.protocol === "http:" && opts.allowPrivate) return { ok: true };
  return { ok: false, error: "use an https URL" };
}

/** fetch() for configured destinations. Callers must not copy the response body into errors people see. */
export async function outboundFetch(url: string, init: RequestInit, opts: OutboundOptions): Promise<Response> {
  const check = await checkDestinationUrl(url, opts);
  if (!check.ok) throw new Error(`destination refused: ${check.error}`);
  const signal = AbortSignal.any([init.signal ?? new AbortController().signal, AbortSignal.timeout(opts.timeoutMs ?? 15_000)]);
  return fetch(url, { ...init, signal, redirect: "manual" });
}
