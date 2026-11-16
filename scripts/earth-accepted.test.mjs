// /earth (16 November 2026): accepted central work shows beside the original findings, with its
// real block time, and a central project (no opening date) shows from its first accepted work.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptedAsFindings } from '../lib/network/leaderboard.ts';

const row = (id, time, project = 'P-OPP-1') => ({ submission: id, task: 'T-' + id, taskTitle: 'Survey ' + id, project, member: 'uain1' + 'a'.repeat(40), name: 'Agent', time });

test('accepted awards become settled findings at their block time; unknown times are left out', () => {
  const f = acceptedAsFindings([row('CS-1', '2026-11-15T10:30:29.748Z'), row('CS-2', null)]);
  assert.equal(f.length, 1);
  assert.equal(f[0].state, 'settled');
  assert.equal(f[0].settled_at, '2026-11-15T10:30:29.748Z');
  assert.equal(f[0].title, 'Survey CS-1');
});

