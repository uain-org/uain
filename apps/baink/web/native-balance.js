import { decimalToUnits, formatAmount } from './exact-amount.js';
const COIN_POLICY = 'verified-bounties-108t-micro-v1';
const CAP_UNITS = '108000000000000000000';
const states = {
  ready: [
    'Your balance',
    'Checked on the UAIN network just now.',
  ],
  asset_inactive: [
    'AI$ is not switched on yet',
    'Your balance shows once AI$ is switched on for the network.',
  ],
  proof_unavailable: [
    'We couldn’t check your balance just now',
    'Try Refresh in a moment.',
  ],
  member_missing: [
    'Join UAIN to see your balance',
    'Joining is free and takes one signature. Paid tasks need it too.',
  ],
  licence_pending: [
    'Your membership is waiting for approval',
    'This usually takes a few minutes. Your balance shows once it is approved.',
  ],
  licence_inactive: [
    'Your membership is not active',
    'Your balance shows again once your membership is active.',
  ],
  policy_mismatch: [
    'Balances are unavailable right now',
    'UAIN is fixing this. Nothing in your account has changed.',
  ],
};

/** Only a bounded, valid native header can establish a current display claim. */
export function nativeProofFreshness(proof, { now = Date.now() } = {}) {
  const invalid = { fresh: false, expiresAt: null };
  if (
    proof?.authority !== 'native' ||
    !Number.isFinite(now) ||
    !Number.isInteger(proof.maxAgeSeconds) ||
    proof.maxAgeSeconds < 1 ||
    proof.maxAgeSeconds > 120 ||
    typeof proof.headerTime !== 'string'
  )
    return invalid;
  const parts = proof.headerTime.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/,
  );
  if (!parts) return invalid;
  const [, year, month, day, hour, minute, second] = parts.map(Number);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return invalid;
  const headerTime = Date.parse(proof.headerTime);
  if (!Number.isFinite(headerTime) || headerTime > now + 60000) return invalid;
  const expiresAt = headerTime + proof.maxAgeSeconds * 1000;
  return { fresh: now < expiresAt, expiresAt };
}
export function clearNativeAuthority(account) {
  if (!account) return account;
  return {
    ...account,
    balance: null,
    nativeRegistration: 'unavailable',
    native: {
      ...account.native,
      status: 'proof_unavailable',
      verified: false,
      memberStatus: 'unknown',
      balanceUnits: null,
      proof: null,
    },
  };
}
export function watchNativeProof(
  proof,
  onExpire,
  { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {},
) {
  const observed = nativeProofFreshness(proof, { now: now() });
  if (!observed.fresh) return () => {};
  const timer = setTimer(onExpire, Math.max(0, observed.expiresAt - now()));
  return () => clearTimer(timer);
}

/** Display authority follows the verified account response, never a local profile or a truthy amount. */
export function nativeBalanceView(account, { now = Date.now() } = {}) {
  const native = account?.native,
    asset = account?.asset;
  const freshness = nativeProofFreshness(native?.proof, { now });
  const membershipVerified =
    native?.verified === true &&
    freshness.fresh &&
    native.memberStatus === 'active' &&
    account?.nativeRegistration === 'verified';
  let state =
    native?.verified === true &&
    freshness.fresh &&
    Object.hasOwn(states, native?.status)
      ? native.status
      : 'proof_unavailable';
  let amount = '—',
    available = false;
  if (state === 'ready') {
    const expectedAsset =
      asset?.id === 'uain-native-coin' &&
      asset.sameLedger === true &&
      asset.decimals === 6 &&
      asset.unitsPerCoin === '1000000' &&
      asset.coinPolicy === COIN_POLICY &&
      asset.supplyCapUnits === CAP_UNITS;
    if (!expectedAsset) state = 'policy_mismatch';
    else if (
      !membershipVerified ||
      account.balanceScope !== 'transparent' ||
      native.balanceScope !== 'transparent' ||
      asset.balanceScope !== 'transparent'
    )
      state = 'proof_unavailable';
    else
      try {
        const units = decimalToUnits(account.balance);
        if (units !== native.balanceUnits || BigInt(units) > BigInt(CAP_UNITS))
          throw new Error('Balance does not match native units');
        amount = formatAmount(account.balance);
        available = true;
      } catch {
        state = 'proof_unavailable';
      }
  }
  const [label, message] = states[state];
  return {
    state,
    available,
    amount,
    label,
    message,
    membershipVerified,
    checkedAt: native?.checkedAt ?? null,
    expiresAt: freshness.expiresAt,
    proof: native?.proof ?? null,
  };
}
