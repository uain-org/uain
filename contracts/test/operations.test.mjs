import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../scripts/compile.mjs';
import { account, newChain } from './evm.mjs';

const pair = generateKeyPairSync('ed25519');
const pem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const now = new Date('2026-09-29T12:00:00Z');
function root(date = '2026-09-27', id = 1) {
  const payload = { date, root: 'a'.repeat(64), head: 'b'.repeat(64), count: 1, first_id: id, last_id: id };
  return { ...payload, provisional: false, signature: sign(null, Buffer.from(JSON.stringify(payload)), pair.privateKey).toString('base64'), computed_at: 'ignored' };
}
const load = () => import('../dist/root.js');

test('compiler exposes deployed runtime and immutable positions, rather than trusting an ABI', () => {
  const built = compile().LedgerAnchor;
  assert.match(built.deployedBytecode ?? '', /^0x[0-9a-f]+$/);
  assert.ok(Object.values(built.immutableReferences ?? {}).flat().length > 0);
});
test('signed documents validate the complete calendar, counters, key and finality', async () => {
  const { validateRoot } = await load();
  assert.equal(validateRoot(root(), pem, now).date, '2026-09-27');
  for (const edit of [{ date: '2026-02-30' }, { count: '1' }, { count: 0 }, { root: '0'.repeat(64) }, { provisional: true }, { date: '2026-09-29' }, { last_id: 0 }, { signature: 'wrong' }]) {
    assert.throws(() => validateRoot({ ...root(), ...edit }, pem, now));
  }
  const other = generateKeyPairSync('ed25519');
  assert.throws(() => validateRoot(root(), other.publicKey, now), /signature/);
  assert.throws(() => validateRoot(root(), pair.privateKey, now), /public PEM/);
  assert.throws(() => validateRoot(root(), pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), now), /public PEM/);
});
test('empty signed days are valid publication evidence and have no anchoring call', async () => {
  const { validateRoot, anchorParameters } = await load();
  const payload = { date: '2026-09-27', root: null, head: null, count: 0, first_id: null, last_id: null };
  const doc = { ...payload, provisional: false, signature: sign(null, Buffer.from(JSON.stringify(payload)), pair.privateKey).toString('base64') };
  const valid = validateRoot(doc, pem, now);
  assert.equal(valid.count, 0);
  assert.throws(() => anchorParameters(valid), /empty/);
});
test('catch-up validates every offered root before choosing the oldest bounded batch', async () => {
  const { planCatchup, dateWindows } = await import('../dist/anchoring.js');
  const docs = [root('2026-09-28', 3), root('2026-09-26', 1), root('2026-09-27', 2)];
  assert.deepEqual(planCatchup(docs, pem, { from: '2026-09-26', to: '2026-09-28', lastDay: 0, limit: 2, now }).map(r => r.date), ['2026-09-26', '2026-09-27']);
  assert.throws(() => planCatchup([...docs, { ...root('2026-09-28', 4), signature: 'wrong' }], pem, { from: '2026-09-26', to: '2026-09-28', lastDay: 0, limit: 1, now }));
  assert.throws(() => planCatchup([docs[0], docs[0]], pem, { from: '2026-09-26', to: '2026-09-28', lastDay: 0, limit: 1, now }), /duplicate/);
  assert.deepEqual(dateWindows('2024-01-01', '2025-01-01'), [{ from: '2024-01-01', to: '2024-12-31' }, { from: '2025-01-01', to: '2025-01-01' }]);
});
test('a requested catch-up start cannot silently jump over the uncovered range', async () => {
  const { catchupStart } = await import('../dist/anchoring.js');
  assert.equal(catchupStart(20722, undefined, undefined), '2026-09-27');
  assert.equal(catchupStart(0, '2026-09-24', undefined), '2026-09-24');
  assert.throws(() => catchupStart(20722, undefined, '2026-09-28'), /skip/);
  assert.throws(() => catchupStart(0, '2026-09-24', '2026-09-25'), /skip/);
});
test('runtime identity matches a real EVM deployment including the immutable owner', async () => {
  const { expectedRuntime, verifyIdentity } = await import('../dist/contract.js');
  const chain = await newChain();
  const deployed = await chain.deploy('LedgerAnchor', account(1), [account(2)]);
  const built = compile().LedgerAnchor;
  const code = await chain.getCode(deployed.address);
  assert.equal(code, expectedRuntime(built, account(1)));
  verifyIdentity(built, { chainId: 84532, code, owner: account(1), anchorer: account(2) }, account(1));
  assert.throws(() => verifyIdentity(built, { chainId: 84532, code, owner: account(3), anchorer: account(2) }, account(3)), /runtime/);
  assert.throws(() => verifyIdentity(built, { chainId: 1, code, owner: account(1), anchorer: account(2) }, account(1)), /Sepolia/);
});
test('deployment preparation pins nonce, predicted address and compiled artifact', async () => {
  const { prepareDeployment } = await import('../dist/deployment.js');
  const built = compile().LedgerAnchor;
  const plan = prepareDeployment(built, { owner: account(1), anchorer: account(2), nonce: 7, chainId: 84532 });
  assert.match(plan.address, /^0x[0-9a-fA-F]{40}$/);
  assert.match(plan.artifactHash, /^[a-f0-9]{64}$/);
  assert.match(plan.data, /^0x/);
  assert.throws(() => prepareDeployment(built, { owner: account(1), anchorer: account(2), nonce: 7, chainId: 1 }), /Sepolia/);
});
test('journal refuses concurrent writers and never retries an uncertain broadcast', async () => {
  const { withJournal, runOperation } = await import('../dist/journal.js');
  const file = join(mkdtempSync(join(tmpdir(), 'uain-anchor-')), 'journal.json');
  let sends = 0;
  await withJournal(file, async journal => {
    await assert.rejects(withJournal(file, async () => {}), /locked/);
    await assert.rejects(runOperation(journal, 'deploy', 'same-plan', async () => { sends++; throw new Error('connection lost'); }, async () => {}), /connection lost/);
  });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).operations.deploy.state, 'uncertain');
  await withJournal(file, async journal => {
    await assert.rejects(runOperation(journal, 'deploy', 'same-plan', async () => { sends++; return `0x${'c'.repeat(64)}`; }, async () => {}), /recovery/);
  });
  assert.equal(sends, 1);
});

