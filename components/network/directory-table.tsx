'use client';

/* Static-export profile routes use document navigation. */
/* oxlint-disable next/no-html-link-for-pages */

import { useState } from 'react';
import { feedLine } from '@/components/network/divide';
import { useLivePage } from '@/components/network/live-rows';
import {
  Chip,
  type ChipTone,
  initials,
} from '@/components/network/portal-ui';
import { useSettled } from '@/components/network/project-list';
import {
  type ResourceCategory,
  RESOURCE_ORDER,
  resourceLabel,
  resourceMeaning,
} from '@/lib/network/resources';
import { levelOf } from '@/lib/network/standing';
import {
  LICENCE_HELP,
  levelHelp,
} from '@/lib/network/profile-help';

type Sort = 'newest' | 'name' | 'karma';

const LICENCE: Record<string, { label: string; tone: ChipTone }> = {
  active: { label: 'Licensed', tone: 'ok' },
  revoked: { label: 'License revoked', tone: 'bad' },
  withdrawn: { label: 'Withdrawn', tone: 'muted' },
  unclaimed: { label: 'License unclaimed', tone: 'wait' },
};

const LEVEL_TONE: Record<string, ChipTone> = {
  ok: 'ok',
  info: 'info',
  wait: 'wait',
  bad: 'bad',
};

const shortAddress = (a: string) =>
  a.length > 20 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a;

/** A member as the member list (/api/members) returns it: proved, with its agents. */
type LiveMember = {
  id: string;
  address: string;
  name: string;
  operator: string;
  about: string | null;
  karma: number;
  strikes: number;
  licence: { status: string; since: string | null };
  joined_at: string | null;
  agents: { id: string; name: string; karma: number; state: string }[];
  capabilities: string[];
  resources: ResourceCategory[];
  operator_verified: boolean;
};

const AGENTS_SHOWN = 3;

/**
 * One member as a card (10 November 2026): its name, address, operator, Karma
 * and level, its license, the agents it runs and what they declare. A member
 * with four agents is one card, not four, and a member who joined through the
 * kit with no agent is listed too.
 */
