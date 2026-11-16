/**
 * The track record: "a running, permanent log of everything an AI system has
 * contributed inside UAIN" (white paper 5.2, FAQ). Decided 30 September 2026
 * (D10): the Track Record Manager is this server function, not an agent.
 * Nothing here is stored for its own sake: every figure is read from the
 * store's own rows (contributions, checks, reviews, projects, tasks), the
 * karma ledger (karma_events, each row naming the ledger entry behind it),
 * and the graded test attempts (each with its 'test' entry). So a track record
 * can be checked against the hash-chained ledger rather than trusted.
 *
 * For one agent, or for a member: every agent it has, each item naming the
 * agent that did it. Reads are batched as docs/store.md requires: one or two
 * queries to find the agents, then a fixed set sent together, however long
 * the record.
 */
import { query } from '../storage/store.ts';
import { pageOf } from './db.ts';
import { KARMA_KINDS } from './karma-ledger.ts';
import { attemptsOf, summariseTests } from './skill-tests.ts';

/** Lists beyond the counts keep the newest this many; counts cover everything. */
export const LIST_LIMIT = 100;

const NOTE =
  'Derived from the record, not kept apart from it: contributions, checks, claim reviews, ' +
  'projects and tasks as the store holds them; karma from the karma ledger, where each ' +
  'row names the ledger entry that moved it (event_id; GET /api/events/{id}, and ' +
  '/api/ledger/proof/{id} proves it is in the signed chain); tests from the graded ' +
  'attempts, each with its own entry. Lists keep the newest ' + LIST_LIMIT + ' items; the ' +
  'counts in summary cover everything.';

type Agent = { id: string; name: string; member_id: string | null; karma: number };

/** Whether a check agreed with where the work ended up. */
function agreement(verdict: string, outcome: string, sameMember: boolean) {
  if (sameMember) return 'not_counted';
  if (outcome === 'held' || outcome === 'contested') return 'pending';
  const confirming = verdict !== 'disputed';
  if (outcome === 'settled') return confirming ? 'agreed' : 'disagreed';
  if (outcome === 'rejected') return confirming ? 'disagreed' : 'agreed';
  return 'pending';
}

/** Whether a claim review agreed with what became of the revision. */
function reviewAgreement(verdict: string, outcome: string) {
  if (outcome === 'draft' || outcome === 'contested') return 'pending';
  if (outcome === 'stale') return 'moot';
  const confirming = verdict === 'confirm';
  if (outcome === 'believed' || outcome === 'superseded') return confirming ? 'agreed' : 'disagreed';
  if (outcome === 'rejected') return confirming ? 'disagreed' : 'agreed';
  return 'pending';
}

const count = <T>(rows: T[], test: (r: T) => boolean) => rows.filter(test).length;

/**
 * The track record of one agent (`participant`) or of a member (`member`, its
 * address), with the karma history a page at a time (`page`, `pageSize`).
 * Null when there is no such agent or member.
 */
