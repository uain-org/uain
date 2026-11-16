// The contribution view (P0-3, 12 November 2026): contribution points are Karma; accepted answers,
// checks and work not counted are listed apart; AI$ earned and the balance are ledger facts.
// One derivation (shared/contribution-view.mjs) behind every surface. FIXTURE: the native reader is
// a stand-in with the real proof shape, and the full-server test runs BAINK's real HTTP and MCP code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiDollars, awardPoints, contributionLines, contributionTotals, deriveContribution } from '../shared/contribution-view.mjs';
import { contributionDisplay } from '../web/contribution-display.js';
import { contributionSummary } from '../agent-kit/uain-agent.mjs';
import { createCentralEarningService } from '../server/central-earning.mjs';
import { createBainkServer } from '../server/app.mjs';
import { CENTRAL_POLICY } from '../server/central-earning-command.mjs';
import { memberPathAllowed } from '../server/mcp-member.mjs';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const M = 'uain1' + 'a'.repeat(40), OTHER = 'uain1' + 'b'.repeat(40);
const AI = (n) => String(BigInt(Math.round(n * 1e6)));
const award = (role, submission, ai, height, task = 'T-' + submission, project = 'P-one', member = M) => ({ submission, task, project, member, role, amount: AI(ai), height: String(height) });
const view = (input) => deriveContribution({ member: M, enrolled: true, karma: 0, strikes: 0, licence: 'active', earnings: { solver: '0', reviewer: '0', total: '0', awards: '0' }, awards: [], awardsComplete: true, submissions: [], submissionsComplete: true, balanceUnits: null, proofHeight: '50', ...input });

test('amounts read as people expect: 1.1 AI$, never 1.100000; points are whole AI$', () => {
  assert.equal(aiDollars('1100000'), '1.1');
  assert.equal(aiDollars('20000000'), '20');
  assert.equal(aiDollars('1'), '0.000001');
  assert.equal(awardPoints('1999999'), 1);
  assert.equal(awardPoints('20000000'), 20);
  assert.equal(awardPoints('999999'), 0);
});

test('no accepted work: zero points, nothing listed, the attribution still adds up', () => {
  const v = view({});
  assert.equal(v.points.total, 0);
  assert.equal(v.points.attribution, 'complete');
  assert.equal(v.points.fromEarlierOrKarmaOnly, 0);
  assert.equal(v.accepted.count, 0);
  assert.deepEqual(v.accepted.items, []);
  assert.match(contributionLines(v)[1], /No accepted answer yet/);
});

test('listed points plus the remainder equal the chain Karma', () => {
  const v = view({ karma: 50, earnings: { solver: AI(20), reviewer: AI(2), total: AI(22), awards: '2' }, awards: [award('solver', 'CS-1', 20, 10), award('reviewer', 'CS-9', 2, 11, 'T-9')] });
  assert.equal(v.points.total, 50);
  assert.equal(v.points.fromAccepted, 20);
  assert.equal(v.points.fromChecks, 2);
  assert.equal(v.points.fromEarlierOrKarmaOnly, 28);
  assert.equal(v.points.fromAccepted + v.points.fromChecks + v.points.fromEarlierOrKarmaOnly, v.points.total);
  assert.deepEqual(v.accepted.items[0], { task: 'T-CS-1', project: 'P-one', submission: 'CS-1', points: 20, 'amountAI$': '20', amountUnits: AI(20), height: '10' });
  assert.equal(v.ledger['earnedAI$'], '22');
  assert.equal(v.ledger['forAnswersAI$'], '20');
  assert.match(v.points.note, /28 from earlier or Karma-only work/);
});

test('the same award seen twice (across pages or reads) counts once', () => {
  const a = award('solver', 'CS-1', 20, 10);
  const v = view({ karma: 20, awards: [a, structuredClone(a), award('solver', 'CS-2', 0.5, 12), structuredClone(a)] });
  assert.equal(v.accepted.count, 2);
  assert.equal(v.accepted.points, 20);
  assert.equal(v.source.awardsRead, 2);
});

test('a check on a rejected submission is a check for others, never an accepted contribution', () => {
  // The reviewer is awarded on every verdict, a rejection too (central_earning.go).
  const v = view({ karma: 2, awards: [award('reviewer', 'CS-rejected', 2, 10)], submissions: [{ id: 'CS-mine', task: 'T-mine', state: 'rejected' }] });
  assert.equal(v.accepted.count, 0);
  assert.equal(v.checks.count, 1);
  assert.equal(v.checks.points, 2);
  assert.deepEqual(v.notCounted.rejected, [{ submission: 'CS-mine', task: 'T-mine' }]);
});