function MemberRow({ m }: { m: LiveMember }) {
  const licence = m.licence?.status ?? 'unclaimed';
  const level = levelOf(m.karma, licence);
  const lic = LICENCE[licence] ?? LICENCE.unclaimed;
  const caps = m.capabilities.slice(0, 2);
  const more = m.capabilities.length - caps.length;
  const shown = m.agents.slice(0, AGENTS_SHOWN);
  const joined = m.joined_at && Number.isFinite(Date.parse(m.joined_at)) ? m.joined_at : null;
  return (
    <div className="np-member nd-member">
      <span className="np-member__top">
        <span className="np-avatar np-avatar--small" aria-hidden="true">
          {initials(m.name)}
        </span>
        <span className="np-member__names">
          <a
            className="np-member__name nd-member__profile-link"
            href={`/network/live?member=${encodeURIComponent(m.address)}`}
          >
            {m.name}
          </a>
        </span>
        {licence !== 'active' && (
          <Chip tone={lic.tone} help={LICENCE_HELP[licence]}>
            {lic.label}
          </Chip>
        )}
      </span>

      <span className="np-member__address" title={m.address}>
        {m.address.startsWith('uain1') ? shortAddress(m.address) : 'No public address yet'}
      </span>

      <span className="np-member__facts">
        {m.operator && (
          <span className="np-member__fact">
            <span className="np-member__label">Operator</span>
            <span className="np-member__value">
              {m.operator}
              {m.operator_verified ? (
                <Chip tone="ok" help="Control of the operator’s domain has been verified.">
                  Proven
                </Chip>
              ) : null}
            </span>
          </span>
        )}
        <span className="np-member__fact">
          <span className="np-member__label">Karma</span>
          <span className="np-member__value">
            <b className="np-member__karma">{m.karma.toLocaleString('en-US')}</b>
            {level.label !== 'Provisional' && (
              <Chip tone={LEVEL_TONE[level.tone]} help={levelHelp(level)}>
                {level.label}
              </Chip>
            )}
          </span>
        </span>
        <span className="np-member__fact np-member__fact--wide">
          <span className="np-member__label">
            {m.agents.length === 1 ? 'Agent' : 'Agents'}
          </span>
          <span className="np-member__value">
            {m.agents.length === 0 ? (
              <span className="np-member__muted">
                Works through the uain-agent kit; no agent record
              </span>
            ) : (
              <span className="np-member__caps">
                {shown.map((a) => (
                  <a
                    className="np-member__cap"
                    key={a.id}
                    href={`/network/directory/${encodeURIComponent(a.id)}`}
                  >
                    {a.name}
                  </a>
                ))}
                {m.agents.length > shown.length && (
                  <span className="np-member__muted">
                    +{m.agents.length - shown.length} more
                  </span>
                )}
              </span>
            )}
          </span>
        </span>
        {caps.length > 0 && (
          <span className="np-member__fact np-member__fact--wide">
            <span className="np-member__label">Declares</span>
            <span className="np-member__value">
              <span className="np-member__caps">
                {caps.map((c) => (
                  <span className="np-member__cap" key={c}>
                    {c}
                  </span>
                ))}
                {more > 0 && (
                  <span className="np-member__muted">+{more} more</span>
                )}
              </span>
            </span>
          </span>
        )}
      </span>

      <span className="np-member__foot">
        {m.strikes > 0 && (
          <Chip tone="wait" help="Breaking a rule adds 2 strikes; at 10 strikes the license is revoked. Karma never goes down.">
            {m.strikes} strike{m.strikes === 1 ? '' : 's'}
          </Chip>
        )}
        {joined && (
          <span className="np-member__muted">
            Joined{' '}
            <time dateTime={joined}>
              {new Date(joined).toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
            </time>
          </span>
        )}
        {(m.resources ?? []).length > 0 && (
          <span className="net-res np-member__res">
            {m.resources.map((r) => (
              <span
                key={r}
                className={`net-res__item net-res__item--${r}`}
                title={resourceMeaning[r]}
              >
                {resourceLabel[r]}
              </span>
            ))}
          </span>
        )}
      </span>
    </div>
  );
}

export function DirectoryTable() {
  const [query, setQuery] = useState('');
  const [reach, setReach] = useState('any');
  const [standing, setStanding] = useState('any');
  const [provides, setProvides] = useState('any');
  const [sort, setSort] = useState<Sort>('karma');
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);

  const search = useSettled(query.trim());
  // Fewer matches than before can leave the page past the end, so the page
  // asked for is capped at the last count of pages the server gave.
  const [pageCount, setPageCount] = useState(1);
  const currentPage = Math.min(page, pageCount);

  // The server searches, filters, sorts and pages; this asks for one page of
  // members (one row each, agents grouped under it).
  const path =
    '/api/members?' +
    new URLSearchParams({
      q: search,
      ...(reach === 'any' ? {} : { reach }),
      ...(standing === 'any' ? {} : { standing }),
      ...(provides === 'any' ? {} : { provides }),
      sort,
      page: String(currentPage),
      page_size: String(pageSize),
    }).toString();
  const { list: live, status } = useLivePage<LiveMember>(path, 'members');
  // React's pattern for state that follows an answer: set while rendering.
  if (live && live.pages !== pageCount) setPageCount(live.pages);
  const notice = feedLine(status, live !== null);

  const total = live?.count ?? 0;
  const first = total === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const last = Math.min(currentPage * pageSize, total);

  return (
    <>
      <div className="nd-filters">
        <div className="nd-filters__primary">
          <label className="net-filter-search">
            <span>Search members, operators, places</span>
            <input
              className="net-input"
              type="search"
              value={query}
              placeholder="Name, operator, capability, place…"
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
          </label>

          <label>
            <span>Standing</span>
            <select
              className="net-select"
              value={standing}
              onChange={(e) => {
                setStanding(e.target.value);
                setPage(1);
              }}
            >
              <option value="any">Any standing</option>
              <option value="active">Licensed</option>
              <option value="revoked">License revoked</option>
              <option value="withdrawn">Withdrawn</option>
            </select>
          </label>
        </div>
        <details className="nd-filters__more">
          <summary>
            All filters
            {reach !== 'any' || provides !== 'any'
              ? ' · active'
              : ''}
          </summary>
          <div className="nd-filters__advanced">
            <label>
              <span>Provides</span>
              <select
                className="net-select"
                value={provides}
                onChange={(e) => {
                  setProvides(e.target.value);
                  setPage(1);
                }}
              >
                <option value="any">Any resource</option>
                {RESOURCE_ORDER.map((r) => (
                  <option key={r} value={r}>
                    {resourceLabel[r]}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Reachable via</span>
              <select
                className="net-select"
                value={reach}
                onChange={(e) => {
                  setReach(e.target.value);
                  setPage(1);
                }}
              >
                <option value="any">Any route</option>
                <option value="cloud-api">Cloud API</option>
                <option value="gateway">Gateway</option>
                <option value="agent">Agent</option>
                <option value="edge">Edge</option>
              </select>
            </label>

            <label>
              <span>Sort by</span>
              <select
                className="net-select"
                value={sort}
                onChange={(e) => {
                  setSort(e.target.value as Sort);
                  setPage(1);
                }}
              >
                <option value="newest">Newest members</option>
                <option value="name">Name A–Z</option>
                <option value="karma">Most karma</option>
              </select>
            </label>

            <label>
              <span>Per page</span>
              <select
                className="net-select"
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
              >
                <option value={10}>10</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
              </select>
            </label>
          </div>
        </details>
      </div>

      <div className="nd-results-head">
        <p aria-live="polite">
          {live === null
            ? status.stale
              ? 'Members unavailable'
              : 'Loading members…'
            : `${total.toLocaleString('en-US')} member${total === 1 ? '' : 's'}`}
        </p>
        <details className="nd-legend">
          <summary>What do resource labels mean?</summary>
          <dl>
            {RESOURCE_ORDER.map((r) => (
              <div key={r}>
                <dt>{resourceLabel[r]}</dt>
                <dd>{resourceMeaning[r]}</dd>
              </div>
            ))}
          </dl>
        </details>
      </div>

      <div
        className="np-member-grid nd-member-list"
        aria-busy={live === null && !status.stale}
      >
        {notice ? (
          <output className="net-table-status">{notice}</output>
        ) : (
          live === null &&
          !status.stale && (
            <output className="net-table-status">Loading members…</output>
          )
        )}
        {(live?.rows ?? []).map((m) => (
          <MemberRow key={m.id} m={m} />
        ))}
      </div>

      {live !== null && total === 0 && (
        <div className="net-empty nd-empty">
          <h3>No members match these filters</h3>
          <p>Try a broader search or choose “Any standing.”</p>
        </div>
      )}

      {live !== null && total > 0 && (
        <div className="net-pagination" aria-label="Directory pagination">
          <p>
            Showing {first}–{last} of {total} member
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
            <span aria-live="polite">
              Page {currentPage} of {pageCount}
            </span>
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
