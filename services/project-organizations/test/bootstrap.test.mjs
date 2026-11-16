import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { centralEarningSigningBytes, CENTRAL_POLICY } from '../../../apps/baink/server/central-earning-command.mjs';
import { memberAddress } from '../../../apps/baink/server/native-financial-command.mjs';
import { digest, sha256 } from '../src/common.mjs';
import { sourceDigestOf, validateSelection } from '../src/selection.mjs';
import { openRegistry } from '../src/registry.mjs';
import { openJournal } from '../src/journal.mjs';
import { FLEET_POLICY_SCHEMA, NATIVE_ROLE_OPERATIONS, createNativeAdapter } from '../src/native.mjs';
import {
  BOOTSTRAP_REVIEW_SCHEMA, BOOTSTRAP_STEPS, GUARDIAN, buildOpenProjectPayload, createBootstrap, openProjectPayload,
  openProjectSigningBytes, participationKey, verifyOpenProjectEnvelope,
} from '../src/bootstrap.mjs';

// FICTIONAL keys, catalogue rows and native state only.
const CHAIN = 'uain-fixture-chain';
const NOW = Date.parse('2026-11-06T12:00:00Z');
const REVISION = 'a'.repeat(40);
const ids = Array.from({ length: 120 }, (_, i) => `OPP-${String(i + 1).padStart(5, '0')}`);
const kpi = (id) => ({ statement: 'Independently verified measurable outcome for ' + id, threshold: null, unit: null, comparator: null, qualification: 'Fixture only' });
const rows = new Map(ids.map((id) => [id, { id, title: `FICTIONAL bounded research question ${id}`, description: 'Fixture description ' + id, category: 'fixture', kpi: kpi(id) }]));
const selection = validateSelection({
  schema: 'uain-project-organization-selection-v1', observedAt: '2026-11-05T00:00:00Z', count: 120,
  selection: 'FICTIONAL fixture selection', authority: 'test',
  projects: ids.map((id) => ({ id, sourceDigest: sourceDigestOf(rows.get(id), REVISION), modelPlanDigest: sha256('plan ' + id), kpi: kpi(id) })),
});
const [A, B, C] = ids;
const native = (id) => 'P-' + id;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return { address: memberAddress(pub), publicKey: pub.toString('base64url'), privateKey };
}
const guardian = identity();
const managerA = identity();
const managerB = identity();
const evaluator = identity();
const solver = identity();
const reviewer = identity();
const outsider = identity();
const everyone = [guardian, managerA, managerB, evaluator, solver, reviewer, outsider];

const review = (id, change = {}) => ({
  schema: BOOTSTRAP_REVIEW_SCHEMA, project: id, source_digest: selection.get(id).sourceDigest, class: 'benevolent',
  prior_art: {
    basis: 'No open or discoverable solution answers this exact bounded question (FICTIONAL fixture).',
    searches: [`fixture search one ${id}`, `fixture search two ${id}`],
  },
  ...change,
});

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

const signingBytes = (c) => (c.operation === 'open_project' ? openProjectSigningBytes(c) : centralEarningSigningBytes(c));

