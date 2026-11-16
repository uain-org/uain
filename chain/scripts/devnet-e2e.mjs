#!/usr/bin/env node
// Disposable four-validator devnet acceptance (9 November 2026). Only
// fictional fixture keys are used; nothing here touches a live node.
//
//   node scripts/devnet-e2e.mjs <orchard uaind> <uain-state> <uain-private-state> <uain-coin-wallet> <uain-private-wallet>
//
// It checks, end to end on a real CometBFT network:
//   1. a generation-2 genesis with four validators and a 2-of-3 guardian quorum;
//   2. one guardian alone is refused, a second approval executes the action;
//   3. with one validator stopped, an AI$ award (coin_claim) and a private AI$
//      payment (shield, private_payment, exit) still finalize;
//   4. a guardian-quorum validator rotation (add a fifth key, retire the first),
//      after which the retired validator can stop without halting the chain;
//   5. the state reader, given only the original genesis pin, follows the signed
//      rotation and verifies state signed by the new set.
// Four validators, not three: with three equal validators one down leaves
// exactly two thirds, and CometBFT needs more than two thirds (3f+1, f=1).
//
// UAIN_DEVNET_ISOLATE=systemd runs each node in its own transient systemd
// scope (separate cgroup with memory and CPU limits) on the test host.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exerciseCoinWalletFlow } from './coin-wallet-flow.mjs';
import { fixturePrivateAction as runPrivateAction } from './private-client-process.mjs';
import { signedEnvelope } from '../client/signing.mjs';

const [daemonArg, stateArg, privateStateArg, coinWalletArg, privateWalletArg] = process.argv.slice(2);
assert.ok(daemonArg && stateArg && privateStateArg && coinWalletArg && privateWalletArg, 'usage: devnet-e2e.mjs <uaind> <uain-state> <uain-private-state> <uain-coin-wallet> <uain-private-wallet>');
const daemon = resolve(daemonArg), stateReader = resolve(stateArg), privateReader = resolve(privateStateArg);
const CHAIN = 'uain-devnet-e2e-1';
const root = await mkdtemp(join(tmpdir(), 'uain-devnet-e2e-'));
const base = Number(process.env.UAIN_DEVNET_PORT ?? 36657);
const ports = [0, 1, 2, 3, 4].map(i => base + 10 * i);
const homes = ports.map((_, i) => join(root, `val-${i + 1}`));
const isolate = process.env.UAIN_DEVNET_ISOLATE === 'systemd';
const runId = createHash('sha256').update(root).digest('hex').slice(0, 8);
const running = new Map();
const pause = ms => new Promise(r => setTimeout(r, ms));
const evidence = 'a'.repeat(64);
const steps = [];
const step = (name, detail = {}) => { steps.push({ name, at: new Date().toISOString(), ...detail }); console.error('STEP', name, JSON.stringify(detail)); };

function identity(name, karma = 0) {
  const keys = generateKeyPairSync('ed25519');
  const raw = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { ...keys, member: { id: `uain1${createHash('sha256').update(raw).digest('hex').slice(0, 40)}`, public_key: raw.toString('base64url'), name, operator: name, family: name, licence: 'active', karma, credits: '0', sequence: '0', default_verifier: false, creator: false, active_projects: 0 } };
}
const guardians = [identity('fictional-guardian-1', 100), identity('fictional-guardian-2', 100), identity('fictional-guardian-3', 100)];
guardians[0].member.default_verifier = true;
const relay = identity('fictional-relay'), sender = identity('fictional-sender', 1000), recipient = identity('fictional-recipient', 100), reviewer = identity('fictional-reviewer', 100), applicant = identity('fictional-applicant');
sender.member.creator = true; applicant.member.licence = 'pending';

