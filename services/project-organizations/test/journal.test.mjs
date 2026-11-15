import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INTENT_STATES, openJournal } from '../src/journal.mjs';

const dirs = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'uain-journal-'));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const refuses = (fn, code) => assert.throws(fn, (e) => e.code === code, `expected ${code}`);
const SIGNER = 'uain1' + 'a'.repeat(40);
const OTHER_SIGNER = 'uain1' + 'b'.repeat(40);
const intent = (id, overrides = {}) => ({
  id,
  projectId: 'OPP-00002',
  kind: 'native',
  operation: 'central_task_open',
  payload: { id, amount: '1000000' },
  selectionDigest: '1'.repeat(64),
  sourceDigest: '2'.repeat(64),
  signer: SIGNER,
  ...overrides,
});
const envelope = (id) => ({ command: { operation: 'central_task_open', sequence: '7', payload: { id } }, signature: 'sig' });
/** A journal with a controllable clock. */
function fixture(directory = tempDir()) {
  const clock = { t: 1_000_000 };
  const journal = openJournal({ directory, now: () => clock.t });
  return { journal, clock, directory, reopen: () => openJournal({ directory, now: () => clock.t }) };
}

test('the journal file is private and the state set is fixed', () => {
  const { journal, directory } = fixture();
  assert.equal(statSync(join(directory, 'journal.sqlite')).mode & 0o777, 0o600);
  assert.deepEqual([...INTENT_STATES], ['prepared', 'claimed', 'dispatched', 'unknown', 'confirmed', 'failed']);
  assert.ok(Object.isFrozen(INTENT_STATES));
  journal.close();
});

test('prepare is idempotent on the stable operation id', () => {
  const { journal, clock } = fixture();
  const first = journal.prepare(intent('op-1'));
  assert.equal(first.state, 'prepared');
  assert.match(first.payloadHash, /^[a-f0-9]{64}$/);
  clock.t += 5000;
  const second = journal.prepare(intent('op-1'));
  assert.deepEqual(second, first);
  assert.equal(journal.list().length, 1);
  // Key order in the payload does not matter: the hash is canonical.
  assert.equal(journal.prepare(intent('op-1', { payload: { amount: '1000000', id: 'op-1' } })).payloadHash, first.payloadHash);
  journal.close();
});

test('prepare does not reset an intent that has already progressed', () => {
  const { journal } = fixture();
  journal.prepare(intent('op-1'));
  journal.claim('op-1', 'worker-a');
  assert.equal(journal.prepare(intent('op-1')).state, 'claimed');
  journal.close();
});

test('a different intent under an existing operation id is refused', () => {
  const { journal } = fixture();
  journal.prepare(intent('op-1', { expectedRevision: 'rev-1' }));
  for (const change of [
    { payload: { id: 'op-1', amount: '1000001' } },
    { projectId: 'OPP-00003' },
    { operation: 'central_submit' },
    { signer: OTHER_SIGNER },
    { sourceDigest: '3'.repeat(64) },
    { selectionDigest: '4'.repeat(64) },
    { expectedRevision: 'rev-2' },
    { expectedRevision: null },
    { kind: 'paperclip', signer: SIGNER },
  ]) refuses(() => journal.prepare(intent('op-1', { expectedRevision: 'rev-1', ...change })), 'intent_payload_conflict');
  assert.equal(journal.get('op-1').payload.amount, '1000000');
  journal.close();
});

test('malformed intents are refused', () => {
  const { journal } = fixture();
  for (const bad of [
    intent('-leading-dash'),
    intent('x'.repeat(97)),
    intent('op', { projectId: 'P-OPP-00002' }),
    intent('op', { kind: 'other' }),
    intent('op', { operation: 'Central' }),
    intent('op', { payload: [] }),
    intent('op', { payload: 'text' }),
    intent('op', { selectionDigest: 'x' }),
    intent('op', { sourceDigest: 'A'.repeat(64) }),
    intent('op', { signer: 'manager-agent' }),
    intent('op', { expectedRevision: '' }),
    { ...intent('op'), extra: true },
    null,
  ]) refuses(() => journal.prepare(bad), 'invalid_intent');
  assert.equal(journal.prepare(intent('op-p', { kind: 'paperclip', signer: 'paperclip-reconciler' })).state, 'prepared');
  assert.equal(journal.list().length, 1);
  journal.close();
});