test('work waiting for review or for more evidence stays apart and is never counted', () => {
  const v = view({
    karma: 20,
    awards: [award('solver', 'CS-ok', 20, 10)],
    submissions: [
      { id: 'CS-wait', task: 'T-a', state: 'under_review' },
      { id: 'CS-ev', task: 'T-b', state: 'under_review', evidence_deadline: '9000' },
      { id: 'CS-back', task: 'T-c', state: 'under_review', evidence_deadline: '9000', reassess: true },
      { id: 'CS-no', task: 'T-d', state: 'rejected' },
      { id: 'CS-ok', task: 'T-CS-ok', state: 'accepted' },
      { id: 'CS-old', task: 'T-e', state: 'superseded' },
      { id: 'CS-wait', task: 'T-a', state: 'under_review' },
    ],
  });
  assert.deepEqual(v.notCounted.awaitingReview.map((s) => s.submission), ['CS-wait', 'CS-back']);
  assert.deepEqual(v.notCounted.needsEvidence.map((s) => s.submission), ['CS-ev']);
  assert.deepEqual(v.notCounted.rejected.map((s) => s.submission), ['CS-no']);
  assert.equal(v.accepted.count, 1);
  assert.equal(v.points.total, 20);
  assert.match(contributionLines(v).join(' '), /Not counted: 2 waiting for review, 1 needing more evidence, 1 rejected/);
});

test('listed points above the chain Karma are shown as read and marked incomplete, never clamped', () => {
  // An award paid before the Karma policy and never backfilled gave no Karma.
  const v = view({ karma: 10, awards: [award('solver', 'CS-1', 20, 3), award('solver', 'CS-2', 10, 30)] });
  assert.equal(v.points.total, 10, 'the total is always the chain Karma');
  assert.equal(v.points.attribution, 'incomplete');
  assert.equal(v.points.incompleteBecause, 'listed_exceeds_karma');
  assert.equal(v.points.fromEarlierOrKarmaOnly, null);
  assert.equal(v.accepted.points, 30, 'the list is not adjusted');
  assert.equal(v.accepted.count, 2);
  assert.match(v.points.note, /more than the 10 Karma on the chain/);
});

test('an unfinished walk or unreadable Karma is said, not guessed', () => {
  const partial = view({ karma: 40, awards: [award('solver', 'CS-1', 20, 3)], awardsComplete: false });
  assert.equal(partial.points.attribution, 'incomplete');
  assert.equal(partial.points.incompleteBecause, 'not_all_awards_read');
  assert.equal(partial.points.fromEarlierOrKarmaOnly, null);
  const unknown = view({ karma: undefined });
  assert.equal(unknown.points.incompleteBecause, 'karma_unreadable');
});

test('a list holds at most 50 rows; counts and points cover every award', () => {
  const awards = Array.from({ length: 60 }, (_, n) => award('solver', 'CS-' + n, 1, n + 1));
  const v = view({ karma: 60, awards });
  assert.equal(v.accepted.items.length, 50);
  assert.equal(v.accepted.more, true);
  assert.equal(v.accepted.count, 60);
  assert.equal(v.accepted.points, 60);
  assert.equal(v.accepted.items[0].submission, 'CS-59', 'newest first');
});

// ---------------------------------------------------------------- the service over proved reads

