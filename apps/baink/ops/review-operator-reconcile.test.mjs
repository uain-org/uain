import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcile, activeFor, validatePlan} from './review-operator-reconcile.mjs';

const owner = 'uain1' + 'a'.repeat(40), other = 'uain1' + 'b'.repeat(40), E = {x: 'e'.repeat(64)};
const J1 = '1'.repeat(32), J2 = '2'.repeat(32), J3 = '3'.repeat(32), OP = '9'.repeat(32);
function db() {
  return {
    jobs: {
      [J1]: {id: J1, owner, phase: 'uncertain', pending: OP},
      [J2]: {id: J2, owner, phase: 'reviewed', pending: null},
      [J3]: {id: J3, owner: other, phase: 'reviewed', pending: null},
    },
    operations: {
      [OP]: {id: OP, jobId: J1, owner, action: 'create', status: 'uncertain'},
      r: {id: 'r', jobId: J2, owner, action: 'review', status: 'completed'},
    },
  };
}
const plan = (jobs = [
  {id: J1, expectPhase: 'uncertain', expectPending: OP, expectPendingStatus: 'uncertain', evidence: E},
  {id: J2, expectPhase: 'reviewed', expectPending: null, expectPendingStatus: null, evidence: E},
]) => ({owner, reason: 'fixture reconciliation of dead jobs', jobs});

test('mirrors the gateway abandon path and frees the owner quota without touching others', () => {
  const d = db();
  assert.deepEqual(activeFor(d, owner), [J1, J2]);
  const changes = reconcile(d, plan(), 1000);
  assert.equal(changes.length, 2);
  assert.deepEqual(activeFor(d, owner), []);
  assert.deepEqual(activeFor(d, other), [J3]);
  assert.equal(d.operations[OP].status, 'cancelled'); assert.equal(d.operations[OP].cancelledAt, 1000);
  assert.equal(d.operations.r.status, 'completed', 'completed history is kept');
  for (const id of [J1, J2]) {
    assert.equal(d.jobs[id].phase, 'abandoned'); assert.equal(d.jobs[id].pending, null); assert.equal(d.jobs[id].abandonedAt, 1000);
    assert.deepEqual(Object.keys(d.jobs[id].operatorReconciliation).sort(), ['at', 'evidence', 'previousPending', 'previousPhase', 'reason', 'settledOperation']);
  }
  assert.deepEqual(d.jobs[J1].operatorReconciliation.settledOperation, {id: OP, action: 'create', previousStatus: 'uncertain', status: 'cancelled'});
  assert.equal(d.jobs[J2].operatorReconciliation.settledOperation, null);
});

test('refuses changed state, relay requests, live work, other owners and weak plans', () => {
  const cases = [
    d => { d.jobs[J2].phase = 'relayed'; },
    d => { d.jobs[J1].pending = null; },
    d => { d.operations[OP].status = 'running'; },
    d => { d.operations.x = {id: 'x', jobId: J2, owner, action: 'relay', status: 'queued'}; },
    d => { d.operations.y = {id: 'y', jobId: J2, owner, action: 'review', status: 'running'}; },
    d => { d.jobs[J2].owner = other; },
  ];
  for (const change of cases) { const d = db(); change(d); const before = JSON.stringify(d); assert.throws(() => reconcile(d, plan(), 1)); }
  assert.throws(() => validatePlan({...plan(), reason: 'short'}));
  assert.throws(() => validatePlan(plan([{id: J2, expectPhase: 'abandoned', expectPending: null, expectPendingStatus: null, evidence: E}])));
  assert.throws(() => validatePlan(plan([{id: J2, expectPhase: 'reviewed', expectPending: null, expectPendingStatus: null, evidence: {x: 'nothex'}}])));
  const d = db(); reconcile(d, plan(), 1); assert.throws(() => reconcile(d, plan(), 2), /phase_changed/, 'a second run refuses');
});
