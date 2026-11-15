import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readResearchBench } from '../lib/network/research-bench.ts';
const task = { id: 'T1', status: 'open', title: 'Question', question: 'What?', done_when: 'CSV', how_to_check: 'Compare exactly', output_format: 'Digests and code' };
const page = (tasks, extra = {}) => Response.json({ authority: 'native', epoch: 'e', app_hash: 'h', count: tasks.length, pages: 1, page: 1, tasks, ...extra });
test('only actual open status is eligible, preserving exact task criteria', async () => {
  const tasks = [task, ...['answered','awaiting_verification','needs_comparison','closed'].map((status,i) => ({ id: `X${i}`, status }))];
  const result = await readResearchBench('', async () => page(tasks));
  assert.equal(result.count, 5); assert.deepEqual(result.tasks, [task]);
});
test('complete coherent pagination and empty census work', async () => {
  let calls = 0;
  const result = await readResearchBench('', async url => {
    assert.match(url, new RegExp(`page=${++calls}$`));
    return page(calls === 1 ? [task] : [{ id: 'T2', status: 'closed' }], { count: 2, pages: 2, page: calls });
  });
  assert.equal(calls, 2); assert.deepEqual(result.tasks, [task]);
  assert.deepEqual((await readResearchBench('', async () => page([]))).tasks, []);
});
test('retired, unavailable, partial, duplicate and missing criteria refuse all output', async () => {
  for (const response of [new Response('{}', {status:409}), new Response('{}', {status:503}),
    page([task], {count:2}), page([task,task]), page([task], {authority:'legacy'}),
    page([{...task, how_to_check:''}]), page([task], {count:-1})]) {
    await assert.rejects(readResearchBench('', async () => response));
  }
});
test('mixed epoch, hash, page count or total refuses a combined task catalogue', async () => {
  for (const change of [{epoch:'changed'}, {app_hash:'changed'}, {pages:3}, {count:3}]) {
    let calls = 0;
    await assert.rejects(readResearchBench('', async () => ++calls === 1
      ? page([task], {count:2,pages:2})
      : page([{id:'T2',status:'closed'}], {count:2,pages:2,page:2,...change})));
  }
});
