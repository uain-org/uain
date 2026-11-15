import test from 'node:test';
import assert from 'node:assert/strict';
import { canReleaseRetainedTerms } from './trade-terms-recovery.js';

const retained = { kind: 'update', body: { clientRequestId: 'trade-terms-1' } };

test('an unrecognised error does not lock terms editing for good', () => {
  // Every retry failed with a code the browser does not know.
  const failed = { retained, lastCode: 'internal_error', readsAtFailure: 3, reads: 3 };
  assert.equal(canReleaseRetainedTerms(failed), false, 'not before the member has seen a fresh list');
  assert.equal(canReleaseRetainedTerms({ ...failed, reads: 4 }), true, 'a newer list read offers the escape');
  assert.equal(canReleaseRetainedTerms({ ...failed, lastCode: null, reads: 4 }), true, 'an error with no code too');
});

test('a rate-limited request stays retained for its exact retry', () => {
  for (const lastCode of ['terms_rate_limited', 'trade_rate_limited'])
    assert.equal(canReleaseRetainedTerms({ retained, lastCode, readsAtFailure: 0, reads: 9 }), false);
});

test('nothing to release while a request or list read is running, or with no retained request', () => {
  assert.equal(canReleaseRetainedTerms({ retained, readsAtFailure: 0, reads: 1, pending: true }), false);
  assert.equal(canReleaseRetainedTerms({ retained: null, readsAtFailure: 0, reads: 1 }), false);
});

test('a request restored from an earlier tab can be released after the first list read', () => {
  assert.equal(canReleaseRetainedTerms({ retained: { ...retained, restored: true }, readsAtFailure: 0, reads: 0 }), false);
  assert.equal(canReleaseRetainedTerms({ retained: { ...retained, restored: true }, readsAtFailure: 0, reads: 1 }), true);
});
