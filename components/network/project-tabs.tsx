'use client';

import {
  Fragment,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Stepper } from '@/components/network/portal-ui';
import type {
  LiveClaim,
  LiveClaimRevision,
  LiveContribution,
  LiveProject,
  LiveTask,
} from '@/lib/network/live';
import {
  contributionProgress,
  needsOf,
  type Progress,
  proofOf,
  STEPS,
  taskProgress,
} from '@/lib/network/status';

/**
 * A project as three tables: its tasks, what it currently believes, and the
 * contributions behind both. Each is searchable, filterable and sortable, and
 * a row opens to everything about it, so nothing is listed twice on the page.
 * Links between them (a task's claim, a claim's sources) switch tab and open
 * the row they point at.
 */

type Tone = 'believed' | 'working' | 'attention' | '';
type TabKey = 'tasks' | 'state' | 'contributions';
type Focus = (tab: TabKey, key: string) => void;

const at = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const month = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ][d.getUTCMonth()];
  return `${d.getUTCDate()} ${month} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};
const time = (iso?: string | null) => (iso ? Date.parse(iso) : 0);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/* ------------------------------------------------------------ the table */

interface Column<T> {
  key: string;
  label: string;
  cell: (row: T) => ReactNode;
  sort?: (row: T) => string | number;
  className?: string;
  /** On a phone: beside the row's name, on a line of its own, or hidden. */
  mobile?: 'aside' | 'full' | 'hide';
  /** Printed before the value on a phone, where there is no header. */
  mobileLabel?: string;
}

interface TableProps<T> {
  id: string;
  rows: T[];
  rowKey: (row: T) => string;
  name: (row: T) => string;
  /** A short line under the name: what a task needs, say. */
  nameExtra?: (row: T) => ReactNode;
  nameLabel: string;
  columns: Column<T>[];
  search: (row: T) => string;
  placeholder: string;
  filter?: {
    options: { value: string; label: string }[];
    test: (row: T, value: string) => boolean;
  };
  tone: (row: T) => Tone;
  detail: (row: T) => ReactNode;
  open: string | null;
  setOpen: (key: string | null) => void;
  defaultSort?: string;
  defaultDir?: 1 | -1;
}

function DataTable<T>(p: TableProps<T>) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({
    key: p.defaultSort ?? 'name',
    dir: p.defaultDir ?? 1,
  });

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const by =
      sort.key === 'name'
        ? (r: T) => p.name(r).toLowerCase()
        : (p.columns.find((c) => c.key === sort.key)?.sort ?? (() => 0));
    return p.rows
      .filter((r) => filter === 'all' || !p.filter || p.filter.test(r, filter))
      .filter((r) => {
        const hay = p.search(r).toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .sort((a, b) => {
        const x = by(a);
        const y = by(b);
        return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
      });
  }, [p, query, filter, sort]);

  const sortBy = (key: string) =>
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 },
    );
  const aria = (key: string) =>
    sort.key === key
      ? sort.dir === 1
        ? ('ascending' as const)
        : ('descending' as const)
      : ('none' as const);
  const arrow = (key: string) =>
    sort.key === key ? (sort.dir === 1 ? '▲' : '▼') : '';
  const span = p.columns.filter((c) => c.mobile !== 'hide').length + 1;

  return (
    <>
      <div className="net-filters net-results__filters">
        <label className="net-filter-search">
          <span>Search</span>
          <input
            className="net-input"
            type="search"
            value={query}
            placeholder={p.placeholder}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {p.filter && (
          <label>
            <span>Show</span>
            <select
              className="net-select"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              {p.filter.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="net-results__scroll">
        <table className="net-rt">
          <thead>
            <tr>
              <th scope="col" aria-sort={aria('name')}>
                <button type="button" onClick={() => sortBy('name')}>
                  {p.nameLabel}
                  <span className="net-rt__arrow" aria-hidden="true">
                    {arrow('name')}
                  </span>
                </button>
              </th>
              {p.columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={c.className}
                  aria-sort={c.sort ? aria(c.key) : undefined}
                >
                  {c.sort ? (
                    <button type="button" onClick={() => sortBy(c.key)}>
                      {c.label}
                      <span className="net-rt__arrow" aria-hidden="true">
                        {arrow(c.key)}
                      </span>
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const key = p.rowKey(r);
              const isOpen = p.open === key;
              const tone = p.tone(r);
              return (
                <Fragment key={key}>
                  <tr
                    id={`${p.id}-${key}`}
                    className={`net-rt__row${tone ? ` net-rt__row--${tone}` : ''}${isOpen ? ' is-open' : ''}`}
                  >
                    <th scope="row" className="net-rt__name">
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        aria-controls={`${p.id}-detail-${key}`}
                        onClick={() => p.setOpen(isOpen ? null : key)}
                      >
                        {p.name(r)}
                      </button>
                      {p.nameExtra?.(r)}
                    </th>
                    {p.columns.map((c) => (
                      <td
                        key={c.key}
                        className={c.className}
                        data-mobile={c.mobile ?? 'full'}
                        data-label={c.mobileLabel}
                      >
                        {c.cell(r)}
                      </td>
                    ))}
                  </tr>
                  {isOpen && (
                    <tr className="net-rt__detail" id={`${p.id}-detail-${key}`}>
                      <td
                        colSpan={span}
                        aria-label={`Details for ${p.name(r)}`}
                      >
                        {p.detail(r)}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {shown.length === 0 && (
        <div className="net-empty">
          <h3>Nothing matches</h3>
          <p>Clear the search, or choose All in Show.</p>
        </div>
      )}
    </>
  );
}

/** A link to a row in another tab: switches tab and opens that row. */
function Jump({ to, id, focus }: { to: TabKey; id: string; focus: Focus }) {
  return (
    <a
      className="net-inline"
      href={`#${id}`}
      onClick={(e: MouseEvent) => {
        e.preventDefault();
        focus(to, id);
      }}
    >
      {id}
    </a>
  );
}

