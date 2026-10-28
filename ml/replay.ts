// Stream prepared benchmark cases into a running cloudfriend over HTTP, as real senders would.
//
//   node ml/replay.ts --url http://localhost:8080 --secret cloudfriend_... \
//     --data data/prepared/re3 --case re3-ob-adservice_f3-1 [--case ...] [--speed 20]
//
// Events go to POST /in/<source> as NDJSON in chunks. --speed replays at that many times real
// time (0, the default, sends as fast as the server accepts). The weak labels stay here; at the
// end the tool prints which escalations landed on the fault, so you can feed that back with
// POST /flags/:id/feedback.
import { parseArgs } from "node:util";
import { loadCases, readStream } from "./streams.ts";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:8080" },
    secret: { type: "string" },
    data: { type: "string" },
    case: { type: "string", multiple: true },
    speed: { type: "string", default: "0" },
    chunk: { type: "string", default: "500" },
  },
});
if (!args.secret || !args.data || !args.case?.length) {
  console.error("usage: node ml/replay.ts --url <cloudfriend> --secret <ingest secret> --data <prepared dir> --case <id> [--speed 20]");
  process.exit(2);
}

const speed = Number(args.speed);
const chunk = Number(args.chunk);
const cases = loadCases(args.data);

async function post(source: string, lines: string[]) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${args.url}/in/${source}`, {
      method: "POST",
      headers: { authorization: `Bearer ${args.secret}`, "content-type": "application/x-ndjson" },
      body: lines.join("\n"),
    });
    if (res.status === 202) return;
    if (res.status !== 503 || attempt > 20) throw new Error(`ingest replied ${res.status}: ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

for (const id of args.case) {
  const c = cases.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  const started = Date.now();
  let first: number | null = null;
  let sent = 0;
  const pending = new Map<string, string[]>();
  const flush = async () => {
    for (const [source, lines] of pending) if (lines.length) await post(source, lines.splice(0));
  };
  for await (const e of readStream(args.data, id)) {
    first ??= e.t;
    if (speed > 0) {
      const due = started + (e.t - first) / speed;
      if (due > Date.now() + 50) {
        await flush();
        await new Promise((r) => setTimeout(r, due - Date.now()));
      }
    }
    const list = pending.get(e.source) ?? [];
    // Log shippers send the line's own time; without it the server would use arrival time.
    const data = e.data as Record<string, unknown>;
    list.push(JSON.stringify("timestamp" in data ? data : { timestamp: new Date(e.t).toISOString(), ...data }));
    pending.set(e.source, list);
    if (list.length >= chunk) await post(e.source, list.splice(0));
    sent++;
  }
  await flush();
  console.log(`${id}: sent ${sent} events in ${((Date.now() - started) / 1000).toFixed(1)} s${c.inject_ms ? ` (fault at +${Math.round((c.inject_ms - c.start_ms) / 1000)} s of data time)` : ""}`);
}
