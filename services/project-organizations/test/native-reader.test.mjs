import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { centralEarningSigningBytes } from '../../../apps/baink/server/central-earning-command.mjs';
import { centralUnlockedUnits } from '../../../apps/baink/server/central-budget.mjs';
import { CENTRAL_POLICY } from '../../../apps/baink/server/central-earning-command.mjs';
import { memberAddress } from '../../../apps/baink/server/native-financial-command.mjs';
import { sha256 } from '../src/common.mjs';
import { validateSelection } from '../src/selection.mjs';
import { openRegistry } from '../src/registry.mjs';
import { openJournal } from '../src/journal.mjs';
import { FLEET_POLICY_SCHEMA, NATIVE_ROLE_OPERATIONS, createNativeAdapter } from '../src/native.mjs';
import { createNativeReader } from '../src/native-reader.mjs';
import { SUPPLY_CAP_UNITS, pricingInputsFromSnapshot, readPricingInputs } from '../src/pricing.mjs';

// FIXTURE chain and identities only; nothing here reads or writes a real native chain.
const CHAIN = 'uain-fixture-reader-chain';
const PRODUCTION = 'uain-fixture-production-chain';
const NOW = Date.parse('2026-11-06T12:00:00Z');
const pad = (n) => String(n).padStart(20, '0');
const refuses = (code) => (e) => (assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`), true);
const ids = Array.from({ length: 120 }, (_, i) => `OPP-${String(i + 1).padStart(5, '0')}`);
const selection = validateSelection({
  schema: 'uain-project-organization-selection-v1', observedAt: '2026-11-05T00:00:00Z', count: 120,
  selection: 'FICTIONAL fixture selection', authority: 'test',
  projects: ids.map((id) => ({
    id, sourceDigest: sha256('source ' + id), modelPlanDigest: sha256('plan ' + id),
    kpi: { statement: 'Independently verified measurable outcome for ' + id, threshold: null, unit: null, comparator: null, qualification: 'Fixture only' },
  })),
});
const [A, B] = ids;
const P = 'P-' + A;
function identity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return { address: memberAddress(pub), publicKey: pub.toString('base64url'), privateKey };
}
const manager = identity();
const evaluator = identity();
const solver = identity();
const reviewer = identity();

/** FIXTURE transport in the BAINK `publicState` shape. `finality`: header | app_hash | flag | none. */
class FakeTransport {
  constructor({ finality = 'header', chain = CHAIN } = {}) {
    Object.assign(this, { finality, chain, height: 100n, store: {}, members: {}, calls: [], broadcasts: [], events: 0 });
    for (const m of [manager, evaluator, solver, reviewer]) this.members[m.address] = { id: m.address, public_key: m.publicKey, licence: 'active', sequence: '0' };
  }
  appHash() {
    return sha256(JSON.stringify(this.store) + this.height);
  }
  event({ member, operation, subject, digest }) {
    this.events++;
    this.store[`event/${pad(this.events)}`] = { id: String(this.events), height: String(this.height), member, operation, subject, command_digest: digest };
    this.store.event_count = String(this.events);
  }
  async publicState(selection, { timeoutMs }) {
    assert.ok(Number.isInteger(timeoutMs));
    assert.ok((selection.keys ?? []).length <= 32, 'at most 32 keys per transport call');
    this.calls.push(structuredClone(selection));
    if (this.fail) throw Object.assign(new Error('boom'), { code: 'transport_down' });
    this.beforeRead?.(this.calls.length);
    const state = {
      chain_id: this.chain, height: String(this.height), header_time: new Date(NOW).toISOString(), event_count: String(this.events),
      records: Object.fromEntries((selection.keys ?? []).filter((k) => !this.drop?.includes(k)).map((k) => [k, structuredClone(this.store[k] ?? null)])),
      ...(selection.member ? { member: structuredClone(this.members[selection.member] ?? null) } : {}),
    };
    if (['header', 'app_hash'].includes(this.finality)) state.app_hash = this.appHash();
    if (this.finality === 'header') state.signed_header = { header: { chain_id: this.chain, height: String(this.height), app_hash: state.app_hash }, commit: { signatures: [] } };
    if (this.finality === 'flag') state.finalized = true;
    if (selection.receipt) {
      const e = this.store[`event/${pad(selection.receipt.event_id)}`];
      state.receipt = { authority: 'native', finalized: this.receiptFinalized ?? true, chain_id: this.chain, state_height: state.height, app_hash: state.app_hash, event: e };
    }
    return { state, proof: { authority: 'native', chainId: this.chain, height: state.height, appHash: state.app_hash, genesisSha256: 'a'.repeat(64), verifierSha256: 'b'.repeat(64) } };
  }
  async broadcast(envelope) {
    this.broadcasts.push(JSON.stringify(envelope));
    const c = envelope.command;
    this.height++;
    this.members[c.member].sequence = String(BigInt(c.sequence) + 1n);
    this.event({ member: c.member, operation: c.operation, subject: c.payload.project ?? c.payload.id, digest: sha256(centralEarningSigningBytes(c)) });
    return 0;
  }
}
const reader = (transport, extra = {}) => createNativeReader({ transport, chainId: CHAIN, productionChainId: PRODUCTION, now: () => NOW, ...extra });

test('read chunks at 32 keys, merges proven records and carries transport finality evidence', async () => {
  const t = new FakeTransport();
  const keys = Array.from({ length: 70 }, (_, i) => `central_task/T-${i}`);
  t.store['central_task/T-3'] = { id: 'T-3', project: P };
  const s = await reader(t).read({ member: solver.address, keys });
  assert.deepEqual(t.calls.map((c) => c.keys.length), [32, 32, 6]);
  assert.ok(t.calls.every((c) => c.member === solver.address));
  assert.equal(Object.keys(s.records).length, 70);
  assert.deepEqual(s.records['central_task/T-3'], { id: 'T-3', project: P });
  assert.equal(s.records['central_task/T-4'], null, 'proven absence stays null');
  assert.equal(s.member.id, solver.address);
  assert.deepEqual([s.chain_id, s.height, s.fetchedAt], [CHAIN, '100', new Date(NOW).toISOString()]);
  assert.match(s.app_hash, /^[a-f0-9]{64}$/);
  assert.equal(s.proof.finalized, true);
  assert.deepEqual([s.proof.authority, s.proof.chainId, s.proof.height, s.proof.appHash, s.proof.production], ['native', CHAIN, '100', s.app_hash, false]);
  assert.equal(s.proof.genesisSha256, 'a'.repeat(64));
  assert.match(s.proof.signedHeaderDigest, /^[a-f0-9]{64}$/);
  assert.equal(s.finalized, undefined, 'no finalized flag is invented from header evidence');
});

test('finality is never fabricated: app_hash alone or no evidence is unfinalized', async () => {
  for (const [finality, expected] of [['none', false], ['app_hash', false], ['header', true], ['flag', true]]) {
    const t = new FakeTransport({ finality });
    const s = await reader(t).read({ keys: ['coin_supply'] });
    assert.equal(s.proof.finalized, expected, finality);
    assert.equal(s.member, null);
    if (finality === 'none') assert.ok(!('app_hash' in s) && s.proof.appHash === null && !('signed_header' in s));
    if (finality === 'flag') assert.equal(s.finalized, true);
    else assert.equal(s.finalized, undefined);
  }
  // one unfinalized chunk makes the whole read unfinalized
  const t = new FakeTransport();
  t.beforeRead = (n) => { t.finality = n === 2 ? 'app_hash' : 'header'; };
  const s = await reader(t, { retries: 0 }).read({ keys: Array.from({ length: 40 }, (_, i) => `k/${i}`) });
  assert.equal(s.proof.finalized, false);
});

test('wrong chain, unproven keys, transport failure and pin mismatch refuse', async () => {
  await assert.rejects(reader(new FakeTransport({ chain: 'other-chain' })).read({ keys: [] }), refuses('native_chain_mismatch'));
  const t = new FakeTransport();
  t.drop = ['coin_supply'];
  await assert.rejects(reader(t).read({ keys: ['coin_supply'] }), refuses('native_record_unproven'));
  const down = new FakeTransport();
  down.fail = true;
  await assert.rejects(reader(down).read({ keys: [] }), refuses('native_read_failed'));
  assert.throws(() => reader(Object.assign(new FakeTransport(), { pins: { chainId: 'other' } })), refuses('native_reader_chain_mismatch'));
  assert.throws(() => createNativeReader({ transport: new FakeTransport(), chainId: CHAIN }), refuses('invalid_native_reader_configuration'));
  await assert.rejects(reader(new FakeTransport()).read({ keys: ['bad key with spaces'] }), refuses('invalid_native_selection'));
  await assert.rejects(reader(new FakeTransport()).read({ member: 'not-an-address', keys: [] }), refuses('invalid_native_selection'));
});

test('chunks from different committed states are retried, then refused', async () => {
  const keys = Array.from({ length: 40 }, (_, i) => `k/${i}`);
  const moving = new FakeTransport();
  moving.beforeRead = () => { moving.store.tick = (moving.store.tick ?? 0) + 1; };
  await assert.rejects(reader(moving).read({ keys }), refuses('native_read_inconsistent'));
  assert.equal(moving.calls.length, 6, 'two chunks, three attempts');
  const settles = new FakeTransport();
  settles.beforeRead = (n) => { if (n <= 2) settles.store.tick = n; };
  const s = await reader(settles).read({ keys });
  assert.equal(settles.calls.length, 4);
  assert.equal(s.proof.finalized, true);
});

test('supply comes from the native coin ledger and feeds pricing; absence never defaults', async () => {
  const t = new FakeTransport();
  const r = reader(t);
  await assert.rejects(r.supply(), refuses('native_supply_unavailable'));
  t.store.coin_supply = { minted: '7000000', reserved: '1100000', transparent: '7000000', shielded: '0' };
  assert.deepEqual(await r.supply(), { cap: SUPPLY_CAP_UNITS.toString(), issued: '7000000', reserved: '1100000' });
  const snap = await r.supplySnapshot();
  assert.equal(snap.proof.finalized, true);
  assert.equal(snap.height, '100');
  t.store.coin_supply = { minted: '7000000', reserved: '0', transparent: '1', shielded: '0' };
  await assert.rejects(r.supply(), refuses('invalid_native_supply'));
  t.store.coin_supply = { minted: '1.5', reserved: '0', transparent: '1.5', shielded: '0' };
  await assert.rejects(r.supply(), refuses('invalid_native_supply'));

  // readPricingInputs joins the project snapshot with reader.supply()
  t.store.coin_supply = { minted: '0', reserved: '0', transparent: '0', shielded: '0' };
  const snapshot = {
    projectId: A, nativeProjectId: P, available: true, tasks: [{ id: 'T-old', project: P }], plan: null,
    budget: { project: P, allocation: centralUnlockedUnits(1), reserved: '0', paid: '0', round: 1, policy: CENTRAL_POLICY },
    fundState: { project: P, revision: 1, approved_revision: 1, completed: 0, pending: '' },
    approvedPlan: { project: P, revision: 1, state: 'accept', stages: [1, 2, 3, 4, 5].map((round) => ({ round, criteria: `Independently checked stage ${round} evidence` })) },
  };
  const inputs = await readPricingInputs({ native: { snapshot: async () => snapshot }, reader: r, projectId: A });
  assert.deepEqual(inputs.supply, { cap: SUPPLY_CAP_UNITS.toString(), issued: '0', reserved: '0' });
  assert.deepEqual(inputs.existingTaskIds, ['T-old']);
  assert.equal(pricingInputsFromSnapshot(snapshot).supply, undefined, 'supply is only included when read');
  delete t.store.coin_supply;
  await assert.rejects(readPricingInputs({ native: { snapshot: async () => snapshot }, reader: r, projectId: A }), refuses('native_supply_unread'));
});

test('tasks(P) walks the global task index, filters by project and caches only immutable index entries', async () => {
  const t = new FakeTransport();
  const r = reader(t, { maxTaskIndex: 5 });
  assert.deepEqual(await r.tasks(P), []);
  const add = (n, id, project) => {
    t.store[`central_task_index/${pad(n)}`] = { id, project };
    t.store[`central_task/${id}`] = { id, project, state: 'open' };
    t.store.central_task_count = String(n);
  };
  add(1, 'T-a', P);
  add(2, 'T-b', 'P-' + B);
  add(3, 'T-c', P);
  assert.deepEqual((await r.tasks(P)).map((x) => x.id), ['T-a', 'T-c']);
  t.calls.length = 0;
  t.store['central_task/T-a'].state = 'under_review';
  const again = await r.tasks(P);
  assert.equal(again[0].state, 'under_review', 'task records are re-read');
  assert.ok(!t.calls.some((c) => c.keys.some((k) => k.startsWith('central_task_index/'))), 'index entries are cached');
  t.store['central_task/T-c'] = { id: 'T-c', project: 'P-' + B };
  await assert.rejects(r.tasks(P), refuses('invalid_native_task'));
  for (const n of [4, 5, 6]) add(n, `T-${n}`, P);
  await assert.rejects(r.tasks(P), refuses('native_task_index_too_large'));
  const broken = new FakeTransport();
  broken.store.central_task_count = '1';
  await assert.rejects(reader(broken).tasks(P), refuses('invalid_native_task_index'));
});

test('findCommand: finalized proof only with evidence; expiry only after a complete scan', async () => {
  const t = new FakeTransport();
  const digest = 'c'.repeat(64);
  for (let i = 0; i < 5; i++) t.event({ member: manager.address, operation: 'central_task_open', subject: `T-${i}`, digest: sha256('other' + i) });
  t.event({ member: solver.address, operation: 'project_join', subject: P, digest });
  const r = reader(t);
  const q = { member: solver.address, commandDigest: digest, operation: 'project_join', expiresHeight: '150' };
  const found = await r.findCommand(q);
  assert.equal(found.found, true);
  assert.deepEqual([found.proof.authority, found.proof.finalized, found.proof.chain_id, found.proof.event_id, found.proof.member, found.proof.operation],
    ['native', true, CHAIN, '6', solver.address, 'project_join']);
  await assert.rejects(r.findCommand({ ...q, operation: 'central_submit' }), refuses('native_event_mismatch'));
  // a gateway receipt read when the retained envelope is supplied
  const envelope = { command: { chain_id: CHAIN, member: solver.address }, public_key: 'x', signature: 'y' };
  assert.equal((await r.findCommand({ ...q, envelope })).proof.receipt.finalized, true);
  t.receiptFinalized = false;
  assert.equal((await r.findCommand({ ...q, envelope })).proof.finalized, false);

  const unproven = new FakeTransport({ finality: 'app_hash' });
  unproven.event({ member: solver.address, operation: 'project_join', subject: P, digest });
  assert.equal((await reader(unproven).findCommand(q)).proof.finalized, false);

  const missing = { ...q, commandDigest: 'd'.repeat(64) };
  assert.deepEqual(await r.findCommand(missing), { found: false, expired: false, complete: true, height: '100', scannedThrough: '6' });
  assert.equal((await r.findCommand({ ...missing, expiresHeight: '99' })).expired, true);
  const slow = new FakeTransport();
  for (let i = 0; i < 10; i++) slow.event({ member: manager.address, operation: 'central_task_open', subject: `T-${i}`, digest: sha256('x' + i) });
  const bounded = reader(slow, { maxEventsPerScan: 4 });
  const partial = await bounded.findCommand({ ...missing, expiresHeight: '1' });
  assert.deepEqual([partial.found, partial.expired, partial.complete, partial.scannedThrough], [false, false, false, '4'], 'an incomplete scan never reads as expired');
  await bounded.findCommand({ ...missing, expiresHeight: '1' });
  assert.equal((await bounded.findCommand({ ...missing, expiresHeight: '1' })).expired, true);
});

test('reviews(submission) needs candidate execution IDs and must account for every review event', async () => {
  const t = new FakeTransport();
  const sid = 'S-1';
  const review = (exec, verdict) => {
    t.store[`central_review/${sid}/${sha256(exec)}`] = { submission: sid, verdict, execution_id: exec, reviewer: reviewer.address };
    t.event({ member: reviewer.address, operation: 'central_review', subject: sid, digest: sha256('review ' + exec) });
  };
  await assert.rejects(reader(t).reviews(sid), refuses('native_reviews_unindexed'));
  let candidates = [];
  const r = reader(t, { reviewExecutionIds: async () => candidates });
  assert.deepEqual(await r.reviews(sid), []);
  review('exec-1', 'needs_evidence');
  review('exec-2', 'accept');
  candidates = ['exec-1'];
  await assert.rejects(r.reviews(sid), refuses('native_reviews_incomplete'));
  candidates = ['exec-1', 'exec-2', 'exec-unknown'];
  assert.deepEqual((await r.reviews(sid)).map((x) => x.verdict), ['needs_evidence', 'accept']);
  await assert.rejects(reader(t, { reviewExecutionIds: async () => candidates, startEvent: '1' }).reviews(sid), refuses('native_reviews_unverified'));
});

test('broadcast relays the transport code; production chain writes are off by default', async () => {
  const t = new FakeTransport();
  const envelope = { command: { chain_id: CHAIN, member: solver.address, sequence: '0', operation: 'project_join', payload: { project: P } } };
  const sent = [];
  const plainTransport = { publicState: t.publicState.bind(t), async broadcast(e) { sent.push(e); return 0; } };
  assert.deepEqual({ ...(await reader(plainTransport).broadcast(envelope)) }, { code: 0, definite: false, rejection: null });
  assert.deepEqual(sent, [envelope]);
  await assert.rejects(reader(plainTransport).broadcast({ command: { ...envelope.command, chain_id: 'other' } }), refuses('invalid_native_envelope'));
  const central = { publicState: t.publicState.bind(t), async broadcastCentral() { return { accepted: false, code: 7, transactionHash: 'X', finalized: false }; } };
  // A transport's own refusal is relayed, never as definite (it does not track first sends).
  assert.deepEqual({ ...(await reader(central).broadcast(envelope)) }, { code: 7, definite: false, rejection: null });
  const claims = { publicState: t.publicState.bind(t), async broadcast() { return { code: 7, definite: true, rejection: { definite: true, code: 7 } }; } };
  assert.equal((await reader(claims).broadcast(envelope)).definite, false);
  await assert.rejects(reader({ publicState: t.publicState.bind(t) }).broadcast(envelope), refuses('native_broadcast_unavailable'));
  const prod = new FakeTransport({ chain: PRODUCTION });
  const prodEnvelope = { command: { ...envelope.command, chain_id: PRODUCTION } };
  const prodReader = createNativeReader({ transport: prod, chainId: PRODUCTION, productionChainId: PRODUCTION });
  assert.equal(prodReader.production, true);
  await assert.rejects(prodReader.broadcast(prodEnvelope), refuses('production_broadcast_not_enabled'));
  assert.equal(prod.broadcasts.length, 0);
  assert.equal((await prodReader.read({ keys: [] })).proof.production, true);
});

/** The reader satisfies the native adapter contract end to end on a FIXTURE transport. */
function adapterFixture(transport, readerOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'uain-native-reader-'));
  const registry = openRegistry({ directory: join(directory, 'registry'), selection });
  registry.bind(A, { nativeProjectId: P, nativeManager: manager.address, nativeEvaluator: evaluator.address, paperclipCompanyId: '00000000-0000-4000-8000-000000000001' });
  const journal = openJournal({ directory: join(directory, 'journal'), now: () => NOW });
  const policy = {
    schema: FLEET_POLICY_SCHEMA, revision: 1, selection_digest: selection.digest,
    projects: { [A]: { native_project: P, source_digest: selection.get(A).sourceDigest, paperclip_company: '00000000-0000-4000-8000-000000000001',
      manager: manager.address, evaluator: evaluator.address, max_task_units: '2000000', max_plan_revision: 3 } },
    roles: Object.fromEntries(Object.entries(NATIVE_ROLE_OPERATIONS).map(([k, v]) => [k, [...v]])), solvers: [solver.address],
  };
  const custody = {
    async sign(command) {
      return { command, public_key: solver.publicKey, signature: edSign(null, centralEarningSigningBytes(command), solver.privateKey).toString('base64url') };
    },
  };
  const r = reader(transport, readerOptions);
  const adapter = createNativeAdapter({ custody, reader: r, registry, journal, selection, policy, chainId: CHAIN, now: () => NOW, timeoutMs: 1000 });
  return { adapter, close() { journal.close(); registry.close(); rmSync(directory, { recursive: true, force: true }); } };
}
function seedProject(t) {
  t.store[`project/${P}`] = { id: P, lead: manager.address, state: 'active', safety_halted: false };
  t.store[`central_project_budget/${P}`] = { project: P, manager: manager.address, round: 1, allocation: centralUnlockedUnits(1), reserved: '0', paid: '0', policy: CENTRAL_POLICY };
  t.store[`central_fund_config/${P}`] = { project: P, evaluator: evaluator.address };
}

test('native adapter: snapshot proof is finalized only with transport evidence; reviews unread stay unknown', async () => {
  for (const [finality, expected] of [['header', true], ['none', false]]) {
    const t = new FakeTransport({ finality });
    seedProject(t);
    t.store[`central_task_index/${pad(1)}`] = { id: 'T-1', project: P };
    t.store['central_task/T-1'] = { id: 'T-1', project: P, state: 'under_review', pending: 'S-1', winner: '' };
    t.store.central_task_count = '1';
    t.store['central_submission/S-1'] = { id: 'S-1', task: 'T-1' };
    t.event({ member: reviewer.address, operation: 'central_review', subject: 'S-1', digest: sha256('review') });
    const f = adapterFixture(t);
    try {
      const view = await f.adapter.snapshot(A, { evidence: true });
      assert.equal(view.available, true);
      assert.equal(view.proof.finalized, expected, finality);
      assert.equal(view.proof.appHash === null, !expected);
      assert.deepEqual(view.tasks.map((x) => x.id), ['T-1']);
      assert.deepEqual(view.records['central_submission/S-1'], { id: 'S-1', task: 'T-1' });
      assert.ok(view.unread.includes('central_review/'), 'reviews without an execution-ID source are unknown, not empty');
    } finally {
      f.close();
    }
  }
});

test('native adapter: dispatch broadcasts through the reader and reconcile confirms only a finalized command', async () => {
  // Reconcile passes the retained envelope, so the gateway receipt for it decides finality:
  // a finalized receipt confirms; a non-finalized one refuses even over header evidence.
  for (const [finality, receiptFinalized, confirmed] of [['header', true, true], ['app_hash', true, true], ['header', false, false], ['app_hash', false, false]]) {
    const t = new FakeTransport({ finality });
    t.receiptFinalized = receiptFinalized;
    seedProject(t);
    const f = adapterFixture(t);
    try {
      await f.adapter.prepare(A, 'project_join', { project: P }, { id: 'join-1', signer: solver.address });
      const sent = await f.adapter.dispatch('join-1');
      assert.equal(sent.status, 'dispatched');
      assert.equal(t.broadcasts.length, 1);
      if (confirmed) {
        const settled = await f.adapter.reconcile('join-1');
        assert.equal(settled.status, 'confirmed');
        assert.equal(settled.intent.receipt.finalized, true);
        assert.equal(settled.intent.receipt.command_digest, sha256(centralEarningSigningBytes(settled.intent.envelope.command)));
      } else {
        await assert.rejects(f.adapter.reconcile('join-1'), refuses('proof_mismatch'));
      }
    } finally {
      f.close();
    }
  }
});
