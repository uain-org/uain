import type { Hex } from 'viem';
import { anchorParameters, dateForDay, dayNumber, validateRoot, type AnchorParameters, type PinnedKey, type SignedRoot } from './root.js';
import { recoverOperation, runOperation, type Journal } from './journal.js';
import { createHash } from 'node:crypto';

export interface StoredAnchor { root: Hex; head: Hex; count: bigint; lastEventId: bigint; anchoredAt: bigint }
export function compareAnchor(stored: StoredAnchor, params: AnchorParameters): 'absent' | 'matches' {
  if (stored.anchoredAt === 0n) {
    if (stored.count !== 0n || stored.lastEventId !== 0n || !/^0x0{64}$/i.test(stored.root) || !/^0x0{64}$/i.test(stored.head)) throw new Error('Inconsistent absent anchor');
    return 'absent';
  }
  if (stored.root.toLowerCase() !== params[1] || stored.head.toLowerCase() !== params[2] || stored.count !== params[3] || stored.lastEventId !== params[4]) throw new Error('On-chain anchor conflict; refusing a replacement');
  return 'matches';
}
export function dateWindows(from: string, to: string): { from: string; to: string }[] {
  const start = dayNumber(from), end = dayNumber(to);
  if (start > end || end - start > 3660) throw new Error('Scan range must be ordered and at most ten years');
  const windows = [];
  for (let day = start; day <= end; day += 366) windows.push({ from: dateForDay(day), to: dateForDay(Math.min(end, day + 365)) });
  return windows;
}
export function catchupStart(lastDay: number, configuredStart: string | undefined, requested: string | undefined): string {
  const earliest = lastDay === 0 ? configuredStart : dateForDay(lastDay + 1);
  if (!earliest) throw new Error('Missing LEDGER_ANCHOR_START_DATE');
  const start = requested ?? earliest;
  if (dayNumber(start) > dayNumber(earliest)) throw new Error('Catch-up start would skip an uncovered range');
  return start;
}
export function planCatchup(values: unknown[], key: PinnedKey, options: { from: string; to: string; lastDay: number; limit: number; now?: Date }): SignedRoot[] {
  const from = dayNumber(options.from), to = dayNumber(options.to);
  if (from > to || !Number.isInteger(options.limit) || options.limit < 1 || options.limit > 31 || !Number.isSafeInteger(options.lastDay) || options.lastDay < 0) throw new Error('Invalid catch-up bounds');
  const roots = values.map(value => validateRoot(value, key, options.now));
  const dates = new Set<string>();
  for (const root of roots) {
    const day = dayNumber(root.date);
    if (day < from || day > to) throw new Error('Root outside requested range');
    if (dates.has(root.date)) throw new Error('Root list contains a duplicate date');
    dates.add(root.date);
  }
  const ordered = roots.filter(r => r.count > 0).sort((a, b) => a.date.localeCompare(b.date));
  let previousId = 0;
  for (const root of ordered) {
    if (root.first_id === null || root.last_id === null || root.first_id <= previousId) throw new Error('Nonmonotonic event ids across days');
    previousId = root.last_id;
  }
  return ordered.filter(r => dayNumber(r.date) > options.lastDay).slice(0, options.limit);
}
export interface AnchorPort {
  read(day: number): Promise<StoredAnchor>;
  readConfirmed(day: number): Promise<StoredAnchor>;
  simulate(params: AnchorParameters): Promise<void>;
  send(params: AnchorParameters): Promise<Hex>;
  confirm(hash: Hex): Promise<void>;
}
export async function auditRoot(root: SignedRoot, port: Pick<AnchorPort, 'read'>): Promise<'absent' | 'matches'> {
  const params = anchorParameters(root);
  return compareAnchor(await port.read(params[0]), params);
}
export function anchorFingerprint(root: SignedRoot, binding: string): string {
  return createHash('sha256').update(JSON.stringify({ binding, root })).digest('hex');
}
/** Preflight all roots before the first write; stop on the first uncertain result. */
export async function executeAnchors(roots: SignedRoot[], port: AnchorPort, journal: Journal, binding: string, recover = false): Promise<void> {
  if (!recover && Object.values(journal.data.operations).some(op => op.state !== 'confirmed')) throw new Error('Journal contains an uncertain operation; read-only recovery is required');
  const prepared = [];
  let previousDay = -1;
  for (const root of roots) {
    const params = anchorParameters(root);
    if (params[0] <= previousDay) throw new Error('Anchoring batch must be chronological');
    previousDay = params[0];
    const status = compareAnchor(await port.read(params[0]), params);
    const op = journal.data.operations[`anchor:${root.date}`];
    const fingerprint = anchorFingerprint(root, binding);
    if (op && op.plan !== fingerprint) throw new Error('Journal plan differs from this anchor');
    if (status === 'absent' && op?.state === 'confirmed') throw new Error('Confirmed anchor is absent; inspect chain reorganization');
    if (status === 'absent' && op && !recover) throw new Error('Operation requires read-only recovery');
    if (status === 'matches' && op && op.state !== 'confirmed' && !recover) throw new Error('Existing anchor requires read-only recovery');
    if (recover && status === 'absent') throw new Error('Recovery cannot prove an anchor; no resubmission occurred');
    prepared.push({ root, params, status, fingerprint, op });
  }
  // All simulations run before broadcasting. Later simulations still see the
  // current lastDay; signed range monotonicity is checked by planCatchup.
  if (!recover) for (const item of prepared) if (item.status === 'absent') await port.simulate(item.params);
  for (const { root, params, status, fingerprint, op } of prepared) {
    const id = `anchor:${root.date}`;
    if (status === 'matches') {
      if (op && op.state !== 'confirmed') {
        if (!recover) throw new Error('Existing anchor requires read-only journal recovery');
        await recoverOperation(journal, id, fingerprint, async pending => {
          if (pending.hash) await port.confirm(pending.hash);
          if (compareAnchor(await port.readConfirmed(params[0]), params) !== 'matches') throw new Error('Anchor recovery requires confirmed read-back');
        });
      }
      continue;
    }
    await runOperation(journal, id, fingerprint, () => port.send(params), async hash => {
      await port.confirm(hash);
      if (await auditRoot(root, port) !== 'matches') throw new Error('Receipt succeeded but anchor is absent');
    });
  }
}