/** Native stand-in that applies the effects of included bootstrap commands. */
class FakeNative {
  constructor() {
    this.height = 100n;
    this.records = { central_earning_activation: { policy: CENTRAL_POLICY, reviewer: reviewer.address, height: '50', evidence_digest: 'a'.repeat(64) } };
    this.members = {};
    this.included = new Map();
    this.broadcasts = [];
    this.broadcastMode = 'include'; // include | include-then-throw | throw
    for (const m of everyone) this.members[m.address] = { id: m.address, public_key: m.publicKey, licence: 'active', sequence: '4' };
    this.members[guardian.address].creator = true;
    for (const m of everyone) this.records[`member/${m.address}`] = this.members[m.address];
  }
  async read({ member, keys }) {
    return structuredClone({
      chain_id: CHAIN, height: String(this.height), header_time: new Date(NOW).toISOString(),
      member: member ? this.members[member] ?? null : null,
      records: Object.fromEntries(keys.map((k) => [k, this.records[k] ?? null])),
    });
  }
  apply(c) {
    const p = c.payload;
    if (c.operation === 'open_project') {
      if (this.records[`project/${p.id}`]) return false;
      this.records[`project/${p.id}`] = { id: p.id, lead: c.member, title: p.title, class: p.class, prior_art: p.prior_art, state: 'active', budget: '0', safety_halted: false };
    } else if (c.operation === 'central_project_start') {
      if (this.records[`central_project_budget/${p.project}`]) return false;
      this.records[`central_project_budget/${p.project}`] = { project: p.project, manager: p.manager, policy: CENTRAL_POLICY, allocation: '10000000000', reserved: '0', paid: '0', round: 1, height: String(this.height), evidence_digest: p.evidence_digest };
    } else if (c.operation === 'central_fund_configure') {
      if (!this.records[`central_project_budget/${p.project}`]) return false;
      this.records[`central_fund_config/${p.project}`] = { project: p.project, evaluator: p.evaluator, height: String(this.height), evidence_digest: p.evidence_digest };
    } else if (c.operation === 'project_join') {
      this.records[participationKey(p.project, c.member)] = { project: p.project, member: c.member };
    }
    return true;
  }
  async broadcast(envelope) {
    this.broadcasts.push(JSON.stringify(envelope));
    if (this.broadcastMode === 'throw') throw new Error('lost reply');
    const c = envelope.command;
    const commandDigest = sha256(signingBytes(c));
    if (!this.included.has(commandDigest) && this.members[c.member].sequence === c.sequence && this.apply(c)) {
      this.included.set(commandDigest, { authority: 'native', finalized: true, chain_id: CHAIN, command_digest: commandDigest, member: c.member, operation: c.operation, height: String(this.height + 1n) });
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
}

class FakeCustody {
  constructor() {
    this.signed = [];
    this.keys = new Map(everyone.map((m) => [m.address, m]));
  }
  async sign(command, context) {
    this.signed.push({ command, context });
    const key = this.keys.get(command.member);
    return { command, public_key: key.publicKey, signature: edSign(null, signingBytes(command), key.privateKey).toString('base64url') };
  }
}

function fixture({ policy = fleetPolicy(), guardianAddress = guardian.address, reviews = { [A]: review(A), [B]: review(B) } } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'uain-bootstrap-'));
  const registry = openRegistry({ directory: join(directory, 'registry'), selection });
  registry.bind(A, { nativeProjectId: native(A), nativeManager: managerA.address, nativeEvaluator: evaluator.address, paperclipCompanyId: uuid(1) });
  let journal = openJournal({ directory: join(directory, 'journal'), now: () => NOW });
  const reader = new FakeNative();
  const custody = new FakeCustody();
  const make = () => createNativeAdapter({ custody, reader, registry, journal, selection, policy, chainId: CHAIN, now: () => NOW, timeoutMs: 50, guardian: guardianAddress });
  const f = {
    reader, custody, registry, adapter: make(), reviews,
    get journal() { return journal; },
    orchestrator() {
      return createBootstrap({
        adapter: f.adapter, journal, selection, policy,
        source: async (id) => ({ row: structuredClone(rows.get(id)), revision: REVISION }),
        review: async (id) => f.reviews[id] ?? null,
      });
    },
    restart() {
      journal.close();
      journal = openJournal({ directory: join(directory, 'journal'), now: () => NOW });
      f.adapter = make();
    },
    close() {
      journal.close();
      registry.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  return f;
}

async function refused(promise, code) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return true;
  });
}
const openPayload = (id = A) => buildOpenProjectPayload({ selection, projectId: id, source: { row: rows.get(id), revision: REVISION }, review: review(id) });

