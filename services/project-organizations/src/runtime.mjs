/** One bounded organization cycle: settle every native intent whose outcome is not
 * yet known, then let the scheduler run at most one job. New work never starts
 * while a reconciliation attempt failed, because an unknown signed intent may
 * still be included and must not be shadowed by fresh native writes. */
import { need } from './common.mjs';

export const RECONCILE_STATES = Object.freeze(['unknown', 'dispatched']);

/**
 * @param deps.journal   `{list({states}), get(id)}` from openJournal
 * @param deps.native    `{reconcile(intentId)}` from createNativeAdapter
 * @param deps.scheduler `{tick()}` from createScheduler
 * @param deps.stopRequested optional `() => boolean` operator stop check
 */
export async function runCycle({ journal, native, scheduler, stopRequested = () => false, maxReconcile = 64 } = {}) {
  need(typeof journal?.list === 'function' && typeof journal.get === 'function' && typeof native?.reconcile === 'function' && typeof scheduler?.tick === 'function',
    'invalid_runtime_configuration');
  need(Number.isInteger(maxReconcile) && maxReconcile >= 1 && maxReconcile <= 1000, 'invalid_runtime_configuration');
  if (stopRequested()) return { state: 'stopped', reconciled: [], failures: [], tick: null };

  // Only native intents settle through the native adapter. Paperclip creates carry a
  // different envelope and are settled by the organization adapter's own reconcile.
  const open = journal.list({ states: [...RECONCILE_STATES] }).filter((i) => i.kind === 'native');
  const reconciled = [];
  const failures = [];
  for (const intent of open.slice(0, maxReconcile)) {
    try {
      await native.reconcile(intent.id);
      // The journal, not the adapter's return value, is the durable outcome.
      reconciled.push({ id: intent.id, from: intent.state, to: journal.get(intent.id)?.state ?? 'unknown' });
    } catch (e) {
      failures.push({ id: intent.id, from: intent.state, reason: e?.code ?? 'reconcile_failed' });
    }
  }
  if (failures.length) return { state: 'held', reason: 'reconciliation_incomplete', reconciled, failures, tick: null };
  if (open.length > maxReconcile) return { state: 'held', reason: 'reconciliation_backlog', reconciled, failures, tick: null };
  if (stopRequested()) return { state: 'stopped', reconciled, failures, tick: null };
  const tick = await scheduler.tick();
  return { state: tick?.state ?? 'unknown', reconciled, failures, tick };
}
