// Read prepared benchmark datasets (see ml/datasets/common.py for the format).
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";

export interface StreamEvent {
  t: number;
  source: string;
  data: unknown;
  /** Weak label from the dataset: 1 = should escalate. */
  y: 0 | 1;
  /** GAIA: the incidents a positive belongs to. */
  inc?: string[];
}

export interface Case {
  id: string;
  dataset: string;
  /** GAIA Aug 15-21 is `holdout`: untouched until a candidate is frozen (benchmarks/<date>/roles.json). */
  split: "train" | "valid" | "eval" | "holdout";
  start_ms: number;
  end_ms: number;
  /** RCAEval: when the fault was injected. */
  inject_ms?: number;
  /** GAIA: injected incidents during this stream, [start, end] epoch ms. */
  incidents?: { id: string; kind: string; service: string; start_ms: number; end_ms: number }[];
  /** Streams with the same `chain` continue each other (GAIA days) and share featurizer state. */
  chain?: string;
  events: number;
  positives: number;
  [k: string]: unknown;
}

export function loadCases(dir: string): Case[] {
  return JSON.parse(fs.readFileSync(path.join(dir, "cases.json"), "utf8"));
}

export async function* readStream(dir: string, id: string): AsyncGenerator<StreamEvent> {
  const file = path.join(dir, "streams", `${id}.ndjson.gz`);
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) if (line) yield JSON.parse(line);
}
