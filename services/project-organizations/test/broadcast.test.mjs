/** FIXTURE keys, chains and RPC only: nothing here contacts a native node or production. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { centralEarningSigningBytes } from '../../../apps/baink/server/central-earning-command.mjs';
import { memberAddress } from '../../../apps/baink/server/native-financial-command.mjs';
import { openProjectSigningBytes } from '../src/bootstrap.mjs';
import { sha256 } from '../src/common.mjs';
import { openJournal } from '../src/journal.mjs';
import { createNativeReader } from '../src/native-reader.mjs';
import {
  FLEET_BROADCAST_OPERATIONS, createOperatorBroadcast, createRpcTransport, definiteRejection, retainedInJournal, verifyFleetEnvelope,
} from '../src/broadcast.mjs';

const CHAIN = 'uain-fixture-broadcast-chain';
const PRODUCTION = 'uain-fixture-production-chain';
const refuses = (code) => (e) => (assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`), true);
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return { address: memberAddress(pub), publicKey: pub.toString('base64url'), privateKey };
}
const manager = identity();
const guardian = identity();

function envelope(who, operation, payload, { sequence = '0', chain = CHAIN } = {}) {
  const command = { version: 1, chain_id: chain, member: who.address, sequence, expires_height: '500', operation, payload };
  const bytes = operation === 'open_project' ? openProjectSigningBytes(command) : centralEarningSigningBytes(command);
  return { command, public_key: who.publicKey, signature: edSign(null, bytes, who.privateKey).toString('base64url') };
}
const fund = (seq = '0', task = 'T-1') => envelope(manager, 'central_task_fund', { task, evidence_digest: sha256('fund ' + task) }, { sequence: seq });
const txHash = (e) => createHash('sha256').update(JSON.stringify(e)).digest('hex').toUpperCase();

/** FIXTURE RPC poster: answers with `code` (and `codespace`), echoing the hash of the bytes. */
function fakeRpc({ code = 0, codespace = '', fail = false, hash = null, error = null, log = '' } = {}) {
  const calls = [];
  return {
    calls,
    set(next) { Object.assign(this.next, next); },
    next: { code, codespace, fail, hash, error, log },
    async postTx({ bytes, transactionHash, timeoutMs }) {
      calls.push({ bytes: Buffer.from(bytes), transactionHash, timeoutMs });
      const n = this.next;
      if (n.fail) throw new Error('connection reset');
      if (n.error) return { jsonrpc: '2.0', id: 'x', error: n.error };
      return { jsonrpc: '2.0', id: 'x', result: { code: n.code, codespace: n.codespace, hash: n.hash ?? transactionHash, log: n.log } };
    },
  };
}
const make = (rpc, extra = {}) => createOperatorBroadcast({ transport: rpc, chainId: CHAIN, productionChainId: PRODUCTION, ...extra });

test('allowed fleet operations only; the exact JSON bytes are posted and the hash is checked', async () => {
  assert.deepEqual([...FLEET_BROADCAST_OPERATIONS].sort(), ['central_fund_apply', 'central_fund_close', 'central_fund_configure', 'central_fund_decide', 'central_fund_plan',
    'central_fund_plan_review', 'central_project_start', 'central_submit', 'central_task_fund', 'central_task_open', 'open_project', 'project_join']);
  const rpc = fakeRpc();
  const b = make(rpc);
  const e = fund();
  const r = await b.broadcast(e, { timeoutMs: 50000 });
  assert.deepEqual(r, { accepted: true, code: 0, txHash: txHash(e), operation: 'central_task_fund', rebroadcast: false, definite: false });
  assert.equal(rpc.calls.length, 1);
  assert.equal(rpc.calls[0].bytes.toString('utf8'), JSON.stringify(e));
  assert.equal(rpc.calls[0].timeoutMs, 10000, 'timeout is bounded');

  // Operations outside the fleet set are refused before any send.
  const review = envelope(manager, 'central_review', {
    submission: 'S-1', verdict: 'accept', criteria_digest: sha256('c'), verification_digest: sha256('v'), execution_id: 'e-1', evidence_digest: sha256('e'),
  }, { sequence: '7' });
  await assert.rejects(b.broadcast(review), refuses('operator_operation_not_allowed'));
  const close = envelope(manager, 'central_fund_close', { project: 'P-OPP-00001', evidence_digest: sha256('x') }, { sequence: '8' });
  // central_fund_close is a fleet operation (evaluator closes a settled fund), so only a narrowed broadcaster refuses it.
  await assert.rejects(make(rpc, { operations: ['project_join'] }).broadcast(close), refuses('operator_operation_not_allowed'));
  // Narrowed operations.
  await assert.rejects(make(rpc, { operations: ['project_join'] }).broadcast(fund('9')), refuses('operator_operation_not_allowed'));
  assert.throws(() => make(rpc, { operations: ['central_review'] }), refuses('invalid_operator_broadcast'));
  assert.equal(rpc.calls.length, 1);
});

