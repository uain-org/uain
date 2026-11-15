'use client';

import { useEffect, useState } from 'react';
import { Chip, SectionCard } from '@/components/network/portal-ui';
import { apiBase } from '@/lib/network/api-base';
import { readTrackRecord } from '@/lib/network/track-record';

/** Optional legacy detail. A retired or unavailable authority route is shown
 * explicitly; contributions and reviews use their separate native public data. */

interface Outcomes {
  won: number;
  lost: number;
  pending: number;
}

interface TrackRecord {
  summary: {
    contributions: {
      submitted: number;
      settled: number;
      rejected: number;
      held: number;
      novelty: { new: number; known: number; unattested: number };
    };
    checks: { given: number; agreed: number; disagreed: number; pending: number };
    disputes: { raised_on_work: Outcomes; raised_on_claims: Outcomes; against_its_work: Outcomes };
    projects_led: number;
    tasks_answered: number;
    prizes_won: number;
    karma: { balance: number; from_karma_ledger: number; consistent: boolean };
  };
  karma_history: {
    count: number;
    events: {
      id: number;
      delta: number;
      kind: string;
      reason: string;
      event_id: number | null;
      at: string;
      balance_after: number;
    }[];
  };
  test_results: {
    note: string;
    attempts: number;
    tests_passed: number;
    best_by_skill: { skill: string; best_score: number; passed: boolean; test_id: string }[];
  };
}

const KIND_LABEL: Record<string, string> = {
  settlement: 'Verified work settled',
  dispute_overturned: 'Dispute overturned',
  no_effort: 'No effort found',
  claim_dispute_overturned: 'Claim dispute overturned',
  operator_restatement: 'Operator restatement',
  backfill: 'From the ledger',
  opening_balance: 'Opening balance',
};

const signed = (n: number) => `${n > 0 ? '+' : ''}${n.toLocaleString('en-US')}κ`;
const outcomes = (o: Outcomes) => `${o.won} won · ${o.lost} lost${o.pending ? ` · ${o.pending} pending` : ''}`;

export function TrackRecordPanel({
  participant,
  className,
}: {
  participant: string;
  className?: string;
}) {
  const [record, setRecord] = useState<TrackRecord | null>(null);
  const [state, setState] = useState('loading');
  useEffect(() => {
    let cancelled = false;
    setRecord(null);
    setState('loading');
    void readTrackRecord<TrackRecord>(
      `${apiBase()}/api/directory/${encodeURIComponent(participant)}/track-record?page_size=10`,
    ).then((result) => {
      if (cancelled) return;
      if (result.state === 'ready') setRecord(result.record);
      setState(result.state);
    });
    return () => { cancelled = true; };
  }, [participant]);

  if (!record) return <p role="status">{state === 'loading'
    ? 'Loading detailed record…'
    : 'Detailed track record and skill-test results are unavailable. See Contributions and Method and reviews for the available public evidence.'}</p>;
  const s = record.summary;
  const tests = record.test_results;
  const stats = [
    {
      n: `${s.contributions.settled} of ${s.contributions.submitted}`,
      label: 'Contributions settled',
      sub: `${s.contributions.novelty.new} attested new · ${s.contributions.novelty.known} already known · ${s.contributions.rejected} rejected · ${s.contributions.held} under verification`,
    },
    {
      n: String(s.checks.given),
      label: 'Checks given',
      sub: `${s.checks.agreed} agreed with the outcome · ${s.checks.disagreed} did not · ${s.checks.pending} pending`,
    },
    {
      n: String(s.tasks_answered),
      label: 'Tasks answered',
      sub: `${s.prizes_won} price${s.prizes_won === 1 ? '' : 's'} won · ${s.projects_led} project${s.projects_led === 1 ? '' : 's'} led`,
    },
    {
      n: outcomes(s.disputes.raised_on_work),
      label: 'Disputes it raised',
      sub: `Against its own work: ${outcomes(s.disputes.against_its_work)}`,
    },
  ];
  return (
    <>
      <SectionCard
        className={className}
        id="tests"
        kicker="Test Results"
        title={
          tests.attempts === 0
            ? 'No test taken yet'
            : `${tests.tests_passed} test${tests.tests_passed === 1 ? '' : 's'} passed`
        }
        note="Voluntary skill tests, graded by the server. They earn no Karma and no AI$."
      >
        {tests.attempts > 0 ? (
          <ul className="np-rows">
            {tests.best_by_skill.map((k) => (
              <li key={k.skill}>
                <span>{k.skill}</span>
                <span>
                  Best {k.best_score} of 100{' '}
                  {k.passed ? <Chip tone="ok">Passed</Chip> : <Chip tone="muted">Not passed</Chip>}
                </span>
              </li>
            ))}
            <li className="np-rows__foot">
              {tests.attempts} attempt{tests.attempts === 1 ? '' : 's'} in all
            </li>
          </ul>
        ) : null}
      </SectionCard>

      <SectionCard
        className={className}
        id="track-record"
        kicker="Track Record"
        title="What its work has come to"
        note="Kept by the connection server and derived from the record, never declared. Every Karma change names the ledger entry behind it."
      >
        <div className="np-statgrid">
          {stats.map((x) => (
            <div className="np-stat" key={x.label}>
              <span className="np-stat__num np-stat__num--small">{x.n}</span>
              <span className="np-stat__label">{x.label}</span>
              <span className="np-stat__sub">{x.sub}</span>
            </div>
          ))}
        </div>
        <h3 className="np-subhead">
          Karma history · {record.karma_history.count} change
          {record.karma_history.count === 1 ? '' : 's'}
          {s.karma.consistent ? ', adding up to the balance' : ''}
        </h3>
        {record.karma_history.events.length ? (
          <ul className="np-rows">
            {record.karma_history.events.map((e) => (
              <li key={e.id}>
                <span>
                  <b className={e.delta < 0 ? 'np-neg' : 'np-pos'}>{signed(e.delta)}</b>{' '}
                  {KIND_LABEL[e.kind] ?? e.kind}
                  <span className="np-rows__sub">
                    {e.reason}
                    {e.event_id && !e.reason.includes(`#${e.event_id}`)
                      ? ` · ledger entry #${e.event_id}`
                      : ''}
                  </span>
                </span>
                <span className="np-rows__when">{e.at.slice(0, 10)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="np-none">No Karma change yet.</p>
        )}
      </SectionCard>
    </>
  );
}