test('one signer lane is held across all projects until the open intent settles', () => {
  const { journal } = fixture();
  journal.prepare(intent('a', { projectId: 'OPP-00002' }));
  journal.prepare(intent('b', { projectId: 'OPP-00003' }));
  journal.prepare(intent('c', { projectId: 'OPP-00004', signer: OTHER_SIGNER }));
  journal.claim('a', 'worker-1');
  refuses(() => journal.claim('b', 'worker-2'), 'signer_lane_busy');
  assert.equal(journal.claim('c', 'worker-2').state, 'claimed', 'a different signer has its own lane');
  journal.recordEnvelope('a', envelope('a'));
  refuses(() => journal.claim('b', 'worker-2'), 'signer_lane_busy');
  journal.markUnknown('a');
  refuses(() => journal.claim('b', 'worker-2'), 'signer_lane_busy');
  journal.recordReceipt('a', { height: '10', tx: 'abc' });
  assert.equal(journal.claim('b', 'worker-2').state, 'claimed');
  journal.close();
});

test('the signer lane survives a restart', () => {
  const f = fixture();
  f.journal.prepare(intent('a'));
  f.journal.prepare(intent('b', { projectId: 'OPP-00003' }));
  f.journal.claim('a', 'worker-1');
  f.journal.close();
  const j = f.reopen();
  refuses(() => j.claim('b', 'worker-2'), 'signer_lane_busy');
  j.close();
});

test('a failed intent frees the lane; only prepared intents can be claimed', () => {
  const { journal } = fixture();
  journal.prepare(intent('a'));
  journal.prepare(intent('b', { projectId: 'OPP-00003' }));
  journal.claim('a', 'w');
  refuses(() => journal.claim('a', 'w'), 'intent_state_conflict');
  journal.fail('a', 'custody refused the payload');
  assert.equal(journal.get('a').failure, 'custody refused the payload');
  refuses(() => journal.claim('a', 'w'), 'intent_state_conflict');
  assert.equal(journal.claim('b', 'w').state, 'claimed');
  refuses(() => journal.claim('b', ''), 'invalid_owner');
  refuses(() => journal.claim('missing', 'w'), 'intent_not_found');
  journal.close();
});

test('the exact signed envelope is retained before dispatch and survives a crash', () => {
  const f = fixture();
  f.journal.prepare(intent('a'));
  refuses(() => f.journal.recordEnvelope('a', envelope('a')), 'intent_state_conflict');
  f.journal.claim('a', 'w');
  const dispatched = f.journal.recordEnvelope('a', envelope('a'));
  assert.equal(dispatched.state, 'dispatched');
  assert.deepEqual(dispatched.envelope, envelope('a'));
  refuses(() => f.journal.recordEnvelope('a', envelope('other')), 'envelope_already_retained');
  refuses(() => f.journal.recordEnvelope('a', 'raw'), 'invalid_envelope');
  f.journal.close();
  const j = f.reopen();
  assert.deepEqual(j.get('a').envelope, envelope('a'));
  assert.equal(j.get('a').state, 'dispatched');
  j.close();
});

test('after a crash a signed intent is unknown and never returns to prepared or gets re-signed', () => {
  const f = fixture();
  f.journal.prepare(intent('a'));
  f.journal.claim('a', 'w');
  f.journal.recordEnvelope('a', envelope('a'));
  f.journal.close(); // process death after signing
  const j = f.reopen();
  assert.equal(j.markUnknown('a').state, 'unknown');
  for (let i = 0; i < 3; i++) assert.equal(j.reconcile('a', { found: false }).state, 'unknown');
  assert.equal(j.reconcile('a', { found: false, expired: false }).state, 'unknown');
  refuses(() => j.claim('a', 'w'), 'intent_state_conflict');
  refuses(() => j.recordEnvelope('a', envelope('a')), 'envelope_already_retained');
  refuses(() => j.fail('a', 'give up'), 'intent_state_conflict');
  assert.equal(j.prepare(intent('a')).state, 'unknown', 're-preparing does not reset it');
  assert.deepEqual(j.get('a').envelope, envelope('a'));
  j.close();
});

