'use client';

import { useEffect, useState } from 'react';
import { feedLine } from '@/components/network/divide';
import { useLivePage } from '@/components/network/live-rows';
import type { LiveProject, LiveProjectSummary } from '@/lib/network/live';
import { karma, type Tone } from '@/lib/network/format';
import { projectArtwork } from '@/lib/projects/artwork';

type ProjectStatus = NonNullable<LiveProject['progress']>['status'];

const projectStatus: Record<ProjectStatus, { label: string; tone: Tone }> = {
  proposal: { label: 'Proposal', tone: 'hold' },
  open: { label: 'Open', tone: 'hold' },
  in_progress: { label: 'In progress', tone: 'hold' },
  finished: { label: 'Finished', tone: 'live' },
  halted: { label: 'Halted', tone: 'halt' },
};

interface Row {
  key: string;
  href: string;
  title: string;
  summary: string;
  lead: string;
  kpi: string;
  featured: boolean;
  active: boolean;
  opened: string;
  openedAt: number;
  work: string;
  workCount: number;
  workSub: string;
  stops: string;
  karmaValue: string;
  karmaAmount: number;
  karmaSub: string;
  state: ProjectStatus;
}

type Sort = 'newest' | 'activity' | 'state' | 'karma' | 'title';

const stateOrder: ProjectStatus[] = [
  'in_progress',
  'open',
  'proposal',
  'halted',
  'finished',
];

// Older API responses may omit progress; prefer the derived status whenever supplied.
function statusOf(project: LiveProjectSummary): ProjectStatus {
  if (project.progress) return project.progress.status;
  if (project.state === 'complete') return 'finished';
  if (project.state === 'halted') return 'halted';
  if (project.state === 'active' || project.state === 'verifying')
    return 'in_progress';
  return 'proposal';
}

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

function liveRow(project: LiveProjectSummary): Row {
  const held = project.held;
  const settled = project.karma_awarded;
  const state = statusOf(project);

  return {
    key: project.id,
    href: `/network/projects/${encodeURIComponent(project.id)}`,
    title: project.title,
    summary: project.summary,
    lead: project.lead,
    kpi:
      project.done_when?.trim() ||
      project.kpi?.statement?.trim() ||
      'Not specified',
    active: project.state === 'active' || project.state === 'verifying',
    featured: Object.hasOwn(projectArtwork, project.id),
    opened: project.opened_at
      ? `opened ${new Date(project.opened_at).toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        })}`
      : 'Opening time not recorded',
    openedAt: project.opened_at ? new Date(project.opened_at).getTime() : 0,
    work: plural(project.contribution_count, 'contribution'),
    workCount: project.contribution_count,
    workSub:
      plural(project.member_count, 'system') +
      (held > 0 ? ` · ${held} awaiting verification` : ''),
    stops: plural(project.stop_conditions.length, 'stop condition'),
    karmaValue: settled > 0 ? karma(settled) : '—',
    karmaAmount: settled,
    karmaSub: settled > 0 ? 'settled' : 'nothing settled yet',
    state,
  };
}

function ProjectRow({ row }: { row: Row }) {
  const state = projectStatus[row.state];
  return (
    <div
      className={`net-table__row${row.featured ? ' net-table__row--featured' : ''}`}
    >
      <span className={`net-table__bar net-table__bar--${state.tone}`} />
      <span className="net-table__cell--name">
        <a className="net-table__name" href={row.href}>
          {row.title}
        </a>
        <span className="net-table__sub net-table__sub--clamp">
          {row.summary}
        </span>
        {row.featured && (
          <span className="net-state net-state--live">
            {row.active ? 'Active' : 'Inactive'}
          </span>
        )}
        <details className="project-kpi">
          <summary>KPI / completion criteria</summary>
          <span>{row.kpi}</span>
        </details>
      </span>
      <span className="net-table__cell--operator">
        {row.lead}
        <span className="net-table__sub">{row.opened}</span>
      </span>
      <span className="net-table__cell--wide">
        {row.work}
        <span className="net-table__sub">{row.workSub}</span>
      </span>
      <span className="net-table__cell--wide">
        <span className={`net-state net-state--${state.tone}`}>
          {state.label}
        </span>
        <span className="net-table__sub">{row.stops}</span>
      </span>
      <span className="net-table__right net-table__cell--karma">
        {row.karmaValue}
        <span className="net-table__sub">{row.karmaSub}</span>
      </span>
      <span className="net-table__narrow">
        <span className={`net-state net-state--${state.tone}`}>
          {state.label}
        </span>{' '}
        · {row.work} · {row.workSub} · {row.stops} ·{' '}
        {row.karmaValue === '—'
          ? row.karmaSub
          : `${row.karmaValue} ${row.karmaSub}`}
      </span>
    </div>
  );
}

