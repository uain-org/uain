// GET /api/accepted (16 November 2026): the newest accepted central work across members, from
// proved solver awards. A reviewed submission with no solver award (a rejection) is never listed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptedWork, resetAcceptedWork, ACCEPTED_TTL_MS } from '../dist/src/api/accepted-work.js';

const A = 'uain1' + 'a'.repeat(40), B = 'uain1' + 'b'.repeat(40);
const award = (id, member, height, amount = '20000000') => ({ submission: id, task: 'T-' + id, project: 'P-1', member, role: 'solver', amount, height: String(height) });
function chain(extra = {}) {
  const records = {
    'central_award/solver/CS-1': award('CS-1', A, 100),
    'central_award/solver/CS-3': award('CS-3', B, 300, '60000000'),
    'central_task/T-CS-1': { id: 'T-CS-1', title: 'Survey one' },
    'central_task/T-CS-3': { id: 'T-CS-3', title: 'Survey three' },
    'project/P-1': { id: 'P-1', title: 'Clean water' },
    [`member/${A}`]: { id: A, name: "Samarth's agent", operator: 'Samarth Sharma' },
    [`member/${B}`]: { id: B, name: 'House agent', operator: '' },
    ...extra,
  };
  const reads = [];
  return {
    reads,
    deps: {
      reviews: async () => [{ subject: 'CS-3', height: '301' }, { subject: 'CS-2', height: '201' }, { subject: 'CS-1', height: '101' }],
      read: async (keys) => { reads.push(keys); return Object.fromEntries(keys.map((k) => [k, records[k] ?? null])); },
      timeAt: async (h) => `2026-11-15T10:${String(Number(h) % 60).padStart(2, '0')}:00.000Z`,
    },
  };
}

test('lists accepted work newest first, never a rejection, with names and block times', async () => {
  resetAcceptedWork();
  const { deps } = chain();
  const { status, body } = await acceptedWork(null, deps);
  assert.equal(status, 200);
  assert.deepEqual(body.accepted.map((r) => r.submission), ['CS-3', 'CS-1'], 'CS-2 was reviewed but has no solver award');
  assert.equal(body.accepted[0].name, 'House agent');
  assert.equal(body.accepted[0].operator, null);
  assert.equal(body.accepted[1].operator, 'Samarth Sharma');
  assert.equal(body.accepted[0].taskTitle, 'Survey three');
  assert.equal(body.accepted[0].projectTitle, 'Clean water');
  assert.equal(body.accepted[0].amount, '60000000');
  assert.equal(body.accepted[0].time, '2026-11-15T10:00:00.000Z');
  assert.equal(body.newest, body.accepted[0].time, 'the real time of the newest award, never "now"');
});

test('held for 30 seconds; awards already read are not proved again', async () => {
  resetAcceptedWork();
  let at = 1_000_000;
  const { deps, reads } = chain();
  deps.now = () => at;
  await acceptedWork(null, deps);
  const first = reads.length;
  await acceptedWork(null, deps);
  assert.equal(reads.length, first, 'held within the window');
  at += ACCEPTED_TTL_MS;
  await acceptedWork(null, deps);
  assert.ok(!reads.slice(first).flat().some((k) => k.startsWith('central_award/')), 'immutable awards are kept');
});

test('a bad limit is refused; a failed first read is unavailable, never an empty list', async () => {
  resetAcceptedWork();
  const { deps } = chain();
  assert.equal((await acceptedWork('0', deps)).status, 400);
  assert.equal((await acceptedWork('101', deps)).status, 400);
  resetAcceptedWork();
  const down = await acceptedWork(null, { ...deps, read: async () => { throw new Error('proof refused'); } });
  assert.equal(down.status, 503);
  assert.equal(down.body.error, 'accepted_unavailable');
});

test('an award record that does not match its key is refused', async () => {
  resetAcceptedWork();
  const { deps } = chain({ 'central_award/solver/CS-1': { ...award('CS-1', A, 100), submission: 'CS-9' } });
  assert.equal((await acceptedWork(null, deps)).status, 503);
});

test('a name the chain record leaves empty is taken from the member and project pages', async () => {
  resetAcceptedWork();
  const { deps } = chain({ [`member/${B}`]: { id: B, name: '', operator: '' }, 'project/P-1': { id: 'P-1', title: '' } });
  deps.names = async (kind, id) => kind === 'member' ? (id === B ? { name: 'UAIN house agent beta', operator: 'UAIN' } : null) : { title: 'Robotaxi' };
  const { body } = await acceptedWork(null, deps);
  assert.equal(body.accepted[0].name, 'UAIN house agent beta');
  assert.equal(body.accepted[0].operator, 'UAIN');
  assert.equal(body.accepted[0].projectTitle, 'Robotaxi');
});
