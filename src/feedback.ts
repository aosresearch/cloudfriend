// What people tell cloudfriend about its decisions, turned into training labels.
//
//   confirmed       a flag was right: its events are labelled "escalate"
//   false_positive  a flag was wrong: its events are labelled "don't escalate", and Jev's
//                   cached verdict for those templates is overturned
//   missed          an event that wasn't escalated should have been (a false negative)
//
// A person's label replaces Jev's label for the same event, never the other way round.
import { all, one, pgText, run, tx, type DB, type Queryable } from "./db.ts";
import { getFlagRow } from "./store.ts";
import { Featurizer, FEATURIZER_VERSION } from "./triage/features.ts";
import { encodeFeatures, type Triage } from "./triage/runtime.ts";

export type FlagVerdict = "confirmed" | "false_positive";

/** $1 y, $2 note, $3 created_at, $4 workspace, $5 event id. */
const UPSERT_HUMAN = `
  INSERT INTO labels (workspace_id, event_id, y, source, route, score, features, featurizer_version, event_source, received_at, data, note, created_at, template, provenance, weight, severity)
  SELECT workspace_id, id, $1::integer, 'human', route, score, features, coalesce(fv, 2), source, received_at, data, $2::text, $3::bigint, template, 'human', NULL::double precision, severity
  FROM events WHERE workspace_id = $4 AND id = $5 AND features IS NOT NULL
  ON CONFLICT (workspace_id, event_id) DO UPDATE SET y = excluded.y, source = 'human', note = excluded.note, created_at = excluded.created_at,
    provenance = 'human', weight = NULL, decision_id = NULL`;

/** The (template, severity) pairs of some events: the units verdicts are cached for. */
const kindsOf = async (db: Queryable, ws: string, ids: number[]) =>
  ids.length
    ? await all<{ template: string; severity: string | null }>(
        db,
        "SELECT DISTINCT template, severity FROM events WHERE workspace_id = $1 AND id = ANY($2::bigint[]) AND template IS NOT NULL",
        [ws, ids],
      )
    : [];

/**
 * Apply a person's verdict on a kind of event to routing (routing.ts) at once, before any
 * retraining. "Escalate" protects the template, revokes its earned suppression and clears any
 * cached "no"; "don't" retires the protection and earns suppression in the current context.
 */
function humanVerdict(triage: Triage, k: { template: string; severity: string | null }, escalate: boolean, now: number, cacheNo: boolean): void {
  const ctx = triage.featurizer.context(k.template);
  triage.routing.personSaid(k.template, k.severity ?? undefined, escalate, now, { rate: ctx?.last_1m, serviceErrors: ctx?.service_errors_10m }, cacheNo);
}

export async function flagFeedback(db: DB, ws: string, triage: Triage | null, flagId: string, verdict: FlagVerdict, note: string | null) {
  const row = await getFlagRow(db, ws, flagId);
  if (!row) return null;
  const ids = row.event_ids.map(Number).filter(Number.isSafeInteger);
  const now = Date.now();
  const y = verdict === "confirmed" ? 1 : 0;
  let labeled = 0;
  await tx(db, async (c) => {
    await c.query("UPDATE flags SET status = $1, note = $2, updated_at = $3 WHERE workspace_id = $4 AND id = $5", [verdict, pgText(note), now, ws, flagId]);
    for (const id of ids) labeled += await run(c, UPSERT_HUMAN, [y, pgText(note), now, ws, id]);
  });
  if (triage) for (const k of await kindsOf(db, ws, ids)) humanVerdict(triage, k, verdict === "confirmed", now, true);
  return { flag: flagId, status: verdict, labeled };
}

export async function eventFeedback(db: DB, ws: string, eventId: number, escalate: boolean, note: string | null, triage: Triage | null = null) {
  const ev = await one<{ id: number; score: number | null; route: string | null }>(
    db,
    "SELECT id, score, route FROM events WHERE workspace_id = $1 AND id = $2",
    [ws, eventId],
  );
  if (!ev) return null;
  const changes = await run(db, UPSERT_HUMAN, [escalate ? 1 : 0, pgText(note), Date.now(), ws, eventId]);
  // A missed escalation's kind reaches Jev from now on and any cached "no" for it is gone;
  // a "no" takes it off that list.
  if (triage) for (const k of await kindsOf(db, ws, [eventId])) humanVerdict(triage, k, escalate, Date.now(), false);
  const flagged = !!(await one(db, "SELECT 1 FROM flags WHERE workspace_id = $1 AND event_ids ? $2 LIMIT 1", [ws, String(eventId)]));
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

const IMPORT_CHUNK = 5_000;

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
export async function importLabels(db: DB, ws: string, items: ImportedLabel[], version = FEATURIZER_VERSION): Promise<number> {
  const f = new Featurizer({ version });
  const now = Date.now();
  const timed = items.map((it, i) => {
    const t = typeof it.received_at === "number" ? it.received_at : it.received_at ? Date.parse(it.received_at) : now - (items.length - i);
    return { it, t: Number.isNaN(t) ? now : Math.round(t) };
  });
  timed.sort((a, b) => a.t - b.t);
  await tx(db, async (c) => {
    // The lowest id so far, read under a lock on the workspace so concurrent imports don't
    // hand out the same ids.
    await c.query("SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE", [ws]);
    const min = (await one<{ m: number | null }>(c, "SELECT min(event_id) AS m FROM labels WHERE workspace_id = $1", [ws]))!.m ?? 0;
    let next = Math.min(min, 0) - 1;
    const rows = timed.map(({ it, t }) => {
      const out = f.featurize({ source: it.source, received_at: t, data: it.data });
      return [next--, it.escalate ? 1 : 0, encodeFeatures(out.values), pgText(it.source), t, JSON.stringify(it.data ?? null), pgText(it.note ?? null), pgText(out.template.slice(0, 300))] as const;
    });
    for (let i = 0; i < rows.length; i += IMPORT_CHUNK) {
      const chunk = rows.slice(i, i + IMPORT_CHUNK);
      await c.query(
        `INSERT INTO labels (workspace_id, event_id, y, source, route, score, features, featurizer_version, event_source, received_at, data, note, created_at, template, provenance)
         SELECT $1::text, e, y, 'human', 'import', NULL::double precision, f, $2::integer, s, t, d, n, $3::bigint, tpl, 'import'
         FROM unnest($4::bigint[], $5::integer[], $6::bytea[], $7::text[], $8::bigint[], $9::text[], $10::text[], $11::text[]) AS u(e, y, f, s, t, d, n, tpl)`,
        [ws, version, now, ...[0, 1, 2, 3, 4, 5, 6, 7].map((k) => chunk.map((r) => r[k]))],
      );
    }
  });
  return timed.length;
}
