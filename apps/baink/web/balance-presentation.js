/** Presentation only. Network readiness may explain an unavailable amount; it
 * can never establish a member, account proof or a spendable balance. */
import { nativeProofFreshness } from './native-balance.js';
const short = {
  checking: 'Checking balance',
  asset_inactive: 'AI$ not active',
  member_missing: 'UAIN not joined',
  licence_pending: 'Membership approval pending',
  licence_inactive: 'Membership inactive',
  proof_unavailable: 'Balance check unavailable',
  policy_mismatch: 'Asset policy mismatch',
};
export function presentationBalance(ledger, network, { now = Date.now() } = {}) {
  if (ledger.available)
    return { ...ledger, headerLabel: `${ledger.amount} AI$` };
  const sameContext = !ledger.proof ||
    (ledger.proof.chainId === network?.proof?.chainId &&
      ledger.proof.epoch === network?.proof?.epoch);
  if (sameContext && network?.verified === true &&
      network.status === 'asset_inactive' && network.assetStatus === 'inactive' &&
      nativeProofFreshness(network.proof, { now }).fresh) {
    return {
      ...ledger,
      state: 'asset_inactive',
      headerLabel: short.asset_inactive,
      label: 'AI$ is not active on the network yet',
      message: 'The network has not activated AI$ yet, so a spendable balance and payments are unavailable. Your BAINK account is ready; joining UAIN does not activate the currency.',
    };
  }
  return { ...ledger, headerLabel: short[ledger.state] ?? 'Balance unavailable' };
}