test('a signed unknown intent is confirmed by an authoritative observation or receipt', () => {
  const { journal } = fixture();
  for (const id of ['a', 'b']) {
    journal.prepare(intent(id, { signer: id === 'a' ? SIGNER : OTHER_SIGNER }));
    journal.claim(id, 'w');
    journal.recordEnvelope(id, envelope(id));
    journal.markUnknown(id);
  }
  refuses(() => journal.reconcile('a', { found: true }), 'invalid_observation');
  const a = journal.reconcile('a', { found: true, proof: { height: '9' } });
  assert.equal(a.state, 'confirmed');
  assert.deepEqual(a.receipt, { height: '9' });
  assert.equal(journal.recordReceipt('b', { height: '11' }).state, 'confirmed');
  refuses(() => journal.reconcile('a', { found: false }), 'intent_state_conflict');
  refuses(() => journal.markUnknown('a'), 'intent_state_conflict');
  refuses(() => journal.recordReceipt('a', { height: '12' }), 'intent_state_conflict');
  journal.close();
});

test('an unsigned claimed or unknown intent returns to prepared when the outcome is absent', () => {
  const { journal } = fixture();
  journal.prepare(intent('a'));
  journal.claim('a', 'w');
  journal.markUnknown('a');
  const back = journal.reconcile('a', { found: false });
  assert.equal(back.state, 'prepared');
  assert.equal(back.owner, null);
  assert.equal(back.envelope, null);
  journal.claim('a', 'w2');
  assert.equal(journal.reconcile('a', { found: false, expired: true }).state, 'prepared', 'no envelope means nothing could expire');
  assert.equal(journal.claim('a', 'w3').owner, 'w3');
  journal.close();
});

test('a signed intent fails only once authoritative state shows its envelope expired unincluded', () => {
  const { journal } = fixture();
  journal.prepare(intent('a'));
  journal.prepare(intent('b', { projectId: 'OPP-00003' }));
  journal.claim('a', 'w');
  journal.recordEnvelope('a', envelope('a'));
  journal.markUnknown('a');
  const failed = journal.reconcile('a', { found: false, expired: true });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.failure, 'expired_unincluded');
  refuses(() => journal.reconcile('a', { found: true, proof: {} }), 'intent_state_conflict');
  assert.equal(journal.claim('b', 'w').state, 'claimed', 'lane freed');
  journal.close();
});

test('reconcile refuses malformed observations and settled intents', () => {
  const { journal } = fixture();
  journal.prepare(intent('a'));
  refuses(() => journal.reconcile('a', { found: false }), 'intent_state_conflict');
  journal.claim('a', 'w');
  for (const bad of [null, {}, { found: 'no' }, []]) refuses(() => journal.reconcile('a', bad), 'invalid_observation');
  refuses(() => journal.markUnknown('missing'), 'intent_not_found');
  journal.close();
});

