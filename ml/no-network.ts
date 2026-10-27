// Preload for offline runs: any network request fails loudly, and the count is printed at exit.
//
//   node --import ./ml/no-network.ts ml/evaluate.ts ...
//
// Proves a replay made no inference calls (docs/benchmarks.md), even with API keys set.
import http from "node:http";
import https from "node:https";

let attempts = 0;
const refuse = (what: string) => {
  attempts++;
  throw new Error(`network request blocked (${what}): this run is offline`);
};
globalThis.fetch = (async (input: unknown) => refuse(`fetch ${String(input).slice(0, 80)}`)) as typeof fetch;
for (const mod of [http, https]) {
  (mod as { request: unknown }).request = () => refuse("http.request");
  (mod as { get: unknown }).get = () => refuse("http.get");
}
process.on("exit", () => console.error(`no-network: ${attempts} request(s) attempted`));
