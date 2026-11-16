import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { centralEarningSigningBytes } from '../../../apps/baink/server/central-earning-command.mjs';
import { memberAddress } from '../../../apps/baink/server/native-financial-command.mjs';
import { sha256 } from '../src/common.mjs';
import { validateSelection } from '../src/selection.mjs';
import { openRegistry } from '../src/registry.mjs';
import { openJournal } from '../src/journal.mjs';
import { FLEET_POLICY_SCHEMA, NATIVE_ROLE_OPERATIONS, createNativeAdapter, validateFleetPolicy } from '../src/native.mjs';

const CHAIN = 'uain-fixture-chain';
const NOW = Date.parse('2026-11-06T12:00:00Z');
const ids = Array.from({ length: 120 }, (_, i) => `OPP-${String(i + 1).padStart(5, '0')}`);
const selection = validateSelection({
  schema: 'uain-project-organization-selection-v1', observedAt: '2026-11-05T00:00:00Z', count: 120,
  selection: 'FICTIONAL fixture selection', authority: 'test',
  projects: ids.map((id) => ({
    id, sourceDigest: sha256('source ' + id), modelPlanDigest: sha256('plan ' + id),
    kpi: { statement: 'Independently verified measurable outcome for ' + id, threshold: null, unit: null, comparator: null, qualification: 'Fixture only' },
  })),
});
const [A, B, C] = ids;
const native = (id) => 'P-' + id;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return { address: memberAddress(pub), publicKey: pub.toString('base64url'), privateKey };
}
const managerA = identity();
const managerB = identity();
const evaluator = identity();
const solver = identity();
const outsider = identity();
const everyone = [managerA, managerB, evaluator, solver, outsider];

function fleetPolicy(overrides = {}) {
  const row = (id, manager, n) => ({
    native_project: native(id), source_digest: selection.get(id).sourceDigest, paperclip_company: uuid(n),
    manager: manager.address, evaluator: evaluator.address, max_task_units: '2000000', max_plan_revision: 3,
  });
  return {
    schema: FLEET_POLICY_SCHEMA, revision: 1, selection_digest: selection.digest,
    projects: { [A]: row(A, managerA, 1), [B]: row(B, managerB, 2) },
    roles: Object.fromEntries(Object.entries(NATIVE_ROLE_OPERATIONS).map(([k, v]) => [k, [...v]])),
    solvers: [solver.address],
    ...overrides,
  };
}

