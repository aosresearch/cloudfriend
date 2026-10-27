// Small exact statistics for miss rates: how bad could it be, given what we saw?

/** P(X <= k) for X ~ Binomial(n, p), summed in log space. */
export function binomCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n || p <= 0) return 1;
  if (p >= 1) return 0;
  const lp = Math.log(p);
  const lq = Math.log1p(-p);
  // log C(n, i) built up term by term.
  let logC = 0;
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log((n - i + 1) / i);
    sum += Math.exp(logC + i * lp + (n - i) * lq);
  }
  return Math.min(1, sum);
}

/**
 * One-sided exact (Clopper-Pearson) upper bound on a rate after `k` events in `n` trials:
 * the largest p for which seeing k or fewer is still at least `1 - confidence` likely.
 * 0 of 300 gives about 1.0% at 95%; 0 of 600 about 0.5%.
 */
export function upperBound(k: number, n: number, confidence = 0.95): number {
  if (n <= 0) return 1;
  if (k >= n) return 1;
  const alpha = 1 - confidence;
  let lo = k / n;
  let hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (binomCdf(k, n, mid) > alpha) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** One-sided exact lower bound, e.g. on a recall: the smallest p still consistent with k of n. */
export function lowerBound(k: number, n: number, confidence = 0.95): number {
  if (n <= 0 || k <= 0) return 0;
  return 1 - upperBound(n - k, n, confidence);
}

/** Percentile bootstrap over groups: `stat` of resampled groups, a central interval. */
export function bootstrap<T>(groups: T[], stat: (gs: T[]) => number, opts: { samples?: number; level?: number; seed?: number } = {}): [number, number] | null {
  if (!groups.length) return null;
  const samples = opts.samples ?? 2000;
  const level = opts.level ?? 0.95;
  let s = opts.seed ?? 1;
  const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const vals: number[] = [];
  for (let b = 0; b < samples; b++) {
    const pick = Array.from({ length: groups.length }, () => groups[Math.floor(rand() * groups.length)]!);
    const v = stat(pick);
    if (Number.isFinite(v)) vals.push(v);
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  const at = (q: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(q * vals.length)))]!;
  return [at((1 - level) / 2), at(1 - (1 - level) / 2)];
}
