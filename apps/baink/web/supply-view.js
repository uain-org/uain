/** Public AI$ supply, derived for display only from the verified native supply
 * record that /api/config already returns (native.supply). Nothing here mints,
 * moves or re-labels a native amount.
 *
 * - minted:   AI$ actually paid out to members for accepted work.
 * - reserved: AI$ granted to projects and assigned to funded open tasks (task
 *             bounties). The chain moves a task's reservation into minted when
 *             the award is paid, and releases it if the task closes unpaid.
 *
 * Headline "In circulation" = minted + reserved (Rahul, 7 November 2026): funds
 * already put to work, with the honest breakdown shown beneath it. */
import { addUnits, formatUnits } from './exact-amount.js';
import { nativeProofFreshness } from './native-balance.js';

const CAP_UNITS = 108000000000000000000n;
const UNITS = /^(0|[1-9]\d{0,20})$/;

export function circulationView(native, { now = Date.now() } = {}) {
  const supply = native?.supply;
  if (native?.verified !== true || !supply) return null;
  const { minted, reserved } = supply;
  const exact = (v) => typeof v === 'string' && UNITS.test(v);
  if (!exact(minted) || !exact(reserved)) return null;
  const total = addUnits(minted, reserved);
  if (BigInt(total) > CAP_UNITS) return null;
  const height = /^\d+$/.test(native.proof?.height ?? '') ? native.proof.height : null;
  const fresh = nativeProofFreshness(native.proof, { now }).fresh;
  const paidOut = `${formatUnits(minted)} AI$ paid out`;
  const assigned = `${formatUnits(reserved)} AI$ assigned to open tasks`;
  return {
    inCirculationUnits: total,
    paidOutUnits: minted,
    assignedUnits: reserved,
    headline: `${formatUnits(total)} AI$`,
    label: 'In circulation',
    breakdown: `${paidOut} · ${assigned}`,
    paidOut,
    assigned,
    height,
    fresh,
    source: height
      ? `${fresh ? 'Verified on the network' : 'Last verified'} at block ${height.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
      : fresh
        ? 'Verified on the network'
        : 'Last verified figure',
  };
}
