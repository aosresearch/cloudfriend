// What people tell cloudfriend about its decisions, turned into training labels.
//
//   confirmed       a flag was right: its events are labelled "escalate"
//   false_positive  a flag was wrong: its events are labelled "don't escalate", and Jev's
//                   cached verdict for those templates is overturned
//   missed          an event that wasn't escalated should have been (a false negative)
//
// A person's label replaces Jev's label for the same event, never the other way round.
import { tx, type DB } from "./db.ts";
import { getFlagRow } from "./store.ts";
import { Featurizer, FEATURIZER_VERSION } from "./triage/features.ts";
import { encodeFeatures, type Triage } from "./triage/runtime.ts";

export type FlagVerdict = "confirmed" | "false_positive";

const UPSERT_HUMAN = `
  INSERT INTO labels (event_id, y, source, route, score, features, featurizer_version, event_source, received_at, data, note, created_at, template)
  SELECT id, ?, 'human', route, score, features, ${FEATURIZER_VERSION}, source, received_at, data, ?, ?, template FROM events WHERE id = ? AND features IS NOT NULL
  ON CONFLICT(event_id) DO UPDATE SET y = excluded.y, source = 'human', note = excluded.note, created_at = excluded.created_at`;

const templatesOf = (db: DB, ids: number[]) =>
  ids.length
    ? (db.prepare(`SELECT DISTINCT template FROM events WHERE id IN (${ids.map(() => "?").join(",")}) AND template IS NOT NULL`).all(...ids) as { template: string }[]).map((r) => r.template)
    : [];

export function flagFeedback(db: DB, triage: Triage | null, flagId: string, verdict: FlagVerdict, note: string | null) {
  const row = getFlagRow(db, flagId);
  if (!row) return null;
  const ids = (JSON.parse(row.event_ids) as string[]).map(Number).filter(Number.isInteger);
  const now = Date.now();
  const y = verdict === "confirmed" ? 1 : 0;
  let labeled = 0;
  tx(db, () => {
    db.prepare("UPDATE flags SET status = ?, note = ?, updated_at = ? WHERE id = ?").run(verdict, note, now, flagId);
    const upsert = db.prepare(UPSERT_HUMAN);
    for (const id of ids) labeled += Number(upsert.run(y, note, now, id).changes);
  });
  if (triage) {
    for (const t of templatesOf(db, ids)) {
      if (verdict === "false_positive") {
        triage.cache.set(t, false, now);
        triage.escalated.delete(t);
      } else triage.escalated.add(t, now);
    }
  }
  return { flag: flagId, status: verdict, labeled };
}

export function eventFeedback(db: DB, eventId: number, escalate: boolean, note: string | null, triage: Triage | null = null) {
  const ev = db.prepare("SELECT id, score, route, decided FROM events WHERE id = ?").get(eventId) as
    | { id: number; score: number | null; route: string | null; decided: number }
    | undefined;
  if (!ev) return null;
  const changes = Number(db.prepare(UPSERT_HUMAN).run(escalate ? 1 : 0, note, Date.now(), eventId).changes);
  // A missed escalation's kind reaches Jev from now on; a "no" takes it off that list.
  for (const t of templatesOf(db, [eventId])) (escalate ? triage?.escalated.add(t, Date.now()) : triage?.escalated.delete(t));
  const flagged = (db.prepare("SELECT count(*) AS n FROM flags WHERE EXISTS (SELECT 1 FROM json_each(flags.event_ids) WHERE value = ?)").get(String(eventId)) as { n: number }).n > 0;
  return {
    event: String(eventId),
    labeled: changes > 0,
    escalate,
    // What the pipeline did with it, so a missed escalation is visible as one.
    score: ev.score,
    route: ev.route,
    was_escalated: flagged,
    kind: escalate && !flagged ? "false_negative" : !escalate && flagged ? "false_positive" : escalate ? "true_positive" : "true_negative",
  };
}

export interface ImportedLabel {
  source: string;
  data: unknown;
  received_at?: string | number;
  escalate: boolean;
  note?: string;
}

/**
 * Labels for events cloudfriend never saw, e.g. last quarter's incidents from another tool.
 * They are featurized in time order with a fresh featurizer, so their history features only
 * see each other. Stored with negative ids so they never collide with real events.
 */
export function importLabels(db: DB, items: ImportedLabel[]): number {
  const f = new Featurizer();
  const now = Date.now();
  const timed = items.map((it, i) => {
    const t = typeof it.received_at === "number" ? it.received_at : it.received_at ? Date.parse(it.received_at) : now - (items.length - i);
    return { it, t: Number.isNaN(t) ? now : t };
  });
  timed.sort((a, b) => a.t - b.t);
  const min = (db.prepare("SELECT min(event_id) AS m FROM labels").get() as { m: number | null }).m ?? 0;
  let next = Math.min(min, 0) - 1;
  const ins = db.prepare(
    `INSERT INTO labels (event_id, y, source, route, score, features, featurizer_version, event_source, received_at, data, note, created_at, template)
     VALUES (?, ?, 'human', 'import', NULL, ?, ${FEATURIZER_VERSION}, ?, ?, ?, ?, ?, ?)`,
  );
  tx(db, () => {
    for (const { it, t } of timed) {
      const out = f.featurize({ source: it.source, received_at: t, data: it.data });
      ins.run(next--, it.escalate ? 1 : 0, encodeFeatures(out.values), it.source, t, JSON.stringify(it.data ?? null), it.note ?? null, now, out.template.slice(0, 300));
    }
  });
  return timed.length;
}
