import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { centralTaskJoinPrompt, centralTaskOpen } from './central-task-actions.js';

const openTask = { id: 'CT-open', project: 'P-one', state: 'open', pending: null, winner: null };
const notJoined = { joined: false, active: true };

test('open funded task with no pending or winner offers the join prompt to a non-member', () => {
  assert.equal(centralTaskOpen(openTask), true);
  assert.equal(centralTaskJoinPrompt(openTask, notJoined), true);
});

test('closed, accepted, under-review and unfunded tasks never show a task join prompt', () => {
  const closed = [
    { ...openTask, state: 'accepted', winner: 'CS-other' },
    { ...openTask, winner: 'CS-other' }, // winner recorded before the state label catches up
    { ...openTask, state: 'under_review', pending: 'CS-other' },
    { ...openTask, pending: 'CS-other' },
    { ...openTask, state: 'open_unfunded' },
    { ...openTask, state: 'closed' },
  ];
  for (const task of closed) {
    assert.equal(centralTaskOpen(task), false, JSON.stringify(task));
    assert.equal(centralTaskJoinPrompt(task, notJoined), false, JSON.stringify(task));
  }
});

test('members, missing detail and missing task get no join prompt', () => {
  assert.equal(centralTaskJoinPrompt(openTask, { joined: true }), false);
  assert.equal(centralTaskJoinPrompt(openTask, null), false);
  assert.equal(centralTaskJoinPrompt(null, notJoined), false);
});

test('CentralEarning gates the task join prompt and submission form on the same open rule', () => {
  const source = readFileSync(new URL('./CentralEarning.jsx', import.meta.url), 'utf8');
  assert.match(source, /\{centralTaskJoinPrompt\(task, detail\) &&\s*\n\s*\(joinPending \?/);
  assert.match(source, /const open = centralTaskOpen\(task\);/);
  assert.match(source, /\{detail\.joined && open && !ownPending && \(/);
  // The old ungated condition must not come back.
  assert.doesNotMatch(source, /\{!detail\.joined && task\.state !== "accepted"/);
  // General project participation stays visible for every task.
  assert.match(source, /detail\.joined \? " · joined" : " · not joined"/);
});

test('operator-held task keeps native open state but offers neither new work nor task join prompt',()=>{const t={...openTask,availability:{authority:'uain-operator',available:false,reason:'task_specification_unusable'}};assert.equal(centralTaskOpen(t),false);assert.equal(centralTaskJoinPrompt(t,notJoined),false);assert.equal(t.state,'open');});

test('held display label names operator correction without rewriting the native enum',async()=>{const {centralTaskLabel}=await import('./central-task-actions.js');const t={...openTask,availability:{authority:'uain-operator',available:false,reason:'task_specification_unusable'}};assert.equal(centralTaskLabel(t,{open:'Open'}),'On hold while its instructions are fixed');assert.equal(centralTaskLabel(openTask,{open:'Open'}),'Open');assert.equal(t.state,'open');});

test('the server status_label (contest, conditional) is shown; an unknown state is never shown raw',async()=>{const {centralTaskLabel}=await import('./central-task-actions.js');
assert.equal(centralTaskLabel({state:'contest_open',status_label:'Contest: best entry by 10 Nov 18:00 wins'},{open:'Open'}),'Contest: best entry by 10 Nov 18:00 wins');
assert.equal(centralTaskLabel({state:'conditional_expired'},{open:'Open'}),'Closed');
assert.equal(centralTaskLabel({state:'open',status_label:''},{open:'Open'}),'Open');});
