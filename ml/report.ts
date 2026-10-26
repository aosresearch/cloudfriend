// Turn ml/evaluate.ts result files into the markdown tables in docs/benchmarks.md.
//
//   node ml/report.ts data/results/re3-eval.json data/results/gaia-eval.json
import fs from "node:fs";

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const names: Record<string, string> = {
  cascade: "**cloudfriend** (classifier → Jev)",
  classifier: "classifier alone",
  keyword: "keyword rule (any error-like line)",
  "jev-all": "Jev on every event",
};

for (const file of process.argv.slice(2)) {
  const r = JSON.parse(fs.readFileSync(file, "utf8"));
  const a = r.aggregate as Record<string, Record<string, any>>;
  const strategies = Object.keys(a);
  const any = a[strategies[0]!]!;
  console.log(`\n### ${file.split("/").pop()} (split: ${r.split}, ${any.events.toLocaleString()} events)\n`);
  if (any.re3_cases !== undefined) {
    console.log("| Strategy | Faults escalated | Median time to escalate | Escalations raised | False escalations before the fault | Lines Jev read | Jev calls |");
    console.log("| --- | --- | --- | --- | --- | --- | --- |");
    for (const s of strategies) {
      const x = a[s]!;
      const reads = s === "cascade" || s === "jev-all" ? `${x.asked_jev.toLocaleString()} (${pct(x.share_to_jev, 2)})` : "0";
      const calls = s === "cascade" || s === "jev-all" ? String(x.jev_calls) : "0";
      const det = s === "jev-all" ? "n/a" : `${x.re3_detected}/${x.re3_detectable_cases}`;
      const ttd = s === "jev-all" || x.re3_median_ttd_s == null ? "n/a" : `${Math.round(x.re3_median_ttd_s)} s`;
      const ff = s === "jev-all" ? "n/a" : `${x.re3_false_flags_before_fault} (in ${x.re3_cases_with_false_flag} of ${x.re3_cases} cases)`;
      console.log(`| ${names[s] ?? s} | ${det} | ${ttd} | ${s === "jev-all" ? "n/a" : x.flags} | ${ff} | ${reads} | ${calls} |`);
    }
  }
  if (any.gaia_days !== undefined) {
    console.log("| Strategy | False escalations per day | Fault windows with an escalation | Lines Jev read | Jev calls |");
    console.log("| --- | --- | --- | --- | --- |");
    for (const s of strategies) {
      const x = a[s]!;
      const reads = s === "cascade" || s === "jev-all" ? `${x.asked_jev.toLocaleString()} (${pct(x.share_to_jev, 3)})` : "0";
      const calls = s === "cascade" || s === "jev-all" ? String(x.jev_calls) : "0";
      const ff = s === "jev-all" ? "n/a" : (x.gaia_false_flags_per_day as number).toFixed(1);
      const inc = s === "jev-all" ? "n/a" : `${x.gaia_incidents_flagged}/${x.gaia_incidents}`;
      console.log(`| ${names[s] ?? s} | ${ff} | ${inc} | ${reads} | ${calls} |`);
    }
  }
  const linked = (r.cases as any[]).filter((c) => c.users);
  if (linked.length) {
    const sum = (k: string) => linked.reduce((n, c) => n + c.users[k], 0);
    console.log(
      `\nUser linking: ${pct(sum("eventsWithUser") / linked.reduce((n, c) => n + c.events, 0))} of events carry a user id; ` +
        `${sum("distinctUsers").toLocaleString()} user-days, ${pct(sum("usersInSeveralServices") / Math.max(sum("distinctUsers"), 1))} of them seen in more than one service. ` +
        `${sum("flagsWithUser")} of ${sum("flags")} escalations name a user.`,
    );
  }
  const j = r.jev;
  console.log(
    `\nJev: ${j.calls} live calls${j.cached_calls ? ` (+${j.cached_calls} replayed from cache)` : ""}, $${j.spent_usd.toFixed(2)}, ` +
      `${j.prompt_tokens.toLocaleString()} prompt tokens, median latency ${j.median_latency_ms ? (j.median_latency_ms / 1000).toFixed(1) + " s" : "n/a"}. ` +
      `Routed to: ${Object.entries(j.routed_to as Record<string, number>).sort((x, y) => y[1] - x[1]).map(([m, n]) => `${m} (${n})`).join(", ")}.`,
  );
}