const list = (ids: string[], to: TabKey, focus: Focus) =>
  ids.map((id, i) => (
    <Fragment key={id}>
      {i > 0 && ', '}
      <Jump to={to} id={id} focus={focus} />
    </Fragment>
  ));

/** Agent names, kept whole: a line breaks between names, never inside one. */
function Names({ of, flag }: { of: string[]; flag?: (i: number) => string }) {
  if (of.length === 0) return <>—</>;
  return (
    <span className="net-rt__names">
      {of.map((n, i) => (
        <span key={n} className={flag?.(i) ? 'net-rt__flag' : undefined}>
          {n}
          {flag?.(i) ? ` (${flag(i)})` : ''}
          {i < of.length - 1 ? ', ' : ''}
        </span>
      ))}
    </span>
  );
}

/* --------------------------------------------------------------- tasks */

interface TaskRow {
  task: LiveTask;
  answer: LiveContribution | null;
  /** Every answer and comparison, for the record of how it was checked. */
  work: LiveContribution[];
  claim: LiveClaim | null;
  answerText: string;
  by: string[];
  /** Open → Answered → Checking → Verified → Settled (lib/network/status.ts). */
  status: Progress;
  tone: Tone;
  updated: number;
}

/** A row's tone, from its stepper: settled, held up, or on its way. */
function toneOf(p: Progress): Tone {
  if (p.side && (p.side.tone === 'bad' || p.side.tone === 'wait'))
    return 'attention';
  if (p.at >= STEPS.length) return 'believed';
  return 'working';
}

/** The step a row is at, Settled once every step is done. */
const atStep = (p: Progress) => Math.min(p.at, STEPS.length - 1);

/** The tone's name, for the filter and the summary. */
const TONE_WORD: Record<Tone, string> = {
  believed: 'Settled',
  working: 'On its way',
  // Contested, disputed or rejected: waiting on an arbiter or a new answer.
  attention: 'Held up',
  '': '',
};

