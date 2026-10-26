export interface CompactOptions {
  maxDepth?: number;
  maxArray?: number;
  maxString?: number;
  maxChars?: number;
}

/**
 * Render arbitrary JSON as a short string for a prompt or a chat message. Scalars come
 * before nested values at every level, so truncation cuts stack frames, not the title.
 */
export function compactJson(value: unknown, opts: CompactOptions = {}): string {
  const { maxDepth = 5, maxArray = 8, maxString = 400, maxChars = 2000 } = opts;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return v.length > maxString ? v.slice(0, maxString) + "…" : v;
    if (v === null || typeof v !== "object") return v;
    if (depth >= maxDepth) return Array.isArray(v) ? `[${v.length} items]` : "{…}";
    if (Array.isArray(v)) {
      const items = v.slice(0, maxArray).map((x) => walk(x, depth + 1));
      if (v.length > maxArray) items.push(`…${v.length - maxArray} more`);
      return items;
    }
    const entries = Object.entries(v).filter(([, x]) => x !== null && x !== "" && x !== undefined);
    const scalar = entries.filter(([, x]) => typeof x !== "object");
    const nested = entries.filter(([, x]) => typeof x === "object");
    return Object.fromEntries([...scalar, ...nested].map(([k, x]) => [k, walk(x, depth + 1)]));
  };
  const text = JSON.stringify(walk(value, 0)) ?? "null";
  return text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
}
