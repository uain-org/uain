'use client';

import { useState } from 'react';
import { feedLine } from '@/components/network/divide';
import { useLivePage } from '@/components/network/live-rows';
import {
  PROPOSAL_STATUS,
  type ProposalStatus,
  type PublicProposal,
} from '@/lib/proposals';

const day = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : '';

/** The server only accepts https links; checked again before one is a link here. */
function Link({ href }: { href: string }) {
  if (!href.startsWith('https://')) return <span>{href}</span>;
  const shown = href.replace(/^https:\/\//, '').replace(/\/$/, '');
  return (
    <a
      className="net-inline"
      href={href}
      target="_blank"
      rel="nofollow noopener noreferrer ugc"
    >
      {shown.length > 70 ? `${shown.slice(0, 69)}…` : shown}
    </a>
  );
}

function ProposalRow({ p }: { p: PublicProposal }) {
  const state = PROPOSAL_STATUS[p.status] ?? PROPOSAL_STATUS.open;
  return (
    <div className="net-row" id={p.id}>
      <span className={`net-row__bar net-row__bar--${state.tone}`} />
      <div className="net-row__main">
        <h3>{p.title}</h3>
        <p style={{ whiteSpace: 'pre-line' }}>{p.goal}</p>
        <p>
          <strong>Who benefits:</strong> {p.benevolence_statement}
        </p>
        {p.links.length ? (
          <p>
            {p.links.map((l, i) => (
              <span key={l}>
                {i ? ' · ' : null}
                <Link href={l} />
              </span>
            ))}
          </p>
        ) : null}
        {p.status === 'adopted' && p.project_id ? (
          <p>
            Adopted into{' '}
            <a
              className="net-inline"
              href={`/network/live?project=${encodeURIComponent(p.project_id)}`}
            >
              {p.project_title ?? p.project_id}
            </a>{' '}
            on {day(p.adopted_at)}.
          </p>
        ) : null}
        {p.status === 'declined' ? (
          <p>
            Declined on {day(p.declined_at)}: {p.decline_reason}
          </p>
        ) : null}
        <p className="net-row__meta">
          {p.id} · proposed {day(p.submitted_at)}
          {p.submitted_by ? ` by ${p.submitted_by}` : ''}
        </p>
      </div>
      <span className="net-row__side">
        <span className={`net-state net-state--${state.tone}`}>
          {state.label}
        </span>
      </span>
    </div>
  );
}

const statuses: ProposalStatus[] = ['open', 'adopted', 'declined'];

export function ProposalList() {
  const [status, setStatus] = useState<'any' | ProposalStatus>('any');
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const pageSize = 20;
  const currentPage = Math.min(page, pageCount);

  const path =
    '/api/proposals?' +
    new URLSearchParams({
      ...(status === 'any' ? {} : { status }),
      page: String(currentPage),
      page_size: String(pageSize),
    }).toString();
  const { list, status: feed } = useLivePage<PublicProposal>(
    path,
    'proposals',
  );
  if (list && list.pages !== pageCount) setPageCount(list.pages);
  const notice = feedLine(feed, list !== null);
  const total = list?.count ?? 0;

  return (
    <>
      <div className="net-filters net-filters--projects">
        <label>
          <span>State</span>
          <select
            className="net-select"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as 'any' | ProposalStatus);
              setPage(1);
            }}
          >
            <option value="any">Any state</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {PROPOSAL_STATUS[s].label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="net-rows">
        {notice ? (
          <output className="net-table-status">{notice}</output>
        ) : (
          list === null && (
            <output className="net-table-status">Loading proposals…</output>
          )
        )}
        {(list?.rows ?? []).map((p) => (
          <ProposalRow key={p.id} p={p} />
        ))}
      </div>

      {list !== null && total === 0 && (
        <div className="net-empty" style={{ marginTop: '2rem' }}>
          <h3>
            {status === 'any'
              ? 'No goal has been proposed yet'
              : 'No proposals in that state'}
          </h3>
        </div>
      )}

      {list !== null && total > pageSize && (
        <div className="net-pagination" aria-label="Proposal pagination">
          <p>
            Page {currentPage} of {pageCount} · {total} proposal
            {total === 1 ? '' : 's'}
          </p>
          <div>
            <button
              type="button"
              className="net-page-button"
              disabled={currentPage === 1}
              onClick={() => setPage(Math.max(1, currentPage - 1))}
            >
              Previous
            </button>
            <button
              type="button"
              className="net-page-button"
              disabled={currentPage === pageCount}
              onClick={() => setPage(Math.min(pageCount, currentPage + 1))}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </>
  );
}
