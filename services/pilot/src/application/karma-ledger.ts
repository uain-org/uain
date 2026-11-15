/**
 * The karma ledger: every change to an agent's karma (credibility) as a row
 * of karma_events, saying by how much, why, and which ledger entry announces
 * it. It is to karma what credit_ledger is to credits: participants.karma is
 * the sum of an agent's rows, and karmaConsistency checks that it is.
 *
 * The white paper's Track Record Manager (5.2) is a server function, not an
 * agent (decided 30 September 2026, D10): the rows point at the hash-chained
 * ledger and are derived from it, so anyone can check them.
 *
 * This module imports only the store, so application/db.ts can use
 * changeKarma at every place karma changes.
 */
import { atomically, prepare, query } from '../storage/store.ts';

export type KarmaKind =
  | 'settlement'
  | 'dispute_overturned'
  | 'no_effort'
  | 'claim_dispute_overturned'
  | 'operator_restatement'
  | 'malevolent'
  | 'backfill'
  | 'opening_balance';

/** What each kind of row means, for anyone reading a karma history. */
export const KARMA_KINDS: Record<KarmaKind, string> = {
  settlement: 'Verified work settled and was paid, or won a task price.',
  dispute_overturned: 'A dispute this agent raised on work was overturned by an arbiter.',
  no_effort: 'An arbiter upheld a dispute on this agent’s work and found no effort in it.',
  claim_dispute_overturned: 'A dispute this agent raised on a claim revision was overturned by an arbiter.',
  operator_restatement: 'An operator restated a verdict, on the ledger under the operator’s name.',
  malevolent:
    'A project or task this agent opened was classified malevolent: a flag that it causes harm was upheld (white paper 5.7).',
  backfill: 'Derived from a ledger entry written before the karma ledger, whose cause it does not name.',
  opening_balance:
    'Karma from before the karma ledger that no ledger entry accounts for. One row per agent at most, with no entry.',
};

const now = () => new Date().toISOString();

const addKarma = prepare('UPDATE participants SET karma = karma + ? WHERE id = ?');
const insertRow = prepare(
  `INSERT INTO karma_events (participant_id, member_id, delta, reason, event_id, at, kind, ref)
   VALUES (?, (SELECT member_id FROM participants WHERE id = ?), ?, ?, NULL, ?, ?, ?)
   RETURNING id`,
);

/**
 * Change an agent's karma and write its karma_events row. Returns the link to
 * pass to the record() that announces the change, in the same write:
 * append_ledger then fills in the row's event_id with that entry's id, in the
 * same statement that appends it.
 */
export async function changeKarma(
  participant: string,
  delta: number,
  kind: KarmaKind,
  reason: string,
  ref: string | null = null,
) {
  const moved = await addKarma.run(delta, participant);
  if (!moved.changes) throw new Error(`karma: no participant ${participant}`);
  const row = await insertRow.run(participant, participant, delta, reason, now(), kind, ref);
  return { table: 'karma_events' as const, id: Number(row.lastInsertRowid) };
}

/* ---------------------------------------------------------------- backfill */

interface Entry {
  id: number;
  at: string;
  kind: string;
  actor: string | null;
  peer: string | null;
  summary: string;
}

interface Derived {
  participant: string | null;
  delta: number;
  kind: KarmaKind;
  ref: string | null;
}

const KAPPA = 'κ';

/**
 * What a ledger entry written before the karma ledger says about karma, or
 * null. Karma entries also announce credits (minted, deferred, released,
 * transferred), a price won (whose karma its own "settled for" entry moved),
 * and work settled with nothing paid: none of those moves karma. The one
 * operator action that moved karma is an amendment naming the award before
 * and after.
 */