/** Authoritative native stand-in: state, inclusion and broadcast bytes. */
class FakeNative {
  constructor() {
    this.height = 100n;
    this.headerTime = NOW;
    this.records = {};
    this.members = {};
    this.included = new Map();
    this.broadcasts = [];
    this.broadcastMode = 'include'; // include | include-then-throw | throw | hang
    this.reads = 0;
    for (const m of everyone) this.members[m.address] = { id: m.address, public_key: m.publicKey, licence: 'active', sequence: '4' };
    for (const [id, manager] of [[A, managerA], [B, managerB]]) {
      const P = native(id);
      this.records[`project/${P}`] = { id: P, lead: 'uain1' + 'f'.repeat(40), state: 'active', safety_halted: false };
      this.records[`central_project_budget/${P}`] = { project: P, manager: manager.address, round: 1, closed: false, main_kpi_achieved: false };
      this.records[`central_fund_config/${P}`] = { project: P, evaluator: evaluator.address };
    }
  }
  async read({ member, keys }) {
    this.reads++;
    if (this.readError) throw this.readError;
    return structuredClone({
      chain_id: CHAIN, height: String(this.height), header_time: new Date(this.headerTime).toISOString(),
      member: member ? this.members[member] ?? null : null,
      records: Object.fromEntries(keys.map((k) => [k, this.records[k] ?? null])),
    });
  }
  async broadcast(envelope) {
    this.broadcasts.push(JSON.stringify(envelope));
    if (this.broadcastMode === 'hang') return new Promise(() => {});
    if (this.broadcastMode === 'throw') throw new Error('lost reply');
    const c = envelope.command;
    const txHash = sha256(JSON.stringify(envelope)).toUpperCase();
    // CheckTx refusals: definite (operator broadcaster, first send), or not definite (mempool full).
    if (this.broadcastMode === 'refuse') return { code: 1, definite: true, rejection: { definite: true, code: 1, codespace: 'undefined', log: 'fixture refusal', txHash, chainId: CHAIN, operation: c.operation } };
    if (this.broadcastMode === 'refuse-other') return { code: 1, definite: true, rejection: { definite: true, code: 1, codespace: 'undefined', log: '', txHash: 'A'.repeat(64), chainId: CHAIN, operation: c.operation } };
    if (this.broadcastMode === 'mempool-full') return { code: 20, definite: false, rejection: null };
    const commandDigest = sha256(centralEarningSigningBytes(c));
    if (!this.included.has(commandDigest) && this.members[c.member].sequence === c.sequence) {
      this.included.set(commandDigest, {
        authority: 'native', finalized: true, chain_id: CHAIN, command_digest: commandDigest, member: c.member, operation: c.operation,
        height: String(this.height + 1n),
      });
      this.members[c.member].sequence = String(BigInt(c.sequence) + 1n);
    }
    if (this.broadcastMode === 'include-then-throw') throw new Error('timeout after native acceptance');
    return 0;
  }
  async findCommand({ commandDigest, expiresHeight }) {
    const proof = this.included.get(commandDigest);
    if (proof) return { found: true, proof: structuredClone(proof) };
    return { found: false, expired: this.height > BigInt(expiresHeight), height: String(this.height) };
  }
  async tasks(P) {
    return Object.entries(this.records).filter(([k, v]) => k.startsWith('central_task/') && v.project === P).map(([, v]) => v);
  }
}

class FakeCustody {
  constructor() {
    this.signed = [];
    this.keys = new Map(everyone.map((m) => [m.address, m]));
  }
  async sign(command) {
    this.signed.push(command);
    if (this.mode === 'hang') return new Promise(() => {});
    const key = this.keys.get(command.member);
    const signedCommand = this.mode === 'substitute' ? { ...command, payload: { ...command.payload, evidence_digest: 'e'.repeat(64) } } : command;
    return {
      command: signedCommand, public_key: key.publicKey,
      signature: edSign(null, centralEarningSigningBytes(signedCommand), key.privateKey).toString('base64url'),
    };
  }
}

function fixture({ policy = fleetPolicy(), bind = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'uain-native-adapter-'));
  const registry = openRegistry({ directory: join(directory, 'registry'), selection });
  if (bind) {
    registry.bind(A, { nativeProjectId: native(A), nativeManager: managerA.address, nativeEvaluator: evaluator.address, paperclipCompanyId: uuid(1) });
    registry.bind(B, { nativeProjectId: native(B), nativeManager: managerB.address, nativeEvaluator: evaluator.address, paperclipCompanyId: uuid(2) });
  }
  let journal = openJournal({ directory: join(directory, 'journal'), now: () => NOW });
  const reader = new FakeNative();
  const custody = new FakeCustody();
  const make = (overrides = {}) => createNativeAdapter({
    custody, reader, registry, journal, selection, policy, chainId: CHAIN, now: () => NOW, timeoutMs: 50, ...overrides,
  });
  const f = {
    directory, registry, reader, custody, adapter: make(), make,
    get journal() { return journal; },
    restart() {
      journal.close();
      journal = openJournal({ directory: join(directory, 'journal'), now: () => NOW });
      f.adapter = make();
      return f.adapter;
    },
    close() {
      journal.close();
      registry.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  return f;
}

const planPayload = (id, revision = 1) => ({
  project: native(id), revision, main_kpi: 'Independently verified measurable outcome for ' + id,
  stages: [1, 2, 3, 4, 5].map((round) => ({ round, criteria: `Measured, retained and independently checked evidence for stage ${round}` })),
  reason: 'Decomposition of the fixed Main KPI.', evidence_digest: 'a'.repeat(64),
});
const criteria = 'Produce a reproducible original result meeting the stated bound.';
const taskPayload = (id, amounts = ['1000000', '100000']) => ({
  id: 'T-' + id, project: native(id), title: 'Bounded original research task', criteria, acceptance_digest: sha256(criteria),
  eligibility: 'unresolved', eligibility_digest: 'b'.repeat(64), solver_amount: amounts[0], reviewer_amount: amounts[1], evidence_digest: 'c'.repeat(64),
});
const approve = (f, id) => { f.reader.records[`central_fund_state/${native(id)}`] = { revision: 1, approved_revision: 1, pending: '', completed: 0 }; };

async function refused(promise, code) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return true;
  });
}

