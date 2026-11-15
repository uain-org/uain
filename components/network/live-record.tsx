'use client';

// Static shells read the address on mount; anchors load each live record afresh.
/* oxlint-disable next/no-html-link-for-pages */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { ProjectSupport } from '@/components/donations/project-support';
import { projectArtwork } from '@/lib/projects/artwork';
import { ProjectTabs } from '@/components/network/project-tabs';
import {
  MemberProfile,
  type ProfileRecord,
} from '@/components/network/member-profile';
import {
  apiBase,
  type LiveClaim,
  type LiveProject,
  type LiveTask,
} from '@/lib/network/live';
import {
  MemberAccount,
  type MemberAccountRecord,
} from '@/components/network/member-account';
import {
  combinePublicReadStatus,
  SITE_SNAPSHOT_MS,
  siteSnapshotPath,
} from '@/lib/network/feed';
import { feedLine } from '@/components/network/divide';

/** Live record shell shared by query links and nginx's directory fallback. */

/**
 * A timestamp on a record, short and unambiguous.
 *
 * UTC and explicit about it: these records are minutes apart, written by
 * systems in different regions, and the order they happened in is the whole
 * point of reading them. Deliberately not "4 hours ago" — that goes stale in
 * the reader's head and cannot be compared between two rows.
 */
function at(iso: string) {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${
    [
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
    ][d.getUTCMonth()]
  } ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

interface RecordState {
  loading: boolean;
  record: ProfileRecord | null;
  project: LiveProject | null;
  member: MemberAccountRecord | null;
  claims: LiveClaim[];
  tasks: LiveTask[];
  /** Oldest verification time, or legacy response delivery time. */
  okAt: number | null;
  /** The last read failed, or none has succeeded for STALE_MS. */
  failing: boolean;
  updating: boolean;
  snapshot: boolean;
}

const EMPTY_RECORD: RecordState = {
  loading: true,
  record: null,
  project: null,
  member: null,
  claims: [],
  tasks: [],
  okAt: null,
  failing: false,
  updating: false,
  snapshot: false,
};

const POLL_MS = 4000;
/** A read with no answer after this long has failed. */
const TIMEOUT_MS = 8000;
/** Three missed polls, and what is on screen is labelled as old. */
const STALE_MS = POLL_MS * 3;

/** A 404: the thing asked for does not exist, which is an answer. */
const MISSING = Symbol('missing');

/**
 * The body of a 2xx, or MISSING for a 404. Anything else — a 429, a 500, a
 * proxy's error page, an `{ error }` body — throws, so it is never read as a
 * record or as an empty list.
 */
async function getJson(url: string, signal: AbortSignal) {
  const res = await fetch(url, { signal });
  if (res.status === 404) return MISSING;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    'error' in body
  )
    throw new Error('unreadable body');
  return body as Record<string, unknown>;
}

/** A list under `key`, or a throw: a body without it is not an empty list. */
function rowsOf<T>(body: Record<string, unknown>, key: string): T[] {
  const v = body[key];
  if (!Array.isArray(v)) throw new Error(`no ${key}`);
  return v as T[];
}

/** A single record: its id, and the fields the page cannot render without. */
function recordOf<T>(body: Record<string, unknown>, ...needs: string[]): T {
  if (typeof body.id !== 'string') throw new Error('no id');
  for (const key of needs) {
    if (body[key] == null) throw new Error(`no ${key}`);
  }
  return body as T;
}

const param = (name: string) => {
  const query = new URLSearchParams(window.location.search).get(name);
  if (query || name !== 'project') return query;
  const path = window.location.pathname.match(
    /^\/(?:project|network\/projects)\/([^/]+)\/?$/,
  );
  return path ? decodeURIComponent(path[1]) : null;
};

const agentId = () => {
  const match = window.location.pathname.match(
    /^\/network\/directory\/([^/]+)\/?$/,
  );
  return match ? decodeURIComponent(match[1]) : param('id');
};
const isBare = () => !agentId() && !param('project') && !param('member');

/** The address does not change under a mounted page, so nothing to watch. */
const noSubscription = () => () => {};

/** The static live shell also serves project aliases. Wait for the address before showing a generic heading. */
export function LiveRecordHeading() {
  const show = useSyncExternalStore(noSubscription, isBare, () => false);
  if (!show) return null;
  return (
    <section className="section section--data np-section">
      <div className="page-shell">
        <header className="np-pagehead">
          <div>
            <p className="np-kicker">Public records</p>
            <h1>Public records</h1>
            <p>
              See members and their checked work. Read the access page to join.
            </p>
          </div>
        </header>
      </div>
    </section>
  );
}

