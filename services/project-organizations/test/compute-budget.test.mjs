import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { approveBudgetChange, openComputeBudget, toCents } from '../src/compute-budget.mjs';

const MODULE = new URL('../src/compute-budget.mjs', import.meta.url).href;
const DAY1 = Date.parse('2026-11-06T10:00:00.000Z');
const call = (projectIds = ['OPP-00001']) => ({ purpose: 'solver', projectIds, model: 'claude-sonnet-5-5' });
async function dir(t) {
  const d = await mkdtemp(join(tmpdir(), 'compute-budget-'));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}
const rows = async (d) => (await readFile(join(d, 'receipts.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));

test('reserves $2 per call, settles provider cost and pauses past the $5 UTC daily cap', async (t) => {
  const d = await dir(t);
  let clock = DAY1;
  const budget = openComputeBudget({ directory: d, now: () => clock });
  const a = budget.reserve(call());
  assert.equal(a.reservedUsd, 2);
  assert.equal(budget.status().dailyUsd, 2);
  budget.settle(a.id, { costUsd: 0.37, stopReason: 'end_turn' });
  assert.equal(budget.status().dailyUsd, 0.37);
  const b = budget.reserve(call());
  assert.ok(b.id);
  assert.equal(budget.status().dailyUsd, 2.37);
  // 2.37 + 2 = 4.37 <= 5 still allowed; then 6.37 > 5 pauses.
  assert.ok(budget.reserve(call()).id);
  assert.deepEqual(budget.reserve(call()).paused, 'daily');
  clock = Date.parse('2026-11-06T23:59:59.999Z');
  assert.equal(budget.reserve(call()).paused, 'daily');
  clock = Date.parse('2026-11-07T00:00:00.000Z');
  assert.equal(budget.status().paused, null);
  assert.ok(budget.reserve(call()).id, 'next UTC accounting day resumes');
});

test('unknown cost stays counted at $2; invalid provider cost keeps the reservation', async (t) => {
  const d = await dir(t);
  const budget = openComputeBudget({ directory: d, now: () => DAY1 });
  const lost = budget.reserve(call());
  const bad = budget.reserve(call());
  budget.settle(bad.id, { costUsd: -3, stopReason: 'error' });
  const s = budget.status();
  assert.equal(s.dailyUsd, 4);
  assert.equal(s.openReservations, 1);
  assert.equal(s.unknownUsd, 2);
  assert.throws(() => budget.settle(bad.id, { costUsd: 0 }), { code: 'compute_reservation_already_settled' });
  assert.throws(() => budget.settle('cb-00000000-0000-4000-8000-000000000000', {}), { code: 'compute_reservation_not_found' });
  const saved = await rows(d);
  assert.equal(saved.find((r) => r.id === lost.id).status, 'reserved');
  assert.equal(saved.find((r) => r.id === bad.id).costUsd, 2);
});

test('migrates the existing project-manager receipts without resetting consumed allowance', async (t) => {
  const d = await dir(t);
  const legacy = [
    { at: '2026-11-01T09:00:00.000Z', projectIds: ['OPP-00001'], model: 'claude-sonnet-5-5', costUsd: 1.234567, status: 'returned', stopReason: 'end_turn' },
    { at: '2026-11-02T09:00:00.000Z', projectIds: ['OPP-00002'], model: 'claude-sonnet-5-5', costUsd: 2, status: 'reserved' },
    { at: '2026-11-06T01:00:00.000Z', projectIds: ['OPP-00003'], model: 'claude-sonnet-5-5', costUsd: 1.1, status: 'returned', stopReason: null },
  ];
  const before = legacy.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await writeFile(join(d, 'receipts.jsonl'), before);
  const budget = openComputeBudget({ directory: d, now: () => DAY1 });
  const s = budget.status();
  // Fractions of a cent round up: 1.234567 -> 1.24; 1.1 -> 1.10 (no float drift to 1.11).
  assert.equal(toCents(1.1), 110);
  assert.equal(s.totalUsd, 4.34);
  assert.equal(s.dailyUsd, 1.1);
  assert.equal(s.openReservations, 1);
  const r = budget.reserve(call());
  const after = await readFile(join(d, 'receipts.jsonl'), 'utf8');
  assert.ok(after.startsWith(before), 'legacy rows are preserved byte for byte');
  const added = (await rows(d)).at(-1);
  assert.deepEqual(Object.keys(added).sort(), ['at', 'costUsd', 'id', 'model', 'projectIds', 'purpose', 'status']);
  assert.equal(added.id, r.id);
  assert.equal(added.costUsd, 2);
});

test('total exhaustion is held across days and new journals until an approved change', async (t) => {
  const d = await dir(t);
  let clock = DAY1;
  const legacy = Array.from({ length: 12 }, (_, i) => JSON.stringify({
    at: `2026-10-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`, projectIds: ['OPP-00001'], model: 'm', costUsd: 2, status: 'returned', stopReason: null,
  }));
  await writeFile(join(d, 'receipts.jsonl'), legacy.join('\n') + '\n'); // $24 used
  const budget = openComputeBudget({ directory: d, now: () => clock });
  assert.equal(budget.reserve(call()).paused, 'total');
  clock += 10 * 86400000;
  assert.equal(budget.reserve(call()).paused, 'total');
  assert.equal(openComputeBudget({ directory: d, now: () => clock }).reserve(call()).paused, 'total', 'a fresh journal does not reset usage');
  assert.throws(() => openComputeBudget({ directory: d, limits: { perCallUsd: 2, dailyUsd: 5, totalUsd: 50 } }), { code: 'compute_budget_policy_mismatch' });
  const fresh = await dir(t);
  assert.throws(() => openComputeBudget({ directory: fresh, limits: { perCallUsd: 2, dailyUsd: 5, totalUsd: 50 } }), { code: 'compute_budget_increase_requires_approval' });
  assert.throws(() => approveBudgetChange({ directory: d, limits: { perCallUsd: 2, dailyUsd: 5, totalUsd: 50 }, approvedBy: 'rahul' }), { code: 'invalid_budget_approval' });
  approveBudgetChange({ directory: d, limits: { perCallUsd: 2, dailyUsd: 5, totalUsd: 50 }, approvedBy: 'rahul', reason: 'approved rollout extension', now: () => clock });
  assert.ok(budget.reserve(call()).id, 'running instance observes the approved policy');
  const policy = JSON.parse(await readFile(join(d, 'compute-budget-policy.json'), 'utf8'));
  assert.equal(policy.history.length, 2);
});

test('refuses corrupt receipts and malformed reservations rather than guessing', async (t) => {
  const d = await dir(t);
  await writeFile(join(d, 'receipts.jsonl'), '{"at":"2026-11-06T00:00:00Z","costUsd":-1,"status":"returned"}\n');
  assert.throws(() => openComputeBudget({ directory: d }), { code: 'compute_budget_receipt_invalid' });
  const ok = await dir(t);
  const budget = openComputeBudget({ directory: ok, now: () => DAY1 });
  for (const bad of [{}, { ...call(), projectIds: [] }, { ...call(), projectIds: ['../x'] }, { ...call(), model: '' }, { ...call(), purpose: 'Bad Purpose' }])
    assert.throws(() => budget.reserve(bad), { code: 'invalid_compute_reservation' });
  assert.throws(() => openComputeBudget({ directory: ok, limits: { perCallUsd: 6, dailyUsd: 5, totalUsd: 25 } }), { code: 'invalid_compute_limits' });
});

test('two journals on one directory share the cap', async (t) => {
  const d = await dir(t);
  const a = openComputeBudget({ directory: d, now: () => DAY1 });
  const b = openComputeBudget({ directory: d, now: () => DAY1 });
  assert.ok(a.reserve(call()).id);
  assert.ok(b.reserve(call()).id);
  assert.equal(a.reserve(call()).paused, 'daily');
  assert.equal(b.reserve(call()).paused, 'daily');
  assert.equal((await rows(d)).length, 2);
});

test('concurrent processes cannot reserve past the daily cap', async (t) => {
  const d = await dir(t);
  openComputeBudget({ directory: d, now: () => DAY1 });
  const script = `import { openComputeBudget } from ${JSON.stringify(MODULE)};
    const b = openComputeBudget({ directory: process.argv[1], now: () => ${DAY1} });
    const out = [];
    for (let i = 0; i < 3; i++) out.push(b.reserve({ purpose: 'solver', projectIds: ['OPP-00001'], model: 'm' }).id ? 'ok' : 'paused');
    console.log(JSON.stringify(out));`;
  const runs = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, d], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(Error(err))));
  })));
  assert.equal(runs.flat().filter((x) => x === 'ok').length, 2);
  assert.equal((await rows(d)).length, 2);
});

test('a live lock holder blocks; a dead holder on this host is broken', async (t) => {
  const d = await dir(t);
  const budget = openComputeBudget({ directory: d, now: () => DAY1, lockTimeoutMs: 100 });
  const lock = join(d, 'compute-budget.lock');
  await writeFile(lock, JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other', at: new Date().toISOString() }));
  assert.throws(() => budget.reserve(call()), { code: 'compute_budget_locked' });
  const dead = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', '0']);
    child.on('exit', () => resolve(child.pid));
  });
  await writeFile(lock, JSON.stringify({ pid: dead, host: hostname(), token: 'crashed', at: new Date().toISOString() }));
  assert.ok(budget.reserve(call()).id);
  await assert.rejects(readFile(lock), /ENOENT/);
});
