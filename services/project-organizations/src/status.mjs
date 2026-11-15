/** Gathers the per-project inputs `buildAcceptance` needs from the real adapters.
 *
 * Sources and the acceptance shapes they are mapped onto:
 * - native.snapshot(id, {evidence: true}) is already acceptance-shaped (`proof`, `records`,
 *   `unread`); an unavailable snapshot is left out, so acceptance reports it unknown.
 * - paperclip.projectStatus(id) GET-only readback -> {projectId, readAt, company, agents}.
 *   Only verified records are projected; a bound record whose readback was unavailable
 *   leaves the whole snapshot out (unknown), a mismatch is projected as absent (missing).
 * - leadershipStore.list({projectId}) reports -> {runId, projectId, companyId, agentId, role,
 *   actual, outcome, finishedAt}.
 * - scheduler.attempts(id) solver attempts (already acceptance-shaped).
 * - accountReader(member) -> {member, total, readAt} for each native award member.
 *
 * Projects are read with bounded concurrency. A source that is not configured or fails for
 * one project yields an `{unavailable}` marker or no entry, which acceptance reports as
 * unknown: a failure never becomes zero, missing or pass, and never stops other projects.
 */
import { byText, need, plain } from './common.mjs';

const OUTCOME_OF = Object.freeze({ completed: 'completed', blocked: 'blocked', failed: 'failed', refused: 'failed' });
const codeOf = (e) => (typeof e?.code === 'string' && /^[a-z0-9_]{1,80}$/.test(e.code) ? e.code : 'read_failed');

/** Paperclip GET-only status -> the acceptance paperclip snapshot, or null when unreadable. */
export function paperclipSnapshotOf(status, projectId, now = () => Date.now()) {
  if (!plain(status) || status.projectId !== projectId || !plain(status.organization)) return null;
  const org = status.organization;
  const entries = ['company', 'ceo', 'manager'].map((k) => org[k]);
  if (!entries.every(plain)) return null;
  // A bound record we could not read is unknown, not absent.
  if (entries.some((e) => e.id && e.readback === 'unavailable')) return null;
  const verified = (e) => e.id && e.readback === 'verified';
  const [company, ceo, manager] = entries;
  const times = entries.filter(verified).map((e) => e.evidence?.fetchedAt).filter((t) => typeof t === 'string' && !Number.isNaN(Date.parse(t)));
  // Every bound record read back but none matched: an observed mismatch, not an unread one.
  if (!times.length && entries.some((e) => e.id && e.readback === 'mismatch')) times.push(new Date(now()).toISOString());
  if (!times.length) return null;
  const agents = [];
  if (verified(ceo)) agents.push({ id: ceo.id, role: 'ceo', reportsTo: null });
  if (verified(manager)) agents.push({ id: manager.id, role: 'manager', reportsTo: status.hierarchy?.managerReportsToCeo === true ? ceo.id : null });
  return { projectId, readAt: times.sort(byText).at(-1), company: { id: verified(company) ? company.id : null }, agents };
}

/** A retained leadership report -> the acceptance leadership run. */
export function leadershipRunOf(report) {
  if (!plain(report)) return null;
  return {
    runId: report.id, projectId: report.projectId, companyId: report.companyId ?? null, agentId: report.agentId ?? null, role: report.role,
    actual: report.actual === true && report.execution?.actual === true, outcome: OUTCOME_OF[report.status] ?? 'failed',
    finishedAt: report.execution?.finishedAt ?? report.recordedAt ?? null,
  };
}

const awardMembers = (snapshot) => [...new Set(Object.entries(snapshot.records ?? {})
  .filter(([k, v]) => k.startsWith('central_award/') && plain(v) && typeof v.member === 'string').map(([, v]) => v.member))].sort(byText);

async function pool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * @returns the buildAcceptance input (minus `production`/`generatedAt`) plus `errors`, a list of
 *   `{projectId, source, reason}` describing every per-project read that failed.
 */