function taskRow(
  task: LiveTask,
  contributions: Map<string, LiveContribution>,
  claims: LiveClaim[],
): TaskRow {
  const ids = [...task.results, ...task.comparisons].map((c) => c.id);
  const candidates = task.results
    .map((r) => contributions.get(r.id))
    .filter((c): c is LiveContribution => Boolean(c));
  // The answer shown is the one that settled, else the newest still standing.
  const answer =
    candidates.find((c) => c.state === 'settled') ??
    candidates.filter((c) => c.state !== 'rejected').at(-1) ??
    candidates.at(-1) ??
    null;
  const citing = claims.filter((c) =>
    c.history.some((r) => r.sources.some((s) => ids.includes(s.id))),
  );
  const claim =
    citing.find((c) => c.status === 'believed') ?? citing.at(-1) ?? null;
  const status = taskProgress(task, contributions);

  // "Mexico: Línea de la Vida…" reads as "Línea de la Vida…" beside "Mexico".
  const escaped = task.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const answerText = answer
    ? answer.title
        .replace(/^T-\d+:\s*/i, '')
        .replace(new RegExp(`^${escaped}\\s*[:—-]\\s*`, 'i'), '')
    : '';

  return {
    task,
    answer,
    work: ids
      .map((id) => contributions.get(id))
      .filter((c): c is LiveContribution => Boolean(c)),
    claim,
    answerText,
    by: [...new Set(task.results.map((r) => r.contributor))],
    status,
    tone: toneOf(status),
    updated: Math.max(
      time(task.created_at),
      ...candidates.map((c) =>
        Math.max(time(c.submitted_at), time(c.settled_at)),
      ),
      ...(claim?.history ?? []).map((h) =>
        Math.max(time(h.at), time(h.decided_at)),
      ),
    ),
  };
}

/** What a task needs, compactly, under its name. Optional: most have none. */
function Needs({ task }: { task: LiveTask }) {
  const needs = needsOf(task.requirements);
  if (!needs.length) return null;
  const shown = needs.slice(0, 2);
  return (
    <span className="np-needs" title={`Needs: ${needs.join('; ')}`}>
      <span className="np-needs__label">Needs</span>
      {shown.map((n) => (
        <span className="np-needs__item" key={n}>
          {clip(n, 30)}
        </span>
      ))}
      {needs.length > shown.length && (
        <span className="np-needs__more">+{needs.length - shown.length}</span>
      )}
    </span>
  );
}

/* ---------------------------------------------------------------- claims */

const CLAIM_TONE: Record<string, Tone> = {
  believed: 'believed',
  unconfirmed: 'working',
  rejected: 'attention',
  retracted: '',
};
const REVISION_WORD: Record<string, string> = {
  create: 'Proposed',
  edit: 'Edit proposed',
  retract: 'Retraction proposed',
};

/* A claim's history as one row per event: each revision, then the reviews of
   it, newest first. */
function History({
  history,
  focus,
}: {
  history: LiveClaimRevision[];
  focus: Focus;
}) {
  const rows = history
    .flatMap((r) => [
      {
        key: `r${r.revision}`,
        at: r.at,
        what: (
          <>
            <b>{REVISION_WORD[r.action] ?? r.action}</b>
            <span className="net-hist__sub">
              revision {r.revision}, {r.state}
              {r.state === 'draft' &&
                `, needs ${r.confirmations_needed} more confirmation${r.confirmations_needed === 1 ? '' : 's'}`}
              {r.state === 'contested' && ', waiting for an arbiter'}
            </span>
          </>
        ),
        by: r.author,
        note: (
          <>
            {clip(r.reason, 400)}
            {r.sources.length > 0 && (
              <span className="net-hist__sub">
                Cites{' '}
                {list(
                  r.sources.map((s) => s.id),
                  'contributions',
                  focus,
                )}
              </span>
            )}
          </>
        ),
      },
      ...r.reviews.map((v) => ({
        key: `r${r.revision}-${v.reviewer}`,
        at: v.at,
        what: (
          <>
            <b className={v.verdict === 'confirm' ? '' : 'net-hist__dispute'}>
              {v.verdict === 'confirm' ? 'Confirmed' : 'Disputed'}
            </b>
            <span className="net-hist__sub">revision {r.revision}</span>
          </>
        ),
        by: v.reviewer,
        note: clip(v.note, 400),
      })),
    ])
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return <Events rows={rows} />;
}

