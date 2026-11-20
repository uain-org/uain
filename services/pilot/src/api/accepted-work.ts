import { mapLimit } from '../native/map-limit.ts';
/**
 * The newest accepted work across all members (GET /api/accepted, 16 November 2026).
 *
 * The website's leaderboard, /earth and /try used the original research ledger
 * (/api/contributions), whose newest entry is from 5 November: every accepted task since
 * then is a central award on the chain (BAINK's paid tasks) and never appears there.
 * Member profiles already read a member's accepted awards (P0-3, contribution-proxy.ts),
 * one member at a time. This lists the same award fields across members, newest first.
 *
 * How: walk the newest finalized `central_review` events this server already projects
 * (native_events), and for each reviewed submission read `central_award/solver/<id>`
 * with a proof. That record exists only when the reviewer accepted the work. A rejection
 * writes a reviewer award and no solver award, so it is never listed. Titles and the
 * member's name come from the proved task, project and member records. Points are not
 * derived here: the site turns `amount` into Karma with BAINK's own awardPoints
 * (apps/baink/shared/contribution-view.mjs), the one derivation.
 *
 * Nothing private: the same fields the public per-member read shows, plus public titles
 * and names. Compute is short (K-50): answered when asked, held ACCEPTED_TTL_MS, one read in
 * flight; an award once read never changes, so it is kept and not proved again.
 * The time is the block time of the award's height, read from the chain's header.
 */
export const ACCEPTED_TTL_MS = 30_000;
export const ACCEPTED_LIMIT = 100;
/** Reviews walked per read: reviews outnumber acceptances (rejections, reviewer checks). */
const REVIEWS_SCANNED = 400;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const ADDRESS = /^uain1[a-f0-9]{40}$/;
const UNITS = /^(0|[1-9][0-9]{0,30})$/;
const HEIGHT = /^[1-9][0-9]{0,19}$/;

export type AcceptedRow = {
  submission: string;
  task: string;
  taskTitle: string | null;
  project: string;
  projectTitle: string | null;
  member: string;
  name: string | null;
  operator: string | null;
  amount: string;
  height: string;
  time: string | null;
};
export type AcceptedDeps = {
  /** Newest-first finalized event records with operation central_review (bounded). */
  reviews: (limit: number) => Promise<Array<{ subject: string; height: string }>>;
  /** Proved records for these keys (null when absent). */
  read: (keys: string[]) => Promise<Record<string, any>>;
  /** Public name and operator of a member, and title of a project, as the site's member and project pages read them. */
  names?: (kind: 'member' | 'project', id: string) => Promise<{ name?: string | null; operator?: string | null; title?: string | null } | null>;
  /** Block time (ISO) at a height, or null. */
  timeAt: (height: string) => Promise<string | null>;
  now?: () => number;
};
type Answer = { status: number; body: Record<string, unknown> };

const awards = new Map<string, AcceptedRow | null>();
const times = new Map<string, string | null>();
let held: { at: number; rows: AcceptedRow[] } | null = null;
let flight: Promise<AcceptedRow[]> | null = null;

const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

