import test from 'node:test';
import { readPersistedState } from '../server/store-sqlite.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, member } from './http-fixture.mjs';
import { nativeWorkCurrentFixture } from './fixtures/native-work-current-fixture.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const CLAIM = 'CL-native-00000000000000000042';
const ASSOCIATED = 'native:00000000000000000042';
const CURRENT = 'native:00000000000000000043';
const disk = async (http) => readPersistedState(http.dataDir);
const localState = (who) => ({
  version: 1,
  accounts: {
    [who.address]: {
      address: who.address,
      publicKey: who.publicKey,
      displayName: 'Synthetic HTTP holder, never native claim content',
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
    },
  },
  requests: {},
  nonces: {},
  history: [],
  nativeIntents: {},
});

/** Synthetic executable qualifies actual process/pins/selection/HTTP plumbing.
 * It does not verify consensus signatures or IAVL proofs, contact the RPC, or
 * write native state. Its only writes are temporary output and fixture traces.
 * Holder signing keys are generated ephemerally by the existing HTTP fixture.
 */
async function configuredFixture(t, { change, finalChange, omitKeys = [] } = {}) {
  const who = member();
  const graph = nativeWorkCurrentFixture({ publicKey: who.publicKey, headerTime: new Date().toISOString() });
  const markerKey = `legacy_answer_claim/${graph.query.workId}`;
  graph.state.records[markerKey] = {
    contribution: graph.query.workId,
    claim: CLAIM,
    revision: ASSOCIATED,
    check_refs: ['private-check-reference-not-projected'],
  };
  graph.state.records[`legacy_claim/${CLAIM}`] = {
    id: CLAIM,
    project: graph.query.projectId,
    balance: 'private-financial-canary-not-projected',
    revisions: [{
      id: ASSOCIATED,
      base: '',
      state: 'believed',
      action: 'create',
      statement: 'Synthetic source claim; this fixture does not establish scientific truth.',
      sources: [graph.query.workId],
      author: graph.query.authorInstanceId,
      member: who.address,
      reviews: [{ private: 'private-review-canary-not-projected' }],
    }],
  };
  graph.state.records[`legacy/claim/${CLAIM}`] = null;
  change?.(graph, markerKey);
  const snapshots = [structuredClone(graph.state)];
  if (finalChange) {
    const final = structuredClone(graph.state);
    finalChange(final, graph, markerKey);
    snapshots.push(final);
  }
  const directory = await mkdtemp(join(tmpdir(), 'baink-claim-http-native-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const genesisPath = join(directory, 'genesis.json');
  const binary = join(directory, 'reader');
  const inputPath = join(directory, 'synthetic-states.json');
  const trace = join(directory, 'selections.jsonl');
  const genesis = JSON.stringify({ chain_id: graph.pins.chainId });
  const input = JSON.stringify({ snapshots, omitKeys });
  const script = `#!${process.execPath}
const fs = require('fs');
let raw = '';
process.stdin.on('data', bytes => raw += bytes);
process.stdin.on('end', () => {
  const request = JSON.parse(raw);
  const fixture = JSON.parse(fs.readFileSync(${JSON.stringify(inputPath)}, 'utf8'));
  const previous = fs.readFileSync(${JSON.stringify(trace)}, 'utf8').trim();
  const index = previous ? previous.split('\\n').length : 0;
  fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(request) + '\\n');
  const state = fixture.snapshots[Math.min(index, fixture.snapshots.length - 1)];
  const records = state.records;
  state.records = Object.fromEntries(['legacy_import', ...(request.keys || [])]
    .filter(key => !fixture.omitKeys.includes(key))
    .map(key => [key, Object.hasOwn(records, key) ? records[key] : null]));
  const output = process.argv[process.argv.indexOf('--out') + 1];
  fs.writeFileSync(output, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
});
`;
  await writeFile(binary, script, { mode: 0o700 });
  await writeFile(genesisPath, genesis, { mode: 0o600 });
  await writeFile(inputPath, input, { mode: 0o600 });
  await writeFile(trace, '', { mode: 0o600 });
  const nativeConfig = {
    binary,
    binaryHash: sha(script),
    genesis: genesisPath,
    genesisHash: sha(genesis),
    rpc: 'http://127.0.0.1:1',
    chainId: graph.pins.chainId,
    timeoutMs: 2000,
    maxAgeSeconds: 120,
  };
  const http = await fixture(t, { initialState: localState(who), nativeConfig });
  return {
    who, graph, markerKey, http, nativeConfig,
    path: '/api/work/claim?' + new URLSearchParams(graph.query),
    calls: async () => (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse),
    async assertSourcesUnchanged() {
      assert.equal(await readFile(inputPath, 'utf8'), input);
      assert.equal(await readFile(binary, 'utf8'), script);
      assert.equal(await readFile(genesisPath, 'utf8'), genesis);
    },
  };
}

async function selectedRead(f) {
  const before = await disk(f.http);
  const result = await f.http.request(f.who, 'GET', f.path);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const after = await disk(f.http);
  assert.equal(Object.keys(after.nonces).length, Object.keys(before.nonces).length + 1);
  after.nonces = before.nonces;
  assert.deepEqual(after, before, 'A signed claim read may consume its nonce but never change business state');
  await f.assertSourcesUnchanged();
  return result.body;
}

function noFinancialOrPrivateProjection(body) {
  assert.equal(body.complete, false);
  assert.equal(body.aiDollarPayment, 'not-established-by-this-record');
  assert.equal(body.trust, 'not-evaluated');
  const forbidden = new Set(['balance', 'balanceUnits', 'paid', 'amount', 'reward', 'prize_due', 'claimed', 'credits', 'settlementAvailable']);
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbidden.has(key), false, `Unexpected monetary field ${key}`);
      walk(child);
    }
  };
  walk(body);
  for (const canary of ['private-financial-canary', 'private-review-canary', 'private-check-reference', 'never-return', 'Never project this claim', 'Synthetic HTTP holder'])
    assert.equal(JSON.stringify(body).includes(canary), false, canary);
}

