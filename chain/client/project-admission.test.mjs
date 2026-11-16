import {test} from 'node:test';
import assert from 'node:assert/strict';
import {freezeProjectAdmission, runProjectAdmission, projectAdmissionPilotConfig} from './project-admission.mjs';
const member = 'uain1' + '1'.repeat(40);
const basis = {basis: 'Isolated fixture only, no production novelty is asserted.', searches: ['fixture-source-a', 'fixture-source-b']};
function input(status = 'approved') {return {
  scope: {chainId: 'isolated-fixture', genesisSha256: 'a'.repeat(64), member, instance: 'fixture-instance'},
  source: {id: 'FIXTURE-ONE', digest: 'b'.repeat(64)}, decision: {status, ...structuredClone(basis)},
  project: {id: 'fixture-project', title: 'A bounded isolated fixture project', class: 'neutral', prior_art: structuredClone(basis)},
  task: {id: 'fixture-task', project: 'fixture-project', title: 'One isolated fixture task', class: 'neutral', prior_art: structuredClone(basis),
    criteria: 'The fixture output must match the independent test oracle exactly.', kind: 'instant', karma_reward: 0, credit_reward: '0'},
};}
function fixture(plan, override = {}) {
  const calls = [];
  const deps = {
    currentScope: async () => plan.scope, sourceDigest: async () => plan.source.digest,
    invoke: async (name, step) => {calls.push({name, step}); return {authority: 'native', request_id: step.request_id,
      finalized: true, event: {id: String(calls.length), operation: step.operation, subject: step.payload.id, member, instance: plan.scope.instance}};},
    ...override,
  };
  return {calls, deps};
}
test('freezes one bounded source/project/task and records public source commitment', () => {
  const source = input(); const plan = freezeProjectAdmission(source);
  assert.ok(Object.isFrozen(plan.task.prior_art.searches));
  source.task.criteria = 'changed';
  assert.notEqual(plan.task.criteria, source.task.criteria);
  assert.equal(plan.steps.length, 2);
  assert.deepEqual(plan.steps.map(s => s.operation), ['open_project', 'open_task']);
  assert.match(plan.steps[0].payload.prior_art.basis, /FIXTURE-ONE@bbbb/);
  assert.deepEqual(plan, freezeProjectAdmission(input()));
  assert.notEqual(plan.digest, freezeProjectAdmission({...input(), source: {id: 'FIXTURE-ONE', digest: 'c'.repeat(64)}}).digest);
});
test('pilot allowlist is derived exactly from approved source-bound frozen steps', () => {
  const plan = freezeProjectAdmission(input());
  const config = projectAdmissionPilotConfig(plan);
  assert.deepEqual(config, {
    sourceId: plan.source.id, sourceDigest: plan.source.digest,
    projectId: plan.project.id, taskId: plan.task.id,
    creatorAddress: plan.scope.member, creatorInstance: plan.scope.instance,
    chainId: plan.scope.chainId, epoch: plan.scope.genesisSha256,
    projectPayload: plan.steps[0].payload, taskPayload: plan.steps[1].payload,
  });
  assert.ok(Object.isFrozen(config.projectPayload.prior_art.searches));
  assert.match(config.projectPayload.prior_art.basis, new RegExp(plan.digest));
  for (const status of ['held', 'rejected'])
    assert.throws(() => projectAdmissionPilotConfig(freezeProjectAdmission(input(status))), /approved/);
  const tampered = structuredClone(plan); tampered.steps[0].payload.title = 'Tampered title';
  assert.throws(() => projectAdmissionPilotConfig(tampered), /intent changed/);
});