test('envelope signature, payload and chain id are verified before sending', async () => {
  const rpc = fakeRpc();
  const b = make(rpc);
  const tampered = fund('1');
  tampered.command.payload.task = 'T-2';
  await assert.rejects(b.broadcast(tampered), refuses('invalid_operator_envelope'));
  const otherKey = fund('2');
  otherKey.public_key = guardian.publicKey;
  await assert.rejects(b.broadcast(otherKey), refuses('invalid_operator_envelope'));
  const wrongChain = envelope(manager, 'project_join', { project: 'P-OPP-00001' }, { chain: PRODUCTION });
  await assert.rejects(b.broadcast(wrongChain), refuses('operator_envelope_chain_mismatch'));
  await assert.rejects(b.broadcast({ ...fund('3'), extra: 1 }), refuses('invalid_operator_envelope'));
  // A bad payload (criteria digest mismatch) fails the typed BAINK check.
  const badOpen = envelope(manager, 'central_task_open', {
    id: 'T-9', project: 'P-OPP-00001', title: 'Task title', criteria: 'criteria text', acceptance_digest: sha256('criteria text'),
    eligibility: 'new', eligibility_digest: sha256('el'), solver_amount: '10', reviewer_amount: '1', evidence_digest: sha256('ev'),
  }, { sequence: '4' });
  assert.equal(verifyFleetEnvelope(badOpen, { chainId: CHAIN }), true);
  badOpen.command.payload.acceptance_digest = sha256('other');
  assert.throws(() => verifyFleetEnvelope(badOpen, { chainId: CHAIN }), refuses('invalid_operator_envelope'));
  assert.equal(rpc.calls.length, 0);

  // open_project uses the bootstrap verifier.
  const open = envelope(guardian, 'open_project', {
    id: 'P-OPP-00001', title: 'Fixture project title', class: 'neutral',
    prior_art: { basis: 'Fixture basis text that is comfortably longer than forty bytes.', searches: ['fixture search one', 'fixture search two'] },
  });
  assert.equal((await b.broadcast(open)).accepted, true);
  const badSig = structuredClone(open);
  badSig.command.payload.title = 'Another fixture title';
  await assert.rejects(b.broadcast(badSig), refuses('invalid_operator_envelope'));
});

test('rebroadcast is byte-identical only, and its refusal is never definite', async () => {
  const rpc = fakeRpc();
  const b = make(rpc);
  const e = fund('5');
  await b.broadcast(e);
  rpc.set({ code: 32 });
  const again = await b.broadcast(JSON.parse(JSON.stringify(e)));
  assert.equal(again.rebroadcast, true);
  assert.equal(again.definite, false, 'the first copy may already be included');
  assert.equal(definiteRejection(again), null);
  // Another envelope for the same signer sequence is a re-sign: refused, nothing sent.
  const before = rpc.calls.length;
  await assert.rejects(b.broadcast(fund('5', 'T-other')), refuses('rebroadcast_not_identical'));
  assert.equal(rpc.calls.length, before);
  // An explicit resend after a restart (lane forgotten) is not definite either.
  const fresh = make(rpc);
  const resent = await fresh.broadcast(e, { rebroadcast: true });
  assert.equal(resent.definite, false);
});