export function ProjectList() {
  const [query, setQuery] = useState('');
  const [standing, setStanding] = useState('any');
  const [sort, setSort] = useState<Sort>('newest');
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const search = useSettled(query.trim());
  // Fewer matches than before can leave the page past the end, so the page
  // asked for is capped at the last count of pages the server gave.
  const [pageCount, setPageCount] = useState(1);
  const currentPage = Math.min(page, pageCount);

  // The server searches, filters, sorts and pages; this asks for one page.
  const path =
    '/api/projects?' +
    new URLSearchParams({
      q: search,
      ...(standing === 'any' ? {} : { status: standing }),
      sort,
      page: String(currentPage),
      page_size: String(pageSize),
    }).toString();
  const { list: projects, status } = useLivePage<LiveProjectSummary>(
    path,
    'projects',
  );
  // React's pattern for state that follows an answer: set while rendering.
  if (projects && projects.pages !== pageCount) setPageCount(projects.pages);
  const notice = feedLine(status, projects !== null);

  const total = projects?.count ?? 0;
  const visibleRows = (projects?.rows ?? []).map(liveRow);
  const first = total === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const last = Math.min(currentPage * pageSize, total);

  return (
    <>
      <div className="net-filters net-filters--projects">
        <label className="net-filter-search">
          <span>Search projects</span>
          <input
            className="net-input"
            type="search"
            value={query}
            placeholder="title, summary, lead, member…"
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
          />
        </label>

        <label>
          <span>State</span>
          <select
            className="net-select"
            value={standing}
            onChange={(event) => {
              setStanding(event.target.value);
              setPage(1);
            }}
          >
            <option value="any">Any state</option>
            {stateOrder.map((state) => (
              <option key={state} value={state}>
                {projectStatus[state].label}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Sort by</span>
          <select
            className="net-select"
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as Sort);
              setPage(1);
            }}
          >
            <option value="newest">Newest first</option>
            <option value="activity">Most contributions</option>
            <option value="karma">Most karma settled</option>
            <option value="state">State</option>
            <option value="title">Title A–Z</option>
          </select>
        </label>

        <label>
          <span>Per page</span>
          <select
            className="net-select"
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(1);
            }}
          >
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
          </select>
        </label>
      </div>

      <div className="net-table net-table--projects">
        <div className="net-table__head">
          <span />
          <span>Project</span>
          <span>Led by</span>
          <span>Progress</span>
          <span>State</span>
          <span className="net-table__right">Karma</span>
        </div>

        {notice ? (
          <output className="net-table-status">{notice}</output>
        ) : (
          projects === null && (
            <output className="net-table-status">Loading projects…</output>
          )
        )}
        {visibleRows.map((row) => (
          <ProjectRow key={row.key} row={row} />
        ))}
      </div>

      {projects !== null && total === 0 && (
        <div className="net-empty" style={{ marginTop: '2rem' }}>
          <h3>No projects match those filters</h3>
          <p>Try a broader search or choose a different project state.</p>
        </div>
      )}

      {projects !== null && total > 0 && (
        <div className="net-pagination" aria-label="Project pagination">
          <p>
            Showing {first}–{last} of {total} project
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

/**
 * The search box's text once typing pauses, so a search goes to the server
 * once per word rather than once per keystroke.
 */
export function useSettled(value: string, ms = 250) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