test('policy maps exactly onto native signer semantics and refuses drift', () => {
  assert.equal(validateFleetPolicy(fleetPolicy(), selection).revision, 1);
  const bad = [
    [{ roles: { ...fleetPolicy().roles, manager: ['central_fund_decide'] } }, 'role_operation_not_native'],
    [{ roles: { ...fleetPolicy().roles, solver: ['central_task_open'] } }, 'role_operation_not_native'],
    [{ selection_digest: 'f'.repeat(64) }, 'fleet_policy_selection_drift'],
    [{ projects: { ...fleetPolicy().projects, 'OPP-99999': fleetPolicy().projects[A] } }, 'project_not_selected'],
    [{ projects: { [A]: { ...fleetPolicy().projects[A], source_digest: 'd'.repeat(64) } } }, 'fleet_policy_binding_mismatch'],
    [{ projects: { [A]: { ...fleetPolicy().projects[A], evaluator: managerA.address } } }, 'evaluator_is_manager'],
    [{ projects: { [A]: fleetPolicy().projects[A], [B]: { ...fleetPolicy().projects[B], manager: managerA.address } } }, 'duplicate_fleet_binding'],
    [{ projects: { [A]: { ...fleetPolicy().projects[A], max_task_units: '1000000000000001' } } }, 'invalid_amount'],
    [{ solvers: [managerA.address] }, 'invalid_fleet_policy'],
  ];
  for (const [change, code] of bad) assert.throws(() => validateFleetPolicy(fleetPolicy(change), selection), (e) => e.code === code, code);
});

test('unselected project, opcode and signer are refused before journal or custody', async () => {
  const f = fixture();
  try {
    await refused(f.adapter.prepare('OPP-99999', 'central_fund_plan', planPayload(A), { id: 'i1' }), 'project_not_selected');
    await refused(f.adapter.prepare(C, 'central_fund_plan', planPayload(C), { id: 'i2' }), 'project_not_in_fleet_policy');
    await refused(f.adapter.prepare(A, 'central_project_start', { project: native(A), manager: managerA.address, evidence_digest: 'a'.repeat(64) }, { id: 'i3' }), 'guardian_operation_unreachable');
    await refused(f.adapter.prepare(A, 'central_fund_configure', { project: native(A), evaluator: evaluator.address, expected_evaluator: '', evidence_digest: 'a'.repeat(64) }, { id: 'i4' }), 'guardian_operation_unreachable');
    await refused(f.adapter.prepare(A, 'central_review', { submission: 'S1', verdict: 'accept', criteria_digest: 'a'.repeat(64), verification_digest: 'a'.repeat(64), execution_id: 'x', evidence_digest: 'a'.repeat(64) }, { id: 'i5' }), 'operation_not_allowed');
    await refused(f.adapter.prepare(A, 'central_fund_plan', planPayload(B), { id: 'i6' }), 'payload_project_mismatch');
    await refused(f.adapter.prepare(A, 'central_submit', { id: 'S1', task: 'T-x', evidence: 'e', evidence_digest: sha256('e') }, { id: 'i7', signer: outsider.address }), 'signer_not_authorized');
    // A manager key cannot sign the evaluator's plan, nor B's manager sign A's task.
    await refused(f.adapter.prepare(A, 'central_fund_plan', planPayload(A), { id: 'i8', signer: managerA.address }), 'signer_not_authorized');
    approve(f, A);
    await refused(f.adapter.prepare(A, 'central_task_open', taskPayload(A), { id: 'i9', signer: managerB.address }), 'signer_not_authorized');
    await refused(f.adapter.prepare(A, 'central_submit', { id: 'S1', task: 'T-x', evidence: 'e', evidence_digest: sha256('e') }, { id: 'i10' }), 'signer_required');
    assert.equal(f.journal.list().length, 0);
    assert.equal(f.custody.signed.length, 0);
  } finally {
    f.close();
  }
});