test('a first-send CheckTx refusal is definite and fails the dispatched journal intent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uain-broadcast-'));
  dirs.push(dir);
  const journal = openJournal({ directory: dir });
  const e = fund('6');
  const id = 'intent-fund-6';
  journal.prepare({
    id, projectId: 'OPP-00001', kind: 'native', operation: 'central_task_fund', payload: e.command.payload,
    selectionDigest: sha256('sel'), sourceDigest: sha256('src'), signer: manager.address,
  });
  journal.claim(id, 'test-owner');
  const rpc = fakeRpc({ code: 7, codespace: 'federation', log: 'central task\u0000 refused\n' + 'x'.repeat(600) });
  const b = make(rpc, { requireRetained: retainedInJournal(journal) });
  // Not yet retained: refused before sending.
  await assert.rejects(b.broadcast(e), refuses('operator_envelope_not_retained'));
  assert.equal(rpc.calls.length, 0);
  journal.recordEnvelope(id, e);
  const r = await b.broadcast(e);
  assert.equal(r.accepted, false);
  assert.equal(r.definite, true);
  const { log, ...rest } = r.rejection;
  assert.deepEqual(rest, { definite: true, code: 7, codespace: 'federation', txHash: txHash(e), chainId: CHAIN, operation: 'central_task_fund' });
  assert.equal(log.length, 400, 'the node log is bounded');
  assert.ok(log.startsWith('central task  refused '), 'control characters stripped');
  const d = definiteRejection(r, { envelope: e });
  assert.equal(d.reason, 'node_rejected:7');
  // Bound to exactly this envelope: another envelope's hash or a forged result is not definite.
  assert.equal(definiteRejection(r, { envelope: fund('6', 'T-other') }), null);
  assert.equal(definiteRejection({ ...r, code: 8 }), null);
  assert.equal(definiteRejection({ ...r, rejection: { ...r.rejection, definite: false } }), null);
  const failed = journal.fail(id, d.reason, { rejection: d.rejection });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.receipt.txHash, txHash(e));
  journal.close();

  // The definitely refused bytes never entered the mempool: their sequence lane is free again
  // for a newly signed envelope (but an accepted lane stays byte-identical only).
  const lane = make(fakeRpc({ code: 7, codespace: 'federation' }));
  assert.equal((await lane.broadcast(fund('30', 'T-refused'))).definite, true);
  const reused = await lane.broadcast(fund('30', 'T-next'));
  assert.deepEqual([reused.rebroadcast, reused.definite], [false, true]);
  // Native federation refusals arrive as codespace `undefined` code 1 (the 0.3.9 daemon): a
  // definite first-send CheckTx refusal, so the journal fails the intent at once.
  const federation = make(fakeRpc({ code: 1, codespace: 'undefined', log: 'central project allocation exceeded' }));
  const refused = await federation.broadcast(fund('31', 'T-refused'));
  assert.deepEqual([refused.definite, refused.rejection.code, refused.rejection.codespace, refused.rejection.log], [true, 1, 'undefined', 'central project allocation exceeded']);
  assert.equal(definiteRejection(refused).reason, 'node_rejected:1');
  assert.equal((await federation.broadcast(fund('31', 'T-next'))).rebroadcast, false);
  // A refusal that is not definite (mempool full) also leaves the lane free: not admitted.
  const full = make(fakeRpc({ code: 20, codespace: 'sdk' }));
  assert.equal((await full.broadcast(fund('33', 'T-refused'))).definite, false);
  assert.equal((await full.broadcast(fund('33', 'T-next'))).rebroadcast, false);
  // An accepted lane stays byte-identical only.
  const accepted = make(fakeRpc());
  await accepted.broadcast(fund('32', 'T-a'));
  await assert.rejects(accepted.broadcast(fund('32', 'T-b')), refuses('rebroadcast_not_identical'));

  // Mempool cache / capacity, I/O and recovered-panic codes are not definite.
  for (const [codespace, code] of [['sdk', 20], ['sdk', 19], ['sdk', 39], ['undefined', 111222]]) {
    const x = await make(fakeRpc({ code, codespace })).broadcast(fund(String(10 + code)));
    assert.equal(x.definite, false, `${codespace}:${code}`);
  }
});

test('transport failure, JSON-RPC error and a hash mismatch are unknown outcomes', async () => {
  await assert.rejects(make(fakeRpc({ fail: true })).broadcast(fund('20')), refuses('broadcast_outcome_unknown'));
  await assert.rejects(make(fakeRpc({ error: { code: -32603, message: 'tx already exists in cache' } })).broadcast(fund('21')), refuses('broadcast_outcome_unknown'));
  await assert.rejects(make(fakeRpc({ hash: 'A'.repeat(64) })).broadcast(fund('22')), refuses('broadcast_outcome_unknown'));
  // After an unknown outcome the same bytes may be resent; a different envelope may not.
  const rpc = fakeRpc({ fail: true });
  const b = make(rpc);
  await assert.rejects(b.broadcast(fund('23')), refuses('broadcast_outcome_unknown'));
  rpc.set({ fail: false });
  assert.equal((await b.broadcast(fund('23'))).rebroadcast, true);
  await assert.rejects(b.broadcast(fund('23', 'T-x')), refuses('rebroadcast_not_identical'));
});