const pins = { chainId: 'fictional-contribution', epoch: 'a'.repeat(64), verifierSha256: 'b'.repeat(64) };
function chainFixture(records, { batched = true } = {}) {
  const reads = [];
  const answer = (selection) => {
    reads.push([...(selection.keys ?? [])]);
    const proof = { authority: 'native', chainId: pins.chainId, epoch: pins.epoch, genesisSha256: pins.epoch, verifierSha256: pins.verifierSha256, height: '50', appHash: 'c'.repeat(64), headerTime: new Date().toISOString(), maxAgeSeconds: 120 };
    const member = selection.member ? structuredClone(records['member/' + selection.member] ?? null) : undefined;
    return { proof, state: { chain_id: pins.chainId, height: '50', app_hash: 'c'.repeat(64), event_count: '9', ...(member !== undefined ? { member } : {}), records: Object.fromEntries((selection.keys ?? []).map((k) => [k, structuredClone(records[k] ?? null)])) } };
  };
  const native = { configured: true, pins, timeoutMs: 8000, async publicState(selection) { return answer(selection); }, ...(batched ? { async centralPublicState(selection) { return answer(selection); } } : {}) };
  return { native, reads };
}
function withAwards(records, member, list) {
  const sum = (role) => String(list.filter((a) => a.role === role).reduce((n, a) => n + BigInt(a.amount), 0n));
  records['central_earnings/' + member] = { member, solver: sum('solver'), reviewer: sum('reviewer'), total: String(BigInt(sum('solver')) + BigInt(sum('reviewer'))), awards: String(list.length) };
  list.forEach((a, n) => {
    records[`central_award_index/${member}/${String(n + 1).padStart(20, '0')}`] = { role: a.role, submission: a.submission };
    records[`central_award/${a.role}/${a.submission}`] = a;
  });
}
function baseRecords(karma) {
  return {
    ['member/' + M]: { id: M, public_key: 'x', sequence: '3', licence: 'active', karma },
    coin_activation: { policy: 'verified-bounties-108t-micro-v1', height: '5', evidence_digest: 'e'.repeat(64) },
    coin_supply: { minted: AI(100), reserved: '0', transparent: AI(100), shielded: '0' },
    ['coin_balance/' + M]: AI(22),
  };
}
const intent = (id, task, at, status = 'finalized') => ({ member: M, status, sendAttemptedAt: at, command: { operation: 'central_submit', payload: { id, task } } });

test('a cold cache and a warm cache give the same view, and the warm read fetches only new awards', async () => {
  const records = baseRecords(300), list = Array.from({ length: 40 }, (_, n) => award(n % 4 === 0 ? 'reviewer' : 'solver', 'CS-' + n, 2 + (n % 3), n + 1, 'T-' + n));
  withAwards(records, M, list);
  let now = 0;
  const { native, reads } = chainFixture(records), store = { read: () => ({ centralEarningIntents: { a: intent('CS-w', 'T-w', '2026-11-12T10:00:00.000Z') } }) };
  records['central_submission/CS-w'] = { id: 'CS-w', task: 'T-w', author: M, state: 'under_review' };
  const service = createCentralEarningService({ store, native, monotonicNow: () => now });
  const cold = await service.contribution(M);
  assert.equal(cold.accepted.count, 30);
  assert.equal(cold.checks.count, 10);
  assert.equal(cold.points.total, 300);
  assert.equal(cold.points.attribution, 'complete');
  assert.equal(cold.points.fromAccepted + cold.points.fromChecks + cold.points.fromEarlierOrKarmaOnly, 300);
  assert.deepEqual(cold.notCounted.awaitingReview, [{ submission: 'CS-w', task: 'T-w' }]);
  assert.equal(cold.ledger['balanceAI$'], '22');
  // Within ten seconds the same answer is served without a read.
  const before = reads.length;
  assert.deepEqual(await service.contribution(M), cold);
  assert.equal(reads.length, before);
  // Later: the award walk is remembered, so only the member snapshot and submissions are read again.
  now += 11000;
  const warm = await service.contribution(M);
  assert.deepEqual(warm, cold, 'a warm cache gives the same view');
  assert.ok(reads.slice(before).flat().every((k) => !k.startsWith('central_award')), 'no award was read twice');
  // A new award appends: only its position is read.
  list.push(award('solver', 'CS-new', 5, 60, 'T-new'));
  withAwards(records, M, list);
  records['member/' + M].karma = 305;
  now += 11000;
  const after = reads.length, grown = await service.contribution(M);
  assert.equal(grown.accepted.count, 31);
  assert.equal(grown.accepted.items[0].submission, 'CS-new');
  assert.deepEqual(reads.slice(after).flat().filter((k) => k.startsWith('central_award')), [`central_award_index/${M}/${'41'.padStart(20, '0')}`, 'central_award/solver/CS-new']);
  // A fresh service (cold cache) agrees with the warm one.
  const fresh = await createCentralEarningService({ store, native: chainFixture(records).native }).contribution(M);
  assert.deepEqual(contributionTotals(fresh), contributionTotals(grown));
});