function run(args) {
  return new Promise((ok, fail) => {
    const child = spawn(daemon, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '';
    child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { out += b; });
    child.once('error', fail); child.once('close', code => code === 0 ? ok(out.trim()) : fail(new Error(out)));
  });
}
function start(i) {
  const args = ['start', '--home', homes[i]];
  const child = isolate
    ? spawn('systemd-run', ['--quiet', '--scope', `--unit=uain-devnet-${runId}-val-${i + 1}-${Date.now()}`, '-p', 'MemoryMax=1G', '-p', 'CPUQuota=100%', daemon, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(daemon, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  for (const s of [child.stdout, child.stderr]) s.on('data', b => { log = (log + b).slice(-20000); });
  child.diagnostics = () => log; running.set(i, child); child.once('exit', () => { if (running.get(i) === child) running.delete(i); });
  return child;
}
async function stop(i) {
  const child = running.get(i); if (!child || child.exitCode !== null) return;
  await new Promise((ok, fail) => { const t = setTimeout(() => { child.kill('SIGKILL'); fail(new Error(`val-${i + 1} did not stop`)); }, 20000); child.once('exit', () => { clearTimeout(t); ok(); }); child.kill('SIGTERM'); });
  running.delete(i);
}
async function rpc(port, method, params = {}) {
  const r = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(method.startsWith('broadcast_tx_') ? 30000 : 4000) });
  const data = await r.json(); if (data.error) throw new Error(JSON.stringify(data.error)); return data.result;
}
const height = async port => Number((await rpc(port, 'status')).sync_info.latest_block_height);
async function waitFor(fn, label, tries = 160) {
  let last;
  for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await pause(500); }
  const logs = [...running.entries()].map(([i, c]) => `--- val-${i + 1}\n${c.diagnostics().slice(-3000)}`).join('\n');
  throw new Error(`${label}: ${last?.message ?? 'timeout'}\n${logs}`);
}
const primary = () => ports[[...running.keys()].sort()[0]];
async function record(port, key, h = '0', prove = false) {
  const r = (await rpc(port, 'abci_query', { path: '/store/federation/key', data: Buffer.from(key).toString('hex'), height: String(h), prove })).response;
  assert.equal(r.code, 0); return r;
}
const json = r => r.value ? JSON.parse(Buffer.from(r.value, 'base64')) : null;

const sequences = new Map();
let privateClientReader;
async function submit(operation, payload, actor, expected = true, prepared) {
  const sequence = sequences.get(actor.member.id) ?? 0;
  const command = { version: 1, chain_id: CHAIN, member: actor.member.id, sequence: String(sequence), expires_height: payload.approval?.expires_height ?? '10000', operation, payload };
  if (prepared) assert.deepEqual(prepared.command, command);
  const tx = prepared ?? signedEnvelope(command, Buffer.from(actor.member.public_key, 'base64url'), actor.privateKey);
  let result;
  if (prepared && expected) {
    const envelopeFile = join(root, `${operation}-${sequence}-submission.json`), journalFile = envelopeFile + '.journal';
    await writeFile(envelopeFile, JSON.stringify(prepared), { mode: 0o600, flag: 'wx' });
    const ack = await runPrivateAction('submit', { reader: privateClientReader, broadcast: { rpc: `http://127.0.0.1:${primary()}` }, envelopeFile, out: journalFile });
    assert.equal(ack.status, 'submitted');
    const confirmed = await waitFor(async () => { const s = await runPrivateAction('status', { reader: privateClientReader, journalFile }); return s.status === 'recorded' ? s : null; }, operation);
    assert.equal(confirmed.state_proof_verified, true);
    result = { check_tx: { code: 0 }, tx_result: { code: 0 }, height: confirmed.height };
  } else result = await rpc(primary(), expected ? 'broadcast_tx_commit' : 'broadcast_tx_sync', { tx: Buffer.from(JSON.stringify(tx)).toString('base64') });
  if (!expected) { assert.notEqual(result.code, 0, `${operation} incorrectly accepted`); return; }
  assert.equal(result.check_tx.code, 0, `${operation} CheckTx: ${result.check_tx.log}`);
  assert.equal(result.tx_result.code, 0, `${operation}: ${result.tx_result.log}`);
  sequences.set(actor.member.id, sequence + 1);
  if (['coin_shield', 'coin_exit', 'private_payment'].includes(operation)) await waitFor(async () => (await height(primary())) > Number(result.height) + 1, 'settle');
  return Number(result.height);
}
// Every guardian-gated operation goes through the 2-of-3 quorum: guardian
// `by[0]` proposes, `by[1]` approves, and the approval executes it.
let actionCount = 0;
async function quorum(operation, payload, by = [0, 1]) {
  const id = `act-${++actionCount}`;
  const h = await height(primary());
  await submit('guardian_action_propose', { id, operation, payload, expires_height: h + 600, evidence_digest: evidence }, guardians[by[0]]);
  const done = await submit('guardian_action_approve', { id, evidence_digest: evidence }, guardians[by[1]]);
  const action = json(await record(primary(), `guardian_action/${id}`));
  assert.equal(action.executed, String(done), `${operation} not executed by the quorum`);
  // Proof readers verify state at header height - 1: wait until it is provable.
  await waitFor(async () => (await height(primary())) > done + 1, `${operation} provable`);
  return done;
}