test('open_project payload mirrors native fields and bounds exactly', () => {
  const p = openPayload();
  assert.deepEqual(Object.keys(p).sort(), ['class', 'id', 'prior_art', 'title']);
  assert.equal(p.id, native(A));
  assert.equal(p.title, rows.get(A).title);
  const bad = [
    { title: 'abcd' }, { title: 'x'.repeat(251) }, { title: ' padded title ' }, { title: 'line\nbreak title' }, { class: 'malevolent' },
    { id: 'bad id' }, { extra: 1 }, { prior_art: { ...p.prior_art, basis: 'too short to explain novelty' } },
    { prior_art: { ...p.prior_art, basis: 'b'.repeat(4001) } }, { prior_art: { ...p.prior_art, basis: p.prior_art.basis + '\r' } },
    { prior_art: { ...p.prior_art, searches: ['only one search'] } }, { prior_art: { ...p.prior_art, searches: ['same query', 'same query'] } },
    { prior_art: { ...p.prior_art, searches: ['abcd', 'long enough query'] } }, { prior_art: { ...p.prior_art, searches: ['q'.repeat(1001), 'long enough query'] } },
    { prior_art: { ...p.prior_art, searches: Array.from({ length: 21 }, (_, n) => `search number ${n}`) } }, { prior_art: { ...p.prior_art, extra: 1 } },
  ];
  for (const change of bad) assert.throws(() => openProjectPayload({ ...p, ...change }), (e) => e.code === 'invalid_native_payload', JSON.stringify(change).slice(0, 60));
  // Native SigningBytes: fixed command order, sorted payload keys, Go HTML escaping.
  const command = { version: 1, chain_id: CHAIN, member: guardian.address, sequence: '4', expires_height: '200', operation: 'open_project', payload: { ...p, title: 'Is a<b & c>d?' } };
  assert.equal(openProjectSigningBytes(command).toString(), 'uain:chain-command:v1\n{"version":1,"chain_id":"uain-fixture-chain","member":"' + guardian.address +
    '","sequence":"4","expires_height":"200","operation":"open_project","payload":{"class":"benevolent","id":"P-OPP-00001","prior_art":{"basis":' +
    JSON.stringify(p.prior_art.basis) + ',"searches":' + JSON.stringify(p.prior_art.searches) + '},"title":"Is a\\u003cb \\u0026 c\\u003ed?"}}');
  const envelope = { command, public_key: guardian.publicKey, signature: edSign(null, openProjectSigningBytes(command), guardian.privateKey).toString('base64url') };
  assert.equal(verifyOpenProjectEnvelope(envelope, { chainId: CHAIN }), true);
  assert.throws(() => verifyOpenProjectEnvelope({ ...envelope, command: { ...command, sequence: '5' } }, { chainId: CHAIN }), (e) => e.code === 'custody_envelope_mismatch');
  assert.throws(() => verifyOpenProjectEnvelope({ ...envelope, public_key: outsider.publicKey }, { chainId: CHAIN }), (e) => e.code === 'custody_envelope_mismatch');
  assert.equal(GUARDIAN, 'uain158ac8d0debcf01d43164ef14736597da589d8b54');
});

test('title comes only from the pinned catalogue source; prior art only from a bound review', () => {
  const build = (source, r = review(A), id = A) => () => buildOpenProjectPayload({ selection, projectId: id, source, review: r });
  const good = { row: rows.get(A), revision: REVISION };
  assert.throws(build({ ...good, row: { ...rows.get(A), title: 'A different, unreviewed title' } }), (e) => e.code === 'selected_source_changed');
  assert.throws(build({ ...good, revision: 'b'.repeat(40) }), (e) => e.code === 'selected_source_changed');
  assert.throws(build({ row: rows.get(B), revision: REVISION }), (e) => e.code === 'selected_source_changed');
  assert.throws(build(good, null), (e) => e.code === 'prior_art_review_required');
  assert.throws(build(good, review(A, { source_digest: 'd'.repeat(64) })), (e) => e.code === 'prior_art_review_stale');
  assert.throws(build(good, review(B)), (e) => e.code === 'invalid_prior_art_review');
  assert.throws(build(good, review(A, { class: 'harmful' })), (e) => e.code === 'invalid_prior_art_review');
  assert.throws(build(good, { ...review(A), model_note: 'x' }), (e) => e.code === 'invalid_prior_art_review');
  assert.throws(() => buildOpenProjectPayload({ selection, projectId: 'OPP-99999', source: good, review: review(A) }), (e) => e.code === 'project_not_selected');
  // A title native would refuse is held, never truncated or rewritten.
  const long = { ...rows.get(A), title: 'T'.repeat(251) };
  const pinned = validateSelection({
    schema: 'uain-project-organization-selection-v1', observedAt: '2026-11-05T00:00:00Z', count: 120, selection: 'FICTIONAL', authority: 'test',
    projects: ids.map((id) => ({ id, sourceDigest: sourceDigestOf(id === A ? long : rows.get(id), REVISION), modelPlanDigest: sha256('plan ' + id), kpi: kpi(id) })),
  });
  assert.throws(() => buildOpenProjectPayload({ selection: pinned, projectId: A, source: { row: long, revision: REVISION }, review: { ...review(A), source_digest: pinned.get(A).sourceDigest } }),
    (e) => e.code === 'title_outside_native_bounds');
});

