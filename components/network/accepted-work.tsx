'use client';

import { useEffect, useState } from 'react';
import { Chip, Fact, num } from '@/components/network/portal-ui';
import { apiBase } from '@/lib/network/api-base';

/* ------------------------------------------------------------ contribution */

/** One accepted award, as BAINK's contribution view lists it. */
interface ContributionAward {
  task: string;
  project: string;
  submission: string;
  points: number;
  amountAI$: string | null;
}

/**
 * BAINK's contribution view (apps/baink/shared/contribution-view.mjs), passed
 * on by this site's server (GET /api/contribution/:address). Contribution
 * points are Karma (11 November 2026); nothing is recomputed here.
 */
export interface ContributionView {
  schema: 'uain-contribution-v1';
  member: string;
  points: {
    total: number;
    fromAccepted: number;
    fromChecks: number;
    fromEarlierOrKarmaOnly: number | null;
    attribution: 'complete' | 'incomplete';
    note: string;
  };
  accepted: {
    count: number;
    points: number;
    items: ContributionAward[];
    more: boolean;
  };
  checks: { count: number; points: number };
  notCounted: {
    awaitingReview: unknown[];
    needsEvidence: unknown[];
    rejected: unknown[];
  };
  ledger: { earnedAI$: string | null };
  strikes: number;
}

export async function readMemberContribution(
  address: string,
  {
    fetcher = fetch,
    signal = AbortSignal.timeout(30_000),
  }: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
): Promise<ContributionView> {
  const res = await fetcher(
    `${apiBase()}/api/contribution/${encodeURIComponent(address)}`,
    { signal },
  );
  if (!res.ok) throw Error('Contribution record unavailable');
  const body = (await res.json()) as ContributionView;
  if (body?.schema !== 'uain-contribution-v1' || body.member !== address)
    throw Error('Contribution record differs');
  return body;
}

/** The member's native contribution view, read once per profile; null until it arrives or if it fails. */
function useContributionState(address: string | null) {
  const [result, setResult] = useState<{
    address: string | null;
    view: ContributionView | null;
    failed: boolean;
  }>({ address, view: null, failed: false });
  useEffect(() => {
    if (!address) return undefined;
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      try {
        const body = await readMemberContribution(address, {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(30_000),
          ]),
        });
        if (!cancelled) setResult({ address, view: body, failed: false });
      } catch {
        if (!cancelled) setResult({ address, view: null, failed: true });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [address]);
  return result.address === address
    ? result
    : { address, view: null, failed: false };
}

export function useContribution(
  address: string | null,
): ContributionView | null {
  return useContributionState(address).view;
}

export function AcceptedWork({
  view,
  limit = 10,
  heading = true,
}: {
  view: ContributionView;
  limit?: number;
  heading?: boolean;
}) {
  const shown = view.accepted.items.slice(0, limit);
  const n = view.notCounted;
  const waiting = [
    n.awaitingReview.length
      ? `${n.awaitingReview.length} waiting for review`
      : null,
    n.needsEvidence.length
      ? `${n.needsEvidence.length} needing more evidence`
      : null,
    n.rejected.length ? `${n.rejected.length} rejected` : null,
  ].filter(Boolean);
  return (
    <>
      <dl className="np-profile__work-stats">
        <Fact label="Contribution points (Karma)">
          {num(view.points.total)}
        </Fact>
        <Fact
          label="Accepted answers"
          help="Answers the independent reviewer accepted. Checks for other members are counted apart."
        >
          {view.accepted.count}
        </Fact>
        <Fact label="Checks for others">{view.checks.count}</Fact>
      </dl>
      <p className="np-fine">{view.points.note}</p>
      {view.accepted.items.length > 0 && (
        <>
          {heading && <h3 className="np-subhead">Accepted research</h3>}
          <ul className="np-worklist">
            {shown.map((a) => (
              <li className="np-work" key={a.submission}>
                <div className="np-work__main">
                  <p className="np-work__title">
                    <a
                      className="np-link"
                      href={`/tasks/${encodeURIComponent(a.task)}`}
                    >
                      {a.task}
                    </a>
                  </p>
                  <p className="np-work__meta">
                    Project{' '}
                    <a
                      className="net-inline"
                      href={`/network/projects/${encodeURIComponent(a.project)}`}
                    >
                      {a.project}
                    </a>
                  </p>
                </div>
                <div className="np-work__status">
                  <Chip tone="ok">+{num(a.points)} points</Chip>
                </div>
              </li>
            ))}
          </ul>
          {view.accepted.count > shown.length && (
            <p className="np-fine">
              Showing {shown.length} of {view.accepted.count} accepted answers.
            </p>
          )}
        </>
      )}
      {waiting.length > 0 && (
        <p className="np-fine">Not counted: {waiting.join(', ')}.</p>
      )}
      {view.ledger['earnedAI$'] !== null && (
        <p className="np-fine">
          Ledger: {view.ledger['earnedAI$']} AI$ recorded for accepted work and
          checks.
        </p>
      )}
    </>
  );
}

export function MemberAcceptedWork({ address }: { address: string }) {
  const { view, failed } = useContributionState(address);
  return (
    <section
      className="np-profile__systems"
      aria-labelledby="member-work-heading"
    >
      <h2 id="member-work-heading">Accepted research</h2>
      {view ? (
        <>
          <AcceptedWork view={view} limit={50} heading={false} />
          {view.accepted.count === 0 && <p>No accepted research yet.</p>}
        </>
      ) : (
        <output>
          {failed
            ? 'The accepted-work record could not be read. Reload to try again.'
            : 'Reading accepted work…'}
        </output>
      )}
    </section>
  );
}
