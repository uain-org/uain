import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import {
  validateFundingSchedule,
  projectFundingReadiness,
} from '../server/funding-policy.mjs';
const amounts = [
  '10000',
  '100000',
  '1000000',
  '10000000',
  '100000000',
  '888890000',
];
const proposal = () => ({
  rounds: amounts.map((amount, i) => ({ round: i + 1, amount })),
  statedTotal: '1000000000',
});
test('six-round proposal uses exact native units and arithmetic only, without adoption', () => {
  const r = validateFundingSchedule(proposal());
  assert.equal(r.arithmeticValid, true);
  assert.equal(r.calculatedTotalUnits, '1000000000000000');
  assert.deepEqual(r.blockers, []);
  assert.equal(r.authorizesFunding, false);
});
test('literal source round6 repeats round3 and cannot reconcile stated total', () => {
  const p = proposal();
  p.rounds[5].amount = '1000000';
  const r = validateFundingSchedule(p);
  assert.equal(r.arithmeticValid, false);
  assert.equal(r.calculatedTotalUnits, '112110000000000');
  assert.deepEqual(r.blockers, [
    'round_amount_not_increasing',
    'stated_total_mismatch',
  ]);
  assert.equal(r.authorizesFunding, false);
});
test('funding schedule rejects malformed quantity types, hidden authority fields, bounds and skipped rounds', () => {
  for (const amount of [
    0,
    0.1,
    '0',
    '-1',
    '1e6',
    '1,000',
    '1.0000001',
    'NaN',
    '108000000000001',
  ]) {
    const p = proposal();
    p.rounds[0].amount = amount;
    assert.throws(() => validateFundingSchedule(p), /funding schedule/i);
  }
  for (const change of [
    (p) => p.rounds.pop(),
    (p) => p.rounds.push({ round: 7, amount: '1' }),
    (p) => (p.rounds[2].round = 4),
    (p) => (p.rounds[0].approved = true),
    (p) => (p.approved = true),
    (p) => (p.rounds[0].round = '1'),
    (p) => (p.statedTotal = 1111110000),
    (p) => (p.rounds = null),
  ]) {
    const p = proposal();
    change(p);
    assert.throws(() => validateFundingSchedule(p), /funding schedule/i);
  }
});
test('fractional native units remain exact and aggregate above native cap is blocked', () => {
  const p = {
    rounds: [
      '0.000001',
      '0.000002',
      '0.000003',
      '0.000004',
      '0.000005',
      '0.000006',
    ].map((amount, i) => ({ round: i + 1, amount })),
    statedTotal: '0.000021',
  };
  assert.equal(validateFundingSchedule(p).calculatedTotalUnits, '21');
  const large = proposal();
  large.rounds = Array.from({ length: 6 }, (_, i) => ({
    round: i + 1,
    amount: String(20000000000000 + i),
  }));
  large.statedTotal = '108000000000000';
  assert.ok(
    validateFundingSchedule(large).blockers.includes(
      'aggregate_exceeds_native_supply_cap',
    ),
  );
});
test('public funding readiness never discloses private amounts/source or implies an adopted fund', () => {
  const r = projectFundingReadiness();
  assert.equal(r.status, 'draft-unadopted');
  assert.equal(r.scheduleConfirmed, true);
  assert.ok(!r.blockers.includes('round_six_unconfirmed'));
  assert.equal(r.proposedRoundCount, 6);
  assert.equal(r.applicationRequired, true);
  assert.equal(r.advancementReviewRequired, true);
  assert.equal(r.directManagerGrant, false);
  assert.equal(r.policyAdopted, false);
  assert.equal(r.submissionAvailable, false);
  assert.equal(r.allocationAvailable, false);
  assert.equal(r.settlementAvailable, false);
  assert.equal(r.reviewer.configured, false);
  for (const key of ['issued', 'reserved', 'spendable'])
    assert.equal(r.funds[key], null);
  assert.match(r.revision, /^[a-f0-9]{64}$/);
  assert.equal(r.amountsPublished, false);
  const encoded = JSON.stringify(r);
  for (const value of [
    '1111110000',
    '112110000',
    '179355',
    'slack.com',
    '1000000000',
  ])
    assert.ok(!encoded.includes(value));
  r.reviewer.configured = true;
  r.funds.spendable = 'fake';
  assert.equal(projectFundingReadiness().reviewer.configured, false);
  assert.equal(projectFundingReadiness().funds.spendable, null);
});

test('six ordered rounds require six present rows even in a sparse internal array', () => {
  const p = proposal();
  delete p.rounds[2];
  p.statedTotal = '1110110000';
  assert.throws(() => validateFundingSchedule(p), /funding schedule/i);
});
test('revision binds the whole readiness snapshot as well as normalized private proposal', () => {
  const { revision, ...readiness } = projectFundingReadiness();
  const literal = proposal();
  const fingerprint = (readiness) =>
    createHash('sha256')
      .update(JSON.stringify({ proposal: literal, readiness }))
      .digest('hex');
  assert.equal(revision, fingerprint(readiness));
  readiness.reviewer.model = 'different-review-concept';
  assert.notEqual(revision, fingerprint(readiness));
});