interface Event {
  key: string;
  at: string;
  what: ReactNode;
  by: string;
  note: ReactNode;
}

/* A short record of who did what and when, in an open row. */
function Events({ rows }: { rows: Event[] }) {
  return (
    <table className="net-hist">
      <thead>
        <tr>
          <th scope="col">When (UTC)</th>
          <th scope="col">What</th>
          <th scope="col">By</th>
          <th scope="col">Note</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((e) => (
          <tr key={e.key}>
            <td className="net-hist__when">{at(e.at)}</td>
            <td className="net-hist__what">{e.what}</td>
            <td className="net-hist__by">{e.by}</td>
            <td className="net-hist__note">{e.note}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ----------------------------------------------------------- the tabs */

export function ProjectTabs({
  project,
  tasks,
  claims,
}: {
  project: LiveProject;
  tasks: LiveTask[];
  claims: LiveClaim[];
}) {
  const contributions = project.contributions as LiveContribution[];
  const byId = useMemo(
    () => new Map(contributions.map((c) => [c.id, c])),
    [contributions],
  );
  const taskTitle = useMemo(
    () => new Map(tasks.map((t) => [t.id, t.title])),
    [tasks],
  );

  const tabs = useMemo(
    () =>
      [
        { key: 'tasks' as const, label: 'Tasks', count: tasks.length },
        { key: 'state' as const, label: 'Pending', count: claims.length },
        {
          key: 'contributions' as const,
          label: 'Completed',
          count: contributions.length,
        },
      ].filter((t) => t.key !== 'tasks' || t.count > 0),
    [tasks.length, claims.length, contributions.length],
  );

  // The tab lives in the address, so a link can open the page on it. This
  // renders only in the browser, after the live data has loaded.
  const [chosen, setTab] = useState<TabKey | null>(() => {
    const wanted = new URLSearchParams(window.location.search).get('tab');
    return wanted === 'tasks' ||
      wanted === 'state' ||
      wanted === 'contributions'
      ? wanted
      : null;
  });
  const tab: TabKey =
    tabs.find((t) => t.key === chosen)?.key ??
    tabs.find((t) => t.count > 0)?.key ??
    tabs[0].key;
  const [open, setOpen] = useState<Record<TabKey, string | null>>({
    tasks: null,
    state: null,
    contributions: null,
  });
  // A jump to a row in another tab waits for that tab to render.
  const pending = useRef<string | null>(null);

  const choose = (key: TabKey) => {
    setTab(key);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', key);
    window.history.replaceState(null, '', url);
  };

  const focus: Focus = (to, key) => {
    choose(to);
    setOpen((o) => ({ ...o, [to]: key }));
    pending.current = `${to}-${key}`;
  };

  useEffect(() => {
    const target = pending.current;
    if (!target) return;
    const el = document.getElementById(target);
    if (!el) return;
    pending.current = null;
    el.scrollIntoView({ block: 'center' });
    el.querySelector('button')?.focus({ preventScroll: true });
  });

  const onKey = (e: KeyboardEvent, i: number) => {
    const n =
      e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
    if (n === null) return;
    const next = tabs[(n + tabs.length) % tabs.length];
    choose(next.key);
    document.getElementById(`tab-${next.key}`)?.focus();
  };

  /* rows */
  const taskRows = useMemo(
    () =>
      // Closed tasks stay on the record, marked Closed beside their stepper.
      tasks.map((t) => taskRow(t, byId, claims)),
    [tasks, byId, claims],
  );
  const taskOf = (claim: LiveClaim) => {
    const ids = claim.sources
      .map((s) => byId.get(s.id)?.task_id)
      .filter((x): x is string => Boolean(x));
    return [...new Set(ids)].map((id) => taskTitle.get(id) ?? id).join(', ');
  };
  const count = <T,>(rows: T[], tone: (r: T) => Tone, t: Tone) =>
    rows.filter((r) => tone(r) === t).length;

  return (
    <section className="net-results" aria-label="Project records">
      <div className="net-tabs" role="tablist" aria-label="Project records">
        {tabs.map((t, i) => (
          <button
            key={t.key}
            id={`tab-${t.key}`}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            aria-controls={`panel-${t.key}`}
            tabIndex={tab === t.key ? 0 : -1}
            className="net-tab"
            onClick={() => choose(t.key)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {t.label}
            <span className="net-tab__count">{t.count}</span>
          </button>
        ))}
      </div>

      {tab === 'tasks' && (
        <div role="tabpanel" id="panel-tasks" aria-labelledby="tab-tasks">
          <p className="net-note net-tabs__lede">
            One row per task, with where it stands: Open, Answered, Checking,
            Verified, Settled. Open a row for the question, how each check
            went and the claim it led to.
          </p>
          <DataTable<TaskRow>
            id="tasks"
            rows={taskRows}
            rowKey={(r) => r.task.id}
            name={(r) => r.task.title}
            nameExtra={(r) => <Needs task={r.task} />}
            nameLabel="Task"
            placeholder="A country, a number, an agent"
            search={(r) =>
              [
                r.task.title,
                r.answerText,
                r.claim?.statement ?? '',
                ...r.by,
                ...(r.answer?.verifications ?? []).map((v) => v.verifier),
              ].join(' ')
            }
            tone={(r) => r.tone}
            filter={{
              options: [
                { value: 'all', label: 'All tasks' },
                ...STEPS.map((step, i) => ({
                  value: `step-${i}`,
                  label: `${step} (${taskRows.filter((r) => atStep(r.status) === i).length})`,
                })),
                {
                  value: 'attention',
                  label: `${TONE_WORD.attention}: contested, disputed or rejected (${count(taskRows, (r) => r.tone, 'attention')})`,
                },
                {
                  value: 'closed',
                  label: `Closed (${taskRows.filter((r) => r.task.status === 'closed').length})`,
                },
              ],
              test: (r, v) =>
                v === 'closed'
                  ? r.task.status === 'closed'
                  : v === 'attention'
                    ? r.tone === 'attention'
                    : `step-${atStep(r.status)}` === v,
            }}
            open={open.tasks}
            setOpen={(k) => setOpen((o) => ({ ...o, tasks: k }))}
            columns={[
              {
                key: 'progress',
                label: 'Status',
                className: 'net-rt__progress',
                mobile: 'full',
                sort: (r) => r.status.at,
                cell: (r) => <Stepper progress={r.status} compact />,
              },
              {
                key: 'price',
                label: 'Price',
                className: 'net-rt__small net-rt__nowrap',
                mobileLabel: 'Price',
                sort: (r) => r.task.karma_offered ?? -1,
                cell: (r) =>
                  r.task.price ? (
                    <span title={r.task.price.rule}>
                      {r.task.price.karma}κ
                      {r.task.price.won_by
                        ? ` · paid to ${r.task.price.won_by}`
                        : ''}
                    </span>
                  ) : (
                    <span className="net-rt__none">—</span>
                  ),
              },
              {
                key: 'answer',
                label: 'Answer',
                className: 'net-rt__main',
                sort: (r) => r.answerText.toLowerCase(),
                cell: (r) =>
                  r.answerText || (
                    <span className="net-rt__none">No answer yet</span>
                  ),
              },
              {
                // Who answered, then who checked: one column, two lines, so
                // the table fits without scrolling sideways.
                key: 'by',
                label: 'Answered · checked by',
                className: 'net-rt__small net-rt__people',
                sort: (r) => (r.by[0] ?? '').toLowerCase(),
                cell: (r) => {
                  const v = r.answer?.verifications ?? [];
                  return (
                    <>
                      <span className="net-rt__line">
                        <span className="net-rt__role">Answered</span>{' '}
                        <Names of={r.by} />
                      </span>
                      <span className="net-rt__line">
                        <span className="net-rt__role">Checked</span>{' '}
                        <Names
                          of={v.map((x) => x.verifier)}
                          flag={(i) =>
                            v[i].verdict === 'confirmed' ? '' : v[i].verdict
                          }
                        />
                      </span>
                    </>
                  );
                },
              },
              {
                key: 'updated',
                label: 'Updated',
                className: 'net-rt__small net-rt__nowrap',
                mobile: 'hide',
                sort: (r) => r.updated,
                cell: (r) => at(new Date(r.updated).toISOString()),
              },
            ]}
            detail={(r) => (
              <div>
                <Stepper progress={r.status} className="np-steps--detail" />
                <div className="net-rt__detail-grid">
                  <div>
                    <h3>What the project believes</h3>
                    {r.claim ? (
                      <>
                        <p className="net-longform">{r.claim.statement}</p>
                        <p className="net-row__meta">
                          <Jump to="state" id={r.claim.id} focus={focus} /> is{' '}
                          {r.claim.status}, proposed by {r.claim.created_by}
                        </p>
                      </>
                    ) : (
                      <p className="net-note">
                        No claim yet. One is proposed once the answer has been
                        checked twice.
                      </p>
                    )}
                  </div>
                  <div>
                    <h3>The question</h3>
                    <p className="net-longform">{r.task.question}</p>
                    {needsOf(r.task.requirements).length ? (
                      <p className="net-row__meta">
                        Needs: {needsOf(r.task.requirements).join('; ')}
                      </p>
                    ) : null}
                    {proofOf(r.task.requirements).length ? (
                      <p className="net-row__meta">
                        Attach: {proofOf(r.task.requirements).join('; ')}
                      </p>
                    ) : null}
                    {r.task.verification ? (
                      <p className="net-row__meta">
                        Checked by {r.task.verification.method}:{' '}
                        {clip(r.task.verification.criteria, 400)}
                      </p>
                    ) : null}
                  </div>
                </div>
                {r.task.passed?.count ? (
                  <>
                    <h3>
                      Who passed on it
                      {r.task.passed.count > r.task.passed.recent.length
                        ? ` (latest ${r.task.passed.recent.length} of ${r.task.passed.count})`
                        : ''}
                    </h3>
                    <Events
                      rows={r.task.passed.recent.map((x) => ({
                        key: x.participant,
                        at: x.at,
                        what: <b>Passed</b>,
                        by: x.participant,
                        note: x.reason ? clip(x.reason, 400) : '—',
                      }))}
                    />
                  </>
                ) : null}
                <div>
                  <h3>How it was checked</h3>
                  {r.work.length ? (
                    <Events
                      rows={r.work
                        .flatMap((c) => [
                          {
                            key: c.id,
                            at: c.submitted_at,
                            what: (
                              <>
                                <b>
                                  {r.task.comparisons.some((x) => x.id === c.id)
                                    ? 'Compared'
                                    : 'Answered'}
                                </b>
                                <span className="net-hist__sub">
                                  <Jump
                                    to="contributions"
                                    id={c.id}
                                    focus={focus}
                                  />
                                  , {c.state}
                                </span>
                              </>
                            ),
                            by: c.contributor,
                            note: clip(c.title, 400),
                          },
                          ...c.verifications.map((v) => ({
                            key: `${c.id}-${v.verifier}`,
                            at: v.at,
                            what: (
                              <>
                                <b
                                  className={
                                    v.verdict === 'confirmed'
                                      ? ''
                                      : 'net-hist__dispute'
                                  }
                                >
                                  {v.verdict[0].toUpperCase()}
                                  {v.verdict.slice(1)}
                                </b>
                                <span className="net-hist__sub">
                                  checked {c.id}
                                </span>
                              </>
                            ),
                            by: v.verifier,
                            note: clip(v.note, 400),
                          })),
                        ])
                        .sort((a, b) =>
                          a.at < b.at ? 1 : a.at > b.at ? -1 : 0,
                        )}
                    />
                  ) : (
                    <p className="net-note">Nobody has answered this yet.</p>
                  )}
                </div>
              </div>
            )}
          />
        </div>
      )}

      {tab === 'state' && (
        <div role="tabpanel" id="panel-state" aria-labelledby="tab-state">
          <p className="net-note net-tabs__lede">
            What the project currently believes. A claim is believed once two
            members other than its author confirm it against the work it cites.
            Open a claim for its full history.
          </p>
          <DataTable<LiveClaim>
            id="state"
            rows={claims}
            rowKey={(c) => c.id}
            name={(c) => c.id}
            nameLabel="Claim"
            defaultSort="date"
            defaultDir={-1}
            placeholder="Words in a claim, a country, an agent"
            search={(c) =>
              [
                c.id,
                c.statement,
                taskOf(c),
                c.created_by,
                ...c.history.flatMap((h) => h.reviews.map((v) => v.reviewer)),
              ].join(' ')
            }
            tone={(c) => CLAIM_TONE[c.status] ?? ''}
            filter={{
              options: [
                { value: 'all', label: 'All claims' },
                ...['believed', 'unconfirmed', 'rejected', 'retracted'].map(
                  (s) => ({
                    value: s,
                    label: `${s[0].toUpperCase()}${s.slice(1)} (${claims.filter((c) => c.status === s).length})`,
                  }),
                ),
              ],
              test: (c, v) => c.status === v,
            }}
            open={open.state}
            setOpen={(k) => setOpen((o) => ({ ...o, state: k }))}
            columns={[
              {
                key: 'status',
                label: 'Status',
                className: 'net-rt__status',
                mobile: 'aside',
                sort: (c) =>
                  ['believed', 'unconfirmed', 'rejected', 'retracted'].indexOf(
                    c.status,
                  ),
                cell: (c) => (
                  <span
                    className={`net-outcome${CLAIM_TONE[c.status] === 'believed' ? ' net-outcome--live' : CLAIM_TONE[c.status] === 'working' ? ' net-outcome--hold' : CLAIM_TONE[c.status] === 'attention' ? ' net-outcome--halt' : ''}`}
                  >
                    {c.status}
                  </span>
                ),
              },
              {
                key: 'about',
                label: 'About',
                className: 'net-rt__about',
                sort: (c) => taskOf(c).toLowerCase(),
                cell: (c) => taskOf(c) || '—',
              },
              {
                key: 'statement',
                label: 'Statement',
                className: 'net-rt__main',
                cell: (c) => (
                  <span className="net-rt__clamp">
                    {c.statement}
                    {c.evidence?.length ? (
                      <span className="net-rt__sub">
                        {' '}
                        · {c.evidence.join(', ')}
                      </span>
                    ) : null}
                  </span>
                ),
              },
              {
                key: 'by',
                label: 'Proposed by',
                className: 'net-rt__small',
                mobileLabel: 'Proposed by',
                sort: (c) => c.created_by,
                cell: (c) => <Names of={[c.created_by]} />,
              },
              {
                key: 'confirmed',
                label: 'Confirmed by',
                className: 'net-rt__small',
                mobileLabel: 'Confirmed by',
                cell: (c) => {
                  const rev =
                    c.history.find((h) => h.revision === c.believed_revision) ??
                    c.history.at(-1);
                  const yes = (rev?.reviews ?? []).filter(
                    (v) => v.verdict === 'confirm',
                  );
                  return <Names of={yes.map((v) => v.reviewer)} />;
                },
              },
              {
                key: 'date',
                label: 'Date',
                className: 'net-rt__small net-rt__nowrap',
                mobileLabel: 'Date',
                sort: (c) => c.created_at,
                cell: (c) => at(c.created_at),
              },
            ]}
            detail={(c) => (
              <div>
                <h3>Statement</h3>
                <p className="net-longform">{c.statement}</p>
                <h3>History</h3>
                <History history={c.history} focus={focus} />
              </div>
            )}
          />
        </div>
      )}

      {tab === 'contributions' && (
        <div
          role="tabpanel"
          id="panel-contributions"
          aria-labelledby="tab-contributions"
        >
          <p className="net-note net-tabs__lede">
            The work itself: answers and comparisons, each checked by members
            other than its author before any karma moves.
          </p>
          <DataTable<LiveContribution>
            id="contributions"
            rows={contributions}
            rowKey={(c) => c.id}
            name={(c) => c.id}
            nameLabel="Contribution"
            defaultSort="task"
            placeholder="A title, a country, an agent"
            search={(c) =>
              [
                c.id,
                c.title,
                c.task_id ? (taskTitle.get(c.task_id) ?? '') : '',
                c.contributor,
                ...c.verifications.map((v) => v.verifier),
              ].join(' ')
            }
            tone={(c) =>
              c.state === 'rejected' ||
              c.state === 'contested' ||
              c.verifications.some((v) => v.verdict !== 'confirmed')
                ? 'attention'
                : c.state === 'settled'
                  ? 'believed'
                  : 'working'
            }
            filter={{
              options: [
                { value: 'all', label: 'All contributions' },
                { value: 'settled', label: 'Settled' },
                { value: 'held', label: 'Waiting for checks' },
                { value: 'contested', label: 'Waiting for an arbiter' },
                { value: 'flagged', label: 'Disputed or rejected' },
              ],
              test: (c, v) =>
                v === 'flagged'
                  ? c.state === 'rejected' ||
                    c.verifications.some((x) => x.verdict !== 'confirmed')
                  : c.state === v,
            }}
            open={open.contributions}
            setOpen={(k) => setOpen((o) => ({ ...o, contributions: k }))}
            columns={[
              {
                key: 'state',
                label: 'Status',
                className: 'net-rt__progress',
                mobile: 'full',
                sort: (c) => contributionProgress(c).at,
                cell: (c) => (
                  <Stepper progress={contributionProgress(c)} compact />
                ),
              },
              {
                key: 'task',
                label: 'Task',
                className: 'net-rt__about',
                sort: (c) =>
                  (c.task_id
                    ? (taskTitle.get(c.task_id) ?? c.task_id)
                    : '~'
                  ).toLowerCase(),
                cell: (c) =>
                  c.task_id
                    ? `${c.reconciles?.length ? 'Compares, ' : ''}${taskTitle.get(c.task_id) ?? c.task_id}`
                    : '—',
              },
              {
                key: 'title',
                label: 'Title',
                className: 'net-rt__main',
                sort: (c) => c.title.toLowerCase(),
                cell: (c) => c.title,
              },
              {
                key: 'by',
                label: 'By',
                className: 'net-rt__small',
                mobileLabel: 'By',
                sort: (c) => c.contributor,
                cell: (c) => <Names of={[c.contributor]} />,
              },
              {
                key: 'checks',
                label: 'Checks',
                className: 'net-rt__small',
                mobileLabel: 'Checks',
                sort: (c) => c.verifications.length,
                cell: (c) => (
                  <>
                    {c.verifications.length} of {c.verifiers_required}
                    {c.verifications.some((v) => v.verdict !== 'confirmed') && (
                      <span className="net-rt__flag">
                        {' '}
                        (
                        {c.verifications
                          .filter((v) => v.verdict !== 'confirmed')
                          .map((v) => v.verdict)
                          .join(', ')}
                        )
                      </span>
                    )}
                  </>
                ),
              },
            ]}
            detail={(c) => (
              <div>
              <Stepper
                progress={contributionProgress(c)}
                className="np-steps--detail"
              />
              <div className="net-rt__detail-grid">
                <div>
                  <h3>Method</h3>
                  <p className="net-longform net-rt__method">{c.detail}</p>
                  <p className="net-row__meta">
                    Submitted {at(c.submitted_at)} UTC, claimed{' '}
                    {c.karma_claimed}κ
                    {c.settled_at ? `, settled ${at(c.settled_at)} UTC` : ''}
                  </p>
                </div>
                <div>
                  <h3>Checks</h3>
                  {c.verifications.length ? (
                    <ul className="net-rt__notes">
                      {c.verifications.map((v) => (
                        <li key={v.verifier}>
                          <strong>
                            {v.verifier}: {v.verdict}
                          </strong>
                          , {at(v.at)} UTC. {v.note}
                          {v.excluded?.length ? (
                            <em>
                              {' '}
                              Not maintained by this project:{' '}
                              {v.excluded.join(', ')}.
                            </em>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="net-note">Not checked yet.</p>
                  )}
                </div>
              </div>
              </div>
            )}
          />
        </div>
      )}
    </section>
  );
}
