#!/usr/bin/env node
// Disposable two-node check of uain-rollback (fictional keys only).
// A validator on the current uaind and a follower on an older uaind see the
// first new consensus operation; the follower halts with a wrong app hash
// (as baink-public-relay did on 9 November 2026 at block 1412544). Then the
// follower is stopped, rolled back one height with uain-rollback, restarted
// on the current uaind, and must re-execute that block and catch up with the
// validator's app hash.
//
//   node scripts/rollback-e2e.mjs <current uaind> <older uaind> <uain-rollback>
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { signedEnvelope } from '../client/signing.mjs';

const [current, older, rollback] = process.argv.slice(2).map(p => resolve(p));
assert.ok(current && older && rollback, 'usage: rollback-e2e.mjs <current uaind> <older uaind> <uain-rollback>');
const root = await mkdtemp(join(tmpdir(), 'uain-rollback-e2e-'));
const base = Number(process.env.UAIN_ROLLBACK_PORT ?? 38657);
const ports = [base, base + 10];
const homes = [join(root, 'validator'), join(root, 'follower')];
const env = { ...process.env, UAIN_ALLOW_NON_ORCHARD: '1' };
const pause = ms => new Promise(r => setTimeout(r, ms));
const running = new Map();
function start(i, binary) {
  const child = spawn(binary, ['start', '--home', homes[i]], { stdio: ['ignore', 'pipe', 'pipe'], env });
  let log = '';
  for (const s of [child.stdout, child.stderr]) s.on('data', b => { log = (log + b).slice(-30000); });
  child.log = () => log;
  running.set(i, child);
  return child;
}
async function stop(i) {
  const c = running.get(i);
  if (!c || c.exitCode !== null) return;
  await new Promise(ok => { c.once('exit', ok); c.kill('SIGTERM'); });
}
async function rpc(port, method, params = {}) {
  const r = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) });
  const d = await r.json(); if (d.error) throw new Error(JSON.stringify(d.error)); return d.result;
}
const height = async p => Number((await rpc(p, 'status')).sync_info.latest_block_height);
async function waitFor(fn, label, tries = 120) {
  let last;
  for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await pause(500); }
  throw new Error(`${label}: ${last?.message ?? 'timeout'}\n${[...running.values()].map(c => c.log().slice(-2000)).join('\n---\n')}`);
}
function identity(name) {
  const k = generateKeyPairSync('ed25519');
  const raw = k.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { ...k, member: { id: `uain1${createHash('sha256').update(raw).digest('hex').slice(0, 40)}`, public_key: raw.toString('base64url'), name, operator: name, family: name, licence: 'active', karma: 100, credits: '0', sequence: '0', default_verifier: false, creator: false, active_projects: 0 } };
}
const guardian = identity('fictional-guardian');
let code = 0;
try {
  const app = join(root, 'app.json');
  await writeFile(app, JSON.stringify({ version: 1, guardians: [guardian.member.id], members: [guardian.member] }));
  for (const [i, h] of homes.entries()) execFileSync(current, ['init', '--home', h, '--chain-id', 'uain-rollback-fixture-1', '--app-genesis', app, '--rpc', `tcp://127.0.0.1:${ports[i]}`, '--p2p', `tcp://127.0.0.1:${ports[i] - 1}`], { env, stdio: 'ignore' });
  await writeFile(join(homes[1], 'config/genesis.json'), await readFile(join(homes[0], 'config/genesis.json')));
  const id = execFileSync(current, ['node-id', '--home', homes[0]], { env }).toString().split('\n').find(l => /^[0-9a-f]{40}$/.test(l));
  const cfg = join(homes[1], 'config/config.toml');
  await writeFile(cfg, (await readFile(cfg, 'utf8')).replace(/^persistent_peers = .*$/m, `persistent_peers = "${id}@127.0.0.1:${ports[0] - 1}"`).replace(/^addr_book_strict = .*$/m, 'addr_book_strict = false'));
  start(0, current);
  start(1, older);
  await waitFor(async () => (await height(ports[1])) >= 3, 'follower syncs on the older binary');
  const command = { version: 1, chain_id: 'uain-rollback-fixture-1', member: guardian.member.id, sequence: '0', expires_height: '10000', operation: 'karma_policy_activate', payload: { policy: 'uain-karma-v2', evidence_digest: 'a'.repeat(64) } };
  const tx = Buffer.from(JSON.stringify(signedEnvelope(command, Buffer.from(guardian.member.public_key, 'base64url'), guardian.privateKey))).toString('base64');
  const result = await rpc(ports[0], 'broadcast_tx_commit', { tx });
  assert.equal(result.tx_result.code, 0, result.tx_result.log);
  const activation = Number(result.height);
  await waitFor(async () => running.get(1).log().includes('wrong Block.Header.AppHash'), 'follower halts at the new operation');
  const stuck = await height(ports[1]).catch(() => null);
  await stop(1);
  const out = execFileSync(rollback, ['--home', homes[1]], { env }).toString();
  assert.match(out, /ROLLED_BACK/);
  start(1, current);
  const target = (await height(ports[0])) + 2;
  await waitFor(async () => (await height(ports[1])) >= target, 'follower catches up after rollback');
  const h = String(target - 1);
  const [a, b] = await Promise.all(ports.map(p => rpc(p, 'block', { height: h })));
  assert.equal(a.block.header.app_hash, b.block.header.app_hash);
  const k = Buffer.from('karma_policy_activation').toString('hex');
  const q = await rpc(ports[1], 'abci_query', { path: '/store/federation/key', data: k });
  assert.ok(q.response.value, 'follower state has the activation after re-execution');
  console.log(JSON.stringify({ status: 'ROLLBACK_E2E_OK', activation_height: activation, follower_stuck_at: stuck, rollback: out.trim(), caught_up_to: target, app_hash: a.block.header.app_hash }));
} catch (error) {
  console.error(error); console.error('diagnostics:', root); code = 1;
} finally {
  for (const i of running.keys()) await stop(i);
  process.exitCode = code;
}
