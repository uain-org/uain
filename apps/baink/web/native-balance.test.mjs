import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nativeBalanceView as balanceAtTime,
  watchNativeProof,
  clearNativeAuthority,
} from './native-balance.js';
const NOW = Date.parse('2026-10-31T12:00:30Z');
const nativeBalanceView = (account, options = {}) =>
  balanceAtTime(account, { now: NOW, ...options });
const ready = () => ({
  nativeRegistration: 'verified',
  balanceScope: 'transparent',
  balance: '108000000000000.000000',
  asset: {
    balanceScope: 'transparent',
    id: 'uain-native-coin',
    symbol: 'AI$',
    sameLedger: true,
    decimals: 6,
    unitsPerCoin: '1000000',
    coinPolicy: 'verified-bounties-108t-micro-v1',
    supplyCapUnits: '108000000000000000000',
  },
  native: {
    memberStatus: 'active',
    balanceScope: 'transparent',
    status: 'ready',
    verified: true,
    balanceUnits: '108000000000000000000',
    checkedAt: '2026-10-31T12:00:00Z',
    proof: {
      authority: 'native',
      chainId: 'uain-native',
      height: '123',
      headerTime: '2026-10-31T12:00:00Z',
      maxAgeSeconds: 120,
    },
  },
});
test('verified native balances display the existing asset exactly, including a zero balance', () => {
  const account = ready();
  const view = nativeBalanceView(account);
  assert.equal(view.available, true);
  assert.equal(view.amount, '108,000,000,000,000');
  assert.equal(view.membershipVerified, true);
  account.balance = '0.000000';
  account.native.balanceUnits = '0';
  assert.equal(nativeBalanceView(account).amount, '0');
  account.balance = '0.000001';
  account.native.balanceUnits = '1';
  assert.equal(nativeBalanceView(account).amount, '0.000001');
});
test('native readiness distinguishes inactive policy, missing membership, licences, and proof failure', () => {
  for (const status of [
    'asset_inactive',
    'proof_unavailable',
    'member_missing',
    'licence_pending',
    'licence_inactive',
    'policy_mismatch',
  ]) {
    const account = ready();
    account.native.status = status;
    account.balance = null;
    const view = nativeBalanceView(account);
    assert.equal(view.available, false);
    assert.equal(view.state, status);
    assert.equal(view.amount, '—');
  }
});
test('malformed or mismatched units, asset identity, policy, and unverified proofs never become balances', () => {
  const changes = [
    (a) => delete a.balanceScope,
    (a) => (a.balanceScope = 'total'),
    (a) => delete a.native.balanceScope,
    (a) => (a.asset.balanceScope = 'total'),
    (a) => (a.balance = 108000000000000),
    (a) => (a.native.balanceUnits = '1'),
    (a) => (a.asset.sameLedger = false),
    (a) => (a.asset.coinPolicy = 'other-policy'),
    (a) => (a.asset.decimals = 18),
    (a) => (a.native.verified = false),
    (a) => (a.native.proof.authority = 'untrusted'),
    (a) => (a.nativeRegistration = 'unavailable'),
  ];
  for (const change of changes) {
    const account = ready();
    change(account);
    const view = nativeBalanceView(account);
    assert.equal(view.available, false);
    assert.equal(view.amount, '—');
  }
  assert.equal(nativeBalanceView(null).available, false);
});

test('the current native adapter metadata qualifies an exact balance beyond Number base-unit precision', async () => {
  const { assetMetadata, formatNativeUnits } =
    await import('../server/native-asset.mjs');
  const account = ready();
  account.asset = assetMetadata();
  account.balance = formatNativeUnits('9007199254740993');
  account.native.balanceUnits = '9007199254740993';
  const view = nativeBalanceView(account);
  assert.equal(view.available, true);
  assert.equal(view.amount, '9,007,199,254.740993');
});

