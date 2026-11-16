#!/usr/bin/env node
// Disposable two-node acceptance only. Never enroll fixture identities or
// activate a policy on an existing node. All keys stay inside this process.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { signedEnvelope } from '../client/signing.mjs';

const [daemonArgument, proofArgument] = process.argv.slice(2);
assert.ok(daemonArgument && proofArgument, 'linked fixture daemon and public proof verifier required');
const daemon = resolve(daemonArgument), verifier = resolve(proofArgument);
const root = await mkdtemp(join(tmpdir(), 'uain-coin-network-fixture-'));
const ports = [Number(process.env.UAIN_COIN_SMOKE_PORT ?? 33657), Number(process.env.UAIN_COIN_SMOKE_PORT ?? 33657) + 10];
assert.ok(ports.every(port => Number.isInteger(port) && port > 1024 && port < 65535));
const homes = [join(root, 'one'), join(root, 'two')];
const running = new Set(), started = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function identity(name, karma = 0) {
  const keys = generateKeyPairSync('ed25519');
  const raw = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { ...keys, member: { id: `uain1${createHash('sha256').update(raw).digest('hex').slice(0, 40)}`, public_key: raw.toString('base64url'), name, operator: name, family: name, licence: 'active', karma, credits: '0', sequence: '0', default_verifier: false, creator: false, active_projects: 0 } };
}
const guardian = identity('fictional-guardian'), relay = identity('fictional-relay');
const sender = identity('fictional-sender', 1000), recipient = identity('fictional-recipient', 100);
sender.member.creator = true; guardian.member.default_verifier = true;
const reviewer = identity('fictional-reviewer', 100);
async function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(daemon, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
    child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(output)));
  });
}
function start(home) {
  const child = spawn(daemon, ['start', '--home', home], { stdio: ['ignore', 'pipe', 'pipe'] }); let log = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log = (log + bytes).slice(-16000); });
  child.diagnostics = () => log; running.add(child); started.push(child); child.once('exit', () => running.delete(child)); return child;
}
async function stop(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('fixture node did not stop cleanly')); }, 15000);
    child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
  });
}
async function rpc(port, method, params = {}) {
  const response = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(method === 'broadcast_tx_commit' ? 15000 : 3000) });
  const data = await response.json(); if (data.error) throw new Error(JSON.stringify(data.error)); return data.result;
}
async function waitFor(fn, child) {
  let last;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(child.diagnostics());
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await pause(500);
  }
  throw new Error(`fixture wait failed: ${last?.message}\n${child.diagnostics()}`);
}
const sequences = new Map();
async function submit(operation, payload, actor = guardian, expected = true) {
  const sequence = sequences.get(actor.member.id) ?? 0;
  const command = { version: 1, chain_id: 'uain-coin-fixture-1', member: actor.member.id, sequence: String(sequence), expires_height: '1000', operation, payload };
  const transaction = signedEnvelope(command, Buffer.from(actor.member.public_key, 'base64url'), actor.privateKey);
  const result = await rpc(ports[0], expected ? 'broadcast_tx_commit' : 'broadcast_tx_sync', { tx: Buffer.from(JSON.stringify(transaction)).toString('base64') });
  if (!expected) { assert.notEqual(result.code, 0, `${operation} incorrectly accepted`); return; }
  assert.equal(result.check_tx.code, 0, result.check_tx.log); assert.equal(result.tx_result.code, 0, result.tx_result.log);
  sequences.set(actor.member.id, sequence + 1); return Number(result.height);
}
async function record(port, key, height = '0', prove = false) {
  const response = (await rpc(port, 'abci_query', { path: '/store/federation/key', data: Buffer.from(key).toString('hex'), height: String(height), prove })).response;
  assert.equal(response.code, 0); return response;
}
async function verifyPublic(genesisFile, bundleFile, key) {
  return new Promise((resolve, reject) => {
    const child = spawn(verifier, ['--genesis', genesisFile, '--bundle', bundleFile, '--key', key], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output += bytes; });
    child.once('error', reject); child.once('close', code => code === 0 && output.includes('STATE_PROOF_VERIFIED') ? resolve() : reject(new Error(output)));
  });
}
try {
  const applicationGenesis = join(root, 'app-genesis.json');
  await writeFile(applicationGenesis, JSON.stringify({ version: 1, guardians: [guardian.member.id], members: [guardian, relay, sender, recipient, reviewer].map(identity => identity.member) }), { mode: 0o600 });
  for (let i = 0; i < 2; i++) await run(['init', '--home', homes[i], '--chain-id', 'uain-coin-fixture-1', '--app-genesis', applicationGenesis, '--rpc', `tcp://127.0.0.1:${ports[i]}`, '--p2p', `tcp://127.0.0.1:${ports[i] - 1}`]);
  const genesisFile = join(homes[0], 'config/genesis.json'); const genesis = await readFile(genesisFile);
  await writeFile(join(homes[1], 'config/genesis.json'), genesis);
  const nodeID = (await run(['node-id', '--home', homes[0]])).split(/\r?\n/).find(line => /^[0-9a-f]{40}$/.test(line)); assert.ok(nodeID);
  const configuration = join(homes[1], 'config/config.toml'); let text = await readFile(configuration, 'utf8');
  text = text.replace(/^persistent_peers = .*$/m, `persistent_peers = "${nodeID}@127.0.0.1:${ports[0] - 1}"`).replace(/^addr_book_strict = .*$/m, 'addr_book_strict = false').replace(/^allow_duplicate_ip = .*$/m, 'allow_duplicate_ip = true'); await writeFile(configuration, text);
  let primary = start(homes[0]), fullnode = start(homes[1]);
  await waitFor(async () => Number((await rpc(ports[0], 'status')).sync_info.latest_block_height) >= 3, primary);
  const evidence = '28'.repeat(32);
  const compact = await submit('activate_storage', { policy: 'compact-state-v1', evidence_digest: evidence });
  await waitFor(async () => Number((await rpc(ports[0], 'status')).sync_info.latest_block_height) > compact + 1, primary);
  await submit('activate_membership', { policy: 'project-membership-v1', evidence_digest: evidence });
  await submit('activate_operator_rewards', { policy: 'pairwise-operator-rewards-v1', evidence_digest: evidence });
  await submit('activate_private_exchange', { policy: 'orchard-v2-reviewed-otc-v1', evidence_digest: evidence, relayer: relay.member.id });
  for (const [i, actor] of [sender, recipient, guardian].entries()) {
    await submit('identity_claim', {}, actor);
    await submit('operator_claim', { domain: `coin-${i}.example` }, actor);
    const claim = JSON.parse(Buffer.from((await record(ports[0], `operator_claim/${actor.member.id}/`)).value, 'base64'));
    await submit('operator_attest', { member: actor.member.id, domain: claim.domain, claim_event_id: claim.event_id, txt: `uain-operator=${claim.did}`, checked_at: new Date().toISOString(), evidence_digest: evidence });
  }
  const activation = await submit('activate_coin', { policy: 'verified-bounties-108t-micro-v1', evidence_digest: evidence });
  await waitFor(async () => Number((await rpc(ports[0], 'status')).sync_info.latest_block_height) > activation + 1, primary);
  const priorArt = { basis: 'No discoverable answer exists for this fictional disposable qualification problem.', searches: ['first fictional prior-art search', 'second fictional prior-art search'] };
  await submit('open_project', { id: 'P-coin', title: 'Fictional native Coin qualification', class: 'benevolent', prior_art: priorArt }, sender);
  for (const actor of [recipient, guardian]) await submit('project_join', { project: 'P-coin' }, actor);
  await submit('open_task', { id: 'T-coin', project: 'P-coin', title: 'Fictional prospective native bounty', class: 'benevolent', prior_art: priorArt, criteria: 'Check the fictional result independently and confirm its previously unknown answer.', kind: 'instant', karma_reward: 13, credit_reward: '13', verifiers_required: 2 }, sender);
  const openEvent = JSON.parse(Buffer.from((await record(ports[0], 'event_count')).value, 'base64'));
  await submit('coin_quote', { task: 'T-coin', open_event: String(openEvent).padStart(20, '0'), amount: '5000000', evidence_digest: evidence }, sender);
  await submit('coin_reserve', { task: 'T-coin', evidence_digest: evidence });
  await submit('submit', { id: 'RC-coin', task: 'T-coin', evidence_digest: evidence }, sender);
  await submit('coin_claim', { contribution: 'RC-coin' }, sender, false);
  const check = { contribution: 'RC-coin', verdict: 'confirm', novelty: 'new', searches: priorArt.searches, evidence_digest: evidence };
  await submit('verify', check, recipient); await submit('verify', check);
  const claimHeight = await submit('coin_claim', { contribution: 'RC-coin' }, sender);
  const keys = ['coin_activation', 'coin_supply', `coin_balance/${sender.member.id}`, 'coin_quote/T-coin', 'coin_reservation/T-coin', 'coin_reward/RC-coin'];
  await waitFor(async () => Number((await rpc(ports[1], 'status')).sync_info.latest_block_height) > claimHeight + 2, fullnode);
  const height = claimHeight + 1;
  const values = new Map(); const proofChecks = [];
  for (const port of ports) {
    const commit = await rpc(port, 'commit', { height: String(height + 1) });
    for (const [i, key] of keys.entries()) {
      const query = await record(port, key, height, true);
      if (values.has(key)) assert.equal(query.value, values.get(key)); else values.set(key, query.value);
      const file = join(root, `proof-${port}-${i}.json`);
      await writeFile(file, JSON.stringify({ signed_header: commit.signed_header, query }));
      await verifyPublic(genesisFile, file, key); proofChecks.push({ port, key, verified: true });
    }
  }
  assert.deepEqual(JSON.parse(Buffer.from(values.get('coin_supply'), 'base64')), { minted: '5000000', reserved: '0', transparent: '5000000', shielded: '0' });
  assert.equal(JSON.parse(Buffer.from(values.get(`coin_balance/${sender.member.id}`), 'base64')), '5000000');
  await submit('coin_claim', { contribution: 'RC-coin' }, sender, false);
  await stop(fullnode); await stop(primary); primary = start(homes[0]); fullnode = start(homes[1]);
  await waitFor(async () => Number((await rpc(ports[1], 'status')).sync_info.latest_block_height) > height + 3, fullnode);
  for (const port of ports) for (const key of keys) assert.equal((await record(port, key)).value, values.get(key));
  await submit('coin_claim', { contribution: 'RC-coin' }, sender, false);
  const receipt = { pass: true, fixture_only: true, real_two_nodes: true, chain_id: 'uain-coin-fixture-1', pinned_genesis_sha256: createHash('sha256').update(genesis).digest('hex'), prospective_signed_bounty_issuance: true, minted_units: '5000000', cap_units: '108000000000000000000', private_pool_units: '0', early_claim_refused: true, replay_refused_before_and_after_restart: true, restart_preserved: true, independent_state_proofs: proofChecks, production_activated: false, production_coin_mint: false, fixture_directory: root };
  await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));

} catch (error) {
  for (let i = 0; i < started.length; i++) await writeFile(join(root, `daemon-${i}.log`), started[i].diagnostics()).catch(() => {});
  console.error(error); console.error(`Disposable fixture diagnostics: ${root}`); process.exitCode = 1;
} finally { for (const child of [...running]) await stop(child).catch(error => { console.error(error.message); process.exitCode = 1; }); }