test('runtime checks reject proxies, changed instructions and malformed immutable layouts', async () => {
  const { expectedRuntime, verifyIdentity } = await import('../dist/contract.js');
  const built = compile().LedgerAnchor;
  const code = expectedRuntime(built, account(1));
  for (const wrong of ['0x', '0x363d3d373d3d3d363d73', `0x00${code.slice(4)}`]) assert.throws(() => verifyIdentity(built, { chainId: 84532, code: wrong, owner: account(1), anchorer: account(2) }, account(1)), /runtime/);
  assert.throws(() => expectedRuntime({ ...built, immutableReferences: {} }, account(1)), /layout/);
  assert.throws(() => expectedRuntime({ ...built, immutableReferences: { owner: [{ start: 0, length: 20 }] } }, account(1)), /position/);
});
test('prepared CREATE address equals the real deployed address', async () => {
  const { prepareDeployment } = await import('../dist/deployment.js');
  const plan = prepareDeployment(compile().LedgerAnchor, { owner: account(1), anchorer: account(2), chainId: 84532, nonce: 0 });
  const deployed = await (await newChain()).deploy('LedgerAnchor', account(1), [account(2)]);
  assert.equal(deployed.address.toLowerCase(), plan.address.toLowerCase());
});
test('confirmation failure preserves the hash, recovery is read-only, and changed plans are blocked', async () => {
  const { withJournal, runOperation, recoverOperation } = await import('../dist/journal.js');
  const file = join(mkdtempSync(join(tmpdir(), 'uain-anchor-')), 'journal.json');
  const hash = `0x${'c'.repeat(64)}`;
  let sends = 0;
  await withJournal(file, async journal => {
    await assert.rejects(runOperation(journal, 'deploy', 'plan', async () => {
      sends++;
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).operations.deploy.state, 'uncertain');
      return hash;
    }, async () => { throw new Error('receipt timeout'); }), /timeout/);
  });
  await withJournal(file, async journal => {
    assert.equal(journal.data.operations.deploy.hash, hash);
    await assert.rejects(runOperation(journal, 'deploy', 'changed', async () => { sends++; return hash; }, async () => {}), /differs/);
    await assert.rejects(recoverOperation(journal, 'deploy', 'plan', async () => { throw new Error('not confirmed'); }), /not confirmed/);
    assert.equal(journal.data.operations.deploy.state, 'uncertain');
    await recoverOperation(journal, 'deploy', 'plan', async op => { assert.equal(op.hash, hash); });
    assert.equal(await runOperation(journal, 'deploy', 'plan', async () => { sends++; return hash; }, async () => {}), 'unchanged');
  });
  assert.equal(sends, 1);
});
test('chronological orchestration anchors real EVM state and exact repeats submit nothing', async () => {
  const { executeAnchors } = await import('../dist/anchoring.js');
  const { withJournal } = await import('../dist/journal.js');
  const chain = await newChain(BigInt(now.getTime() / 1000));
  const contract = await chain.deploy('LedgerAnchor', account(1), [account(2)]);
  const file = join(mkdtempSync(join(tmpdir(), 'uain-anchor-')), 'journal.json');
  let sends = 0;
  const port = { read: day => contract.read('anchorOf', [day]), simulate: async () => {},
    send: async params => { await contract.send('anchor', params, account(2)); sends++; return `0x${'c'.repeat(64)}`; }, confirm: async () => {} };
  const roots = [root('2026-09-26', 1), root('2026-09-27', 2)];
  await withJournal(file, journal => executeAnchors(roots, port, journal, 'binding'));
  await withJournal(file, journal => executeAnchors(roots, port, journal, 'binding'));
  assert.equal(sends, 2);
  assert.equal(await contract.read('lastDay'), 20723);
});
test('a conflicting later root or failed preflight prevents every write in the batch', async () => {
  const { executeAnchors } = await import('../dist/anchoring.js');
  const { withJournal } = await import('../dist/journal.js');
  const zero = { root: `0x${'0'.repeat(64)}`, head: `0x${'0'.repeat(64)}`, count: 0n, lastEventId: 0n, anchoredAt: 0n };
  let sends = 0;
  const roots = [root('2026-09-26', 1), root('2026-09-27', 2)];
  const base = { read: async () => zero, simulate: async () => {}, send: async () => { sends++; return `0x${'c'.repeat(64)}`; }, confirm: async () => {} };
  for (const port of [{ ...base, read: async day => day === 20723 ? { ...zero, anchoredAt: 1n } : zero }, { ...base, simulate: async p => { if (p[0] === 20723) throw new Error('simulation failed'); } }]) {
    const file = join(mkdtempSync(join(tmpdir(), 'uain-anchor-')), 'journal.json');
    await withJournal(file, async journal => assert.rejects(executeAnchors(roots, port, journal, 'binding')));
  }
  assert.equal(sends, 0);
});
test('a missing read-back stops the batch and requires recovery before another write', async () => {
  const { executeAnchors } = await import('../dist/anchoring.js');
  const { withJournal } = await import('../dist/journal.js');
  const file = join(mkdtempSync(join(tmpdir(), 'uain-anchor-')), 'journal.json');
  const zero = { root: `0x${'0'.repeat(64)}`, head: `0x${'0'.repeat(64)}`, count: 0n, lastEventId: 0n, anchoredAt: 0n };
  let sends = 0;
  const port = { read: async () => zero, simulate: async () => {}, send: async () => { sends++; return `0x${'c'.repeat(64)}`; }, confirm: async () => {} };
  const roots = [root('2026-09-26', 1), root('2026-09-27', 2)];
  await withJournal(file, async journal => assert.rejects(executeAnchors(roots, port, journal, 'binding'), /absent/));
  await withJournal(file, async journal => assert.rejects(executeAnchors(roots, port, journal, 'binding'), /recovery/));
  await withJournal(file, async journal => assert.rejects(executeAnchors([roots[0]], port, journal, 'binding', true), /cannot prove/));
  assert.equal(sends, 1);
});
test('every committed anchor field is audited and inconsistent absence is rejected', async () => {
  const { compareAnchor } = await import('../dist/anchoring.js');
  const { anchorParameters } = await load();
  const params = anchorParameters(root());
  const stored = { root: params[1], head: params[2], count: params[3], lastEventId: params[4], anchoredAt: 1n };
  for (const field of ['root', 'head', 'count', 'lastEventId']) assert.throws(() => compareAnchor({ ...stored, [field]: ['root', 'head'].includes(field) ? `0x${'f'.repeat(64)}` : 100n }, params), /conflict/);
  assert.throws(() => compareAnchor({ ...stored, anchoredAt: 0n }, params), /Inconsistent/);
});
test('a lost hash recovers only a matching confirmed anchor, without calling a wallet', async () => {
  const { executeAnchors, anchorFingerprint } = await import('../dist/anchoring.js');
  const { anchorParameters } = await load();
  const { withJournal } = await import('../dist/journal.js');
  const file = join(mkdtempSync(join(tmpdir(), 'uain-anchor-')), 'journal.json');
  const doc = root(); const params = anchorParameters(doc);
  const matching = { root: params[1], head: params[2], count: params[3], lastEventId: params[4], anchoredAt: 100n };
  const zero = { root: `0x${'0'.repeat(64)}`, head: `0x${'0'.repeat(64)}`, count: 0n, lastEventId: 0n, anchoredAt: 0n };
  let confirmed = false, sends = 0;
  const port = { read: async () => matching, readConfirmed: async () => confirmed ? matching : zero, simulate: async () => {}, send: async () => { sends++; return `0x${'c'.repeat(64)}`; }, confirm: async () => {} };
  await withJournal(file, async journal => {
    journal.data.operations[`anchor:${doc.date}`] = { plan: anchorFingerprint(doc, 'binding'), state: 'uncertain', updatedAt: now.toISOString() }; journal.save();
    await assert.rejects(executeAnchors([doc], port, journal, 'binding', true), /confirmed/);
    assert.equal(journal.data.operations[`anchor:${doc.date}`].state, 'uncertain');
    confirmed = true;
    await executeAnchors([doc], port, journal, 'binding', true);
    assert.equal(journal.data.operations[`anchor:${doc.date}`].state, 'confirmed');
  });
  assert.equal(sends, 0);
});
test('HTTP reads are bounded across both headers and streamed bodies, with redirects refused', async () => {
  const { fetchJson, apiOrigin } = await import('../dist/http.js');
  assert.equal(apiOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  for (const origin of ['http://uain.global', 'https://user:pass@uain.global', 'https://uain.global/path', 'https://uain.global?key=x']) assert.throws(() => apiOrigin(origin));
  let cancelled = false;
  await assert.rejects(fetchJson('http://test', async (_, opts) => { assert.equal(opts.redirect, 'error'); return new Response('a'.repeat(100)); }, 10), /byte limit/);
  await assert.rejects(fetchJson('http://test', async () => new Promise(() => {}), 100, 20), /deadline/);
  await assert.rejects(fetchJson('http://test', async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })), 100, 20), /deadline/);
  assert.equal(cancelled, true);
});
test('CLI rejects implicit sends, misspelled flags and conflicting recovery flags', async () => {
  const { parseArguments } = await import('../dist/cli.js');
  assert.equal(parseArguments(['deploy', '--nonce', '0']).send, false);
  for (const args of [['audit', '--send'], ['deploy', '--send', '--recover'], ['catchup', '--sedn'], ['deploy', '--nonce'], ['catchup', '--limit', '1', '--limit', '2']]) assert.throws(() => parseArguments(args));
});
test('CLI configuration diagnostics do not expose provider URLs or credentials', async () => {
  const { failureMessage } = await import('../dist/cli.js');
  assert.equal(failureMessage(new Error('Missing BASE_SEPOLIA_RPC')), 'Missing BASE_SEPOLIA_RPC');
  assert.equal(failureMessage(new Error('request https://rpc.example/private-api-key failed')), 'Check configuration, pinned root and journal/chain state');
});
test('publication is append-only and verifies against an independent key', async () => {
  const { publishRoot } = await import('../dist/publication.js');
  const dir = mkdtempSync(join(tmpdir(), 'uain-publish-'));
  assert.equal(publishRoot(dir, root(), pem, now), 'created');
  assert.equal(publishRoot(dir, { ...root(), computed_at: 'different' }, pem, now), 'unchanged');
  assert.throws(() => publishRoot(dir, root('2026-09-27', 2), pem, now), /differs/);
  const other = generateKeyPairSync('ed25519');
  assert.throws(() => publishRoot(dir, root('2026-09-28'), other.publicKey, now), /signature/);
  writeFileSync(join(dir, '2026-09-27.json'), '{}');
  assert.throws(() => publishRoot(dir, root(), pem, now));
});