test('unselected project and non-bootstrap caller are refused before journal or custody', async () => {
  const f = fixture();
  try {
    const p = openPayload();
    await refused(f.adapter.prepare('OPP-99999', 'open_project', p, { id: 'o1', caller: 'bootstrap' }), 'project_not_selected');
    await refused(f.adapter.prepare(C, 'open_project', { ...p, id: native(C) }, { id: 'o2', caller: 'bootstrap' }), 'project_not_in_fleet_policy');
    await refused(f.adapter.prepare(A, 'open_project', p, { id: 'o3' }), 'guardian_operation_unreachable');
    await refused(f.adapter.prepare(A, 'open_project', p, { id: 'o4', caller: 'agent', signer: guardian.address }), 'guardian_operation_unreachable');
    await refused(f.adapter.prepare(A, 'open_project', p, { id: 'o5', caller: 'root' }), 'invalid_caller');
    await refused(f.adapter.prepare(A, 'open_project', p, { id: 'o6', caller: 'bootstrap', signer: managerA.address }), 'signer_not_authorized');
    await refused(f.adapter.prepare(A, 'open_project', { ...p, id: native(B) }, { id: 'o7', caller: 'bootstrap' }), 'payload_project_mismatch');
    await refused(f.adapter.prepare(A, 'open_project', { ...p, title: 'abc' }, { id: 'o8', caller: 'bootstrap' }), 'invalid_native_payload');
    await refused(f.adapter.prepare(A, 'project_join', { project: native(A) }, { id: 'o9', caller: 'bootstrap' }), 'bootstrap_is_guardian_only');
    await refused(f.adapter.prepare(A, 'central_project_start', { project: native(A), manager: outsider.address, evidence_digest: 'a'.repeat(64) }, { id: 'o10', caller: 'bootstrap' }), 'manager_mismatch');
    await refused(f.adapter.prepare(A, 'central_fund_configure', { project: native(A), evaluator: outsider.address, expected_evaluator: '', evidence_digest: 'a'.repeat(64) }, { id: 'o11', caller: 'bootstrap' }), 'evaluator_mismatch');
    const narrowed = fleetPolicy({ roles: { ...fleetPolicy().roles, guardian: ['central_project_start', 'central_fund_configure'] } });
    const n = fixture({ policy: narrowed });
    await refused(n.adapter.prepare(A, 'open_project', p, { id: 'o12', caller: 'bootstrap' }), 'operation_not_allowed');
    n.close();
    const unconfigured = fixture({ guardianAddress: null });
    await refused(unconfigured.adapter.prepare(A, 'open_project', p, { id: 'o13', caller: 'bootstrap' }), 'bootstrap_not_configured');
    unconfigured.close();
    const overlapping = fixture({ guardianAddress: managerA.address });
    await refused(overlapping.adapter.prepare(A, 'open_project', p, { id: 'o14', caller: 'bootstrap' }), 'guardian_overlaps_policy');
    overlapping.close();
    assert.equal(f.journal.list().length, 0);
    assert.equal(f.custody.signed.length, 0);
  } finally {
    f.close();
  }
});

test('a guardian intent is dispatched only through the bootstrap caller', async () => {
  const f = fixture();
  try {
    const intent = await f.adapter.prepare(A, 'open_project', openPayload(), { id: 'open-a', caller: 'bootstrap' });
    assert.equal(intent.state, 'prepared');
    assert.equal(intent.signer, guardian.address);
    await refused(f.adapter.dispatch('open-a'), 'guardian_operation_unreachable');
    assert.equal(f.journal.get('open-a').state, 'prepared'); // refused before the claim
    const done = await f.adapter.dispatch('open-a', { caller: 'bootstrap' });
    assert.equal(done.status, 'dispatched');
    assert.deepEqual(f.custody.signed.map((s) => [s.command.operation, s.context.role, s.context.caller]), [['open_project', 'guardian', 'bootstrap']]);
    assert.equal((await f.adapter.reconcile('open-a')).status, 'confirmed');
    assert.equal(f.reader.records[`project/${native(A)}`].lead, guardian.address);
    // An agent intent cannot be pushed through the bootstrap caller.
    await f.adapter.prepare(A, 'project_join', { project: native(A) }, { id: 'join-a', signer: managerA.address });
    await refused(f.adapter.dispatch('join-a', { caller: 'bootstrap' }), 'bootstrap_is_guardian_only');
  } finally {
    f.close();
  }
});