test('transfers in and out, refunds, payment requests and a legacy pilot-credits-v1 claim change neither points nor accepted work', async () => {
  const records = baseRecords(42);
  withAwards(records, M, [award('solver', 'CS-1', 20, 10), award('reviewer', 'CS-2', 2, 11)]);
  let data = { centralEarningIntents: {} };
  const { native } = chainFixture(records), store = { read: () => structuredClone(data) };
  let now = 0;
  const service = createCentralEarningService({ store, native, monotonicNow: () => now });
  const first = await service.contribution(M);
  // Money moves: AI$ received and sent, a refund, a payment request, an older v1 claim in BAINK's store.
  records['coin_balance/' + M] = AI(80);
  records['coin_balance/' + OTHER] = AI(5);
  data = {
    centralEarningIntents: {},
    serverSends: { s1: { from: M, to: OTHER, amountUnits: AI(5), status: 'finalized' }, s2: { from: OTHER, to: M, amountUnits: AI(63), status: 'finalized' } },
    paymentRequests: { r1: { payer: OTHER, payee: M, amountUnits: AI(7), status: 'open' } },
    tradeRefunds: { f1: { to: M, amountUnits: AI(3) } },
    nativeEarningClaims: { c1: { member: M, policy: 'pilot-credits-v1', amountUnits: AI(1000), status: 'claimed' } },
  };
  now += 11000;
  const second = await service.contribution(M);
  for (const key of ['points', 'accepted', 'checks', 'notCounted']) assert.deepEqual(second[key], first[key], key);
  assert.equal(second.ledger['earnedAI$'], first.ledger['earnedAI$'], 'AI$ earned counts awards only');
  assert.equal(second.ledger['balanceAI$'], '80', 'the balance is the ledger fact that moved');
});

test('the signed status carries the same view, and status still answers when the view cannot be read', async () => {
  const pair = generateKeyPairSync('ed25519'), raw = pair.publicKey.export({ format: 'jwk' }).x, key = Buffer.from(raw, 'base64url');
  const user = { publicKey: key.toString('base64'), address: 'uain1' + sha(key).slice(0, 40) };
  const records = {
    ['member/' + user.address]: { id: user.address, public_key: raw, sequence: '3', licence: 'active', karma: 25 },
    central_earning_activation: null,
    coin_activation: { policy: 'verified-bounties-108t-micro-v1', height: '5', evidence_digest: 'e'.repeat(64) },
    coin_supply: { minted: AI(22), reserved: '0', transparent: AI(22), shielded: '0' },
    ['coin_balance/' + user.address]: AI(22),
  };
  withAwards(records, user.address, [award('solver', 'CS-s', 20, 10, 'T-s', 'P-one', user.address), award('reviewer', 'CS-r', 2, 11, 'T-r', 'P-one', user.address)]);
  const { native } = chainFixture(records), store = { read: () => ({}) };
  const service = createCentralEarningService({ store, native });
  const status = await service.status(user), pub = await service.contribution(user.address);
  assert.deepEqual(contributionTotals(status.contribution), contributionTotals(pub));
  assert.equal(status.contribution.accepted.count, 1, 'the reviewer award is not an accepted answer');
  assert.equal(status.earnings.awards, '2', 'earnings.awards counts both roles; the view separates them');
  // A reader failure in the view leaves status answering: status's own three reads pass, the walk's fail.
  let calls = 0;
  const broken = createCentralEarningService({ store, native: { ...native, async centralPublicState(selection) { if (++calls > 3) throw Error('reader down'); return native.centralPublicState(selection); } } });
  const degraded = await broken.status(user);
  assert.equal(degraded.contribution.available, false);
  assert.equal(degraded.earnings.total, AI(22));
});

