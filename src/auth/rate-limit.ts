// In-memory login throttling with exponential backoff, keyed separately by client IP and by email.
// A key gets `free` failed attempts; after that each further failure locks it for base * 2^(extra - 1),
// capped at `max`. Entries are forgotten `forgetAfterMs` after the last failure. Unknown emails are
// throttled exactly like known ones, so a lockout says nothing about whether an account exists.
// Being in memory, the limits are per process and reset on restart. A null IP (no address of the
// client's own, e.g. behind an untrusted proxy: see client-ip.ts) skips the per-IP limits, since a
// key shared by every client would let anyone lock everyone out.

export interface BackoffPolicy {
  free: number;
  baseMs: number;
  maxMs: number;
  forgetAfterMs: number;
}

export interface LoginLimits {
  ip: BackoffPolicy;
  email: BackoffPolicy;
  /** Upper bound on tracked keys per limiter; the stalest are dropped beyond it. */
  maxEntries: number;
  maxInFlightPerIp: number;
  maxInFlightPerEmail: number;
}

export const DEFAULT_LOGIN_LIMITS: LoginLimits = {
  ip: { free: 20, baseMs: 1_000, maxMs: 15 * 60_000, forgetAfterMs: 60 * 60_000 },
  email: { free: 5, baseMs: 1_000, maxMs: 15 * 60_000, forgetAfterMs: 60 * 60_000 },
  maxEntries: 50_000,
  maxInFlightPerIp: 8,
  maxInFlightPerEmail: 2,
};

interface Entry {
  failures: number;
  lastFailure: number;
  lockedUntil: number;
}

class Backoff {
  readonly #policy: BackoffPolicy;
  readonly #maxEntries: number;
  readonly #entries = new Map<string, Entry>();

  constructor(policy: BackoffPolicy, maxEntries: number) {
    this.#policy = policy;
    this.#maxEntries = maxEntries;
  }

  #get(key: string, now: number): Entry | undefined {
    const e = this.#entries.get(key);
    if (e && now - e.lastFailure >= this.#policy.forgetAfterMs && now >= e.lockedUntil) {
      this.#entries.delete(key);
      return undefined;
    }
    return e;
  }

  /** Milliseconds until the key may try again (0 = now). */
  wait(key: string, now: number): number {
    const e = this.#get(key, now);
    return e ? Math.max(0, e.lockedUntil - now) : 0;
  }

  fail(key: string, now: number): void {
    let e = this.#get(key, now);
    if (!e) {
      if (this.#entries.size >= this.#maxEntries) this.#prune(now);
      e = { failures: 0, lastFailure: now, lockedUntil: 0 };
      this.#entries.set(key, e);
    } else {
      // Keep Map order = staleness order, so pruning drops the stalest first.
      this.#entries.delete(key);
      this.#entries.set(key, e);
    }
    e.failures++;
    e.lastFailure = now;
    const extra = e.failures - this.#policy.free;
    if (extra > 0) {
      const delay = Math.min(this.#policy.maxMs, this.#policy.baseMs * 2 ** Math.min(extra - 1, 30));
      e.lockedUntil = now + delay;
    }
  }

  reset(key: string): void {
    this.#entries.delete(key);
  }

  #prune(now: number): void {
    for (const [k, e] of this.#entries) {
      if (now - e.lastFailure >= this.#policy.forgetAfterMs && now >= e.lockedUntil) this.#entries.delete(k);
    }
    // Still full: drop the stalest tenth.
    if (this.#entries.size >= this.#maxEntries) {
      let n = Math.ceil(this.#maxEntries / 10);
      for (const k of this.#entries.keys()) {
        if (n-- <= 0) break;
        this.#entries.delete(k);
      }
    }
  }
}

export class LoginRateLimiter {
  readonly #ip: Backoff;
  readonly #email: Backoff;
  readonly #limits: LoginLimits;
  readonly #now: () => number;
  // Failures are only known after the (slow) password check, so a burst of parallel requests could all
  // pass the backoff check first. Capping attempts in flight per key bounds that overshoot.
  readonly #inFlight = new Map<string, number>();

  constructor(limits: LoginLimits = DEFAULT_LOGIN_LIMITS, now: () => number = Date.now) {
    this.#limits = limits;
    this.#ip = new Backoff(limits.ip, limits.maxEntries);
    this.#email = new Backoff(limits.email, limits.maxEntries);
    this.#now = now;
  }

  /**
   * Returns how many milliseconds the caller must wait (> 0: refuse the attempt). On 0 the attempt is
   * counted as in flight, and the caller must call finish() exactly once.
   */
  begin(ip: string | null, email: string): number {
    const now = this.#now();
    const wait = Math.max(ip === null ? 0 : this.#ip.wait(ip, now), this.#email.wait(email, now));
    if (wait > 0) return wait;
    const ipKey = ip === null ? null : "ip\0" + ip;
    const emailKey = "email\0" + email;
    if ((ipKey !== null && (this.#inFlight.get(ipKey) ?? 0) >= this.#limits.maxInFlightPerIp) || (this.#inFlight.get(emailKey) ?? 0) >= this.#limits.maxInFlightPerEmail) {
      return 1_000;
    }
    if (ipKey !== null) this.#inFlight.set(ipKey, (this.#inFlight.get(ipKey) ?? 0) + 1);
    this.#inFlight.set(emailKey, (this.#inFlight.get(emailKey) ?? 0) + 1);
    return 0;
  }

  /** Records the outcome. A success clears the email's failures, not the IP's (one valid account must not reset an attacker's IP budget). */
  finish(ip: string | null, email: string, success: boolean): void {
    for (const key of [...(ip === null ? [] : ["ip\0" + ip]), "email\0" + email]) {
      const n = (this.#inFlight.get(key) ?? 1) - 1;
      if (n > 0) this.#inFlight.set(key, n);
      else this.#inFlight.delete(key);
    }
    if (success) {
      this.#email.reset(email);
    } else {
      const now = this.#now();
      if (ip !== null) this.#ip.fail(ip, now);
      this.#email.fail(email, now);
    }
  }
}