test('a narrowed policy role cannot be widened by the caller', async () => {
  const roles = { ...fleetPolicy().roles, manager: ['project_join', 'central_task_open'] };
  const f = fixture({ policy: fleetPolicy({ roles }) });
  try {
    await refused(f.adapter.prepare(A, 'central_task_fund', { task: 'T-' + A, evidence_digest: 'a'.repeat(64) }, { id: 'n1' }), 'operation_not_allowed');
  } finally {
    f.close();
  }
});

test('wrong source, plan revision, manager or evaluator is refused', async () => {
  const f = fixture();
  try {
    await refused(f.adapter.prepare(A, 'central_fund_plan', planPayload(A, 2), { id: 'w1' }), 'plan_revision_mismatch');
    await refused(f.adapter.prepare(A, 'central_fund_plan', planPayload(A, 4), { id: 'w2' }), 'plan_revision_above_bound');
    await refused(f.adapter.prepare(A, 'central_fund_plan_review', { project: native(A), revision: 1, verdict: 'accept', evidence_digest: 'a'.repeat(64) }, { id: 'w3' }), 'plan_revision_mismatch');
    await refused(f.adapter.prepare(A, 'central_task_open', taskPayload(A), { id: 'w4' }), 'plan_not_approved');
    approve(f, A);
    await refused(f.adapter.prepare(A, 'central_task_open', taskPayload(A, ['1900000', '100001']), { id: 'w5' }), 'amount_above_bound');
    f.reader.records[`central_project_budget/${native(A)}`].manager = outsider.address;
    await refused(f.adapter.prepare(A, 'central_task_open', taskPayload(A), { id: 'w6' }), 'native_manager_mismatch');
    f.reader.records[`central_project_budget/${native(A)}`].manager = managerA.address;
    f.reader.records[`central_fund_config/${native(A)}`].evaluator = outsider.address;
    await refused(f.adapter.prepare(A, 'central_fund_plan', planPayload(A), { id: 'w7' }), 'native_evaluator_mismatch');
    assert.equal(f.custody.signed.length, 0);
  } finally {
    f.close();
  }
  // Registry bound to a different manager than the root-owned policy.
  const g = fixture({ bind: false });
  try {
    g.registry.bind(A, { nativeProjectId: native(A), nativeManager: outsider.address, nativeEvaluator: evaluator.address });
    approve(g, A);
    await refused(g.adapter.prepare(A, 'central_task_open', taskPayload(A), { id: 'w8' }), 'manager_binding_mismatch');
    await refused(g.adapter.prepare(B, 'central_task_open', taskPayload(B), { id: 'w9' }), 'native_binding_missing');
  } finally {
    g.close();
  }
  // Policy pinned to another source digest cannot even construct an adapter.
  const p = fleetPolicy();
  p.projects[A].source_digest = 'd'.repeat(64);
  assert.throws(() => fixture({ policy: p }), (e) => e.code === 'fleet_policy_binding_mismatch');
});

