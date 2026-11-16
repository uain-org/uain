import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { readFederationState, composeFederationCommand, findFederationReceipt } from '../../../chain/client/federation-workflow.mjs';
import { researchEvidence } from '../../../chain/client/evidence-document.mjs';
import { createNativeProjectPilotService } from '../server/native-project-pilot.mjs';
import {e2eSkip} from '../../../ops/ci/e2e-gate.mjs';

// Explicit opt-in: this launches only an owned isolated consensus node, never a
// configured public network. No installed member key or production state is used.
test('isolated consensus proves BAINK pilot project/task/join/submit/review receipts', { skip: e2eSkip(process.env.UAIN_PROJECT_PILOT_E2E === '1', 'UAIN_PROJECT_PILOT_E2E=1 with UAIN_NATIVE_CHAIN_BINARY and UAIN_NATIVE_STATE_BINARY'), timeout: 150000 }, async () => {
  const binary = process.env.UAIN_NATIVE_CHAIN_BINARY, executable = process.env.UAIN_NATIVE_STATE_BINARY;
  assert.ok(binary && executable, 'explicit existing isolated QA tools required');
  const hash = x => createHash('sha256').update(x).digest('hex');
  const hashFile = async p => hash(await readFile(p));
  const root = await mkdtemp(join(tmpdir(), 'uain-project-pilot-node-'));
  const actors = ['creator', 'reviewer', 'default'].map((name, i) => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    const address = 'uain1' + hash(raw).slice(0, 40);
    return { name, instance: `pilot-${name}`, privateKey, raw,
      user: { address, publicKey: raw.toString('base64') },
      member: { id: address, public_key: raw.toString('base64url'), name: `Synthetic ${name}`, operator: `Synthetic operator ${i}`, family: `Synthetic family ${i}`, licence: 'active', karma: 0, credits: '0', sequence: '0', default_verifier: i === 2, creator: i === 0, active_projects: 0 } };
  });
  // The ordinary reviewer has pre-existing fixture standing, not role grants
  // or earned work in a real network.
  actors[1].member.karma = 100;
  let node;
  const exec = args => new Promise((resolve, reject) => { const p = spawn(binary, args, { stdio: 'ignore' }); p.once('error', reject); p.once('close', code => code === 0 ? resolve() : reject(Error(`isolated init refused (${code})`))); });
  const freePort = async () => { const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
  const rpc = `http://127.0.0.1:${await freePort()}`, p2p = `tcp://127.0.0.1:${await freePort()}`;
  let sends = 0;
  try {
    const appGenesis = join(root, 'app.json'), home = join(root, 'node');
    await writeFile(appGenesis, JSON.stringify({ version: 1, members: actors.map(a => a.member), guardians: [actors[2].user.address] }), { mode: 0o600 });
    await exec(['init', '--home', home, '--chain-id', 'isolated-baink-project-pilot', '--app-genesis', appGenesis, '--rpc', rpc.replace('http:', 'tcp:'), '--p2p', p2p]);
    node = spawn(binary, ['start', '--home', home], { stdio: 'ignore' });
    node.once('error', () => {});
    const readyDeadline = Date.now() + 20000;
    for (;;) {
      try { const s = await (await fetch(rpc + '/status')).json(); if (BigInt(s.result.sync_info.latest_block_height) >= 3n) break; } catch {}
      assert.ok(Date.now() < readyDeadline, 'owned consensus node failed to become ready');
      await delay(100);
    }
    const reader = { executable, executableSha256: await hashFile(executable), genesis: join(home, 'config/genesis.json'), genesisSha256: await hashFile(join(home, 'config/genesis.json')), rpc };
    async function broadcast(envelope) {
      sends++;
      const bytes = Buffer.from(JSON.stringify(envelope));
      const r = await (await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'broadcast_tx_sync', params: { tx: bytes.toString('base64') } }) })).json();
      assert.equal(r.result.code, 0, 'isolated command rejected by actual node');
      return { accepted: true, code: 0, transactionHash: r.result.hash };
    }
    async function setup(a, operation, payload) {
      const state = await readFederationState({ ...reader, request: { member: a.user.address } });
      const envelope = composeFederationCommand({ state, operation, payload, signingKey: a.privateKey });
      await broadcast(envelope);
      const deadline = Date.now() + 15000;
      for (;;) {
        const receipt = await findFederationReceipt({ reader, envelope, afterEvent: state.event_count });
        if (receipt.finalized) return receipt;
        assert.ok(Date.now() < deadline, 'isolated setup receipt did not finalize');
        await delay(100);
      }
    }
    for (const a of actors) await setup(a, 'instance_create', { id: a.instance, name: `Synthetic ${a.name} instance`, family: a.member.family });
    await setup(actors[2], 'activate_membership', { policy: 'project-membership-v1', evidence_digest: 'a'.repeat(64) });
    // Wait for a fresh subsequent height: activation applies prospectively.
    let state = await readFederationState({ ...reader, request: {} });
    const activationHeight = BigInt(state.height);
    for (;;) { state = await readFederationState({ ...reader, request: {} }); if (BigInt(state.height) > activationHeight) break; await delay(100); }
    const prior_art = { basis: 'Synthetic isolated integration fixture only; never an actual scientific novelty claim.', searches: ['https://fixture.invalid/search-one', 'https://fixture.invalid/search-two'] };
    const config = { sourceId: 'OPP-00002', sourceDigest: 'b'.repeat(64), projectId: 'isolated-pilot-project', taskId: 'isolated-pilot-task', creatorAddress: actors[0].user.address, creatorInstance: actors[0].instance, chainId: state.chain_id, epoch: reader.genesisSha256,
      projectPayload: { id: 'isolated-pilot-project', title: 'Synthetic project lifecycle fixture', class: 'neutral', prior_art },
      taskPayload: { id: 'isolated-pilot-task', project: 'isolated-pilot-project', title: 'Synthetic zero-priced research fixture', class: 'neutral', prior_art, criteria: 'Verify the isolated native and BAINK adapter lifecycle. This is synthetic engineering evidence, never a scientific result.', kind: 'instant', karma_reward: 0, credit_reward: '0' } };
    let data = {}, queue = Promise.resolve();
    const store = { read: () => structuredClone(data), transact(fn) { const run = queue.then(async () => { const next = structuredClone(data), result = fn(next); await writeFile(join(root, 'pilot-store.json'), JSON.stringify(next), { mode: 0o600 }); data = next; return structuredClone(result); }); queue = run.catch(() => {}); return run; } };
    const native = { configured: true, timeoutMs: 15000, pins: { chainId: config.chainId, epoch: config.epoch, verifierSha256: reader.executableSha256 }, async publicState(selection) {
      const s = await readFederationState({ ...reader, request: selection, timeoutMs: 15000 });
      return { state: s, proof: { authority: 'native', chainId: s.chain_id, epoch: config.epoch, verifierSha256: reader.executableSha256, height: s.height, appHash: s.app_hash, headerTime: s.header_time, maxAgeSeconds: 120 } };
    }, broadcastResearch: broadcast };
    const service = createNativeProjectPilotService({ store, native, config, enabled: true, sourceDigest: () => config.sourceDigest });
    const results = [];
    async function act(a, operation, payload, body) {
      const input = { clientRequestId: `isolated-${operation}-${a.name}`, sourceDigest: config.sourceDigest, operation, instance: a.instance, payload, ...(body ? { body } : {}) };
      const prepared = await service.prepare(a.user, input), intent = prepared.intent;
      const envelope = { command: intent.command, public_key: a.raw.toString('base64url'), signature: sign(null, Buffer.from(intent.signingBytesBase64, 'base64'), a.privateKey).toString('base64url') };
      const sent = await service.submit(a.user, intent.id, { envelope });
      assert.equal(sent.intent.status, 'accepted');
      const deadline = Date.now() + 15000;
      let final;
      do {
        final = (await service.receipt(a.user, intent.id, {})).intent;
        if (final.finalized) break;
        assert.ok(Date.now() < deadline, `receipt did not finalize: ${operation}`);
        await delay(100);
      } while (true);
      assert.equal(final.receipt.event.operation, operation);
      assert.equal(final.receipt.event.member, a.user.address);
      assert.equal(final.receipt.event.instance, a.instance);
      const before = sends;
      assert.equal((await service.submit(a.user, intent.id, { envelope })).attempted, false);
      assert.equal(sends, before, 'finalized intent was rebroadcast');
      results.push({ operation, event: final.receipt.event.id, digest: final.receipt.event.command_digest });
      return final;
    }
    await act(actors[0], 'open_project', config.projectPayload);
    await act(actors[0], 'open_task', config.taskPayload);
    for (const a of actors.slice(1)) await act(a, 'project_join', { project: config.projectId });
    const body = { title: 'Synthetic isolated evidence', detail: 'This is a synthetic engineering fixture, not a new scientific result or a production contribution.', evidence: { synthetic: true }, sources: ['https://fixture.invalid'] };
    await act(actors[0], 'submit', { id: 'isolated-pilot-result', task: config.taskId, evidence_digest: researchEvidence(body).digest }, body);
    let snapshot = await service.snapshot(actors[0].user, { contributionId: 'isolated-pilot-result' });
    assert.equal(snapshot.contribution.state, 'held');
    for (const a of actors.slice(1)) await act(a, 'verify', { contribution: 'isolated-pilot-result', verdict: 'confirm', novelty: 'new', searches: prior_art.searches, evidence_digest: 'c'.repeat(64) });
    snapshot = await service.snapshot(actors[0].user, { contributionId: 'isolated-pilot-result' });
    assert.equal(snapshot.contribution.state, 'settled');
    assert.equal(snapshot.task.state, 'settled');
    assert.equal(snapshot.contribution.settlement.independent_operators, 2);
    assert.equal(snapshot.contribution.settlement.other_family, true);
    const monetary = await native.publicState({ keys: ['coin_supply', 'coin_reservation/' + config.taskId] });
    assert.equal(monetary.state.records.coin_supply, null);
    assert.equal(monetary.state.records['coin_reservation/' + config.taskId], null);
    assert.equal(results.length, 7);
    assert.equal(sends, 11, 'unexpected additional broadcasts');
    console.log(JSON.stringify({ qualification: 'isolated-baink-project-native-finality', chain: config.chainId, operations: results, nativeState: snapshot.contribution.state, funding: false, productionActions: false }));
  } finally {
    if (node && node.exitCode === null) { const stopped = new Promise(r => node.once('close', r)); node.kill('SIGTERM'); await stopped; }
    await rm(root, { recursive: true, force: true });
  }
});