test('admission is sequential final native registration, not scientific acceptance or money', async () => {
  const plan = freezeProjectAdmission(input()); const {deps, calls} = fixture(plan);
  const result = await runProjectAdmission(plan, deps);
  assert.equal(result.state, 'admitted'); assert.equal(result.receipts.length, 2);
  assert.equal(result.financialOperations, false); assert.equal(result.scientificAcceptance, false);
  assert.equal(calls[0].name, 'uain_native_command');
  assert.equal(calls[1].step.payload.project, plan.project.id);
  assert.equal(calls[1].step.payload.karma_reward, 0);
  assert.equal(calls[1].step.payload.credit_reward, '0');
});
test('held and rejected decisions do not require or call signing capability', async () => {
  for (const status of ['held', 'rejected']) {
    const plan = freezeProjectAdmission(input(status));
    assert.equal((await runProjectAdmission(plan)).state, status);
  }
});
test('pending project stops task signing; resume uses identical intent IDs', async () => {
  const plan = freezeProjectAdmission(input()); let pending = true; const calls = [];
  const {deps} = fixture(plan, {invoke: async (_, step) => {
    calls.push(structuredClone(step));
    if (pending) return {authority: 'native', request_id: step.request_id, finalized: false};
    return {authority: 'native', request_id: step.request_id, finalized: true,
      event: {id: '1', operation: step.operation, subject: step.payload.id, member, instance: plan.scope.instance}};
  }});
  assert.equal((await runProjectAdmission(plan, deps)).state, 'pending');
  assert.equal(calls.length, 1);
  pending = false;
  assert.equal((await runProjectAdmission(plan, deps)).state, 'admitted');
  assert.deepEqual(calls[0], calls[1]); assert.equal(calls.length, 3);
});
test('changed source and chain/actor reject before invoking bridge', async () => {
  const plan = freezeProjectAdmission(input());
  for (const override of [
    {sourceDigest: async () => 'c'.repeat(64)},
    {currentScope: async () => ({...plan.scope, member: 'uain1' + '2'.repeat(40)})},
    {currentScope: async () => ({...plan.scope, genesisSha256: 'c'.repeat(64)})},
  ]) {
    const {deps, calls} = fixture(plan, override);
    await assert.rejects(runProjectAdmission(plan, deps), /changed/);
    assert.equal(calls.length, 0);
  }
});
test('source drift between finalized project and task stops second write', async () => {
  const plan = freezeProjectAdmission(input()); let reads = 0;
  const {deps, calls} = fixture(plan, {sourceDigest: async () => ++reads === 1 ? plan.source.digest : 'c'.repeat(64)});
  await assert.rejects(runProjectAdmission(plan, deps), /source changed/);
  assert.equal(calls.length, 1);
});
test('mutated or forged frozen steps are rejected before invoking bridge', async () => {
  const original = freezeProjectAdmission(input());
  for (const change of [
    p => p.steps[0].operation = 'roles', p => p.steps[0].payload.title = 'substitution',
    p => p.digest = 'd'.repeat(64), p => p.version = 2, p => p.task.criteria = 'Different criteria with otherwise plausible complete sentence.',
  ]) {
    const plan = structuredClone(original); change(plan); const {deps, calls} = fixture(plan);
    await assert.rejects(runProjectAdmission(plan, deps), /intent changed/); assert.equal(calls.length, 0);
  }
});
test('do not accept arbitrary finalized acknowledgements or wrong operation/actor/chain', async () => {
  const plan = freezeProjectAdmission(input());
  for (const change of [
    r => delete r.event, r => r.request_id = 'wrong', r => r.authority = 'metadata',
    r => r.event.operation = 'coin_reserve', r => r.event.subject = 'other-project',
    r => r.event.member = 'uain1' + '2'.repeat(40), r => r.event.instance = 'other-instance',
    r => r.chain_id = 'other-chain', r => r.genesis_sha256 = 'c'.repeat(64),
    r => r.proof = {chain_id: 'other-chain'}, r => r.event.command_digest = 'not-a-digest',
  ]) {
    const {deps, calls} = fixture(plan); const invoke = deps.invoke;
    deps.invoke = async (...args) => {const r = await invoke(...args); change(r); return r;};
    await assert.rejects(runProjectAdmission(plan, deps), /receipt/); assert.equal(calls.length, 1);
  }
});
test('authorization and ambiguous transport errors propagate once; no retry or next task', async () => {
  const plan = freezeProjectAdmission(input());
  for (const message of ['project Karma gate or allowance', 'ambiguous transport timeout']) {
    let calls = 0; const {deps} = fixture(plan, {invoke: async () => {calls++; throw Error(message);}});
    await assert.rejects(runProjectAdmission(plan, deps), new RegExp(message)); assert.equal(calls, 1);
  }
});
test('exact fields and constraints exclude key paths, financial tasks and injected state', () => {
  const changes = [
    p => p.scope.signingKeyFile = '/private', p => p.task.credit_reward = '1', p => p.task.karma_reward = 1,
    p => p.task.kind = 'future', p => p.task.state = 'settled', p => p.task.project = 'another',
    p => p.project.prior_art.searches = ['one'], p => p.decision.status = 'automatic',
    p => p.source.digest = 'not-a-hash', p => p.project.id = 'UPPERCASE', p => p.task.criteria = 'too short',
  ];
  for (const change of changes) {const value = input(); change(value); assert.throws(() => freezeProjectAdmission(value));}
});