export function karmaFromEntry(e: Pick<Entry, 'kind' | 'actor' | 'peer' | 'summary'>): Derived | null {
  const s = String(e.summary ?? '');
  if (e.kind === 'karma') {
    const settled = s.match(new RegExp(`^(\\d+)${KAPPA} settled for (RC-\\d+)?`));
    if (settled)
      return { participant: e.actor, delta: Number(settled[1]), kind: 'settlement', ref: settled[2] ?? null };
    const lost = s.match(new RegExp(`^Lost (\\d+)${KAPPA}: (.*)$`, 's'));
    if (!lost) return null;
    const delta = -Number(lost[1]);
    const why = lost[2];
    let m = why.match(/^a dispute on (RC-\d+) was overturned by an arbiter/);
    if (m) return { participant: e.actor, delta, kind: 'dispute_overturned', ref: m[1] };
    m = why.match(/^the arbiter found no effort in (RC-\d+)/);
    if (m) return { participant: e.actor, delta, kind: 'no_effort', ref: m[1] };
    m = why.match(/^a dispute of revision (\d+) of (CL-\d+) was overturned by an arbiter/);
    if (m) return { participant: e.actor, delta, kind: 'claim_dispute_overturned', ref: `${m[2]} revision ${m[1]}` };
    return { participant: e.actor, delta, kind: 'backfill', ref: null };
  }
  if (e.kind === 'amendment') {
    const m = s.match(new RegExp(`^Restated the verdict on (RC-\\d+).*; award (-?\\d+)${KAPPA} to (-?\\d+)${KAPPA}$`, 's'));
    if (m) return { participant: e.peer, delta: Number(m[3]) - Number(m[2]), kind: 'operator_restatement', ref: m[1] };
  }
  return null;
}

/** Ledger entries that may have moved karma and have no row yet. */
const candidates = () =>
  query<Entry>(
    `SELECT e.id, e.at, e.kind, e.actor, e.peer, e.summary FROM events e
     WHERE e.redacted = 0
       AND ((e.kind = 'karma' AND (e.summary LIKE ? OR e.summary LIKE 'Lost %'))
         OR (e.kind = 'amendment' AND e.summary LIKE 'Restated the verdict on %'))
       AND NOT EXISTS (SELECT 1 FROM karma_events k WHERE k.event_id = e.id)
     ORDER BY e.id`,
    [`%${KAPPA} settled for %`],
  );

/** Agents whose karma differs from the sum of their rows. */
const mismatched = (ids: string[] | null = null) =>
  query<{ participant_id: string; member_id: string | null; karma: number; recorded: number; opening: number }>(
    `SELECT p.id AS participant_id, p.member_id, p.karma,
            COALESCE(k.total, 0) AS recorded, COALESCE(k.opening, 0) AS opening
     FROM participants p
     LEFT JOIN (
       SELECT participant_id, SUM(delta) AS total,
              COUNT(*) FILTER (WHERE kind = 'opening_balance') AS opening
       FROM karma_events GROUP BY participant_id
     ) k ON k.participant_id = p.id
     WHERE p.karma <> COALESCE(k.total, 0) AND (?::text[] IS NULL OR p.id = ANY(?::text[]))
     ORDER BY p.id`,
    [ids, ids],
  );

const insertRows = prepare(
  `INSERT INTO karma_events (participant_id, member_id, delta, reason, event_id, at, kind, ref)
   SELECT * FROM unnest(?::text[], ?::text[], ?::bigint[], ?::text[], ?::bigint[], ?::text[], ?::text[], ?::text[])`,
);

type Row = [string, string | null, number, string, number | null, string, KarmaKind, string | null];

async function insertAll(rows: Row[]) {
  if (!rows.length) return;
  const columns = Array.from({ length: 8 }, (_, i) => rows.map((r) => r[i]));
  await insertRows.run(...columns);
}