function unavailable(body) {
  assert.equal(body.status, 'unavailable');
  assert.equal(body.scope, 'native-selected-work-claim');
  for (const key of ['association', 'claim', 'proof']) assert.equal(body[key], null);
  noFinancialOrPrivateProjection(body);
}

test('registered signed HTTP holder gets only the selected associated claim through the pinned executable', async (t) => {
  const f = await configuredFixture(t);
  const body = await selectedRead(f);
  assert.equal(body.status, 'available');
  assert.equal(body.scope, 'native-selected-work-claim');
  assert.equal(body.actorAddress, f.who.address);
  assert.deepEqual(body.binding, f.graph.query);
  assert.equal(body.association, 'present');
  assert.equal(body.claim.id, CLAIM);
  assert.equal(body.claim.projectId, f.graph.query.projectId);
  assert.equal(body.claim.sourceKey, `legacy_claim/${CLAIM}`);
  assert.equal(body.claim.associationSourceKey, f.markerKey);
  assert.equal(body.claim.associatedRevisionId, ASSOCIATED);
  assert.deepEqual(body.claim.associatedRevision, {
    id: ASSOCIATED, base: '', state: 'believed', action: 'create',
    statement: 'Synthetic source claim; this fixture does not establish scientific truth.',
    sources: [f.graph.query.workId],
  });
  assert.deepEqual(body.claim.believedRevision, body.claim.associatedRevision);
  assert.equal(body.proof.authority, 'native');
  assert.equal(body.proof.chainId, 'isolated-current-work-fixture');
  assert.equal(body.proof.epoch, f.nativeConfig.genesisHash);
  assert.equal(body.proof.verifierSha256, f.nativeConfig.binaryHash);
  noFinancialOrPrivateProjection(body);
  const calls = await f.calls();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].member, f.who.address);
  assert.equal(calls[0].keys.length, 15);
  assert.equal(calls[0].keys.includes(`legacy_claim/${CLAIM}`), false);
  assert.equal(calls[1].keys.length, 17);
  assert.ok(calls[1].keys.includes(`legacy_claim/${CLAIM}`));
  assert.ok(calls[1].keys.includes(`legacy/claim/${CLAIM}`));
});