test('stale proof and revoked licence refuse before signing', async () => {
  const f = fixture();
  try {
    f.reader.headerTime = NOW - 10 * 60 * 1000;
    await refused(f.adapter.prepare(A, 'central_fund_plan', planPayload(A), { id: 's1' }), 'stale_native_proof');
    f.reader.headerTime = NOW;
    const intent = await f.adapter.prepare(A, 'central_fund_plan', planPayload(A), { id: 's2' });
    assert.equal(intent.state, 'prepared');
    assert.equal(intent.signer, evaluator.address);
    assert.equal(f.custody.signed.length, 0, 'prepare never calls custody');
    f.reader.members[evaluator.address].licence = 'revoked';
    await refused(f.adapter.dispatch('s2'), 'member_licence_inactive');
    assert.equal(f.custody.signed.length, 0);
    assert.equal(f.journal.get('s2').state, 'failed');
    assert.equal(f.reader.broadcasts.length, 0);
  } finally {
    f.close();
  }
});

test('a policy revision change after prepare refuses the stale intent', async () => {
  let current = fleetPolicy();
  const f = fixture({ policy: () => current });
  try {
    await f.adapter.prepare(A, 'central_fund_plan', planPayload(A), { id: 'r1' });
    current = { ...fleetPolicy(), revision: 2 };
    await refused(f.adapter.dispatch('r1'), 'policy_revision_changed');
    assert.equal(f.custody.signed.length, 0);
  } finally {
    f.close();
  }
});

test('one shared signer across two projects is serialized: second gets signer_lane_busy', async () => {
  const f = fixture();
  try {
    await f.adapter.prepare(A, 'central_fund_plan', planPayload(A), { id: 'plan-a' });
    await f.adapter.prepare(B, 'central_fund_plan', planPayload(B), { id: 'plan-b' });
    const [first, second] = await Promise.allSettled([f.adapter.dispatch('plan-a'), f.adapter.dispatch('plan-b')]);
    assert.equal(first.status, 'fulfilled');
    assert.equal(first.value.status, 'dispatched');
    assert.equal(second.status, 'rejected');
    assert.equal(second.reason.code, 'signer_lane_busy');
    assert.equal(f.journal.get('plan-b').state, 'prepared');
    assert.equal((await f.adapter.reconcile('plan-a')).status, 'confirmed');
    const next = await f.adapter.dispatch('plan-b');
    assert.equal(next.status, 'dispatched');
    assert.equal(next.intent.envelope.command.sequence, '5', 'second command uses the next native sequence');
    assert.equal(f.custody.signed.length, 2);
  } finally {
    f.close();
  }
});

test('crash after retaining the envelope but before broadcast: restart reconciles, never re-signs', async () => {
  const f = fixture();
  try {
    await f.adapter.prepare(A, 'central_fund_plan', planPayload(A), { id: 'c1' });
    const real = f.journal;
    const crashing = { ...real, recordEnvelope(id, e) { real.recordEnvelope(id, e); throw new Error('process killed'); } };
    await assert.rejects(f.make({ journal: crashing }).dispatch('c1'), /process killed/);
    assert.equal(f.reader.broadcasts.length, 0);
    const adapter = f.restart();
    await refused(adapter.dispatch('c1'), 'reconcile_required');
    assert.equal((await adapter.reconcile('c1')).status, 'unknown');
    assert.equal(f.reader.broadcasts.length, 0, 'reconcile alone never broadcasts');
    const retained = JSON.stringify(f.journal.get('c1').envelope);
    assert.equal((await adapter.reconcile('c1', { rebroadcast: true })).rebroadcast, true);
    assert.deepEqual(f.reader.broadcasts, [retained], 'rebroadcast is byte-identical');
    assert.equal((await adapter.reconcile('c1')).status, 'confirmed');
    assert.equal(f.custody.signed.length, 1);
  } finally {
    f.close();
  }
});

test('crash after broadcast: unknown outcome is confirmed from native state', async () => {
  const f = fixture();
  try {
    f.reader.broadcastMode = 'include-then-throw';
    await f.adapter.prepare(A, 'central_fund_plan', planPayload(A), { id: 'c2' });
    const result = await f.adapter.dispatch('c2');
    assert.equal(result.status, 'unknown');
    const adapter = f.restart();
    const settled = await adapter.reconcile('c2');
    assert.equal(settled.status, 'confirmed');
    assert.equal(settled.intent.receipt.command_digest, sha256(centralEarningSigningBytes(settled.intent.envelope.command)));
    assert.equal(f.custody.signed.length, 1);
    assert.equal(f.reader.broadcasts.length, 1);
  } finally {
    f.close();
  }
});