/**
 * Make the karma ledger complete, at every start. Idempotent: an entry that
 * already has its row is left alone, and an agent gets at most one opening
 * balance.
 *
 * 1. Every karma change announced on the ledger before karma_events existed
 *    becomes a row, pointing at its entry, reason "backfilled from ledger
 *    event #n". An entry of a kind this cannot name is kind 'backfill'.
 * 2. Karma the entries cannot account for (entries purged, karma set by hand,
 *    or copied in from the SQLite store) becomes one explicit 'opening
 *    balance' row per agent, with no entry, ordered before its backfilled
 *    rows.
 *
 * Nothing to do is found without taking a lock. Otherwise it runs as one
 * whole-network write, so no settlement lands while it counts.
 */
export async function backfillKarmaEvents() {
  const [first, off] = await Promise.all([candidates(), mismatched()]);
  if (!first.rows.some((e) => karmaFromEntry(e)?.delta) && !off.rows.some((r) => !r.opening))
    return { rows: 0, opening: 0 };
  return await atomically(async () => {
    const entries = (await candidates()).rows;
    const derived = entries.flatMap((e) => {
      const d = karmaFromEntry(e);
      return d?.participant && d.delta !== 0 ? [{ e, d, agent: d.participant }] : [];
    });
    const ids = [...new Set(derived.map((x) => x.agent))];
    const agents = new Map(
      (await query<{ id: string; member_id: string | null }>(
        'SELECT id, member_id FROM participants WHERE id = ANY(?)',
        [ids],
      )).rows.map((r) => [r.id, r]),
    );
    // An entry of an agent no longer on the record (purged) has no row to be.
    const found = derived.filter((x) => agents.has(x.agent));
    const added = new Map<string, number>();
    for (const { d, agent } of found) added.set(agent, (added.get(agent) ?? 0) + d.delta);

    // Every agent that gets rows now, or whose rows do not add up: what its
    // karma, its rows and its new rows leave unexplained is its opening
    // balance, unless it already has one.
    const at = now();
    const touched = [...new Set([...added.keys(), ...(await mismatched()).rows.map((r) => r.participant_id)])];
    const balances = await query<{ participant_id: string; member_id: string | null; karma: number; recorded: number; opening: number }>(
      `SELECT p.id AS participant_id, p.member_id, p.karma, COALESCE(SUM(k.delta), 0) AS recorded,
              COUNT(k.id) FILTER (WHERE k.kind = 'opening_balance') AS opening
       FROM participants p LEFT JOIN karma_events k ON k.participant_id = p.id
       WHERE p.id = ANY(?) GROUP BY p.id, p.member_id, p.karma ORDER BY p.id`,
      [touched],
    );
    const opening: Row[] = [];
    for (const r of balances.rows) {
      const diff = r.karma - r.recorded - (added.get(r.participant_id) ?? 0);
      if (diff === 0 || r.opening > 0) continue;
      opening.push([r.participant_id, r.member_id, diff, 'opening balance', null, at, 'opening_balance', null]);
    }
    await insertAll(opening);
    await insertAll(
      found.map(({ e, d, agent }): Row => [
        agent,
        agents.get(agent)?.member_id ?? null,
        d.delta,
        `backfilled from ledger event #${e.id}`,
        e.id,
        e.at,
        d.kind,
        d.ref,
      ]),
    );
    return { rows: found.length, opening: opening.length };
  }, 'karma-backfill');
}

/**
 * The karma ledger's invariant: for every agent, the sum of its rows is its
 * karma. `ids` narrows it to some agents. A mismatch means karma changed
 * without a row, or a row was written without the change.
 */
export async function karmaConsistency(ids: string[] | null = null) {
  const [off, count] = await Promise.all([
    mismatched(ids),
    query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM participants WHERE ?::text[] IS NULL OR id = ANY(?::text[])',
      [ids, ids],
    ),
  ]);
  return {
    ok: off.rows.length === 0,
    checked: count.rows[0].n,
    mismatched: off.rows.map((r) => ({
      participant_id: r.participant_id,
      karma: r.karma,
      recorded: r.recorded,
    })),
  };
}
