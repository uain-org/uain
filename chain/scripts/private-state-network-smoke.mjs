#!/usr/bin/env node
// Disposable two-node acceptance only. Never enroll fixture identities or
// activate a policy on an existing node. All keys stay inside this process.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { signedEnvelope } from '../client/signing.mjs';
import { readPrivateState } from '../client/private-state.mjs';

const [daemonArgument, readerArgument] = process.argv.slice(2);
assert.ok(daemonArgument && readerArgument, 'linked fixture daemon and reader required');
const daemon = resolve(daemonArgument), reader = resolve(readerArgument);
const root = await mkdtemp(join(tmpdir(), 'uain-private-state-network-fixture-'));
const ports = [Number(process.env.UAIN_PRIVATE_STATE_SMOKE_PORT ?? 32657), Number(process.env.UAIN_PRIVATE_STATE_SMOKE_PORT ?? 32657) + 10];
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
const sender = identity('fictional-sender'), recipient = identity('fictional-recipient');
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
let sequence = 0;
async function submit(operation, payload) {
  const command = { version: 1, chain_id: 'uain-private-state-fixture-1', member: guardian.member.id, sequence: String(sequence), expires_height: '1000', operation, payload };
  const transaction = signedEnvelope(command, Buffer.from(guardian.member.public_key, 'base64url'), guardian.privateKey);
  const result = await rpc(ports[0], 'broadcast_tx_commit', { tx: Buffer.from(JSON.stringify(transaction)).toString('base64') });
  assert.equal(result.check_tx.code, 0, result.check_tx.log); assert.equal(result.tx_result.code, 0, result.tx_result.log); sequence++; return Number(result.height);
}
try {
  const applicationGenesis = join(root, 'app-genesis.json');
  await writeFile(applicationGenesis, JSON.stringify({ version: 1, guardians: [guardian.member.id], members: [guardian, relay, sender, recipient, reviewer].map(identity => identity.member) }), { mode: 0o600 });
  for (let i = 0; i < 2; i++) await run(['init', '--home', homes[i], '--chain-id', 'uain-private-state-fixture-1', '--app-genesis', applicationGenesis, '--rpc', `tcp://127.0.0.1:${ports[i]}`, '--p2p', `tcp://127.0.0.1:${ports[i] - 1}`]);
  const genesisFile = join(homes[0], 'config/genesis.json'); const genesis = await readFile(genesisFile);
  await writeFile(join(homes[1], 'config/genesis.json'), genesis);
  const nodeID = (await run(['node-id', '--home', homes[0]])).split(/\r?\n/).find(line => /^[0-9a-f]{40}$/.test(line)); assert.ok(nodeID);
  const configuration = join(homes[1], 'config/config.toml'); let text = await readFile(configuration, 'utf8');
  text = text.replace(/^persistent_peers = .*$/m, `persistent_peers = "${nodeID}@127.0.0.1:${ports[0] - 1}"`).replace(/^addr_book_strict = .*$/m, 'addr_book_strict = false').replace(/^allow_duplicate_ip = .*$/m, 'allow_duplicate_ip = true'); await writeFile(configuration, text);
  let primary = start(homes[0]), fullnode = start(homes[1]);
  await waitFor(async () => Number((await rpc(ports[0], 'status')).sync_info.latest_block_height) >= 3, primary);
  const digest = createHash('sha256'); for await (const bytes of createReadStream(reader)) digest.update(bytes);
  const options = { executable: reader, executableSha256: digest.digest('hex'), genesis: genesisFile, genesisSha256: createHash('sha256').update(genesis).digest('hex'), request: { reviewer: reviewer.member.id, parties: [sender.member.id, recipient.member.id] }, maxAgeSeconds: 120 };
  const read = port => readPrivateState({ ...options, rpc: `http://127.0.0.1:${port}` });
  await assert.rejects(read(ports[0]), /finalized private state refused/); // genuine inactive-policy proof
  const evidence = '28'.repeat(32);
  const compact = await submit('activate_storage', { policy: 'compact-state-v1', evidence_digest: evidence });
  await waitFor(async () => Number((await rpc(ports[0], 'status')).sync_info.latest_block_height) > compact + 1, primary);
  await submit('activate_private_exchange', { policy: 'orchard-v2-reviewed-otc-v1', evidence_digest: evidence, relayer: relay.member.id });
  const appointment = await submit('private_reviewer', { member: reviewer.member.id, active: true, evidence_digest: evidence });
  await waitFor(async () => Number((await rpc(ports[1], 'status')).sync_info.latest_block_height) > appointment + 1, fullnode);
  const first = await read(ports[0]), second = await read(ports[1]);
  for (const state of [first, second]) { assert.equal(state.count, '0'); assert.deepEqual(state.commitments, []); assert.equal(state.relayer.member, relay.member.id); assert.equal(state.reviewer.karma, 100); assert.equal(state.licence_revision, '0'); }
  assert.equal(first.root, second.root);
  // Real daemon restart preserves the policy and keys; no funded note or Coin mint.
  await stop(fullnode); await stop(primary); primary = start(homes[0]); fullnode = start(homes[1]);
  await waitFor(async () => Number((await rpc(ports[1], 'status')).sync_info.latest_block_height) > appointment + 3, fullnode);
  const resumed = await read(ports[1]); assert.equal(resumed.root, first.root); assert.equal(resumed.count, '0');
  const readPolicy = port => readPrivateState({ ...options, rpc: `http://127.0.0.1:${port}`, request: { policy_only:true, reviewer:reviewer.member.id } });
  for (const port of ports) {
    const policy=await readPolicy(port);
    assert.equal(policy.policy_only,true); assert.equal(policy.witness_complete,false);
    assert.deepEqual(policy.parties,[]); assert.deepEqual(policy.commitments,[]); assert.equal(policy.root,first.root);
    assert.match(policy.relayer.sequence,/^(0|[1-9][0-9]*)$/);
    await assert.rejects(readPrivateState({ ...options, rpc:`http://127.0.0.1:${port}`, request:{policy_only:true,reviewer:reviewer.member.id,parties:[sender.member.id,recipient.member.id]} }),/distinct members/);
  }
  const revoked = await submit('private_reviewer', { member: reviewer.member.id, active: false, evidence_digest: evidence });
  await waitFor(async () => Number((await rpc(ports[1], 'status')).sync_info.latest_block_height) > revoked + 1, fullnode);
  await assert.rejects(read(ports[0]), /active proven reviewer appointment/);
  await assert.rejects(read(ports[1]), /active proven reviewer appointment/);
  await assert.rejects(readPolicy(ports[0]), /active proven reviewer appointment/);
  await assert.rejects(readPolicy(ports[1]), /active proven reviewer appointment/);
  console.log(JSON.stringify({ pass: true, fixture_only: true, real_two_nodes: true, pinned_genesis_sha256: options.genesisSha256, reader_sha256: options.executableSha256, empty_pool_root: first.root, notes: '0', inactive_policy_refused: true, appointed_reviewer_verified: true, public_policy_without_trading_identities:true, policy_revocation_refused:true, replica_root_matches: true, restart_preserved: true, revoked_reviewer_refused_on_both: true, production_activated: false, coin_mint: false, fixture_directory: root }, null, 2));
} catch (error) {
  for (let i = 0; i < started.length; i++) await writeFile(join(root, `daemon-${i}.log`), started[i].diagnostics()).catch(() => {});
  console.error(error); console.error(`Disposable fixture diagnostics: ${root}`); process.exitCode = 1;
} finally { for (const child of [...running]) await stop(child).catch(error => { console.error(error.message); process.exitCode = 1; }); }