test('unknown outcome is never resent or re-signed; expiry fails it only from native height', async () => {
  const f = fixture();
  try {
    f.reader.broadcastMode = 'hang';
    await f.adapter.prepare(A, 'central_fund_plan', planPayload(A), { id: 'u1' });
    assert.equal((await f.adapter.dispatch('u1')).status, 'unknown');
    for (let i = 0; i < 3; i++) assert.equal((await f.adapter.reconcile('u1')).status, 'unknown');
    await refused(f.adapter.dispatch('u1'), 'reconcile_required');
    assert.equal(f.reader.broadcasts.length, 1);
    assert.equal(f.custody.signed.length, 1);
    // The lane stays held while the outcome is unknown.
    await f.adapter.prepare(B, 'central_fund_plan', planPayload(B), { id: 'u2' });
    await refused(f.adapter.dispatch('u2'), 'signer_lane_busy');
    f.reader.height = 201n;
    assert.equal((await f.adapter.reconcile('u1')).status, 'failed');
    assert.equal(f.reader.broadcasts.length, 1);
  } finally {
    f.close();
  }
});

test('a definite first-send CheckTx refusal fails the intent at once and frees the signer lane', async () => {
  const f = fixture();
  try {
    f.reader.broadcastMode = 'refuse';
    await f.adapter.prepare(A, 'central_fund_plan', planPayload(A), { id: 'r1' });
    const sent = await f.adapter.dispatch('r1');
    assert.deepEqual([sent.status, sent.code, sent.intent.state, sent.intent.failure], ['failed', 1, 'failed', 'node_rejected:1']);
    assert.deepEqual([sent.intent.receipt.definite, sent.intent.receipt.codespace, sent.intent.receipt.log], [true, 'undefined', 'fixture refusal']);
    assert.equal(sent.intent.receipt.txHash, sha256(JSON.stringify(sent.intent.envelope)).toUpperCase());
    // Settled: never reconciled, resent or re-signed.
    const reads = f.reader.reads;
    assert.equal((await f.adapter.reconcile('r1', { rebroadcast: true })).status, 'failed');
    assert.equal(f.reader.reads, reads, 'reconcile of a failed intent reads nothing');
    assert.throws(() => f.journal.reconcile('r1', { found: true, proof: { authority: 'native' } }), (e) => e.code === 'intent_state_conflict');
    await refused(f.adapter.dispatch('r1'), 'reconcile_required');
    assert.equal(f.reader.broadcasts.length, 1);
    assert.equal(f.custody.signed.length, 1);
    // Preparing the same ID returns the failed intent; it is never revived.
    assert.equal((await f.adapter.prepare(A, 'central_fund_plan', planPayload(A), { id: 'r1' })).state, 'failed');
    // The evaluator lane is free at once: a NEW intent is prepared and signed from fresh state.
    f.reader.broadcastMode = 'include';
    await f.adapter.prepare(B, 'central_fund_plan', planPayload(B), { id: 'r2' });
    const next = await f.adapter.dispatch('r2');
    assert.deepEqual([next.status, next.code], ['dispatched', 0]);
    assert.equal(f.custody.signed.length, 2);
    assert.equal(f.custody.signed[1].sequence, f.custody.signed[0].sequence, 'the refused command consumed no sequence');
    assert.notEqual(next.intent.envelope.signature, sent.intent.envelope.signature);
  } finally {
    f.close();
  }
});