test('list filters by project and state; get returns null for unknown ids', () => {
  const { journal, clock } = fixture();
  journal.prepare(intent('a'));
  clock.t += 1;
  journal.prepare(intent('b', { projectId: 'OPP-00003' }));
  clock.t += 1;
  journal.prepare(intent('c', { signer: OTHER_SIGNER }));
  journal.claim('c', 'w');
  assert.deepEqual(journal.list().map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual(journal.list({ projectId: 'OPP-00002' }).map((r) => r.id), ['a', 'c']);
  assert.deepEqual(journal.list({ states: ['claimed'] }).map((r) => r.id), ['c']);
  assert.equal(journal.get('missing'), null);
  journal.close();
});

test('a work lease is exclusive until it expires', () => {
  const { journal, clock } = fixture();
  const lease = journal.acquireLease('task:T-1', 'solver-a', 60_000);
  assert.deepEqual(lease, { key: 'task:T-1', owner: 'solver-a', expiresAt: clock.t + 60_000, attempt: 1 });
  assert.equal(journal.acquireLease('task:T-1', 'solver-b', 60_000), null);
  clock.t += 30_000;
  const renewed = journal.acquireLease('task:T-1', 'solver-a', 60_000);
  assert.equal(renewed.attempt, 1, 'renewal by the holder is the same attempt');
  assert.equal(renewed.expiresAt, clock.t + 60_000);
  clock.t += 59_999;
  assert.equal(journal.acquireLease('task:T-1', 'solver-b', 60_000), null);
  clock.t += 1;
  const taken = journal.acquireLease('task:T-1', 'solver-b', 60_000);
  assert.equal(taken.owner, 'solver-b');
  assert.equal(taken.attempt, 2);
  assert.equal(journal.acquireLease('task:T-2', 'solver-a', 1000).attempt, 1, 'leases are per key');
  journal.close();
});

test('an expired holder re-acquiring its own lease starts a new attempt', () => {
  const { journal, clock } = fixture();
  journal.acquireLease('k', 'solver-a', 1000);
  clock.t += 1000;
  assert.equal(journal.acquireLease('k', 'solver-a', 1000).attempt, 2);
  journal.close();
});

test('only the holder can release a lease', () => {
  const { journal } = fixture();
  journal.acquireLease('k', 'solver-a', 1000);
  assert.equal(journal.releaseLease('k', 'solver-b'), false);
  assert.equal(journal.lease('k').owner, 'solver-a');
  assert.equal(journal.releaseLease('k', 'solver-a'), true);
  assert.equal(journal.lease('k'), null);
  assert.equal(journal.acquireLease('k', 'solver-b', 1000).attempt, 1);
  journal.close();
});

test('leases survive a restart and still expire on time', () => {
  const f = fixture();
  f.journal.acquireLease('k', 'solver-a', 10_000);
  f.journal.close();
  const j = f.reopen();
  assert.equal(j.acquireLease('k', 'solver-b', 10_000), null);
  assert.deepEqual({ ...j.lease('k') }, { key: 'k', owner: 'solver-a', expiresAt: 1_010_000, attempt: 1 });
  f.clock.t += 10_000;
  assert.equal(j.acquireLease('k', 'solver-b', 10_000).attempt, 2);
  j.close();
});

test('lease concurrency across two journal handles is exclusive', () => {
  const f = fixture();
  const other = f.reopen();
  assert.ok(f.journal.acquireLease('k', 'solver-a', 5000));
  assert.equal(other.acquireLease('k', 'solver-b', 5000), null);
  f.journal.close();
  other.close();
});

test('malformed leases are refused', () => {
  const { journal } = fixture();
  for (const args of [['', 'o', 1], ['k', '', 1], ['k', 'o', 0], ['k', 'o', 1.5], ['k', 'o', 86_400_001], ['k', 'o', '10']])
    refuses(() => journal.acquireLease(...args), 'invalid_lease');
  journal.close();
});

test('a journal configuration without a directory or clock is refused', () => {
  refuses(() => openJournal({ directory: undefined }), 'invalid_journal_configuration');
  refuses(() => openJournal({ directory: tempDir(), now: 5 }), 'invalid_journal_configuration');
});

test('a signed intent fails only with a definite node rejection of its envelope', () => {
  const { journal } = fixture();
  journal.prepare(intent('a'));
  journal.claim('a', 'w');
  journal.recordEnvelope('a', envelope('a'));
  refuses(() => journal.fail('a', 'gave up waiting'), 'intent_state_conflict');
  refuses(() => journal.fail('a', 'maybe rejected', { rejection: { definite: false } }), 'intent_state_conflict');
  const failed = journal.fail('a', 'node rejected sequence', { rejection: { definite: true, code: 'bad_sequence' } });
  assert.equal(failed.state, 'failed');
  assert.deepEqual(failed.receipt, { definite: true, code: 'bad_sequence' });
  journal.prepare(intent('b'));
  journal.claim('b', 'w');
  journal.recordEnvelope('b', envelope('b'));
  journal.markUnknown('b');
  refuses(() => journal.fail('b', 'node rejected', { rejection: { definite: true } }), 'intent_state_conflict');
  journal.close();
});
