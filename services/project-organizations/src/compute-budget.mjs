/** Shared provider compute budget: one locked, durable journal for every
 * provider-backed call (project-manager plans, leadership and solver jobs).
 *
 * The journal is the existing project-manager `receipts.jsonl`: one JSON row per
 * call, `{at, projectIds, model, costUsd, status: 'reserved'|'returned', stopReason}`.
 * New rows add `id` and `purpose`; old rows without an `id` are counted as they
 * are and never rewritten. A reservation counts `perCallUsd` until the provider
 * reports a finite, non-negative cost; a call that never returns stays counted.
 *
 * Every mutation runs under an exclusive `O_EXCL` lock file and rewrites the
 * journal by atomic rename, so separate processes opening the same directory
 * cannot reserve past a cap. Amounts are summed in integer cents.
 *
 * Daily exhaustion pauses until the next UTC day. Total exhaustion is held: it
 * clears only when `approveBudgetChange` records an explicitly approved policy. */
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { need, plain, refuse, text } from './common.mjs';

export const DEFAULT_LIMITS = Object.freeze({ perCallUsd: 2, dailyUsd: 5, totalUsd: 25 });
export const RECEIPTS_FILE = 'receipts.jsonl';
export const POLICY_FILE = 'compute-budget-policy.json';
const POLICY_SCHEMA = 'uain-compute-budget-policy-v1';
const LOCK_FILE = 'compute-budget.lock';
const STATUSES = ['reserved', 'returned'];
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const PURPOSE = /^[a-z][a-z0-9_.-]{0,63}$/;
const EMPTY_LOCK_STALE_MS = 10000;

/** Dollars -> integer cents, rounding any fraction of a cent up (never under-counts). */
export const toCents = (usd) => Math.ceil(Number((usd * 100).toFixed(6)));
const toUsd = (cents) => cents / 100;
const dayOf = (iso) => new Date(Date.parse(iso)).toISOString().slice(0, 10);

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(sleepCell, 0, 0, ms);

function validLimits(limits) {
  need(plain(limits) && Object.keys(limits).length === 3 && ['perCallUsd', 'dailyUsd', 'totalUsd'].every((k) => {
    const v = limits[k];
    return Number.isFinite(v) && v > 0 && v <= 100000 && Number.isInteger(Number((v * 100).toFixed(6)));
  }), 'invalid_compute_limits');
  need(limits.perCallUsd <= limits.dailyUsd && limits.dailyUsd <= limits.totalUsd, 'invalid_compute_limits');
  return Object.freeze({ perCallUsd: limits.perCallUsd, dailyUsd: limits.dailyUsd, totalUsd: limits.totalUsd });
}
const sameLimits = (a, b) => a.perCallUsd === b.perCallUsd && a.dailyUsd === b.dailyUsd && a.totalUsd === b.totalUsd;

