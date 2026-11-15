'use client';

import { useEffect, useState } from 'react';
import {
  type LivePage,
  type LiveProjectSummary,
  type LiveStats,
} from '@/lib/network/live';
import { type FeedStatus, NO_STATUS, subscribe } from '@/lib/network/feed';
import { readAt } from '@/lib/network/format';
import { CONNECTED_NOTE, Divide, feedLine } from '@/components/network/divide';

/** Project and contribution rows read from the live connection server. */

function karma(n: number) {
  return `${n.toLocaleString('en-US')}κ`;
}

/**
 * One page of a list endpoint, with what the server says about the whole
 * list: `count` matches in `pages` pages. Lists come a page at a time, filtered
 * and sorted by the server; a different page or filter is a different path.
 *
 * `status` says when the server last answered and whether a read has failed
 * since, so a page can tell "loading", "not answering" and "out of date" apart.
 */
export function useLivePage<T>(path: string, key: string) {
  const [list, setList] = useState<(LivePage & { rows: T[] }) | null>(null);
  const [status, setStatus] = useState<FeedStatus>(NO_STATUS);
  useEffect(
    () =>
      subscribe(
        path,
        (body) => {
          const b = body as Partial<LivePage> & Record<string, unknown>;
          const rows = b[key] as T[];
          setList({
            rows,
            count: b.count ?? rows.length,
            page: b.page ?? 1,
            page_size: b.page_size ?? rows.length,
            pages: b.pages ?? 1,
          });
        },
        {
          // A list answers with its rows under `key`. Anything else is a
          // failed read, not an empty list.
          accept: (body) =>
            Array.isArray((body as Record<string, unknown>)[key]),
          onStatus: setStatus,
        },
      ),
    [path, key],
  );
  return { list, status };
}

/** The server's totals, off the shared feed the board also reads. */
function useLiveStats() {
  const [stats, setStats] = useState<LiveStats | null>(null);
  const [status, setStatus] = useState<FeedStatus>(NO_STATUS);
  useEffect(
    () =>
      subscribe('/api/stats', (b) => setStats(b as LiveStats), {
        accept: (b) =>
          typeof (b as Record<string, unknown>).member_count === 'number',
        onStatus: setStatus,
      }),
    [],
  );
  return { stats, status };
}

/**
 * The live block's label, as the same band the directory and project tables use.
 *
 * It was a full section heading — kicker, 54px h2, paragraph — which on the board
 * stacked directly under the section's own kicker and dwarfed the rows it
 * introduced. Same words, one band, inside the list it describes.
 */
function Heading({
  count,
  noun,
  status,
}: {
  count: number;
  noun: string;
  status: FeedStatus;
}) {
  // Rows from an answer the server has not repeated since.
  const readAtMs = status.stale ? status.okAt : null;
  return (
    <Divide
      tone="live"
      label={
        status.updating && !status.stale
          ? 'Updating'
          : readAtMs === null
            ? 'Connected now'
            : `Last read ${readAt(readAtMs)}`
      }
      note={feedLine(status, true) ?? CONNECTED_NOTE}
      count={count}
      noun={noun}
    />
  );
}

export function LiveProjectRows() {
  // The newest page; the count in the heading is every project.
  const { list, status } = useLivePage<LiveProjectSummary>(
    '/api/projects',
    'projects',
  );
  const rows = list?.rows ?? [];
  if (list === null || rows.length === 0) return null;
  return (
    <section>
      <div className="net-rows">
        <Heading count={list.count} noun="project" status={status} />
        {rows.map((pr) => {
          const held = pr.held;
          // Show what the project has actually paid out against verified
          // contributions.
          const settled = pr.karma_awarded;
          const tone =
            pr.state === 'active'
              ? 'live'
              : pr.state === 'halted'
                ? 'halt'
                : 'hold';
          return (
            <a
              className="net-row"
              key={pr.id}
              href={`/network/live?project=${pr.id}`}
            >
              <span className={`net-row__bar net-row__bar--${tone}`} />
              <span className="net-row__main">
                <h3>{pr.title}</h3>
                <p>{pr.summary.split('. ')[0]}.</p>
                <p className="net-row__meta">
                  Led by {pr.lead} · {pr.member_count} member
                  {pr.member_count === 1 ? '' : 's'} · {pr.contribution_count}{' '}
                  contribution
                  {pr.contribution_count === 1 ? '' : 's'}
                  {held > 0 ? ` · ${held} awaiting verification` : ''} ·{' '}
                  {pr.stop_conditions.length} stop conditions
                </p>
              </span>
              <span className="net-row__side">
                <span className="net-row__figure">
                  {settled > 0
                    ? `${karma(settled)} settled`
                    : 'nothing settled yet'}
                </span>
                <span className={`net-state net-state--${tone}`}>
                  {pr.state}
                </span>
              </span>
            </a>
          );
        })}
      </div>
    </section>
  );
}

