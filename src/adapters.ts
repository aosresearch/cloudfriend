import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ActionAdapter, DeciderAdapter, SourceAdapter } from "./types.ts";

export interface Adapters {
  sources: Map<string, SourceAdapter>;
  deciders: Map<string, DeciderAdapter>;
  actions: Map<string, ActionAdapter>;
}

const BUILTIN_DIR = path.join(import.meta.dirname, "adapters");
const ADAPTER_FILE = /^([a-z0-9][a-z0-9_-]*)\.(ts|js|mjs)$/;

/**
 * Every file in `<dir>/sources`, `<dir>/deciders` and `<dir>/actions` is an adapter named
 * after the file. Files in `extraDir` override built-ins with the same name.
 */
export async function loadAdapters(extraDir: string | null = null): Promise<Adapters> {
  const out: Adapters = { sources: new Map(), deciders: new Map(), actions: new Map() };
  for (const dir of [BUILTIN_DIR, extraDir]) {
    if (!dir) continue;
    await loadKind(path.join(dir, "sources"), out.sources, (a) => typeof a.parse === "function");
    await loadKind(path.join(dir, "deciders"), out.deciders, (a) => typeof a.decide === "function");
    await loadKind(path.join(dir, "actions"), out.actions, (a) => typeof a.run === "function");
  }
  if (!out.sources.has("json")) throw new Error("the json source adapter is required");
  return out;
}

async function loadKind<T>(dir: string, into: Map<string, T>, valid: (a: any) => boolean): Promise<void> {
  let files: string[];
  try {
    files = fs.readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const file of files) {
    const m = ADAPTER_FILE.exec(file);
    if (!m || file.endsWith(".d.ts") || file.includes(".test.")) continue;
    const mod = await import(pathToFileURL(path.join(dir, file)).href);
    const adapter = mod.default;
    if (!adapter || !valid(adapter)) {
      throw new Error(`${path.join(dir, file)}: default export is not a valid adapter`);
    }
    into.set(m[1]!, adapter);
  }
}