test('a displayed balance and membership expire at the native proof deadline without a new response', () => {
  const account = ready();
  const fresh = nativeBalanceView(account, {
    now: Date.parse('2026-10-31T12:01:59.999Z'),
  });
  assert.equal(fresh.available, true);
  assert.equal(fresh.membershipVerified, true);
  const expired = nativeBalanceView(account, {
    now: Date.parse('2026-10-31T12:02:00Z'),
  });
  assert.equal(expired.amount, '—');
  assert.equal(expired.available, false);
  assert.equal(expired.membershipVerified, false);
  assert.equal(expired.state, 'proof_unavailable');
});
test('invalid, over-age, or future-dated proof metadata cannot qualify native balances or member badges', () => {
  const changes = [
    (a) => delete a.native.proof.headerTime,
    (a) => (a.native.proof.headerTime = 'invalid'),
    (a) => (a.native.proof.headerTime = '2026-02-31T12:00:00Z'),
    (a) => (a.native.proof.headerTime = '2026-10-31T12:01:30.001Z'),
    (a) => delete a.native.proof.maxAgeSeconds,
    (a) => (a.native.proof.maxAgeSeconds = 121),
    (a) => (a.native.proof.maxAgeSeconds = 0),
    (a) => (a.native.proof.maxAgeSeconds = -1),
    (a) => (a.native.proof.maxAgeSeconds = 1.5),
    (a) => (a.native.proof.maxAgeSeconds = '120'),
    (a) => (a.native.proof.maxAgeSeconds = NaN),
  ];
  for (const change of changes) {
    const account = ready();
    change(account);
    const view = nativeBalanceView(account);
    assert.equal(view.available, false);
    assert.equal(view.membershipVerified, false);
    assert.equal(view.amount, '—');
  }
  const boundary = ready();
  boundary.native.proof.headerTime = '2026-10-31T12:01:30Z';
  assert.equal(nativeBalanceView(boundary).available, true);
});

test('the expiry watcher clears displayed authority at the exact proof deadline even without a refresh response', () => {
  let now = NOW,
    account = ready(),
    scheduled;
  watchNativeProof(
    account.native.proof,
    () => {
      account = clearNativeAuthority(account);
    },
    {
      now: () => now,
      setTimer: (callback, delay) => {
        scheduled = { callback, delay };
        return 1;
      },
      clearTimer: () => {},
    },
  );
  assert.equal(scheduled.delay, 90000);
  now += 89999;
  assert.equal(nativeBalanceView(account, { now }).available, true);
  now += 1;
  scheduled.callback();
  const view = nativeBalanceView(account, { now });
  assert.equal(view.amount, '—');
  assert.equal(view.membershipVerified, false);
  assert.equal(account.native.verified, false);
});
test('a failed account refresh removes native authority while retaining editable profile identity', () => {
  const account = ready();
  account.displayName =
    'Unsaved profile remains outside refreshed native state';
  account.address = 'uain1' + 'a'.repeat(40);
  const failed = clearNativeAuthority(account);
  assert.equal(failed.displayName, account.displayName);
  assert.equal(failed.address, account.address);
  assert.equal(failed.native.proof, null);
  const view = nativeBalanceView(failed);
  assert.equal(view.amount, '—');
  assert.equal(view.membershipVerified, false);
  assert.equal(view.state, 'proof_unavailable');
});

test('a fresh proven identity with a pending or revoked licence never receives the active-member badge', () => {
  for (const [memberStatus, status] of [
    ['pending', 'licence_pending'],
    ['inactive', 'licence_inactive'],
    ['revoked', 'licence_inactive'],
  ]) {
    const account = ready();
    account.native.memberStatus = memberStatus;
    account.native.status = status;
    account.balance = null;
    const view = nativeBalanceView(account);
    assert.equal(view.membershipVerified, false);
    assert.equal(view.available, false);
    assert.equal(view.state, status);
  }
});