test('a refusal that is not definite, or names other bytes, stays unknown and holds the lane', async () => {
  const f = fixture();
  try {
    for (const [mode, id] of [['mempool-full', 'n1'], ['refuse-other', 'n2']]) {
      f.reader.broadcastMode = mode;
      await f.adapter.prepare(A, 'central_fund_plan', planPayload(A), { id });
      const sent = await f.adapter.dispatch(id);
      assert.deepEqual([sent.status, sent.intent.state], ['unknown', 'unknown'], mode);
      await f.adapter.prepare(B, 'central_fund_plan', planPayload(B), { id: `${id}-b` });
      await refused(f.adapter.dispatch(`${id}-b`), 'signer_lane_busy');
      f.reader.height = 201n; // only native expiry settles it
      assert.equal((await f.adapter.reconcile(id)).status, 'failed');
      assert.equal(f.journal.get(id).failure, 'expired_unincluded');
      f.reader.height = 100n;
    }
  } finally {
    f.close();
  }
});

test('custody timeout or substituted command is never broadcast', async () => {
  const f = fixture();
  try {
    f.custody.mode = 'hang';
    await f.adapter.prepare(A, 'central_fund_plan', planPayload(A), { id: 't1' });
    await refused(f.adapter.dispatch('t1'), 'custody_timeout');
    assert.equal(f.journal.get('t1').state, 'unknown');
    // No retained envelope exists, so reconciliation returns it to prepared.
    assert.equal((await f.adapter.reconcile('t1')).status, 'prepared');
    f.custody.mode = 'substitute';
    await refused(f.adapter.dispatch('t1'), 'custody_envelope_mismatch');
    assert.equal(f.reader.broadcasts.length, 0);
    assert.equal(f.journal.get('t1').envelope, null);
  } finally {
    f.close();
  }
});

test('a proof for another command cannot confirm an intent', async () => {
  const f = fixture();
  try {
    f.reader.broadcastMode = 'throw';
    await f.adapter.prepare(A, 'central_fund_plan', planPayload(A), { id: 'p1' });
    await f.adapter.dispatch('p1');
    f.reader.findCommand = async () => ({ found: true, proof: { authority: 'native', finalized: true, chain_id: CHAIN, command_digest: 'f'.repeat(64), member: evaluator.address, operation: 'central_fund_plan' } });
    await refused(f.adapter.reconcile('p1'), 'proof_mismatch');
    assert.equal(f.journal.get('p1').state, 'unknown');
  } finally {
    f.close();
  }
});

test('manager, evaluator and solver roles sign only their native operations', async () => {
  const f = fixture();
  try {
    approve(f, A);
    const open = await f.adapter.prepare(A, 'central_task_open', taskPayload(A), { id: 'm1' });
    assert.equal(open.signer, managerA.address);
    const join = await f.adapter.prepare(A, 'project_join', { project: native(A) }, { id: 'm2', signer: solver.address });
    assert.equal(join.signer, solver.address);
    f.reader.records[`central_task/T-${A}`] = { id: 'T-' + A, project: native(A), state: 'open' };
    const submit = await f.adapter.prepare(A, 'central_submit', { id: 'S-1', task: 'T-' + A, evidence: 'result', evidence_digest: sha256('result') }, { id: 'm3', signer: solver.address });
    assert.equal(submit.signer, solver.address);
    // A task of another project cannot be funded or submitted through A.
    f.reader.records[`central_task/T-${B}`] = { id: 'T-' + B, project: native(B), state: 'open' };
    await refused(f.adapter.prepare(A, 'central_task_fund', { task: 'T-' + B, evidence_digest: 'a'.repeat(64) }, { id: 'm4' }), 'payload_project_mismatch');
    const r = f.reader.records;
    r[`central_fund_state/${native(A)}`] = { revision: 1, approved_revision: 1, pending: 'APP-1', completed: 0 };
    r['central_fund_application/APP-1'] = { id: 'APP-1', project: native(A), manager: managerA.address, state: 'pending', round: 1 };
    const decide = await f.adapter.prepare(A, 'central_fund_decide', { application: 'APP-1', verdict: 'accept', verification_digest: 'a'.repeat(64), feedback: 'Evidence independently checked against stage one.', main_kpi_achieved: false }, { id: 'm5' });
    assert.equal(decide.signer, evaluator.address);
    assert.equal(f.custody.signed.length, 0);
  } finally {
    f.close();
  }
});

