#!/usr/bin/env node
// Public cold-sync evidence only. No member/source selection or private key.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const run = promisify(execFile);

export function assessWalletSync(holder, reference, now = Date.now()) {
  assert.equal(holder.node_info.network, reference.node_info.network, 'holder/reference chain differs');
  assert.equal(holder.validator_info.voting_power, '0', 'holder must be a nonvalidator');
  assert.equal(holder.sync_info.earliest_block_height, '1', 'full public history from block one required');
  assert.equal(holder.sync_info.catching_up, false, 'holder still catching up');
  for (const status of [holder, reference]) {
    const age = now - Date.parse(status.sync_info.latest_block_time);
    assert.ok(Number.isFinite(age) && age >= -60000 && age < 120000, 'fresh holder and reference blocks required');
    assert.match(status.sync_info.latest_block_height, /^[1-9][0-9]*$/);
  }
  const own = BigInt(holder.sync_info.latest_block_height), other = BigInt(reference.sync_info.latest_block_height);
  assert.ok(own >= other - 3n, 'holder remains behind reference');
  const checkpoint = (own < other ? own : other) - 2n;
  assert.ok(checkpoint > 1n, 'finalized checkpoint required');
  return { checkpoint: checkpoint.toString(), blocks_behind: (other > own ? other - own : 0n).toString() };
}

async function rpc(endpoint, method, params = {}) {
  const url = new URL(endpoint);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(url.hostname) && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash, 'own loopback nodes required');
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000), redirect: 'error' });
  assert.ok(response.ok);
  const bytes = Buffer.from(await response.arrayBuffer()); assert.ok(bytes.length < 4*1024*1024);
  const frame = JSON.parse(bytes); assert.ok(!frame.error); return frame.result;
}
export async function verifyWalletSync({ holderRPC, referenceRPC, genesisPath, genesisSha256, proofBinary, proofSha256, output }) {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const raw = await readFile(genesisPath), genesis = JSON.parse(raw);
  assert.equal(hash(raw), genesisSha256, 'independent genesis pin differs');
  assert.equal(hash(await readFile(proofBinary)), proofSha256, 'independent proof binary pin differs');
  const statuses = await Promise.all([holderRPC, referenceRPC].map(endpoint => rpc(endpoint, 'status')));
  assert.equal(statuses[0].node_info.network, genesis.chain_id);
  assert.ok(!genesis.validators.some(v => v.pub_key.value === statuses[0].validator_info.pub_key.value), 'holder key appears in canonical validator set');
  const progress = assessWalletSync(...statuses);
  const peers = await rpc(holderRPC, 'net_info'); assert.ok(Number(peers.n_peers) >= 1);
  await mkdir(output); // A receipt never replaces previous evidence.
  const keys = ['legacy', ...genesis.app_state.members.map(member => 'member/'+member.id)];
  const captures = await Promise.all([holderRPC, referenceRPC].map(async endpoint => {
    const commit = await rpc(endpoint, 'commit', { height: String(BigInt(progress.checkpoint)+1n) });
    const queries = [];
    for (const key of keys) queries.push((await rpc(endpoint, 'abci_query', { path: '/store/federation/key', data: Buffer.from(key).toString('hex'), height: progress.checkpoint, prove: true })).response);
    return { commit, queries };
  }));
  assert.deepEqual(captures[0].commit.signed_header, captures[1].commit.signed_header, 'checkpoint headers differ');
  const proofs = [];
  for (let node=0; node<2; node++) for (let index=0; index<keys.length; index++) {
    const query = captures[node].queries[index];
    assert.equal(query.value, captures[0].queries[index].value, 'checkpoint state differs');
    assert.deepEqual(JSON.parse(Buffer.from(query.value, 'base64')), index===0 ? genesis.app_state.legacy : genesis.app_state.members[index-1], 'original genesis records differ');
    const path = join(output, `${node}-${index}.json`);
    await writeFile(path, JSON.stringify({ signed_header: captures[node].commit.signed_header, query }, null, 2)+'\n', { flag: 'wx' });
    const { stdout } = await run(proofBinary, ['--genesis',genesisPath,'--bundle',path,'--key',keys[index],'--max-age','2m'], { timeout: 15000, maxBuffer: 65536 });
    assert.ok(stdout.includes('STATE_PROOF_VERIFIED'));
    proofs.push({ node: node===0?'holder':'reference', key:keys[index], verified:true });
  }
  const receipt = { checked_at:new Date().toISOString(), pass:true, qualification_only:true, chain_id:genesis.chain_id, genesis_sha256:genesisSha256, proof_sha256:proofSha256, ...progress, holder_height:statuses[0].sync_info.latest_block_height, reference_height:statuses[1].sync_info.latest_block_height, holder_node_id:statuses[0].node_info.id, holder_voting_power:'0', earliest_height:'1', app_hash:captures[0].commit.signed_header.header.app_hash, configured_peer_ids:peers.peers.map(peer=>peer.node_info.id), proofs, production_activation:false, real_member_adoption:false };
  await writeFile(join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  return receipt;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [holderRPC,referenceRPC,genesisPath,genesisSha256,proofBinary,proofSha256,output] = process.argv.slice(2);
  if (!output) throw Error('usage: verify-wallet-sync.mjs HOLDER_LOOPBACK_RPC REFERENCE_LOOPBACK_RPC GENESIS GENESIS_SHA256 PROOF_BINARY PROOF_SHA256 NEW_OUTPUT');
  const receipt = await verifyWalletSync({holderRPC,referenceRPC,genesisPath,genesisSha256,proofBinary,proofSha256,output});
  console.log(JSON.stringify({pass:true,height:receipt.holder_height,checkpoint:receipt.checkpoint,proofs:receipt.proofs.length}));
}