let exitCode = 0;
try {
  // 1. Keys, ceremony genesis, joins.
  const identities = [];
  for (let i = 0; i < 5; i++) identities.push(JSON.parse((await run(['keys', '--home', homes[i], '--moniker', `val-${i + 1}`])).split(/\r?\n/).find(line => line.startsWith('{'))));
  const appGenesis = join(root, 'app-genesis.json');
  await writeFile(appGenesis, JSON.stringify({ version: 1, generation: 2, guardians: guardians.map(g => g.member.id), guardian_threshold: 2, members: [...guardians, relay, sender, recipient, reviewer, applicant].map(x => x.member) }));
  const validatorsFile = join(root, 'validators.json');
  await writeFile(validatorsFile, JSON.stringify(identities.slice(0, 4).map(v => ({ name: v.name, pub_key: v.pub_key, power: 10 }))));
  const genesisFile = join(root, 'genesis.json');
  await run(['genesis', '--chain-id', CHAIN, '--app-genesis', appGenesis, '--validators', validatorsFile, '--out', genesisFile]);
  const genesisBytes = await readFile(genesisFile); const genesisSha256 = createHash('sha256').update(genesisBytes).digest('hex');
  for (let i = 0; i < 5; i++) {
    const peers = identities.map((v, j) => j === i ? null : `${v.node_id}@127.0.0.1:${ports[j] - 1}`).filter(Boolean).join(',');
    await run(['join', '--home', homes[i], '--genesis', genesisFile, '--moniker', `val-${i + 1}`, '--peers', peers, '--rpc', `tcp://127.0.0.1:${ports[i]}`, '--p2p', `tcp://127.0.0.1:${ports[i] - 1}`]);
  }
  for (let i = 0; i < 4; i++) start(i);
  await waitFor(async () => (await height(ports[0])) >= 3 && (await height(ports[3])) >= 3, 'four validators produce blocks');
  const status = await rpc(ports[0], 'validators', { height: '2' });
  assert.equal(Number(status.total), 4);
  step('four-validator-genesis', { chain: CHAIN, genesis_sha256: genesisSha256, validators: identities.slice(0, 4).map(v => v.address), isolation: isolate ? 'systemd-scope' : 'process' });

  // 2. One of three refused; two of three executes.
  const licence = { member: applicant.member.id, status: 'active', evidence_digest: evidence };
  await submit('licence', licence, guardians[0], false);
  let h = await height(ports[0]);
  await submit('guardian_action_propose', { id: 'licence-1', operation: 'licence', payload: licence, expires_height: h + 600, evidence_digest: evidence }, guardians[0]);
  assert.equal(json(await record(ports[0], 'guardian_action/licence-1')).executed, '0');
  assert.equal(json(await record(ports[0], `member/${applicant.member.id}`)).licence, 'pending');
  await submit('guardian_action_approve', { id: 'licence-1', evidence_digest: evidence }, guardians[0], false);
  await submit('guardian_action_approve', { id: 'licence-1', evidence_digest: evidence }, guardians[2]);
  assert.equal(json(await record(ports[0], `member/${applicant.member.id}`)).licence, 'active');
  step('guardian-quorum', { one_of_three_direct: 'refused', one_of_three_proposal: 'not executed', duplicate_approval: 'refused', two_of_three: 'executed' });

  // Policy activations, all through the quorum.
  let act = await quorum('activate_storage', { policy: 'compact-state-v1', evidence_digest: evidence });
  await waitFor(async () => (await height(ports[0])) > act + 1, 'storage activation');
  await quorum('activate_membership', { policy: 'project-membership-v1', evidence_digest: evidence });
  await quorum('activate_operator_rewards', { policy: 'pairwise-operator-rewards-v1', evidence_digest: evidence });
  await quorum('activate_private_exchange', { policy: 'orchard-v2-reviewed-otc-v1', relayer: relay.member.id, evidence_digest: evidence });
  for (const [i, actor] of [sender, recipient, guardians[0]].entries()) {
    await submit('identity_claim', {}, actor); await submit('operator_claim', { domain: `devnet-${i}.example` }, actor);
    const claim = json(await record(ports[0], `operator_claim/${actor.member.id}/`));
    await quorum('operator_attest', { member: actor.member.id, domain: claim.domain, claim_event_id: claim.event_id, txt: `uain-operator=${claim.did}`, checked_at: new Date().toISOString(), evidence_digest: evidence });
  }
  act = await quorum('activate_coin', { policy: 'verified-bounties-108t-micro-v1', evidence_digest: evidence });
  await waitFor(async () => (await height(ports[0])) > act + 1, 'coin activation');
  step('policies-activated-by-quorum');

  // 3. Stop one validator; award and payment still finalize.
  await stop(3);
  const downAt = await height(ports[0]);
  await waitFor(async () => (await height(ports[0])) > downAt + 2, 'blocks with val-4 down');
  step('validator-down', { stopped: 'val-4', height: downAt });
  const priorArt = { basis: 'No discoverable answer exists for this fictional isolated devnet qualification.', searches: ['first fictional prior-art search', 'second fictional prior-art search'] };
  await submit('open_project', { id: 'P-devnet', title: 'Fictional devnet Coin qualification', class: 'benevolent', prior_art: priorArt }, sender);
  for (const actor of [recipient, guardians[0]]) await submit('project_join', { project: 'P-devnet' }, actor);
  await submit('open_task', { id: 'T-devnet', project: 'P-devnet', title: 'Fictional prospective native bounty', class: 'benevolent', prior_art: priorArt, criteria: 'Check the fictional result independently and confirm its previously unknown answer.', kind: 'instant', karma_reward: 13, credit_reward: '13', verifiers_required: 2 }, sender);
  const openEvent = json(await record(ports[0], 'event_count'));
  await submit('coin_quote', { task: 'T-devnet', open_event: String(openEvent).padStart(20, '0'), amount: '5000000', evidence_digest: evidence }, sender);
  await submit('coin_reserve', { task: 'T-devnet', evidence_digest: evidence }, guardians[0], false);
  await quorum('coin_reserve', { task: 'T-devnet', evidence_digest: evidence }, [1, 2]);
  await submit('submit', { id: 'RC-devnet', task: 'T-devnet', evidence_digest: evidence }, sender);
  const check = { contribution: 'RC-devnet', verdict: 'confirm', novelty: 'new', searches: priorArt.searches, evidence_digest: evidence };
  await submit('verify', check, recipient); await submit('verify', check, guardians[0]);
  const awardHeight = await submit('coin_claim', { contribution: 'RC-devnet' }, sender);
  assert.equal(json(await record(ports[0], `coin_balance/${sender.member.id}`)), '5000000');
  step('award-with-validator-down', { operation: 'coin_claim', height: awardHeight, minted: '5000000' });

  await quorum('private_reviewer', { member: reviewer.member.id, active: true, evidence_digest: evidence });
  const reader = { executable: privateReader, executableSha256: createHash('sha256').update(await readFile(privateReader)).digest('hex'), genesis: genesisFile, genesisSha256, rpc: `http://127.0.0.1:${ports[0]}`, maxAgeSeconds: 120 };
  privateClientReader = reader;
  const flow = await exerciseCoinWalletFlow({ root, reader, coinWallet: resolve(coinWalletArg), privateWallet: resolve(privateWalletArg), sender, recipient, reviewer, relay, submit });
  const supply = json(await record(ports[0], 'coin_supply'));
  assert.equal(supply.minted, '5000000');
  step('payment-with-validator-down', { operations: ['coin_shield', 'private_payment', 'coin_exit'], records: flow.proven_records.length, supply });

  // val-4 returns and catches up.
  start(3);
  const back = await height(ports[0]);
  await waitFor(async () => (await height(ports[3])) >= back, 'val-4 catch-up');
  step('validator-restarted', { caught_up_to: back });

  // 4. Rotation: val-5 (synced as a full node) replaces val-1.
  start(4);
  await waitFor(async () => (await height(ports[4])) >= back, 'val-5 sync');
  const rotation = { updates: [{ pub_key: identities[0].pub_key, power: '0' }, { pub_key: identities[4].pub_key, power: '10', name: 'val-5' }], evidence_digest: evidence };
  await submit('validator_set_update', rotation, guardians[0], false);
  const rotated = await quorum('validator_set_update', rotation, [2, 0]);
  await waitFor(async () => { const v = await rpc(ports[1], 'validators', { height: String(rotated + 2) }); const a = v.validators.map(x => x.address); return a.includes(identities[4].address) && !a.includes(identities[0].address); }, 'rotation effective');
  const epoch = json(await record(ports[1], 'validator_epoch/00000000000000000001'));
  assert.equal(epoch.header_height, String(rotated + 1));
  await stop(0);
  const afterRetire = await height(ports[1]);
  await waitFor(async () => (await height(ports[1])) > afterRetire + 3, 'chain continues without the retired validator');
  step('validator-rotation', { executed_height: rotated, transition_header: epoch.header_height, retired: identities[0].address, added: identities[4].address });

  // 5. A reader holding only the original genesis pin follows the rotation.
  const out = join(root, 'post-rotation-snapshot.json');
  const keys = ['coin_supply', `coin_balance/${sender.member.id}`, 'validator_epoch_count', 'guardian_action/licence-1'];
  await new Promise((ok, fail) => {
    const child = spawn(stateReader, ['--genesis', genesisFile, '--genesis-sha256', genesisSha256, '--rpc', `http://127.0.0.1:${ports[1]}`, '--out', out, '--max-age', '120s'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let log = ''; for (const s of [child.stdout, child.stderr]) s.on('data', b => { log += b; });
    child.on('error', fail); child.on('close', code => code === 0 ? ok() : fail(new Error(log))); child.stdin.end(JSON.stringify({ keys }));
  });
  const snapshot = JSON.parse(await readFile(out, 'utf8'));
  assert.ok(snapshot.height > rotated + 2, 'snapshot predates the rotation');
  assert.equal(snapshot.records[`coin_balance/${sender.member.id}`] !== undefined, true);
  assert.equal(snapshot.records.validator_epoch_count, 1);
  step('reader-follows-rotation', { height: snapshot.height, app_hash: snapshot.app_hash });

  const receipt = { status: 'DEVNET_E2E_OK', fixture: true, chain: CHAIN, genesis_sha256: genesisSha256, validators_initial: 4, validators_final: identities.slice(1, 5).map(v => v.address), guardian_threshold: '2-of-3', steps };
  await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  console.error(error); console.error(`Disposable devnet diagnostics: ${root}`); exitCode = 1;
  await mkdir(join(root, 'logs'), { recursive: true }).catch(() => {});
  for (const [i, c] of running) await writeFile(join(root, 'logs', `val-${i + 1}.log`), c.diagnostics()).catch(() => {});
} finally {
  for (const i of [...running.keys()]) await stop(i).catch(e => { console.error(e.message); exitCode = 1; });
  process.exitCode = exitCode;
}