test('an existing project is reused only on an exact binding; anything else is held', async () => {
  const p = openPayload();
  const exact = { id: p.id, lead: guardian.address, title: p.title, class: p.class, prior_art: structuredClone(p.prior_art), state: 'active', budget: '0', safety_halted: false };
  const conflicts = [
    { ...exact, lead: outsider.address }, // same name, other owner: never inferred
    { ...exact, title: p.title + ' (other)' },
    { ...exact, class: 'neutral' },
    { ...exact, prior_art: { ...p.prior_art, searches: [...p.prior_art.searches].reverse() } },
    { ...exact, state: 'halted' },
    { ...exact, lead_instance: 'guardian-instance' },
  ];
  for (const existing of conflicts) {
    const f = fixture();
    try {
      f.reader.records[`project/${native(A)}`] = existing;
      await refused(f.adapter.prepare(A, 'open_project', p, { id: 'open-a', caller: 'bootstrap' }), 'native_project_conflict');
      const r = await f.orchestrator().bootstrapProject(A);
      assert.equal(r.status, 'held');
      assert.equal(r.step, 'open_project');
      assert.equal(r.reason, 'native_project_conflict');
      assert.equal(f.journal.list().length, 0);
      assert.equal(f.custody.signed.length, 0);
    } finally {
      f.close();
    }
  }
  const f = fixture();
  try {
    f.reader.records[`project/${native(A)}`] = exact;
    const reused = await f.adapter.prepare(A, 'open_project', p, { id: 'open-a', caller: 'bootstrap' });
    assert.equal(reused.state, 'reused');
    assert.equal(f.journal.list().length, 0);
    const r = await f.orchestrator().bootstrapProject(A);
    assert.equal(r.status, 'waiting');
    assert.equal(r.step, 'central_project_start');
    assert.deepEqual(r.completed.map((c) => [c.step, c.via]), [['open_project', 'native']]);
    // The guardian must hold the creator role to open a missing project.
    f.reader.records[`project/${native(B)}`] = undefined;
    f.reader.members[guardian.address].creator = false;
    await refused(f.adapter.prepare(B, 'open_project', openPayload(B), { id: 'open-b', caller: 'bootstrap' }), 'guardian_not_creator');
  } finally {
    f.close();
  }
});

test('a compact-storage project is matched through its proven project_metadata record', async () => {
  // chain/federation/compact.go createProject: under compact-state-v1 the state record keeps
  // empty title/class/prior art plus a metadata digest; the immutable metadata holds the rest.
  const p = openPayload();
  const state = { id: p.id, lead: guardian.address, title: '', class: '', prior_art: { basis: '', searches: null }, state: 'active', budget: '0',
    safety_halted: false, storage_policy: 'compact-state-v1', metadata_digest: 'd'.repeat(64) };
  const metadata = { id: p.id, title: p.title, class: p.class, prior_art: structuredClone(p.prior_art) };
  const cases = [
    [metadata, 'reused'],
    [null, 'native_project_conflict'], // metadata unproven: never assumed
    [{ ...metadata, title: p.title + ' (other)' }, 'native_project_conflict'],
    [{ ...metadata, id: 'P-OTHER' }, 'native_project_conflict'],
  ];
  for (const [meta, expected] of cases) {
    const f = fixture();
    try {
      f.reader.records[`project/${native(A)}`] = state;
      f.reader.records[`project_metadata/${native(A)}`] = meta;
      const attempt = f.adapter.prepare(A, 'open_project', p, { id: 'open-a', caller: 'bootstrap' });
      if (expected === 'reused') assert.equal((await attempt).state, 'reused');
      else await refused(attempt, expected);
      assert.equal(f.custody.signed.length, 0);
    } finally {
      f.close();
    }
  }
});

