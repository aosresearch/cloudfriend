// Accepts any POST. Also the fallback for `/in/<name>` when no adapter is called <name>.
//   - a JSON object becomes one event
//   - a JSON array becomes one event per item
//   - newline-delimited JSON becomes one event per line
//   - anything else becomes one event: { "raw": "<body as text>" }
import { defineSource, type ParsedEvent } from "../../types.ts";

const decoder = new TextDecoder();

export function parseJsonBody(body: Uint8Array): unknown[] {
  const text = decoder.decode(body).trim();
  if (!text) return [];
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [value];
  } catch {
    // Not one JSON document; try NDJSON before giving up.
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length > 1) {
    try {
      return lines.map((l) => JSON.parse(l));
    } catch {
      // Fall through to raw text.
    }
  }
  return [{ raw: text }];
}

export default defineSource({
  parse(body): ParsedEvent[] {
    return parseJsonBody(body).map((data) => ({ data }));
  },
});
