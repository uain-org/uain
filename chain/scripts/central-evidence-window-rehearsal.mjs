#!/usr/bin/env node
// Disposable two-node rehearsal ONLY (10 November 2026). Never points at an existing chain;
// every identity is a fictional fixture key generated here. It rehearses the S6 evidence-window
// activation (central-evidence-window-v1) on real pinned daemons, and the way out for a
// needs_evidence recorded before activation: a fresh central_review with a new execution id.
// Member revision and reassessment go through BAINK's real central-earning service and its
// pinned proof reader (prepare, sign, submit, reconcile), as the kit does.
//
//   node central-evidence-window-rehearsal.mjs <primary uaind> <second-node uaind> <uain-state> [window_blocks]
//
// The two daemons may differ (0.4.1 validator, 0.4.2 second node): every block must then still
// give the same app hash on both, which shows 0.4.2 executes the S6 operations as 0.4.1 does.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { signedEnvelope } from '../client/signing.mjs';
import { createCentralEarningService } from '../../apps/baink/server/central-earning.mjs';
import { createNativeAssetAdapter } from '../../apps/baink/server/native-asset.mjs';
import { centralEarningSigningBytes } from '../../apps/baink/server/central-earning-command.mjs';

const [primaryDaemon, secondDaemon, stateReader] = process.argv.slice(2, 5).map((p) => resolve(p));
const WINDOW = process.argv[5] ?? '20';
const readerPin = '136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860';
const hash = (s) => createHash('sha256').update(s).digest('hex');
assert.equal(hash(await readFile(stateReader)), readerPin, 'reader differs from original independent pin');
const daemonPins = { primary: hash(await readFile(primaryDaemon)), second: hash(await readFile(secondDaemon)) };
const chainId = 'uain-evidence-fixture-1';
const root = await mkdtemp(join(tmpdir(), 'uain-evidence-window-fixture-'));
const base = Number(process.env.UAIN_EVIDENCE_REHEARSAL_PORT ?? 36657);
const ports = [base, base + 10];
const homes = ports.map((_, i) => join(root, `node-${i}`));
const running = new Set();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function identity(name, karma = 0) {
  const keys = generateKeyPairSync('ed25519');
  const raw = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { ...keys, raw, member: { id: `uain1${hash(raw).slice(0, 40)}`, public_key: raw.toString('base64url'), name, operator: name, family: name, licence: 'active', karma, credits: '0', sequence: '0', default_verifier: false, creator: false, active_projects: 0 } };
}
const guardian = identity('fictional-guardian'), relay = identity('fictional-relay');
const manager = identity('fictional-manager', 1000), author = identity('fictional-author', 100), other = identity('fictional-second-author', 100);
manager.member.creator = true; guardian.member.default_verifier = true;
function run(binary, args) {
  return new Promise((ok, no) => { const c = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; c.stdout.on('data', (b) => { out += b; }); c.stderr.on('data', (b) => { out += b; }); c.once('error', no); c.once('close', (code) => (code === 0 ? ok(out.trim()) : no(new Error(out)))); });
}
function start(home, binary) {
  const c = spawn(binary, ['start', '--home', home], { stdio: ['ignore', 'pipe', 'pipe'] }); let log = '';
  for (const s of [c.stdout, c.stderr]) s.on('data', (b) => { log = (log + b).slice(-16000); });
  c.diagnostics = () => log; running.add(c); c.once('exit', () => running.delete(c)); return c;
}
async function stop(c) { if (c.exitCode !== null) return; await new Promise((ok) => { const t = setTimeout(() => c.kill('SIGKILL'), 15000); c.once('exit', () => { clearTimeout(t); ok(); }); c.kill('SIGTERM'); }); }
async function rpc(port, method, params = {}) {
  const r = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(method.startsWith('broadcast_tx_') ? 15000 : 3000) });
  const d = await r.json(); if (d.error) throw new Error(JSON.stringify(d.error)); return d.result;
}
const height = async (i = 0) => Number((await rpc(ports[i], 'status')).sync_info.latest_block_height);
async function waitFor(fn, label) {
  let last;
  for (let i = 0; i < 240; i++) {
    if (running.size < 2) throw new Error(`a fixture node exited during ${label}`);
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await pause(500);
  }
  throw new Error(`${label}: ${last?.message ?? 'not reached'}`);
}
async function record(key, i = 0) {
  const r = (await rpc(ports[i], 'abci_query', { path: '/store/federation/key', data: Buffer.from(key).toString('hex') })).response;
  assert.equal(r.code, 0); return r.value ? JSON.parse(Buffer.from(r.value, 'base64')) : null;
}
// Sequence from chain state, so BAINK-sent commands and direct ones interleave correctly.
async function submit(operation, payload, actor = guardian, expected = true) {
  const m = await record(`member/${actor.member.id}`);
  const command = { version: 1, chain_id: chainId, member: actor.member.id, sequence: m.sequence, expires_height: String((await height()) + 300), operation, payload };
  const tx = signedEnvelope(command, Buffer.from(actor.member.public_key, 'base64url'), actor.privateKey);
  const r = await rpc(ports[0], expected ? 'broadcast_tx_commit' : 'broadcast_tx_sync', { tx: Buffer.from(JSON.stringify(tx)).toString('base64') });
  // CheckTx executes the command on a branch of the latest state, so a refusal is definite there.
  if (!expected) { assert.notEqual(r.code, 0, `${operation} incorrectly accepted`); return null; }
  assert.equal(r.check_tx.code, 0, `${operation}: ${r.check_tx.log}`); assert.equal(r.tx_result.code, 0, `${operation}: ${r.tx_result.log}`);
  return Number(r.height);
}
const results = { fixture: true, daemonPins, window_blocks: WINDOW, steps: [] };
const step = (name, extra = {}) => { results.steps.push({ name, ...extra }); console.error('ok -', name); };
const evidence = 'a'.repeat(64), criteria = 'result equals 42';
const sub = (id, task, text = '42', revises) => ({ id, task, evidence: text, evidence_digest: hash(text), ...(revises ? { revises } : {}) });
const review = (submission, verdict, execution_id, text = '42') => ({ submission, verdict, execution_id, criteria_digest: hash(criteria), verification_digest: evidence, evidence_digest: hash(text) });
let nodes = [], native = null;
try {
  const app = join(root, 'app-genesis.json');
  await writeFile(app, JSON.stringify({ version: 1, guardians: [guardian.member.id], members: [guardian, relay, manager, author, other].map((x) => x.member) }));
  for (let i = 0; i < 2; i++) await run(primaryDaemon, ['init', '--home', homes[i], '--chain-id', chainId, '--app-genesis', app, '--rpc', `tcp://127.0.0.1:${ports[i]}`, '--p2p', `tcp://127.0.0.1:${ports[i] - 1}`]);
  const genesisBytes = await readFile(join(homes[0], 'config/genesis.json'));
  await writeFile(join(homes[1], 'config/genesis.json'), genesisBytes);
  const id = (await run(primaryDaemon, ['node-id', '--home', homes[0]])).split(/\r?\n/).find((x) => /^[0-9a-f]{40}$/.test(x));
  const cfg = join(homes[1], 'config/config.toml');
  await writeFile(cfg, (await readFile(cfg, 'utf8')).replace(/^persistent_peers = .*$/m, `persistent_peers = "${id}@127.0.0.1:${ports[0] - 1}"`).replace(/^addr_book_strict = .*$/m, 'addr_book_strict = false'));
  nodes = [start(homes[0], primaryDaemon), start(homes[1], secondDaemon)];
  await waitFor(async () => (await height(1)) >= 3, 'two nodes ready');
  const settle = async (h) => waitFor(async () => (await height()) > h + 1, 'finality');
  await settle(await submit('activate_storage', { policy: 'compact-state-v1', evidence_digest: evidence }));
  await submit('activate_membership', { policy: 'project-membership-v1', evidence_digest: evidence });
  await submit('activate_operator_rewards', { policy: 'pairwise-operator-rewards-v1', evidence_digest: evidence });
  await submit('activate_private_exchange', { policy: 'orchard-v2-reviewed-otc-v1', relayer: relay.member.id, evidence_digest: evidence });
  for (const [i, actor] of [manager, author, other, guardian].entries()) {
    await submit('identity_claim', {}, actor); await submit('operator_claim', { domain: `evidence-${i}.example` }, actor);
    const claim = await record(`operator_claim/${actor.member.id}/`);
    await submit('operator_attest', { member: actor.member.id, domain: claim.domain, claim_event_id: claim.event_id, txt: `uain-operator=${claim.did}`, checked_at: new Date().toISOString(), evidence_digest: evidence });
  }
  await settle(await submit('activate_coin', { policy: 'verified-bounties-108t-micro-v1', evidence_digest: evidence }));
  const prior_art = { basis: 'No discoverable answer exists for this fictional isolated evidence-window rehearsal.', searches: ['first fictional prior-art search', 'second fictional prior-art search'] };
  await submit('open_project', { id: 'P-ev', title: 'Fictional evidence-window project', class: 'benevolent', prior_art }, manager);
  for (const actor of [author, other, guardian]) await submit('project_join', { project: 'P-ev' }, actor);
  await settle(await submit('central_earning_activate', { policy: 'central-earning-five-kpi-fund-v2', reviewer: guardian.member.id, evidence_digest: evidence }));
  await submit('central_project_start', { project: 'P-ev', manager: manager.member.id, evidence_digest: evidence }, manager);
  // Paid task terms follow a Fund Manager plan (central-earning-five-kpi-fund-v2).
  await submit('central_fund_configure', { project: 'P-ev', evaluator: guardian.member.id, expected_evaluator: '', evidence_digest: evidence });
  await submit('central_fund_plan', { project: 'P-ev', revision: 1, main_kpi: 'Main fictional goal with reproducible measurable result', stages: [1, 2, 3, 4, 5].map((round) => ({ round, criteria: `Fictional measurable acceptance criterion for stage ${round}` })), reason: 'Initial fictional research plan', evidence_digest: evidence });
  await submit('central_fund_plan_review', { project: 'P-ev', revision: 1, verdict: 'accept', evidence_digest: evidence });
  for (const n of [1, 2, 3, 4]) await submit('central_task_open', { id: `CT-${n}`, project: 'P-ev', title: `Fictional evidence task ${n}`, criteria, acceptance_digest: hash(criteria), eligibility: 'hard', eligibility_digest: evidence, solver_amount: '1000000', reviewer_amount: '200000', evidence_digest: evidence }, manager);
  step('central earning on, four funded tasks');

  // 1. A needs_evidence recorded BEFORE activation carries no deadline; nothing the author can do.
  await submit('central_submit', sub('CS-pre', 'CT-1', '41'), author);
  await submit('central_review', review('CS-pre', 'needs_evidence', 'pre', '41'));
  let s = await record('central_submission/CS-pre');
  assert.equal(s.state, 'under_review'); assert.equal(s.evidence_deadline, undefined);
  await submit('central_reassess', { submission: 'CS-pre' }, author, false);
  await submit('central_submit', sub('CS-pre-r0', 'CT-1', '42', 'CS-pre'), author, false);
  await submit('central_evidence_expire', { submission: 'CS-pre' }, other, false);
  step('pre-activation needs_evidence: no deadline; reassess, revise, expire refused');

  // 2. Activation: guardian only, valid window only, once.
  await submit('central_evidence_activate', { policy: 'central-evidence-window-v1', window_blocks: WINDOW, evidence_digest: evidence }, manager, false);
  await submit('central_evidence_activate', { policy: 'central-evidence-window-v1', window_blocks: '0', evidence_digest: evidence }, guardian, false);
  const activatedAt = await submit('central_evidence_activate', { policy: 'central-evidence-window-v1', window_blocks: WINDOW, evidence_digest: evidence });
  await settle(activatedAt);
  const activation = await record('central_evidence_activation');
  assert.deepEqual(activation, { policy: 'central-evidence-window-v1', window_blocks: WINDOW, height: String(activatedAt + 1), approved_by: guardian.member.id, evidence_digest: evidence });
  await submit('central_evidence_activate', { policy: 'central-evidence-window-v1', window_blocks: WINDOW, evidence_digest: evidence }, guardian, false);
  step('activation by the guardian only, once', { activation });

  // 3. The old request still has no deadline after activation and stays stuck.
  s = await record('central_submission/CS-pre'); assert.equal(s.evidence_deadline, undefined);
  await submit('central_reassess', { submission: 'CS-pre' }, author, false);
  await submit('central_evidence_expire', { submission: 'CS-pre' }, other, false);
  step('pre-activation request: still no deadline after activation');

  // 4. Way out without a chain change: the reviewer records a fresh needs_evidence (new execution id).
  const reissued = await submit('central_review', review('CS-pre', 'needs_evidence', 'reissue', '41'));
  s = await record('central_submission/CS-pre');
  assert.equal(s.evidence_request_height, String(reissued)); assert.equal(s.evidence_deadline, String(reissued + Number(WINDOW)));
  await submit('central_review', review('CS-pre', 'needs_evidence', 'reissue-2', '41'), guardian, false);
  step('fresh needs_evidence on the old submission gets a deadline; a second request is refused', { deadline: s.evidence_deadline });

  // BAINK's real service and pinned proof reader, as the member kit uses it.
  const config = { binary: stateReader, binaryHash: readerPin, genesis: join(homes[0], 'config/genesis.json'), genesisHash: hash(genesisBytes), chainId, rpc: `http://127.0.0.1:${ports[0]}`, timeoutMs: 10000, maxAgeSeconds: 120 };
  native = createNativeAssetAdapter({ config });
  let data = {}, queue = Promise.resolve();
  const store = { read: () => structuredClone(data), transact(fn) { const p = queue.then(() => { const next = structuredClone(data), out = fn(next); data = next; return structuredClone(out); }); queue = p.catch(() => {}); return p; } };
  const baink = createCentralEarningService({ store, native, enabled: true });
  const userOf = (a) => ({ publicKey: a.raw.toString('base64'), address: a.member.id });
  async function viaBaink(actor, operation, payload) {
    // BAINK reads proved state one block behind the latest commit; let the last direct command settle first.
    await settle(await height());
    const user = userOf(actor), { intent } = await baink.prepare(user, { operation, payload });
    const envelope = { command: intent.command, public_key: actor.member.public_key, signature: sign(null, centralEarningSigningBytes(intent.command), actor.privateKey).toString('base64url') };
    const sent = await baink.submit(user, intent.id, { envelope });
    assert.equal(sent.attempted, true, operation); assert.equal(sent.intent.status, 'accepted', operation);
    return waitFor(async () => { const r = await baink.reconcile(user, intent.id, {}); return r.intent.status === 'finalized' ? r.intent : null; }, operation + ' finalized through BAINK');
  }
  // Before this change BAINK refused it at prepare (no deadline); now its view offers the two actions.
  await settle(reissued);
  const view = await baink.submission(userOf(author), 'CS-pre', { executionId: 'reissue' });
  assert.equal(view.outcome, 'needs_evidence', JSON.stringify({ review: view.review, evidence: view.evidence, submission: view.submission })); assert.equal(view.evidence.kind, 'reviewer_request');
  assert.deepEqual(view.evidence.actions.map((a) => a.operation), ['central_submit', 'central_reassess']);

  // 5. Revise through BAINK; one revision only; the revision gets accept or reject, never a second request.
  const revised = await viaBaink(author, 'central_submit', sub('CS-pre-r', 'CT-1', '42', 'CS-pre'));
  assert.equal(revised.result.status, 'submitted');
  assert.equal((await record('central_submission/CS-pre')).state, 'superseded');
  assert.equal((await record('central_task/CT-1')).pending, 'CS-pre-r');
  await submit('central_submit', sub('CS-pre-r2', 'CT-1', '43', 'CS-pre'), author, false);
  await submit('central_review', review('CS-pre-r', 'needs_evidence', 'r-needs'), guardian, false);
  await submit('central_review', review('CS-pre-r', 'accept', 'r-accept'));
  assert.equal((await record('central_submission/CS-pre-r')).state, 'accepted');
  assert.equal((await record('central_award/solver/CS-pre-r')).member, author.member.id);
  step('revision through BAINK, then accepted and paid');

  // 6. Reassess through BAINK; once only; the reviewer must then decide.
  await submit('central_submit', sub('CS-b', 'CT-2', '41'), author);
  await submit('central_review', review('CS-b', 'needs_evidence', 'b', '41'));
  const reassessed = await viaBaink(author, 'central_reassess', { submission: 'CS-b' });
  assert.equal(reassessed.result.status, 'reassessment_requested');
  assert.equal((await record('central_submission/CS-b')).reassess, true);
  await submit('central_reassess', { submission: 'CS-b' }, author, false);
  await submit('central_submit', sub('CS-b-r', 'CT-2', '42', 'CS-b'), author, false);
  await submit('central_review', review('CS-b', 'needs_evidence', 'b-again', '41'), guardian, false);
  await submit('central_review', review('CS-b', 'reject', 'b-reject', '41'));
  assert.equal((await record('central_submission/CS-b')).state, 'rejected');
  step('reassessment through BAINK, then rejected');

  // 7. Expiry: refused inside the window; afterwards any member may expire it and the task reopens.
  await submit('central_submit', sub('CS-c', 'CT-3', '41'), other);
  const asked = await submit('central_review', review('CS-c', 'needs_evidence', 'c', '41'));
  const deadline = asked + Number(WINDOW);
  await submit('central_evidence_expire', { submission: 'CS-c' }, author, false);
  // Same for the implicit path on CT-4.
  await submit('central_submit', sub('CS-d', 'CT-4', '41'), other);
  await submit('central_review', review('CS-d', 'needs_evidence', 'd', '41'));
  await waitFor(async () => (await height()) > deadline + 2, 'evidence window passes');
  await submit('central_review', review('CS-c', 'accept', 'c-late', '41'), guardian, false);
  await submit('central_reassess', { submission: 'CS-c' }, other, false);
  await viaBaink(author, 'central_evidence_expire', { submission: 'CS-c' });
  const expired = await record('central_submission/CS-c'), reopened = await record('central_task/CT-3');
  assert.equal(expired.state, 'expired'); assert.equal(reopened.state, 'open'); assert.equal(reopened.pending, '');
  assert.equal(await record('central_award/reviewer/CS-c'), null);
  await submit('central_submit', sub('CS-c2', 'CT-3'), author);
  await waitFor(async () => (await height()) > Number((await record('central_submission/CS-d')).evidence_deadline) + 1, 'second window passes');
  await submit('central_submit', sub('CS-d2', 'CT-4'), author);
  assert.equal((await record('central_submission/CS-d')).state, 'expired'); assert.equal((await record('central_task/CT-4')).pending, 'CS-d2');
  step('expiry: refused in the window, then by any member through BAINK, and implicitly by a new submission; task reopened, no reviewer fee');

  // 8. Both nodes agree, and the original pinned reader verifies the new records on both.
  const end = await height();
  await waitFor(async () => (await height(1)) >= end, 'second node catches up');
  const hashes = [];
  for (let h = activatedAt; h <= end; h++) {
    const [a, b] = await Promise.all([0, 1].map(async (i) => (await rpc(ports[i], 'block', { height: String(h) })).block.header.app_hash));
    assert.equal(a, b, `app hash differs at ${h}`); hashes.push(a);
  }
  const keys = ['central_evidence_activation', 'central_submission/CS-pre', 'central_submission/CS-pre-r', 'central_submission/CS-b', 'central_submission/CS-c', 'central_submission/CS-d', 'central_task/CT-1', 'central_task/CT-3', `central_review/CS-pre/${hash('reissue')}`];
  const verified = [];
  for (const [i, port] of ports.entries()) {
    const out = join(root, `verified-${i}.json`);
    await new Promise((ok, no) => { const c = spawn(stateReader, ['--genesis', join(homes[0], 'config/genesis.json'), '--genesis-sha256', hash(genesisBytes), '--rpc', `http://127.0.0.1:${port}`, '--out', out, '--max-age', '120s'], { stdio: ['pipe', 'pipe', 'pipe'] }); let log = ''; for (const st of [c.stdout, c.stderr]) st.on('data', (b) => { log += b; }); c.on('error', no); c.on('close', (code) => (code === 0 ? ok() : no(Error(log)))); c.stdin.end(JSON.stringify({ keys })); });
    const snap = JSON.parse(await readFile(out, 'utf8'));
    assert.deepEqual(snap.records.central_evidence_activation, activation);
    assert.equal(snap.records['central_submission/CS-pre'].state, 'superseded'); assert.equal(snap.records['central_submission/CS-c'].state, 'expired');
    verified.push({ node: i, height: snap.height, appHash: snap.app_hash });
  }
  step('both nodes: identical app hash every block from activation; pinned reader verifies the S6 records', { blocks: hashes.length, verified });

  // 9. Stopped swap, as on production: stop the second node, then the first; start both on the
  //    second daemon (0.4.2 in the mixed run) over the same homes; blocks resume and state is unchanged.
  if (daemonPins.primary !== daemonPins.second) {
    const before = {}; for (const key of keys) before[key] = await record(key);
    const stoppedAt = await height(); const t0 = Date.now();
    await stop(nodes[1]); await stop(nodes[0]);
    nodes = [start(homes[0], secondDaemon), start(homes[1], secondDaemon)];
    await waitFor(async () => (await height()) > stoppedAt + 2 && (await height(1)) > stoppedAt + 2, 'blocks after swap');
    const pausedMs = Date.now() - t0;
    for (const key of keys) assert.deepEqual(await record(key), before[key], key);
    const [a, b] = await Promise.all([0, 1].map(async (i) => (await rpc(ports[i], 'block', { height: String(stoppedAt + 2) })).block.header.app_hash));
    assert.equal(a, b);
    const info = await rpc(ports[0], 'abci_info');
    await submit('central_review', review('CS-c2', 'accept', 'after-swap'));
    assert.equal((await record('central_submission/CS-c2')).state, 'accepted');
    step('stopped swap of both nodes to the second daemon: same state, blocks resume, S6 records unchanged, a review settles after', { stoppedAt, pausedMs, version: info.response.version });
  }
  results.status = 'EVIDENCE_WINDOW_REHEARSAL_OK';
  console.log(JSON.stringify(results));
} finally {
  await native?.close?.();
  for (const c of [...running]) await stop(c);
  await rm(root, { recursive: true, force: true });
}