function writeAtomic(directory, name, body) {
  const temp = join(directory, `.${name}.${process.pid}.${randomUUID()}`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, join(directory, name));
  try {
    const dir = openSync(directory, 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch { /* directory fsync is best effort on platforms that refuse it */ }
}

function readRows(directory) {
  let raw;
  try {
    raw = readFileSync(join(directory, RECEIPTS_FILE), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  return raw.split('\n').filter((line) => line.trim()).map((line) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      refuse('compute_budget_receipt_invalid', 'unreadable compute receipt row');
    }
    need(plain(row) && typeof row.at === 'string' && Number.isFinite(Date.parse(row.at)) &&
      Number.isFinite(row.costUsd) && row.costUsd >= 0 && STATUSES.includes(row.status), 'compute_budget_receipt_invalid');
    return row;
  });
}

function readPolicy(directory) {
  let raw;
  try {
    raw = readFileSync(join(directory, POLICY_FILE), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const policy = JSON.parse(raw);
  need(plain(policy) && policy.schema === POLICY_SCHEMA && Array.isArray(policy.history), 'compute_budget_policy_invalid');
  return { ...policy, limits: validLimits(policy.limits) };
}

/** Exclusive lock shared by every process using `directory`. A lock left by a dead
 * process on this host is broken by rename-and-verify; any other holder is waited on. */
function locker(directory, timeoutMs) {
  const path = join(directory, LOCK_FILE);
  const host = hostname();
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e.code === 'EPERM';
    }
  };
  function stale(raw) {
    if (!raw) {
      try { return Date.now() - statSync(path).mtimeMs > EMPTY_LOCK_STALE_MS; } catch { return false; }
    }
    try {
      const holder = JSON.parse(raw);
      return holder.host === host && Number.isSafeInteger(holder.pid) && holder.pid !== process.pid && !alive(holder.pid);
    } catch {
      return false;
    }
  }
  function breakStale() {
    let raw;
    try { raw = readFileSync(path, 'utf8'); } catch (e) { return e.code === 'ENOENT'; }
    if (!stale(raw)) return false;
    const aside = `${path}.stale-${randomUUID()}`;
    try { renameSync(path, aside); } catch (e) { return e.code === 'ENOENT'; }
    const moved = readFileSync(aside, 'utf8');
    if (moved === raw) {
      unlinkSync(aside);
      return true;
    }
    // We moved a fresh holder's lock: put it back, or fail closed.
    try {
      linkSync(aside, path);
    } catch {
      unlinkSync(aside);
      refuse('compute_budget_lock_conflict', 'compute budget lock changed while breaking a stale holder');
    }
    unlinkSync(aside);
    return false;
  }
  return function withLock(fn) {
    const token = randomUUID();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const fd = openSync(path, 'wx', 0o600);
        try {
          writeSync(fd, JSON.stringify({ pid: process.pid, host, token, at: new Date().toISOString() }));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      if (breakStale()) continue;
      need(Date.now() < deadline, 'compute_budget_locked', 'compute budget lock is held by another live process');
      sleep(2 + Math.floor(Math.random() * 15));
    }
    try {
      return fn();
    } finally {
      try {
        if (JSON.parse(readFileSync(path, 'utf8')).token === token) unlinkSync(path);
      } catch { /* a lock we no longer hold is left to its holder */ }
    }
  };
}

function summarize(rows, policy, now) {
  const today = new Date(now).toISOString().slice(0, 10);
  let daily = 0;
  let total = 0;
  let open = 0;
  let openCents = 0;
  for (const row of rows) {
    const cents = toCents(row.costUsd);
    total += cents;
    if (dayOf(row.at) === today) daily += cents;
    if (row.status === 'reserved') {
      open++;
      openCents += cents;
    }
  }
  const per = toCents(policy.limits.perCallUsd);
  const paused = total + per > toCents(policy.limits.totalUsd) ? 'total'
    : daily + per > toCents(policy.limits.dailyUsd) ? 'daily' : null;
  return { today, daily, total, open, openCents, paused };
}

function initialPolicy(directory, limits, at) {
  for (const k of Object.keys(DEFAULT_LIMITS))
    need(limits[k] <= DEFAULT_LIMITS[k], 'compute_budget_increase_requires_approval',
      'a new compute budget cannot exceed the existing approved caps');
  const policy = { schema: POLICY_SCHEMA, limits, history: [{ at, limits, approvedBy: 'existing-approved-caps', reason: 'initial' }] };
  writeAtomic(directory, POLICY_FILE, JSON.stringify(policy, null, 2) + '\n');
  return policy;
}

/**
 * @param directory the existing project-manager worker directory (holds receipts.jsonl)
 * @param limits optional assertion; must match the persisted policy, or for a new
 *   directory must not exceed DEFAULT_LIMITS.
 */
export function openComputeBudget({ directory, now = () => Date.now(), limits, lockTimeoutMs = 5000 } = {}) {
  need(typeof directory === 'string' && typeof now === 'function' && Number.isInteger(lockTimeoutMs) && lockTimeoutMs > 0,
    'invalid_compute_budget_configuration');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const withLock = locker(directory, lockTimeoutMs);
  const at = () => new Date(now()).toISOString();
  withLock(() => {
    const policy = readPolicy(directory);
    const asserted = limits === undefined ? undefined : validLimits(limits);
    if (policy) {
      if (asserted) need(sameLimits(policy.limits, asserted), 'compute_budget_policy_mismatch', 'limits differ from the approved policy');
    } else initialPolicy(directory, asserted ?? DEFAULT_LIMITS, at());
    readRows(directory); // refuse a corrupt journal at open, not mid-run
  });
  const state = () => {
    const policy = readPolicy(directory);
    need(policy, 'compute_budget_policy_missing');
    const rows = readRows(directory);
    return { policy, rows, sum: summarize(rows, policy, now()) };
  };
  const save = (rows) => writeAtomic(directory, RECEIPTS_FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const report = ({ policy, rows, sum }) => Object.freeze({
    day: sum.today,
    limits: policy.limits,
    dailyUsd: toUsd(sum.daily),
    totalUsd: toUsd(sum.total),
    openReservations: sum.open,
    unknownUsd: toUsd(sum.openCents),
    receipts: rows.length,
    paused: sum.paused,
  });
  return {
    /** Atomically checks both caps and records a `perCallUsd` reservation. */
    reserve({ purpose, projectIds, model } = {}) {
      need(typeof purpose === 'string' && PURPOSE.test(purpose), 'invalid_compute_reservation', 'invalid purpose');
      need(Array.isArray(projectIds) && projectIds.length >= 1 && projectIds.length <= 100 &&
        projectIds.every((id) => typeof id === 'string' && PROJECT_ID.test(id)) && new Set(projectIds).size === projectIds.length,
      'invalid_compute_reservation', 'invalid projectIds');
      need(text(model, 1, 96), 'invalid_compute_reservation', 'invalid model');
      return withLock(() => {
        const current = state();
        if (current.sum.paused) return Object.freeze({ paused: current.sum.paused, ...report(current) });
        const row = {
          at: at(), projectIds: [...projectIds], model, costUsd: current.policy.limits.perCallUsd, status: 'reserved',
          id: 'cb-' + randomUUID(), purpose,
        };
        save([...current.rows, row]);
        return Object.freeze({ id: row.id, at: row.at, purpose, projectIds: Object.freeze([...projectIds]), model, reservedUsd: row.costUsd });
      });
    },
    /** Records the provider's return. A missing, negative or non-finite cost keeps the reservation amount. */
    settle(id, { costUsd, stopReason = null } = {}) {
      need(typeof id === 'string' && /^cb-[0-9a-f-]{36}$/.test(id), 'invalid_compute_settlement');
      return withLock(() => {
        const { rows } = state();
        const row = rows.find((r) => r.id === id);
        need(row, 'compute_reservation_not_found');
        need(row.status === 'reserved', 'compute_reservation_already_settled');
        if (Number.isFinite(costUsd) && costUsd >= 0) row.costUsd = costUsd;
        row.status = 'returned';
        row.stopReason = typeof stopReason === 'string' && text(stopReason, 1, 200) ? stopReason : null;
        row.settledAt = at();
        save(rows);
        return Object.freeze({ ...row });
      });
    },
    status: () => withLock(() => report(state())),
  };
}

/** The only way to change caps, including clearing a total exhaustion hold. */
export function approveBudgetChange({ directory, limits, approvedBy, reason, now = () => Date.now(), lockTimeoutMs = 5000 }) {
  need(typeof directory === 'string' && text(approvedBy, 1, 96) && text(reason, 8, 400), 'invalid_budget_approval');
  const next = validLimits(limits);
  return locker(directory, lockTimeoutMs)(() => {
    const policy = readPolicy(directory);
    need(policy, 'compute_budget_policy_missing');
    const at = new Date(now()).toISOString();
    const updated = { ...policy, limits: next, history: [...policy.history, { at, limits: next, approvedBy, reason }] };
    writeAtomic(directory, POLICY_FILE, JSON.stringify(updated, null, 2) + '\n');
    return Object.freeze({ limits: next, at });
  });
}