test('bootstrap prepares each step only after the previous one is confirmed', async () => {
  const f = fixture();
  try {
    const o = f.orchestrator();
    const expected = [...BOOTSTRAP_STEPS];
    for (const [n, step] of expected.entries()) {
      const waiting = await o.bootstrapProject(A);
      assert.equal(waiting.status, 'waiting');
      assert.equal(waiting.step, step);
      assert.equal(waiting.intentState, 'prepared');
      assert.equal(waiting.completed.length, n);
      // Idempotent while waiting: no further intent is prepared.
      const again = await o.bootstrapProject(A);
      assert.equal(again.intentId, waiting.intentId);
      assert.equal(f.journal.list().length, n + 1);
      const intent = f.journal.get(waiting.intentId);
      const caller = step === 'project_join' ? 'agent' : 'bootstrap';
      assert.equal(intent.signer, step === 'project_join' ? managerA.address : guardian.address);
      // Dispatched but not yet confirmed: still waiting on the same step.
      await f.adapter.dispatch(waiting.intentId, { caller });
      const dispatched = await o.bootstrapProject(A);
      assert.equal(dispatched.step, step);
      assert.equal(dispatched.intentState, 'dispatched');
      assert.equal((await f.adapter.reconcile(waiting.intentId)).status, 'confirmed');
    }
    const done = await o.bootstrapProject(A);
    assert.equal(done.status, 'complete');
    assert.deepEqual(done.completed.map((c) => [c.step, c.via]), expected.map((s) => [s, 'journal']));
    assert.deepEqual(f.custody.signed.map((s) => s.command.operation), expected);
    const P = native(A);
    const evidence = digest(review(A));
    assert.equal(f.reader.records[`project/${P}`].lead, guardian.address); // no lead transfer
    assert.deepEqual([f.reader.records[`central_project_budget/${P}`].manager, f.reader.records[`central_project_budget/${P}`].evidence_digest], [managerA.address, evidence]);
    assert.deepEqual([f.reader.records[`central_fund_config/${P}`].evaluator, f.reader.records[`central_fund_config/${P}`].evidence_digest], [evaluator.address, evidence]);
    assert.ok(f.reader.records[participationKey(P, managerA.address)]);
    // A second join of the same member is refused natively, so it is reused, not signed.
    const join = await f.adapter.prepare(A, 'project_join', { project: P }, { id: 'join-again', signer: managerA.address });
    assert.equal(join.state, 'reused');
  } finally {
    f.close();
  }
});

test('native preconditions hold start and configure before any signature', async () => {
  const f = fixture();
  try {
    const o = f.orchestrator();
    const step = async () => {
      const r = await o.bootstrapProject(A);
      if (r.status === 'waiting' && r.intentState === 'prepared') {
        await f.adapter.dispatch(r.intentId, { caller: r.step === 'project_join' ? 'agent' : 'bootstrap' });
        await f.adapter.reconcile(r.intentId);
      }
      return r;
    };
    assert.equal((await step()).step, 'open_project');
    const activation = f.reader.records.central_earning_activation;
    delete f.reader.records.central_earning_activation;
    assert.deepEqual([(await o.bootstrapProject(A)).status, (await o.bootstrapProject(A)).reason], ['blocked', 'central_earning_inactive']);
    f.reader.records.central_earning_activation = { ...activation, height: '101' }; // scheduled for a later height
    assert.equal((await o.bootstrapProject(A)).reason, 'central_earning_inactive');
    f.reader.records.central_earning_activation = activation;
    f.reader.records[`member/${managerA.address}`] = { ...f.reader.members[managerA.address], licence: 'revoked' };
    assert.equal((await o.bootstrapProject(A)).reason, 'manager_licence_inactive');
    f.reader.records[`member/${managerA.address}`] = f.reader.members[managerA.address];
    assert.equal((await step()).step, 'central_project_start');
    f.reader.records[`member/${evaluator.address}`] = { ...f.reader.members[evaluator.address], licence: 'pending' };
    assert.equal((await o.bootstrapProject(A)).reason, 'evaluator_licence_inactive');
    f.reader.records[`member/${evaluator.address}`] = f.reader.members[evaluator.address];
    // A budget that names another manager is a conflict, held for reconciliation.
    const P = native(A);
    const budget = f.reader.records[`central_project_budget/${P}`];
    f.reader.records[`central_project_budget/${P}`] = { ...budget, manager: outsider.address };
    const mismatch = await o.bootstrapProject(A);
    assert.deepEqual([mismatch.status, mismatch.step, mismatch.reason], ['held', 'central_fund_configure', 'native_manager_mismatch']);
    f.reader.records[`central_project_budget/${P}`] = budget;
    f.reader.records[`central_fund_config/${P}`] = { project: P, evaluator: outsider.address };
    const held = await o.bootstrapProject(A);
    assert.deepEqual([held.status, held.reason], ['held', 'native_bootstrap_conflict']);
    delete f.reader.records[`central_fund_config/${P}`];
    assert.equal((await step()).step, 'central_fund_configure');
    assert.deepEqual(f.custody.signed.map((s) => s.command.operation), ['open_project', 'central_project_start', 'central_fund_configure']);
    // A missing review holds the project before anything is prepared.
    const g = fixture({ reviews: {} });
    const r = await g.orchestrator().bootstrapProject(A);
    assert.deepEqual([r.status, r.step, r.reason], ['held', 'open_project', 'prior_art_review_required']);
    assert.equal(g.journal.list().length, 0);
    g.close();
  } finally {
    f.close();
  }
});

