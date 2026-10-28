// Move recorded Jev calls from the round-3 cache key to the current one (ml/jev.ts).
//
//   node ml/rekey-cache.ts --from data/r3/jev-cache --to data/jev-cache [--out migration.json]
//
// The old key hashed only the model asked for, the bare system prompt and the user prompt. A
// record is moved only if that key can be recomputed from what the record itself stores: its
// prompt must start with the current SYSTEM_PROMPT and no operator instructions, and the hash
// of (model, SYSTEM_PROMPT, the rest of the prompt) must be its file name. That proves the
// model asked for and the system prompt. What the old key did not cover is taken from the
// code at the time, and written into each record's `migrated` field:
//   request parameters  REQUEST_PARAMS (temperature 0, max_tokens 4000, JSON replies), unchanged
//                       in src/adapters/deciders/openrouter.ts since before round 3 (git log -p)
//   reply schema        RESPONSE_SCHEMA_VERSION: the system prompt asking for it is verified
//   event limit         800: ml/jev.ts's default; no run set CLOUDFRIEND_EVENT_CHARS
// Records that can't be verified are listed and left behind. The source is never changed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { REQUEST_PARAMS, RESPONSE_SCHEMA_VERSION, SYSTEM_PROMPT } from "../src/adapters/deciders/openrouter.ts";
import { JEV } from "../src/adapters/deciders/jev.ts";
import { BENCHMARK_EVENT_CHARS, CACHE_KEY_VERSION, cacheKey, sha256, type JevRecord, type JevRequest } from "./jev.ts";

const { values: args } = parseArgs({
  options: {
    from: { type: "string" },
    to: { type: "string" },
    out: { type: "string" },
    model: { type: "string", default: JEV.model },
    "event-chars": { type: "string", default: BENCHMARK_EVENT_CHARS },
  },
});
if (!args.from || !args.to) {
  console.error("usage: node ml/rekey-cache.ts --from <old cache dir> --to <new cache dir> [--out migration.json]");
  process.exit(2);
}

const SEP = "\n\n---\n\n";
const v1Key = (model: string, system: string, prompt: string) => crypto.createHash("sha256").update(model + "\0" + system + "\0" + prompt).digest("hex");

const files: string[] = [];
for (const d of fs.readdirSync(args.from).sort()) {
  const sub = path.join(args.from, d);
  if (fs.statSync(sub).isDirectory()) for (const f of fs.readdirSync(sub).sort()) if (f.endsWith(".json")) files.push(path.join(sub, f));
}

const moved: { from: string; to: string }[] = [];
const left: { file: string; reason: string }[] = [];
for (const file of files) {
  const oldKey = path.basename(file, ".json");
  let rec: Partial<JevRecord> & { prompt?: string };
  try {
    rec = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    left.push({ file: oldKey, reason: "unreadable" });
    continue;
  }
  if (rec.key_version === CACHE_KEY_VERSION) {
    left.push({ file: oldKey, reason: "already current" });
    continue;
  }
  if (typeof rec.prompt !== "string" || !rec.prompt.startsWith(SYSTEM_PROMPT + SEP)) {
    left.push({ file: oldKey, reason: "its system prompt isn't the current one (or has operator instructions)" });
    continue;
  }
  const prompt = rec.prompt.slice(SYSTEM_PROMPT.length + SEP.length);
  if (v1Key(args.model!, SYSTEM_PROMPT, prompt) !== oldKey) {
    left.push({ file: oldKey, reason: "its old key doesn't recompute from the stored prompt" });
    continue;
  }
  const req: JevRequest = { model: args.model!, system: SYSTEM_PROMPT, prompt, params: REQUEST_PARAMS, schema: RESPONSE_SCHEMA_VERSION, event_chars: args["event-chars"]! };
  const key = cacheKey(req);
  const next: JevRecord = {
    ...(rec as JevRecord),
    key_version: CACHE_KEY_VERSION,
    request: { model: req.model, system_sha256: sha256(req.system), params: req.params, schema: req.schema, event_chars: req.event_chars },
    migrated: {
      from_key: oldKey,
      verified: "model asked for and system prompt: the old key recomputes from the stored prompt",
      assumed: { params: "REQUEST_PARAMS, unchanged since before the round", schema: RESPONSE_SCHEMA_VERSION, event_chars: req.event_chars },
    },
  };
  const dest = path.join(args.to, key.slice(0, 2), key + ".json");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(next));
  moved.push({ from: oldKey, to: key });
}

const report = {
  from: args.from,
  to: args.to,
  key_version: CACHE_KEY_VERSION,
  system_prompt_sha256: sha256(SYSTEM_PROMPT),
  model: args.model,
  event_chars: args["event-chars"],
  records: files.length,
  moved: moved.length,
  left_behind: left,
  map: moved,
};
if (args.out) fs.writeFileSync(args.out, JSON.stringify(report, null, 1));
console.log(`${moved.length} of ${files.length} records moved to key v${CACHE_KEY_VERSION}; ${left.length} left behind`);
for (const l of left.slice(0, 20)) console.log(`  ${l.file}: ${l.reason}`);