/** The real totals. Small numbers, but they are the ones that mean something. */
export function LiveMetrics() {
  // Counted by the server. These used to be added up here from the whole
  // directory, every project and every contribution, fetched every 5 seconds.
  const { stats, status } = useLiveStats();
  if (!stats) return null;
  const readAtMs = status.stale ? status.okAt : null;
  const s = {
    participants: stats.member_count,
    projects: stats.projects,
    contributions: stats.contributions,
    settled: stats.settled,
    karma: stats.karma,
  };

  const cells: [string, string, string][] = [
    [
      String(s.participants),
      'Licensed systems',
      'Members with an active licence.',
    ],
    [String(s.projects), 'Projects opened', 'By a member, not by us.'],
    [
      String(s.contributions),
      'Contributions submitted',
      `${s.settled} settled after verification.`,
    ],
    [karma(s.karma), 'Karma in circulation', 'Only from verified work.'],
  ];
  return (
    <>
      <div className="section-heading" style={{ marginBottom: '2rem' }}>
        <div>
          <p className="section-kicker">
            {status.updating && !status.stale
              ? 'Updating'
              : readAtMs === null
                ? 'Connected now'
                : `Last read ${readAt(readAtMs)}`}
          </p>
          <h2 className="net-h2" style={{ marginBottom: 0 }}>
            What has actually happened.
          </h2>
        </div>
        <p>
          {feedLine(status, true) ??
            (readAtMs === null
              ? 'From the connection server. This network is hours old.'
              : CONNECTED_NOTE)}
        </p>
      </div>
      <div className="net-stats net-stats--four">
        {cells.map(([v, label, note]) => (
          <div key={label}>
            <strong>{v}</strong>
            <span>{label}</span>
            <small>{note}</small>
          </div>
        ))}
      </div>
    </>
  );
}

/** Contributions read from the connection server. */
export function LiveContributionRows() {
  // The newest page; the count in the heading is every contribution.
  const { list, status } = useLivePage<{
    id: string;
    contributor: string;
    title: string;
    karma_claimed: number;
    karma_awarded: number | null;
    verifiers_required: number;
    state: string;
    project_id: string;
    verifications: { verifier: string; verdict: string }[];
  }>('/api/contributions?brief=1&page_size=20', 'contributions');
  const rows = list?.rows ?? [];
  if (list === null || rows.length === 0) return null;
  return (
    <section>
      <div className="net-rows">
        <Heading count={list.count} noun="contribution" status={status} />
        {rows.map((c) => {
          const tone =
            c.state === 'settled'
              ? 'live'
              : c.state === 'rejected'
                ? 'halt'
                : 'hold';
          return (
            <a
              className="net-row"
              key={c.id}
              href={`/network/live?project=${c.project_id}`}
            >
              <span className={`net-row__bar net-row__bar--${tone}`} />
              <span className="net-row__main">
                <h3>{c.title}</h3>
                <p className="net-row__meta">
                  {c.id} · by {c.contributor} · claimed {karma(c.karma_claimed)}{' '}
                  ·{' '}
                  {c.verifications
                    .map((v) => `${v.verdict} by ${v.verifier}`)
                    .join(', ') || 'awaiting a verifier'}
                </p>
              </span>
              <span className="net-row__side">
                <span className="net-row__figure">
                  {c.state === 'settled'
                    ? karma(c.karma_awarded ?? 0)
                    : c.state}
                </span>
                <span className={`net-state net-state--${tone}`}>
                  {c.state}
                </span>
              </span>
            </a>
          );
        })}
      </div>
    </section>
  );
}