async function build(deps: AcceptedDeps): Promise<AcceptedRow[]> {
  const reviewed = await deps.reviews(REVIEWS_SCANNED);
  const ids = [...new Set(reviewed.map((r) => r.subject).filter((s) => typeof s === 'string' && ID.test(s)))];
  const unknown = ids.filter((id) => !awards.has(id));
  if (unknown.length) {
    const records = await deps.read(unknown.map((id) => 'central_award/solver/' + id));
    for (const id of unknown) {
      const a = records['central_award/solver/' + id];
      if (a === null || a === undefined) { awards.set(id, null); continue; }
      if (!obj(a) || a.submission !== id || a.role !== 'solver' || !ID.test(a.task) || !ID.test(a.project) || !ADDRESS.test(a.member) || !UNITS.test(String(a.amount)) || !HEIGHT.test(String(a.height)))
        throw Error('central award record differs');
      awards.set(id, { submission: id, task: a.task, taskTitle: null, project: a.project, projectTitle: null, member: a.member, name: null, operator: null, amount: String(a.amount), height: String(a.height), time: null });
    }
  }
  const rows = ids.map((id) => awards.get(id)).filter((r): r is AcceptedRow => !!r)
    .sort((a, b) => (BigInt(b.height) > BigInt(a.height) ? 1 : BigInt(b.height) < BigInt(a.height) ? -1 : a.submission.localeCompare(b.submission)))
    .slice(0, ACCEPTED_LIMIT).map((r) => ({ ...r }));
  if (!rows.length) return rows;
  // Titles and names change rarely and are public; read them fresh with each build.
  const keys = [...new Set(rows.flatMap((r) => ['central_task/' + r.task, 'project/' + r.project, 'member/' + r.member]))];
  const named = await deps.read(keys);
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  // The chain's member and project records may leave the name empty (it lives in their metadata);
  // the site's own member and project reads resolve it, so those are asked once per id.
  const looked = new Map<string, Promise<any>>();
  const look = (kind: 'member' | 'project', id: string) => {
    const key = kind + '/' + id;
    if (!looked.has(key)) looked.set(key, deps.names ? deps.names(kind, id).catch(() => null) : Promise.resolve(null));
    return looked.get(key)!;
  };
  // Names and block times are asked a few at a time (21 November 2026), not one row after another.
  await mapLimit(rows, async (r) => {
    const t = named['central_task/' + r.task], p = named['project/' + r.project], m = named['member/' + r.member];
    r.taskTitle = obj(t) && t.id === r.task ? text(t.title) : null;
    r.projectTitle = (obj(p) && p.id === r.project ? text(p.title) : null) ?? text((await look('project', r.project))?.title);
    const fromChain = obj(m) && m.id === r.member ? m : null;
    const shown = text(fromChain?.name) ? fromChain : await look('member', r.member);
    r.name = text(shown?.name);
    r.operator = text(shown?.operator);
  });
  const heights = [...new Set(rows.map((r) => r.height))].filter((h) => !times.has(h));
  await mapLimit(heights, async (h) => {
    try { times.set(h, await deps.timeAt(h)); } catch { /* left unknown; asked again next build */ }
  });
  for (const r of rows) r.time = times.get(r.height) ?? null;
  return rows;
}

export async function acceptedWork(limitParam: string | null, deps: AcceptedDeps): Promise<Answer> {
  const limit = limitParam === null ? 50 : Number(limitParam);
  if (!Number.isInteger(limit) || limit < 1 || limit > ACCEPTED_LIMIT)
    return { status: 400, body: { error: 'invalid_limit', message: `limit is 1 to ${ACCEPTED_LIMIT}.` } };
  const now = deps.now ?? Date.now;
  if (!held || now() - held.at >= ACCEPTED_TTL_MS) {
    try {
      flight ??= build(deps).finally(() => { flight = null; });
      const rows = await flight;
      held = { at: now(), rows };
    } catch {
      if (!held) return { status: 503, body: { error: 'accepted_unavailable', message: 'Accepted work could not be read just now. Try again in a minute.' } };
    }
  }
  const rows = held!.rows.slice(0, limit);
  return {
    status: 200,
    body: {
      schema: 'uain-accepted-v1',
      authority: 'native',
      note: 'Accepted answers to central (BAINK) tasks, newest first: one row per solver award on the chain. A rejection is never listed. Points are Karma: 1 per whole AI$ of the award (BAINK awardPoints). The time is the block time of the award.',
      readAt: new Date(held!.at).toISOString(),
      newest: rows[0]?.time ?? null,
      count: rows.length,
      accepted: rows,
    },
  };
}

/** Forget everything held (tests). */
export function resetAcceptedWork() {
  awards.clear();
  times.clear();
  held = null;
  flight = null;
}