// ---------------------------------------------------------------- every surface, one fixture

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
test('one fixture through the public API, the MCP tool, the kit formatter and the browser formatter gives the same totals', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'baink-contribution-'));
  const genesis = JSON.stringify({ chain_id: 'fictional-contribution' }), genesisFile = join(dir, 'genesis.json'), binary = join(dir, 'reader');
  await writeFile(binary, 'synthetic contribution reader', { mode: 0o700 });
  await writeFile(genesisFile, genesis, { mode: 0o600 });
  const memberKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x, member = 'uain1' + sha(Buffer.from(memberKey, 'base64url')).slice(0, 40);
  const records = {
    ['member/' + member]: { id: member, public_key: memberKey, sequence: '3', licence: 'active', karma: 47, strikes: 2 },
    coin_activation: { policy: 'verified-bounties-108t-micro-v1', height: '5', evidence_digest: 'e'.repeat(64) },
    central_earning_activation: { policy: CENTRAL_POLICY, reviewer: member, height: '5', evidence_digest: 'e'.repeat(64) },
    coin_supply: { minted: AI(100), reserved: '0', transparent: AI(100), shielded: '0' },
    ['coin_balance/' + member]: AI(31.5),
    guardians: null, legacy_import: null, event_count: '9',
  };
  withAwards(records, member, [award('solver', 'CS-1', 20, 10, 'T-OPP-00001-1-prior-art-survey', 'P-OPP-00001', member), award('solver', 'CS-2', 1.5, 12, 'T-2', 'P-two', member), award('reviewer', 'CS-3', 2, 14, 'T-3', 'P-two', member)]);
  const transport = {
    profile: null, prepare: async () => {}, close: async () => {}, readBatch: async () => { throw Error('unused'); },
    async read(selection) {
      const out = { chain_id: 'fictional-contribution', height: '50', header_time: new Date().toISOString(), app_hash: 'c'.repeat(64), event_count: '9', records: {} };
      for (const k of [...(selection.keys ?? []), ...(selection.member ? ['member/' + selection.member] : []), 'guardians', 'legacy_import', 'event_count']) out.records[k] = structuredClone(records[k] ?? null);
      if (selection.member) out.member = structuredClone(records['member/' + selection.member] ?? null);
      out.queries = Object.keys(out.records).map((k) => ({ key: Buffer.from(k).toString('base64') }));
      return Buffer.from(JSON.stringify(out));
    },
  };
  const nativeConfig = { binary, binaryHash: sha('synthetic contribution reader'), genesis: genesisFile, genesisHash: sha(genesis), chainId: 'fictional-contribution', rpc: 'http://127.0.0.1:9', timeoutMs: 3000, maxAgeSeconds: 120 };
  transport.profile = { chainId: nativeConfig.chainId, genesisSha256: nativeConfig.genesisHash, verifierSha256: nativeConfig.binaryHash, maxAgeSeconds: 120 };
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const app = await createBainkServer({ dataDir: join(dir, 'data'), publicOrigin: url, projectsSource: null, catalogueDir: null, nativeConfig, nativeStateTransport: transport });
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
  t.after(async () => { app.server.closeAllConnections?.(); await app.close(); await rm(dir, { recursive: true, force: true }); });

  const api = await fetch(`${url}/api/public/contribution/${member}`);
  assert.equal(api.status, 200);
  const fromApi = await api.json();
  const mcp = await fetch(url + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'baink_contribution', arguments: { address: member } } }) });
  const fromMcp = (await mcp.json()).result.structuredContent;
  const kit = contributionSummary(fromApi), browser = contributionDisplay(fromApi);

  const expected = { points: 47, accepted: 2, acceptedPoints: 21, checks: 1, checksPoints: 2, remainder: 24, attribution: 'complete', 'earnedAI$': '23.5' };
  assert.deepEqual(contributionTotals(fromApi), expected);
  assert.deepEqual(contributionTotals(fromMcp), expected);
  assert.deepEqual(browser.totals, expected);
  assert.deepEqual({ points: kit['contributionPoints (Karma)'], accepted: kit.acceptedContributions, acceptedPoints: kit.pointsFromAccepted, checks: kit.checksForOthers, checksPoints: kit.pointsFromChecks, remainder: kit.pointsFromEarlierOrKarmaOnly, attribution: kit.attribution, 'earnedAI$': kit.ledger['earnedAI$'] }, expected);
  assert.deepEqual(fromMcp.summary, contributionLines(fromApi));
  assert.equal(fromMcp.nextStep.tool, 'baink_tasks', 'the reply leads to the next useful action');
  assert.equal(fromApi.ledger['balanceAI$'], '31.5');
  assert.equal(fromApi.strikes, 2);
  assert.match(kit.accepted[0], /^T-2 \(project P-two, submission CS-2\): 1 points; ledger 1\.5 AI\$$/);
  // Points lead; AI$ is never shown with six zeros.
  assert.ok(!/\.\d*0 AI\$/.test(JSON.stringify(fromMcp.summary)));
  assert.match(fromMcp.summary[0], /^47 contribution points \(Karma\)/);
  // A malformed address is refused; the no-install relay allows this read.
  assert.equal((await fetch(`${url}/api/public/contribution/uain1xyz`)).status, 404);
  assert.equal(memberPathAllowed('GET', `/api/public/contribution/${member}`), true);
  assert.equal(memberPathAllowed('GET', '/api/public/contribution/uain1xyz'), false);
});