export async function collectStatus({
  selection, registry = null, journal = null, native = null, paperclip = null, leadershipStore = null, scheduler = null,
  accountReader = null, concurrency = 4, now = () => Date.now(),
} = {}) {
  need(selection?.projects?.length === 120 && typeof selection.digest === 'string', 'invalid_status_input', 'a frozen 120-project selection is required');
  need(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 4, 'invalid_status_input', 'concurrency is at most 4');
  need(native === null || typeof native.snapshot === 'function', 'invalid_status_input', 'native');
  need(paperclip === null || typeof paperclip.projectStatus === 'function', 'invalid_status_input', 'paperclip');
  need(leadershipStore === null || typeof leadershipStore.list === 'function', 'invalid_status_input', 'leadershipStore');
  need(scheduler === null || typeof scheduler.attempts === 'function', 'invalid_status_input', 'scheduler');
  need(accountReader === null || typeof accountReader === 'function', 'invalid_status_input', 'accountReader');
  const nativeSnapshots = new Map(), paperclipSnapshots = new Map(), leadershipRuns = new Map(), workerAttempts = new Map(), accountReadbacks = new Map();
  const errors = [];
  const fail = (projectId, source, reason) => errors.push({ projectId, source, reason });

  await pool([...selection.ids], concurrency, async (id) => {
    let snapshot = null;
    if (native) {
      try {
        const s = await native.snapshot(id, { evidence: true });
        if (plain(s) && s.available === true && plain(s.proof) && plain(s.records)) {
          snapshot = s;
          nativeSnapshots.set(id, s);
        } else fail(id, 'native', plain(s) && typeof s.error === 'string' ? s.error : 'native_snapshot_unavailable');
      } catch (e) {
        fail(id, 'native', codeOf(e));
      }
    }
    if (paperclip) {
      try {
        const status = await paperclip.projectStatus(id);
        const projected = paperclipSnapshotOf(status, id, now);
        if (projected) paperclipSnapshots.set(id, projected);
        else if (Object.values(status?.organization ?? {}).some((e) => e?.id)) fail(id, 'paperclip', 'paperclip_readback_unavailable');
      } catch (e) {
        fail(id, 'paperclip', codeOf(e));
      }
    }
    if (!leadershipStore) leadershipRuns.set(id, { unavailable: 'leadership_store_unavailable' });
    else {
      try {
        leadershipRuns.set(id, leadershipStore.list({ projectId: id }).map(leadershipRunOf).filter(Boolean));
      } catch (e) {
        fail(id, 'leadership', codeOf(e));
        leadershipRuns.set(id, { unavailable: 'leadership_store_unreadable' });
      }
    }
    if (!scheduler) workerAttempts.set(id, { unavailable: 'scheduler_unavailable' });
    else {
      try {
        workerAttempts.set(id, scheduler.attempts(id).filter((a) => plain(a) && a.kind === 'solver'));
      } catch (e) {
        fail(id, 'scheduler', codeOf(e));
        workerAttempts.set(id, { unavailable: 'scheduler_unreadable' });
      }
    }
    if (snapshot && accountReader) {
      const shown = [];
      try {
        for (const member of awardMembers(snapshot)) {
          const r = await accountReader(member);
          need(plain(r) && r.member === member && typeof r.total === 'string' && typeof r.readAt === 'string', 'account_readback_invalid');
          shown.push({ member, total: r.total, readAt: r.readAt, ...(r.fixture === true ? { fixture: true } : {}) });
        }
        accountReadbacks.set(id, shown);
      } catch (e) {
        fail(id, 'account', codeOf(e));
        accountReadbacks.set(id, { unavailable: 'account_readback_unreadable' });
      }
    }
  });
  return { selection, registry, journal, nativeSnapshots, paperclipSnapshots, leadershipRuns, workerAttempts, accountReadbacks, errors };
}