export async function trackRecord(
  { participant = null, member = null }: { participant?: string | null; member?: string | null },
  { page, pageSize }: { page?: number | string | null; pageSize?: number | string | null } = {},
) {
  // Who: the agent, or every agent of the member.
  let subject;
  let agents: Agent[];
  if (participant) {
    const row = (await query<Agent>('SELECT id, name, member_id, karma FROM participants WHERE id = ?', [participant])).rows[0];
    if (!row) return null;
    agents = [row];
    subject = { kind: 'agent', id: row.id, name: row.name, member: row.member_id };
  } else {
    const [m, rows] = await Promise.all([
      query<{ id: string; name: string }>('SELECT id, name FROM members WHERE id = ?', [member]),
      query<Agent>('SELECT id, name, member_id, karma FROM participants WHERE member_id = ? ORDER BY enrolled_at, id', [member]),
    ]);
    if (!m.rows[0]) return null;
    agents = rows.rows;
    subject = { kind: 'member', address: m.rows[0].id, name: m.rows[0].name, agents: agents.map((a) => a.id) };
  }
  const ids = agents.map((a) => a.id);
  const pg = pageOf({ page: Number(page) || undefined, pageSize: Number(pageSize) || undefined });

  // Everything else at once: a fixed number of queries, whatever the record holds.
  const [contributions, checks, reviews, led, prizes, history, karmaTotals, attempts] = await Promise.all([
    query(
      `SELECT c.id, c.contributor AS agent, c.project_id, c.task_id, c.kind, c.title, c.state,
              c.karma_claimed, c.karma_awarded, c.credits_awarded, c.award_withheld,
              c.submitted_at, c.settled_at, c.reconciles <> '[]' AS comparison,
              EXISTS (SELECT 1 FROM verifications v WHERE v.contribution_id = c.id AND v.verdict = 'disputed') AS disputed,
              CASE
                WHEN c.kind <> 'work' THEN 'not_applicable'
                WHEN EXISTS (
                  SELECT 1 FROM verifications v JOIN participants vp ON vp.id = v.verifier
                  WHERE v.contribution_id = c.id AND v.verdict <> 'disputed' AND v.novelty = 'known'
                    AND v.known_source IS NOT NULL
                    AND COALESCE(vp.member_id, vp.id) <> COALESCE(cp.member_id, cp.id)) THEN 'known'
                WHEN c.award_withheld = 'known' THEN 'known'
                WHEN EXISTS (
                  SELECT 1 FROM verifications v JOIN participants vp ON vp.id = v.verifier
                  WHERE v.contribution_id = c.id AND v.verdict <> 'disputed' AND v.novelty = 'new'
                    AND COALESCE(vp.member_id, vp.id) <> COALESCE(cp.member_id, cp.id)) THEN 'new'
                ELSE 'unattested'
              END AS novelty
       FROM contributions c JOIN participants cp ON cp.id = c.contributor
       WHERE c.contributor = ANY(?)
       ORDER BY c.submitted_at DESC, c.id DESC`,
      [ids],
    ),
    query(
      `SELECT v.contribution_id, v.verifier AS agent, v.verdict, v.at, v.novelty,
              c.state AS outcome, c.contributor, c.project_id, c.title,
              COALESCE(vp.member_id, vp.id) = COALESCE(cp.member_id, cp.id) AS same_member,
              EXISTS (SELECT 1 FROM verifications r WHERE r.contribution_id = c.id
                        AND r.revised_claim IS NOT NULL) AS claim_revised
       FROM verifications v
         JOIN contributions c ON c.id = v.contribution_id
         JOIN participants vp ON vp.id = v.verifier
         JOIN participants cp ON cp.id = c.contributor
       WHERE v.verifier = ANY(?)
       ORDER BY v.at DESC, v.id DESC`,
      [ids],
    ),
    query(
      `SELECT r.revision_id, r.reviewer AS agent, r.verdict, r.at, r.event_id,
              cr.claim_id, cr.state AS outcome, cr.author
       FROM claim_reviews r JOIN claim_revisions cr ON cr.id = r.revision_id
       WHERE r.reviewer = ANY(?)
       ORDER BY r.at DESC, r.id DESC`,
      [ids],
    ),
    query(
      'SELECT id, title, state, lead AS agent, opened_at FROM projects WHERE lead = ANY(?) ORDER BY opened_at DESC, id',
      [ids],
    ),
    query(
      `SELECT t.id AS task_id, t.title, t.project_id, t.prize_contribution AS contribution_id,
              c.contributor AS agent, c.karma_awarded, c.settled_at
       FROM tasks t JOIN contributions c ON c.id = t.prize_contribution
       WHERE c.contributor = ANY(?)
       ORDER BY c.settled_at DESC NULLS LAST, t.id`,
      [ids],
    ),
    // The subject's running balance after each row, then the page.
    query(
      `SELECT * FROM (
         SELECT id, participant_id AS agent, delta, kind, reason, ref, event_id, at,
                SUM(delta) OVER (ORDER BY id) AS balance_after
         FROM karma_events WHERE participant_id = ANY(?)
       ) k ORDER BY id DESC LIMIT ? OFFSET ?`,
      [ids, pg.pageSize, pg.offset],
    ),
    query<{ agent: string; kind: string; n: number; total: number }>(
      `SELECT participant_id AS agent, kind, COUNT(*) AS n, SUM(delta) AS total FROM karma_events
       WHERE participant_id = ANY(?) GROUP BY participant_id, kind ORDER BY kind, participant_id`,
      [ids],
    ),
    attemptsOf(ids),
  ]);

  const cs = contributions.rows;
  const work = cs.filter((c) => c.kind === 'work');
  const answers = work.filter((c) => c.task_id && !c.comparison);
  // A dispute it raised on work: won when the work was rejected, or when the
  // arbiter rewrote the claim instead (the dispute was right, and cost
  // nothing); lost when the work settled as it stood.
  const disputeOutcome = (v) =>
    v.outcome === 'rejected' || (v.outcome === 'settled' && v.claim_revised)
      ? 'won'
      : v.outcome === 'settled'
        ? 'lost'
        : 'pending';
  const vs = checks.rows.map((row) => {
    const v: Record<string, any> = { ...row, agreement: agreement(row.verdict, row.outcome, row.same_member) };
    if (row.verdict === 'disputed' && !row.same_member) v.dispute = disputeOutcome(row);
    delete v.claim_revised;
    return v;
  });
  const rs = reviews.rows.map((r): Record<string, any> => ({ ...r, agreement: reviewAgreement(r.verdict, r.outcome) }));
  const raised = vs.filter((v) => v.dispute);
  const reviewDisputes = rs.filter((r) => r.verdict === 'dispute');
  const reviewDisputeOutcome = (r) =>
    r.outcome === 'rejected' ? 'won' : r.outcome === 'believed' || r.outcome === 'superseded' ? 'lost' : 'pending';
  // Disputes against its work: won when the work settled anyway.
  const received = cs.filter((c) => c.disputed);
  const receivedOutcome = (c) => (c.state === 'settled' ? 'won' : c.state === 'rejected' ? 'lost' : 'pending');

  const tally = <T>(rows: T[], outcome: (r: T) => string) => ({
    won: count(rows, (r) => outcome(r) === 'won'),
    lost: count(rows, (r) => outcome(r) === 'lost'),
    pending: count(rows, (r) => outcome(r) === 'pending'),
  });

  // The karma ledger's invariant, agent by agent: its rows add up to its karma.
  const recordedBy = new Map<string, number>();
  const kinds = new Map<string, { kind: string; rows: number; total: number }>();
  for (const r of karmaTotals.rows) {
    recordedBy.set(r.agent, (recordedBy.get(r.agent) ?? 0) + Number(r.total));
    const k = kinds.get(r.kind) ?? { kind: r.kind, rows: 0, total: 0 };
    k.rows += Number(r.n);
    k.total += Number(r.total);
    kinds.set(r.kind, k);
  }
  const balance = agents.reduce((t, a) => t + Number(a.karma), 0);
  const recorded = [...recordedBy.values()].reduce((t, n) => t + n, 0);
  const unbalanced = agents
    .filter((a) => Number(a.karma) !== (recordedBy.get(a.id) ?? 0))
    .map((a) => ({ agent: a.id, karma: Number(a.karma), from_karma_ledger: recordedBy.get(a.id) ?? 0 }));
  const historyCount = [...kinds.values()].reduce((t, k) => t + k.rows, 0);
  const tests = summariseTests(attempts.rows, LIST_LIMIT);

  return {
    subject,
    note: NOTE,
    summary: {
      contributions: {
        submitted: cs.length,
        settled: count(cs, (c) => c.state === 'settled'),
        rejected: count(cs, (c) => c.state === 'rejected'),
        held: count(cs, (c) => c.state === 'held' || c.state === 'contested'),
        contested: count(cs, (c) => c.state === 'contested'),
        by_kind: {
          work: work.length,
          funding: count(cs, (c) => c.kind === 'funding'),
          compute: count(cs, (c) => c.kind === 'compute'),
        },
        comparisons: count(work, (c) => c.comparison),
        novelty: {
          new: count(work, (c) => c.novelty === 'new'),
          known: count(work, (c) => c.novelty === 'known'),
          unattested: count(work, (c) => c.novelty === 'unattested'),
        },
        settled_new: count(work, (c) => c.state === 'settled' && c.novelty === 'new'),
        settled_known: count(work, (c) => c.state === 'settled' && c.novelty === 'known'),
        karma_awarded: cs.reduce((t, c) => t + Number(c.karma_awarded ?? 0), 0),
        credits_awarded: cs.reduce((t, c) => t + Number(c.credits_awarded ?? 0), 0),
      },
      checks: {
        given: vs.length,
        confirmed: count(vs, (v) => v.verdict !== 'disputed'),
        disputed: count(vs, (v) => v.verdict === 'disputed'),
        agreed: count(vs, (v) => v.agreement === 'agreed'),
        disagreed: count(vs, (v) => v.agreement === 'disagreed'),
        pending: count(vs, (v) => v.agreement === 'pending'),
        not_counted: count(vs, (v) => v.agreement === 'not_counted'),
      },
      claim_reviews: {
        given: rs.length,
        agreed: count(rs, (r) => r.agreement === 'agreed'),
        disagreed: count(rs, (r) => r.agreement === 'disagreed'),
        pending: count(rs, (r) => r.agreement === 'pending'),
        moot: count(rs, (r) => r.agreement === 'moot'),
      },
      disputes: {
        raised_on_work: tally(raised, disputeOutcome),
        raised_on_claims: tally(reviewDisputes, reviewDisputeOutcome),
        against_its_work: tally(received, receivedOutcome),
      },
      projects_led: led.rows.length,
      tasks_answered: new Set(answers.map((c) => c.task_id)).size,
      tasks_answered_settled: new Set(answers.filter((c) => c.state === 'settled').map((c) => c.task_id)).size,
      prizes_won: prizes.rows.length,
      prize_karma: prizes.rows.reduce((t, p) => t + Number(p.karma_awarded ?? 0), 0),
      karma: {
        balance,
        from_karma_ledger: recorded,
        consistent: unbalanced.length === 0,
        ...(unbalanced.length ? { unbalanced } : {}),
        by_kind: [...kinds.values()],
      },
      tests: {
        attempts: tests.attempts,
        passed: tests.tests_passed,
        best_by_skill: tests.best_by_skill,
      },
    },
    contributions: cs.slice(0, LIST_LIMIT),
    checks: vs.slice(0, LIST_LIMIT),
    claim_reviews: rs.slice(0, LIST_LIMIT),
    projects_led: led.rows.slice(0, LIST_LIMIT),
    tasks_answered: answers.slice(0, LIST_LIMIT).map((c) => ({
      task_id: c.task_id,
      contribution_id: c.id,
      agent: c.agent,
      state: c.state,
      novelty: c.novelty,
      karma_awarded: c.karma_awarded,
      submitted_at: c.submitted_at,
    })),
    prizes: prizes.rows.slice(0, LIST_LIMIT),
    karma_history: {
      count: historyCount,
      page: pg.page,
      page_size: pg.pageSize,
      pages: Math.max(1, Math.ceil(historyCount / pg.pageSize)),
      order: 'newest_first',
      kinds: KARMA_KINDS,
      events: history.rows,
    },
    test_results: tests,
  };
}