test('HTTP distinguishes the work-associated superseded revision from a current believed retraction', async (t) => {
  const f = await configuredFixture(t, { change(graph) {
    const revisions = graph.state.records[`legacy_claim/${CLAIM}`].revisions;
    revisions[0].state = 'superseded';
    revisions.push({
      id: CURRENT, base: ASSOCIATED, state: 'believed', action: 'retract',
      statement: 'Synthetic current retraction; this is not positive confirmation.',
      sources: ['RC-9999'],
    });
  } });
  const body = await selectedRead(f);
  assert.equal(body.status, 'available');
  assert.equal(body.association, 'present');
  assert.equal(body.claim.associatedRevision.id, ASSOCIATED);
  assert.equal(body.claim.associatedRevision.state, 'superseded');
  assert.equal(body.claim.associatedRevision.action, 'create');
  assert.equal(body.claim.believedRevision.id, CURRENT);
  assert.equal(body.claim.believedRevision.action, 'retract');
  assert.deepEqual(body.claim.believedRevision.sources, ['RC-9999']);
  noFinancialOrPrivateProjection(body);
});

test('an associated draft without a believed revision remains present rather than absent', async (t) => {
  const f = await configuredFixture(t, { change(graph) {
    graph.state.records[`legacy_claim/${CLAIM}`].revisions[0].state = 'draft';
  } });
  const body = await selectedRead(f);
  assert.equal(body.status, 'available');
  assert.equal(body.association, 'present');
  assert.equal(body.claim.associatedRevision.state, 'draft');
  assert.equal(body.claim.believedRevision, null);
  noFinancialOrPrivateProjection(body);
});

test('proven association absence is available only with the complete selected ownership proof', async (t) => {
  const absent = await configuredFixture(t, { change(graph, markerKey) {
    graph.state.records[markerKey] = null;
  } });
  const body = await selectedRead(absent);
  assert.equal(body.status, 'available');
  assert.equal(body.association, 'absent');
  assert.equal(body.claim, null);
  assert.ok(body.proof);
  assert.equal((await absent.calls()).length, 1);
  noFinancialOrPrivateProjection(body);

  const missingOwnership = await configuredFixture(t, { change(graph, markerKey) {
    graph.state.records[markerKey] = null;
    graph.state.records[`legacy/task/${graph.query.taskId}`].contributions = [];
  } });
  unavailable(await selectedRead(missingOwnership));
});

test('omitted semantic proof records and foreign author ownership never disclose an empty or positive claim', async (t) => {
  const missing = await configuredFixture(t, { omitKeys: ['instance/claude-lead'] });
  unavailable(await selectedRead(missing));
  const other = member();
  const foreign = await configuredFixture(t, { change(graph) {
    graph.state.records[`instance/${graph.query.authorInstanceId}`].member = other.address;
    graph.state.records[`legacy/actor/${graph.query.authorInstanceId}`].member = other.address;
    graph.state.records[`legacy/work/${graph.query.workId}`].member = other.address;
  } });
  unavailable(await selectedRead(foreign));
});

test('malformed mutable claim is unavailable even when a valid frozen claim is selected alongside it', async (t) => {
  const f = await configuredFixture(t, { change(graph) {
    const records = graph.state.records;
    records[`legacy/claim/${CLAIM}`] = structuredClone(records[`legacy_claim/${CLAIM}`]);
    records[`legacy_claim/${CLAIM}`] = {};
  } });
  unavailable(await selectedRead(f));
  assert.equal((await f.calls()).length, 2);
});