test('crash or unknown outcome is reconciled from native state without re-signing', async () => {
  const f = fixture();
  try {
    let r = await f.orchestrator().bootstrapProject(A);
    f.reader.broadcastMode = 'include-then-throw';
    assert.equal((await f.adapter.dispatch(r.intentId, { caller: 'bootstrap' })).status, 'unknown');
    f.reader.broadcastMode = 'include';
    f.restart(); // process crash: a fresh journal handle and adapter
    r = await f.orchestrator().bootstrapProject(A);
    assert.deepEqual([r.status, r.step, r.intentState], ['waiting', 'open_project', 'unknown']);
    await refused(f.adapter.dispatch(r.intentId, { caller: 'bootstrap' }), 'reconcile_required');
    assert.equal((await f.adapter.reconcile(r.intentId)).status, 'confirmed');
    assert.equal(f.custody.signed.length, 1);
    r = await f.orchestrator().bootstrapProject(A);
    assert.equal(r.step, 'central_project_start');

    // Lost reply, not included: stays unknown, a rebroadcast resends the exact bytes only.
    f.reader.broadcastMode = 'throw';
    assert.equal((await f.adapter.dispatch(r.intentId, { caller: 'bootstrap' })).status, 'unknown');
    const signed = f.custody.signed.length;
    f.reader.broadcastMode = 'include';
    const again = await f.adapter.reconcile(r.intentId, { rebroadcast: true });
    assert.equal(again.rebroadcast, true);
    assert.equal(f.reader.broadcasts.at(-1), f.reader.broadcasts.at(-2));
    assert.equal(f.custody.signed.length, signed);
    assert.equal((await f.adapter.reconcile(r.intentId)).status, 'confirmed');
    assert.equal((await f.orchestrator().bootstrapProject(A)).step, 'central_fund_configure');

    // A definitely failed step is held for review, never silently re-prepared.
    const failing = fixture();
    const first = await failing.orchestrator().bootstrapProject(A);
    failing.journal.fail(first.intentId, 'operator_rejected');
    const held = await failing.orchestrator().bootstrapProject(A);
    assert.deepEqual([held.status, held.reason, held.failure], ['held', 'bootstrap_step_failed', 'operator_rejected']);
    failing.close();
  } finally {
    f.close();
  }
});

test('a step satisfied between prepare and dispatch fails unsigned and is then reused', async () => {
  const f = fixture();
  try {
    const r = await f.orchestrator().bootstrapProject(A);
    const p = f.journal.get(r.intentId).payload;
    f.reader.records[`project/${native(A)}`] = { ...structuredClone(p), lead: guardian.address, state: 'active', safety_halted: false };
    await refused(f.adapter.dispatch(r.intentId, { caller: 'bootstrap' }), 'native_already_satisfied');
    assert.equal(f.journal.get(r.intentId).state, 'failed');
    assert.equal(f.custody.signed.length, 0);
    const next = await f.orchestrator().bootstrapProject(A);
    assert.deepEqual([next.step, next.completed[0].via], ['central_project_start', 'native']);
  } finally {
    f.close();
  }
});