test('production chain needs an explicit enable; configuration is refused when incomplete', async () => {
  const rpc = fakeRpc();
  const prod = createOperatorBroadcast({ transport: rpc, chainId: PRODUCTION, productionChainId: PRODUCTION });
  const e = envelope(manager, 'project_join', { project: 'P-OPP-00001' }, { chain: PRODUCTION });
  await assert.rejects(prod.broadcast(e), refuses('production_broadcast_not_enabled'));
  assert.equal(rpc.calls.length, 0);
  const enabled = createOperatorBroadcast({ transport: rpc, chainId: PRODUCTION, productionChainId: PRODUCTION, allowProduction: true });
  assert.equal((await enabled.broadcast(e)).accepted, true);
  assert.throws(() => createOperatorBroadcast({ transport: rpc, chainId: CHAIN }), refuses('invalid_operator_broadcast'));
  assert.throws(() => createOperatorBroadcast({ transport: {}, chainId: CHAIN, productionChainId: PRODUCTION }), refuses('invalid_operator_broadcast'));
});

test('native reader prefers the injected broadcaster and refuses one bound to another chain', async () => {
  const transport = { async publicState() { throw new Error('unused'); }, async broadcastCentral() { throw new Error('must not be used'); } };
  const rpc = fakeRpc({ code: 5, codespace: 'federation' });
  const broadcaster = make(rpc);
  const reader = createNativeReader({ transport, chainId: CHAIN, productionChainId: PRODUCTION, broadcaster });
  const relayed = await reader.broadcast(fund('30'));
  assert.deepEqual([relayed.code, relayed.definite, relayed.rejection.txHash], [5, true, txHash(fund('30'))]);
  assert.equal(rpc.calls.length, 1);
  // A resend through the reader is marked as such: never definite.
  const again = await createNativeReader({ transport, chainId: CHAIN, productionChainId: PRODUCTION, broadcaster: make(rpc) }).broadcast(fund('30'), { rebroadcast: true });
  assert.deepEqual([again.code, again.definite, again.rejection], [5, false, null]);
  const other = createOperatorBroadcast({ transport: rpc, chainId: 'uain-other-fixture', productionChainId: PRODUCTION });
  assert.throws(() => createNativeReader({ transport, chainId: CHAIN, productionChainId: PRODUCTION, broadcaster: other }),
    refuses('invalid_native_reader_configuration'));
});

test('RPC poster: owned loopback or public HTTPS only, broadcast_tx_sync body, bounded reply', async () => {
  for (const rpc of ['http://10.0.0.1:26657', 'http://user:pw@127.0.0.1:1', 'https://rpc.fixture.test/path', 'http://127.0.0.1:1/?q=1', 'ftp://127.0.0.1', 'nope'])
    assert.throws(() => createRpcTransport({ rpc }), refuses('invalid_native_rpc'), rpc);
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    const body = JSON.parse(init.body);
    const tx = Buffer.from(body.params.tx, 'base64');
    const hash = createHash('sha256').update(tx).digest('hex');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { code: 0, hash, log: '' } }));
  };
  const poster = createRpcTransport({ rpc: 'http://127.0.0.1:26667', fetchImpl });
  const b = make(poster);
  const e = fund('40');
  const r = await b.broadcast(e);
  assert.equal(r.accepted, true);
  assert.equal(seen[0].url, 'http://127.0.0.1:26667');
  assert.equal(seen[0].init.redirect, 'error');
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.method, 'broadcast_tx_sync');
  assert.equal(Buffer.from(body.params.tx, 'base64').toString('utf8'), JSON.stringify(e));

  const huge = createRpcTransport({ rpc: 'https://rpc.fixture.test', fetchImpl: async () => new Response('x'.repeat(70000)) });
  await assert.rejects(make(huge).broadcast(fund('41')), refuses('broadcast_outcome_unknown'));
  const down = createRpcTransport({ rpc: 'https://rpc.fixture.test', fetchImpl: async () => new Response('no', { status: 503 }) });
  await assert.rejects(make(down).broadcast(fund('42')), refuses('broadcast_outcome_unknown'));
});