test('proved mutable absence permits a valid frozen assert revision without changing its provenance', async (t) => {
  const f = await configuredFixture(t, { change(graph) {
    const records = graph.state.records;
    records[`legacy/claim/${CLAIM}`] = structuredClone(records[`legacy_claim/${CLAIM}`]);
    records[`legacy/claim/${CLAIM}`].revisions[0].action = 'assert';
    records[`legacy_claim/${CLAIM}`] = null;
  } });
  const body = await selectedRead(f);
  assert.equal(body.status, 'available');
  assert.equal(body.claim.sourceKey, `legacy/claim/${CLAIM}`);
  assert.equal(body.claim.associatedRevision.action, 'assert');
  assert.equal(body.claim.associatedRevision.id, ASSOCIATED);
  noFinancialOrPrivateProjection(body);
});

test('signed HTTP preserves a valid selected claim beside unprojected historical Go zero-value bodies', async (t) => {
  for (const [name, historical] of [
    ['original omitted statement and empty sources', { sources: [] }],
    ['round-tripped empty statement and nil sources', { statement: '', sources: null }],
    ['null statement and omitted sources', { statement: null }],
  ]) await t.test(name, async (subtest) => {
    const f = await configuredFixture(subtest, { change(graph) {
      const claim = graph.state.records[`legacy_claim/${CLAIM}`];
      claim.revisions[0].base = '73';
      claim.revisions[0].action = 'edit';
      // Pinned cb0402fe legacy_research_test.go:79 supplies the old assert stub;
      // later Go edits retain earlier revisions while validating the new body.
      claim.revisions.unshift({ id: '73', base: '', state: 'superseded', action: 'assert', reviews: [], ...historical });
    } });
    const body = await selectedRead(f);
    assert.equal(body.status, 'available');
    assert.equal(body.association, 'present');
    assert.equal(body.claim.associatedRevision.id, ASSOCIATED);
    assert.equal(body.claim.associatedRevision.base, '73');
    assert.equal(body.claim.associatedRevision.statement, 'Synthetic source claim; this fixture does not establish scientific truth.');
    assert.deepEqual(body.claim.associatedRevision.sources, [f.graph.query.workId]);
    assert.deepEqual(body.claim.believedRevision, body.claim.associatedRevision);
    assert.equal(Object.hasOwn(body.claim, 'revisions'), false);
    noFinancialOrPrivateProjection(body);
    assert.equal((await f.calls()).length, 2);
  });
});

test('only the final selected proof supplies claim content and header after the discovery hint', async (t) => {
  const f = await configuredFixture(t, { finalChange(final) {
    final.height = '1025788';
    final.app_hash = 'd'.repeat(64);
    final.records[`legacy_claim/${CLAIM}`].revisions[0].statement = 'Only final selected proof content';
  } });
  const body = await selectedRead(f);
  assert.equal(body.status, 'available');
  assert.equal(body.claim.associatedRevision.statement, 'Only final selected proof content');
  assert.equal(body.proof.height, '1025788');
  assert.equal(body.proof.appHash, 'd'.repeat(64));
  noFinancialOrPrivateProjection(body);
});

test('association or ownership drift between the hint and final HTTP proof fails closed', async (t) => {
  for (const [name, finalChange] of [
    ['association revision changed', (final, graph, markerKey) => { final.records[markerKey].revision = CURRENT; }],
    ['association disappeared', (final, graph, markerKey) => { final.records[markerKey] = null; }],
    ['ownership relation disappeared', (final, graph) => { final.records[`legacy/task/${graph.query.taskId}`].contributions = []; }],
  ]) await t.test(name, async (subtest) => {
    const f = await configuredFixture(subtest, { finalChange });
    unavailable(await selectedRead(f));
    assert.equal((await f.calls()).length, 2);
  });
});