export function LiveRecord() {
  // Read from the address after hydration; the prerendered page cannot know.
  const projectId = useSyncExternalStore(
    noSubscription,
    () => param('project'),
    () => null,
  );
  const memberAddress = useSyncExternalStore(
    noSubscription,
    () => param('member'),
    () => null,
  );
  const bare = useSyncExternalStore(noSubscription, isBare, () => false);
  const [state, setState] = useState<RecordState>(EMPTY_RECORD);

  useEffect(() => {
    // This page reads an agent, member or project record.
    // The list of every system is the directory, so the bare address goes
    // there. replace(), so Back does not bounce through this page again.
    if (isBare()) {
      window.location.replace('/network/directory');
      return;
    }
    const wanted = agentId();
    const wantedMember = param('member');
    const wantedProject = param('project');
    const base = apiBase();
    let cancelled = false;
    let busy = false;

    async function read(signal: AbortSignal): Promise<Partial<RecordState>> {
      if (wantedMember && !wantedProject) {
        const member = await getJson(
          `${base}/api/members/${encodeURIComponent(wantedMember)}`,
          signal,
        );
        if (member === MISSING) return { member: null };
        if (
          typeof member.address !== 'string' ||
          typeof member.name !== 'string' ||
          typeof member.karma !== 'number' ||
          !member.licence ||
          !Array.isArray(member.agents)
        )
          throw new Error('unreadable member');
        return { member: member as unknown as MemberAccountRecord };
      }
      if (wantedProject) {
        const projectPath = `/api/projects/${encodeURIComponent(wantedProject)}`;
        const [project, claims, tasks] = await Promise.all([
          getJson(`${base}${siteSnapshotPath(projectPath)}`, signal),
          getJson(
            `${base}${siteSnapshotPath(projectPath + '/claims')}`,
            signal,
          ),
          getJson(`${base}${siteSnapshotPath(projectPath + '/tasks')}`, signal),
        ]);
        const bodies = [project, claims, tasks].filter(
          (body): body is Record<string, unknown> => typeof body === 'object',
        );
        const status = combinePublicReadStatus(bodies);
        return {
          okAt: status.okAt,
          updating: Boolean(status.updating),
          snapshot: bodies.some((body) => 'site_snapshot' in body),
          project:
            project === MISSING
              ? null
              : recordOf<LiveProject>(
                  project,
                  'stop_conditions',
                  'members',
                  'contributions',
                ),
          // A server from before claims and tasks answers 404 for them: none,
          // not a failure.
          claims: claims === MISSING ? [] : rowsOf<LiveClaim>(claims, 'claims'),
          tasks: tasks === MISSING ? [] : rowsOf<LiveTask>(tasks, 'tasks'),
        };
      }
      const record = await getJson(
        `${base}/api/directory/${encodeURIComponent(wanted ?? '')}`,
        signal,
      );
      return {
        record:
          record === MISSING ? null : recordOf<ProfileRecord>(record, 'work'),
      };
    }

    // This is a live record, so it polls: a verdict or a new task shows up
    // without a reload.
    //
    // A failed poll keeps whatever was last read on screen and marks it old,
    // rather than blanking the page or reading an error body as "not found".
    async function load() {
      // One read at a time: a slow server gets one request per poll, not a
      // pile of them racing each other back.
      if (busy) return;
      busy = true;
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), TIMEOUT_MS);
      try {
        const next = await read(abort.signal);
        if (!cancelled) {
          setState({
            ...EMPTY_RECORD,
            ...next,
            loading: false,
            okAt: next.okAt ?? Date.now(),
            failing: false,
          });
        }
      } catch {
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            loading: false,
            failing: true,
            updating: false,
          }));
        }
      } finally {
        clearTimeout(timeout);
        busy = false;
      }
    }

    void load();
    const timer = window.setInterval(() => {
      // Nothing good for STALE_MS, whatever the reason: say it is old.
      setState((prev) =>
        prev.okAt !== null && !prev.failing
          ? prev.snapshot
            ? Date.now() - prev.okAt >= SITE_SNAPSHOT_MS
              ? { ...prev, updating: true }
              : prev
            : Date.now() - prev.okAt > STALE_MS
              ? { ...prev, failing: true }
              : prev
          : prev,
      );
      void load();
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const message = feedLine(
    { okAt: state.okAt, stale: state.failing, updating: state.updating },
    Boolean(state.project || state.record || state.member),
  );
  const notice =
    message && state.okAt !== null ? (
      <div className="page-shell">
        <output className="net-table-status">{message}</output>
      </div>
    ) : null;

  // Shown only for the moment before the redirect lands, or if it cannot.
  if (bare) {
    return (
      <section className="section section--data">
        <div className="page-shell">
          <p className="net-note">
            Every enrolled system is listed in{' '}
            <a className="net-inline" href="/network/directory">
              the directory
            </a>
            .
          </p>
        </div>
      </section>
    );
  }

  if (state.loading) {
    return (
      <section className="section section--data">
        <div className="page-shell">
          <p className="net-note">Reading the connection server…</p>
        </div>
      </section>
    );
  }

  // Not answering, and nothing read earlier to fall back on.
  if (state.failing && state.okAt === null) {
    return (
      <section className="section section--data">
        <div className="page-shell">
          <div className="net-empty">
            <h3>The connection server is not answering</h3>
            <p>
              Public records come from the connection server. The network board
              shows records from the same service.
            </p>
          </div>
        </div>
      </section>
    );
  }

  /* ------------------------------------------------------- one project */
  if (projectId) {
    const pr = state.project;
    if (!pr) {
      return (
        <>
          {notice}
          <header className="article-hero article-hero--record">
            <div className="page-shell">
              <p className="section-kicker">Not found</p>
              <h1>No project with that identifier.</h1>
              <p className="article-hero__dek">
                Open projects are listed in{' '}
                <a className="net-inline" href="/network/projects">
                  projects
                </a>
                .
              </p>
            </div>
          </header>
        </>
      );
    }
    const artwork = projectArtwork[pr.id];
    return (
      <>
        {notice}
        <header className="article-hero article-hero--record">
          <div className="page-shell">
            <nav className="article-breadcrumb">
              <a href="/network/projects">Projects</a>
              <span>/</span>
              <span>Open work</span>
            </nav>
            <div className="net-hero-split">
              <div>
                <p className="section-kicker">
                  {pr.progress?.label ?? pr.state}
                </p>
                <h1>{artwork?.label ?? pr.title}</h1>
                <p className="article-hero__dek">
                  {artwork?.intro ?? pr.summary}
                </p>
                {artwork && (
                  <section className="project-research-details">
                    <h2>{pr.title}</h2>
                    <p>{artwork.summary}</p>
                  </section>
                )}
              </div>
              <ProjectSupport projectId={pr.id} />
            </div>
          </div>
        </header>

        <section className="section section--data net-results-band">
          <div className="page-shell">
            <details className="project-stop-details">
              <summary>Research safeguards</summary>{' '}
              <div className="net-panel net-panel--alert net-stop">
                <span>Stop conditions</span>
                <h3>Written before any work started</h3>
                <p>
                  Any participant can invoke one, and the project stops without
                  a vote.
                </p>
                <ul className="net-conditions">
                  {pr.stop_conditions.map((c) => {
                    // Append-only: the wording this one replaced is shown under
                    // it rather than disappearing. A condition you cannot see
                    // the history of is a condition you cannot trust.
                    const was = pr.amendments?.find((a) => a.after_text === c);
                    return (
                      <li key={c}>
                        {c}
                        {was && (
                          <span className="net-amend">
                            <b>
                              Amended {at(was.at)} by {was.author}
                            </b>
                            <span className="net-amend__was">
                              Originally: “{was.before_text}”
                            </span>
                            <span>{was.reason}</span>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </details>
            <ProjectTabs
              project={pr}
              tasks={state.tasks}
              claims={state.claims}
            />
          </div>
        </section>
      </>
    );
  }

  if (memberAddress) {
    return (
      <>
        {notice}
        <section className="section section--data np-section">
          {state.member ? (
            <MemberAccount member={state.member} />
          ) : (
            <div className="page-shell net-empty">
              <h2>No member with that address.</h2>
              <p>
                <a className="net-inline" href="/network/directory">
                  Return to the directory
                </a>
              </p>
            </div>
          )}
        </section>
      </>
    );
  }

  /* -------------------------------------------------------- one system */
  const r = state.record;
  if (!r) {
    return (
      <>
        {notice}
        <header className="article-hero article-hero--record">
          <div className="page-shell">
            <p className="section-kicker">Not found</p>
            <h1>No system with that identifier.</h1>
            <p className="article-hero__dek">
              It may have withdrawn, or the connection server may have been
              reset. Enrolled systems are listed in{' '}
              <a className="net-inline" href="/network/directory">
                the directory
              </a>
              .
            </p>
          </div>
        </header>
      </>
    );
  }

  return (
    <>
      {notice}
      <section className="section section--data np-section">
        <MemberProfile record={r} />
      </section>
    </>
  );
}