test('snapshot reports reader-fetched state and leaves unknowns null', async () => {
  const f = fixture();
  try {
    approve(f, A);
    f.reader.records[`central_fund_plan/${native(A)}/00000000000000000001`] = { project: native(A), revision: 1, state: 'accept' };
    f.reader.records[`central_task/T-${A}`] = { id: 'T-' + A, project: native(A), state: 'open' };
    const view = await f.adapter.snapshot(A);
    assert.equal(view.available, true);
    assert.equal(view.fetchedAt, new Date(NOW).toISOString());
    assert.equal(view.budget.manager, managerA.address);
    assert.equal(view.plan.state, 'accept');
    assert.equal(view.tasks.length, 1);
    f.reader.readError = new Error('rpc down');
    const down = await f.adapter.snapshot(A);
    assert.equal(down.available, false);
    for (const k of ['height', 'budget', 'fundConfig', 'fundState', 'plan', 'tasks']) assert.equal(down[k], null, k);
    await assert.rejects(f.adapter.snapshot('OPP-99999'), (e) => e.code === 'project_not_selected');
  } finally {
    f.close();
  }
});

test('snapshot reads the approved plan separately when an amendment is pending', async () => {
  const f = fixture();
  try {
    approve(f, A);
    const P = native(A);
    f.reader.records[`central_fund_state/${P}`] = { ...f.reader.records[`central_fund_state/${P}`], revision: 2, approved_revision: 1 };
    f.reader.records[`central_fund_plan/${P}/00000000000000000001`] = { project: P, revision: 1, state: 'accept' };
    f.reader.records[`central_fund_plan/${P}/00000000000000000002`] = { project: P, revision: 2, state: 'pending' };
    const view = await f.adapter.snapshot(A);
    assert.equal(view.available, true);
    assert.equal(view.plan.revision, 2);
    assert.equal(view.approvedPlan.revision, 1);
    assert.equal(view.approvedPlan.state, 'accept');
  } finally {
    f.close();
  }
});

test('snapshot binds pending application and both plans in one final proved selection', async () => {
 const f=fixture();try {
  approve(f,A);const P=native(A),stateKey=`central_fund_state/${P}`,appKey='central_fund_application/APP-1';
  f.reader.records[stateKey].pending='APP-1';f.reader.records[appKey]={id:'APP-1',project:P,round:1,state:'pending'};
  const calls=[],read=f.reader.read.bind(f.reader);f.reader.read=async(a)=>{calls.push(a.keys);if(calls.length===2)f.reader.height=101n;return read(a);};
  const s=await f.adapter.snapshot(A);
  assert.deepEqual(s.applications?.['APP-1'],f.reader.records[appKey]);
  assert.equal(s.height,'101');assert.equal(s.proof.height,'101');
  assert.ok(calls.some(keys=>keys.includes(appKey)&&keys.includes(stateKey)&&keys.includes(`central_fund_plan/${P}/00000000000000000001`)&&keys.includes(`central_project_budget/${P}`)));
 }finally{f.close();}
});
test('snapshot refuses a changed pending binding or unread application during discovery', async () => {
 for(const mode of ['changed','plan','regressed','unread','stale']){const f=fixture();try{
  approve(f,A);const P=native(A),key=`central_fund_state/${P}`;f.reader.records[key].pending='APP-1';
  const read=f.reader.read.bind(f.reader);let n=0;f.reader.read=async(a)=>{n++;if(n===2){if(mode==='changed')f.reader.records[key].pending='APP-2';if(mode==='plan')f.reader.records[key].approved_revision=2;if(mode==='regressed')f.reader.height=99n;if(mode==='stale')f.reader.headerTime=NOW-600000;}const r=await read(a);if(mode==='unread'&&n===2)delete r.records['central_fund_application/APP-1'];return r;};
  const s=await f.adapter.snapshot(A);assert.equal(s.available,false,mode);assert.equal(s.applications,null);
 }finally{f.close();}}
});
