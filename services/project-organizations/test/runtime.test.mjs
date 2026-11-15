import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJournal } from '../src/journal.mjs';
import { runCycle } from '../src/runtime.mjs';

const SIGNER = 'uain1' + 'b'.repeat(40);
async function journalWith(t, states) {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-'));
  const journal = openJournal({ directory });
  t.after(async () => { journal.close(); await rm(directory, { recursive: true, force: true }); });
  states.forEach((state, i) => {
    const id = `intent-${i}`;
    journal.prepare({
      id, projectId: 'OPP-00001', kind: 'native', operation: 'central_submit', payload: { n: i },
      selectionDigest: 'a'.repeat(64), sourceDigest: 'b'.repeat(64), signer: i === 0 ? SIGNER : 'uain1' + String(i).repeat(40).slice(0, 40),
    });
    if (state === 'prepared') return;
    journal.claim(id, 'custody');
    if (state === 'claimed') return;
    journal.recordEnvelope(id, { signed: i });
    if (state === 'unknown') journal.markUnknown(id);
    if (state === 'confirmed') journal.recordReceipt(id, { height: i });
  });
  return journal;
}
const scheduler = (calls) => ({ tick: async () => { calls.push('tick'); return { state: 'submission_prepared' }; } });

test('reconciles every unknown or dispatched intent before new work', async (t) => {
  const journal = await journalWith(t, ['unknown', 'dispatched', 'prepared', 'confirmed']);
  const calls = [];
  const native = { reconcile: async (id) => { calls.push(id); return journal.recordReceipt(id, { found: true }); } };
  const result = await runCycle({ journal, native, scheduler: scheduler(calls) });
  assert.deepEqual(calls, ['intent-0', 'intent-1', 'tick']);
  assert.deepEqual(result.reconciled.map((r) => [r.id, r.from, r.to]), [['intent-0', 'unknown', 'confirmed'], ['intent-1', 'dispatched', 'confirmed']]);
  assert.equal(result.state, 'submission_prepared');
});

test('a failed reconciliation holds the cycle without starting new work', async (t) => {
  const journal = await journalWith(t, ['unknown', 'dispatched']);
  const calls = [];
  const native = { reconcile: async (id) => { calls.push(id); if (id === 'intent-0') throw Object.assign(Error('reader down'), { code: 'native_reader_unavailable' }); return { state: 'unknown' }; } };
  const result = await runCycle({ journal, native, scheduler: scheduler(calls) });
  assert.deepEqual(calls, ['intent-0', 'intent-1'], 'every open intent is still attempted');
  assert.deepEqual([result.state, result.reason, result.tick], ['held', 'reconciliation_incomplete', null]);
  assert.deepEqual(result.failures, [{ id: 'intent-0', from: 'unknown', reason: 'native_reader_unavailable' }]);
});

test('a still-unknown signed intent is reported but does not block other lanes', async (t) => {
  const journal = await journalWith(t, ['unknown']);
  const calls = [];
  const native = { reconcile: async (id) => journal.reconcile(id, { found: false }) };
  const result = await runCycle({ journal, native, scheduler: scheduler(calls) });
  assert.deepEqual(result.reconciled, [{ id: 'intent-0', from: 'unknown', to: 'unknown' }]);
  assert.deepEqual(calls, ['tick']);
});

test('bounded backlog and operator stop hold before any tick', async (t) => {
  const journal = await journalWith(t, ['unknown', 'dispatched', 'dispatched']);
  const calls = [];
  const native = { reconcile: async (id) => { calls.push(id); return { state: 'unknown' }; } };
  const backlog = await runCycle({ journal, native, scheduler: scheduler(calls), maxReconcile: 2 });
  assert.deepEqual([backlog.state, backlog.reason, calls], ['held', 'reconciliation_backlog', ['intent-0', 'intent-1']]);
  const stopped = await runCycle({ journal, native, scheduler: scheduler(calls), stopRequested: () => true });
  assert.equal(stopped.state, 'stopped');
  assert.equal(calls.length, 2);
  await assert.rejects(runCycle({ journal, native: {}, scheduler: scheduler(calls) }), { code: 'invalid_runtime_configuration' });
});

test('paperclip intents are left to the organization adapter and never block native work', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-'));
  const journal = openJournal({ directory });
  t.after(async () => { journal.close(); await rm(directory, { recursive: true, force: true }); });
  journal.prepare({ id: 'pc.OPP-00001.company.1', projectId: 'OPP-00001', kind: 'paperclip', operation: 'paperclip.company.create', payload: { body: {} },
    selectionDigest: 'a'.repeat(64), sourceDigest: 'b'.repeat(64), signer: 'paperclip:OPP-00001.company.1' });
  journal.claim('pc.OPP-00001.company.1', 'paperclip');
  journal.recordEnvelope('pc.OPP-00001.company.1', { capability: 'company.create' });
  journal.markUnknown('pc.OPP-00001.company.1');
  const calls = [];
  const native = { reconcile: async (id) => { calls.push(id); throw Object.assign(Error('not a native envelope'), { code: 'retained_envelope_mismatch' }); } };
  const result = await runCycle({ journal, native, scheduler: scheduler(calls) });
  assert.deepEqual(calls, ['tick']);
  assert.deepEqual([result.state, result.failures], ['submission_prepared', []]);
});
