#!/usr/bin/env node
// Disposable two-node acceptance only. Never enroll fixture identities or
// activate a policy on an existing node. All keys stay inside this process.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { signedEnvelope } from '../client/signing.mjs';

const [daemonArgument, proofArgument] = process.argv.slice(2);
assert.ok(daemonArgument && proofArgument, 'linked fixture daemon and public proof verifier required');
const daemon = resolve(daemonArgument), verifier = resolve(proofArgument);
const root = await mkdtemp(join(tmpdir(), 'uain-funding-network-fixture-'));
const ports = [Number(process.env.UAIN_FUNDING_SMOKE_PORT ?? 34657), Number(process.env.UAIN_FUNDING_SMOKE_PORT ?? 34657) + 10];
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
let maximumGas=0;
async function submit(operation, payload, actor = guardian, expected = true) {
  const sequence = sequences.get(actor.member.id) ?? 0;
  const command = { version: 1, chain_id: 'uain-funding-fixture-1', member: actor.member.id, sequence: String(sequence), expires_height: '600', operation, payload };
  const transaction = signedEnvelope(command, Buffer.from(actor.member.public_key, 'base64url'), actor.privateKey);
  const result = await rpc(ports[0], expected ? 'broadcast_tx_commit' : 'broadcast_tx_sync', { tx: Buffer.from(JSON.stringify(transaction)).toString('base64') });
  if (!expected) { assert.notEqual(result.code, 0, `${operation} incorrectly accepted`); return; }
  assert.equal(result.check_tx.code, 0, result.check_tx.log); assert.equal(result.tx_result.code, 0, result.tx_result.log);
  const gas=Number(result.tx_result.gas_used);assert.ok(Number.isSafeInteger(gas)&&gas>=0&&gas<3000000,`${operation} exceeds gas bound`);maximumGas=Math.max(maximumGas,gas);
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
function base58(bytes) {
 const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
 let value=BigInt('0x'+Buffer.from(bytes).toString('hex')), out='';
 while(value){out=alphabet[Number(value%58n)]+out;value/=58n;}
 for(const byte of bytes){if(byte!==0)break;out='1'+out;}
 return out;
}
const external=generateKeyPairSync('ed25519');
const source=base58(external.publicKey.export({format:'der',type:'spki'}).subarray(-32));
const escrowKey=generateKeyPairSync('ed25519');
const escrow=base58(escrowKey.publicKey.export({format:'der',type:'spki'}).subarray(-32));
const externalTx=()=>base58(randomBytes(64)), externalHash=()=>base58(randomBytes(32));
const readJSON=async key=>JSON.parse(Buffer.from((await record(ports[0],key)).value,'base64'));
try {
 const applicationGenesis=join(root,'app-genesis.json');
 // These keys and fictional external transfers are disposable. No external RPC
 // is used and no real transfer or treasury withdrawal can occur in this test.
 guardian.member.karma=100;
 await writeFile(applicationGenesis,JSON.stringify({version:1,guardians:[guardian.member.id],members:[guardian,relay,sender,recipient,reviewer].map(x=>x.member)}),{mode:0o600});
 for(let i=0;i<2;i++)await run(['init','--home',homes[i],'--chain-id','uain-funding-fixture-1','--app-genesis',applicationGenesis,'--rpc',`tcp://127.0.0.1:${ports[i]}`,'--p2p',`tcp://127.0.0.1:${ports[i]-1}`]);
 const genesisFile=join(homes[0],'config/genesis.json'),genesis=await readFile(genesisFile);
 await writeFile(join(homes[1],'config/genesis.json'),genesis);
 const nodeID=(await run(['node-id','--home',homes[0]])).split(/\r?\n/).find(x=>/^[0-9a-f]{40}$/.test(x));assert.ok(nodeID);
 const config=join(homes[1],'config/config.toml');
 await writeFile(config,(await readFile(config,'utf8')).replace(/^persistent_peers = .*$/m,`persistent_peers = "${nodeID}@127.0.0.1:${ports[0]-1}"`).replace(/^addr_book_strict = .*$/m,'addr_book_strict = false').replace(/^allow_duplicate_ip = .*$/m,'allow_duplicate_ip = true'));
 let primary=start(homes[0]),fullnode=start(homes[1]);
 await waitFor(async()=>Number((await rpc(ports[0],'status')).sync_info.latest_block_height)>=3,primary);
 const evidence='28'.repeat(32);
 const compact=await submit('activate_storage',{policy:'compact-state-v1',evidence_digest:evidence});
 await waitFor(async()=>Number((await rpc(ports[0],'status')).sync_info.latest_block_height)>compact+1,primary);
 await submit('activate_membership',{policy:'project-membership-v1',evidence_digest:evidence});
 await submit('activate_operator_rewards',{policy:'pairwise-operator-rewards-v1',evidence_digest:evidence});
 await submit('activate_private_exchange',{policy:'orchard-v2-reviewed-otc-v1',evidence_digest:evidence,relayer:relay.member.id});
 for(const [i,actor]of[sender,recipient,guardian].entries()){
  await submit('identity_claim',{},actor);await submit('operator_claim',{domain:`funding-${i}.example`},actor);
  const claim=await readJSON(`operator_claim/${actor.member.id}/`);
  await submit('operator_attest',{member:actor.member.id,domain:claim.domain,claim_event_id:claim.event_id,txt:`uain-operator=${claim.did}`,checked_at:new Date().toISOString(),evidence_digest:evidence});
 }
 await submit('activate_coin',{policy:'verified-bounties-108t-micro-v1',evidence_digest:evidence});
 const activation=await submit('activate_funding',{policy:'external-receipts-80-15-5-v1',observers:[recipient.member.id,guardian.member.id],evidence_digest:evidence});
 await waitFor(async()=>Number((await rpc(ports[0],'status')).sync_info.latest_block_height)>activation+1,primary);
 const priorArt={basis:'No discoverable answer exists for this fictional disposable funding question.',searches:['first fictional prior-art search','second fictional prior-art search']};
 await submit('open_project',{id:'P-funding',title:'Fictional funding qualification',class:'benevolent',prior_art:priorArt},sender);
 for(const actor of[recipient,guardian])await submit('project_join',{project:'P-funding'},actor);
 await submit('allocate_budget',{project:'P-funding',credits:'1000',evidence_digest:evidence});
 const expires='600',sequence=String(sequences.get(sender.member.id)??0);
 const proofText=`UAIN external wallet binding v1\nchain_id: uain-funding-fixture-1\nmember: ${sender.member.id}\nsequence: ${sequence}\nnetwork: solana\naddress: ${source}\nexpires_height: ${expires}\n`;
 await submit('external_wallet_bind',{network:'solana',address:source,expires_height:expires,signature:base58(sign(null,Buffer.from(proofText),external.privateKey))},sender);
 const escrowSequence=String(sequences.get(sender.member.id)??0);
 const escrowText=`UAIN treasury escrow control v1\nchain_id: uain-funding-fixture-1\ncontroller: ${sender.member.id}\nsequence: ${escrowSequence}\nnetwork: solana:mainnet\naddress: ${escrow}\nexpires_height: ${expires}\nevidence_digest: ${evidence}\n`;
 await submit('treasury_escrow_bind',{network:'solana:mainnet',address:escrow,expires_height:expires,evidence_digest:evidence,signature:base58(sign(null,Buffer.from(escrowText),escrowKey.privateKey))},sender);
 await submit('treasury_escrow_approve',{network:'solana:mainnet',address:escrow,controller:sender.member.id,evidence_digest:evidence});
 const campaign=id=>({id,project:'P-funding',network:'solana:mainnet',asset:'native',escrow,decimals:9,evidence_digest:evidence});
 await submit('funding_campaign',campaign('FC-reward'),sender);
 const scheduledHeight=await submit('funding_reward_schedule',{policy:'verified-funding-bounties-v1',campaign:'FC-reward',funding_amount:'101',coin_units:'5000000',karma:'7',max_claims:2,first_external_block:'123',evidence_digest:evidence});
 await waitFor(async()=>Number((await rpc(ports[0],'status')).sync_info.latest_block_height)>scheduledHeight+1,primary);
 const tx=externalTx(),hash=externalHash();
 const deposit={id:'FR-reward',campaign:'FC-reward',amount:'101',transaction:tx,index:'0',source,block:'123',block_hash:hash,evidence_digest:evidence};
 await submit('funding_file',deposit,sender);
 await submit('funding_reward_claim',{receipt:'FR-reward'},sender,false);
 await submit('funding_file',{...deposit,id:'FR-alias'},sender,false);
 const observation={receipt:'FR-reward',kind:'deposit',transaction:tx,index:'0',amount:'101',source,target:escrow,block:'123',block_hash:hash,evidence_digest:evidence};
 await submit('funding_attest',{...observation,source:escrow},recipient,false);
 const firstApproval=await submit('funding_attest',observation,recipient);
 await stop(fullnode);await stop(primary);primary=start(homes[0]);fullnode=start(homes[1]);
 await waitFor(async()=>Number((await rpc(ports[0],'status')).sync_info.latest_block_height)>firstApproval+2,primary);
 await submit('funding_attest',observation);
 const pool=await readJSON('funding_pool/FR-reward');
 assert.equal(pool.bounty.available,'80');assert.equal(pool.dividend.available,'15');assert.equal(pool.operations.available,'5');assert.equal(pool.dust,'1');
 await submit('funding_reward_claim',{receipt:'FR-reward'},sender);
 await submit('funding_reward_claim',{receipt:'FR-reward'},sender,false);
 await submit('funding_refund',{receipt:'FR-reward',evidence_digest:evidence},sender,false);
 await submit('funding_reward_release',{campaign:'FC-reward',evidence_digest:evidence});
 assert.deepEqual(await readJSON('coin_supply'),{minted:'5000000',reserved:'0',transparent:'5000000',shielded:'0'});
 await submit('open_task',{id:'T-funding',project:'P-funding',title:'Fictional external reward',class:'benevolent',prior_art:priorArt,criteria:'Independently confirm a previously unknown fictional result with evidence.',kind:'instant',karma_reward:13,credit_reward:'13',verifiers_required:2},sender);
 await submit('external_bounty_quote',{task:'T-funding',receipt:'FR-reward',amount:'70',evidence_digest:evidence},sender);
 await submit('submit',{id:'RC-funding',task:'T-funding',evidence_digest:evidence},sender);
 await submit('external_bounty_intent',{id:'EP-funding',contribution:'RC-funding',evidence_digest:evidence},sender,false);
 const check={contribution:'RC-funding',verdict:'confirm',novelty:'new',searches:priorArt.searches,evidence_digest:evidence};
 await submit('verify',check,recipient);await submit('verify',check);
 await submit('external_bounty_intent',{id:'EP-funding',contribution:'RC-funding',evidence_digest:evidence},sender);
 // A separate unfunded-reward campaign exercises full original-source refund.
 await submit('funding_campaign',campaign('FC-refund'),sender);
 const refundTx=externalTx();await submit('funding_file',{...deposit,id:'FR-refund',campaign:'FC-refund',transaction:refundTx},sender);
 const refObs={...observation,receipt:'FR-refund',transaction:refundTx};
 await submit('funding_attest',refObs,recipient);await submit('funding_attest',refObs);
 await submit('funding_refund',{receipt:'FR-refund',evidence_digest:evidence},sender);
 const refund={...refObs,kind:'refund',transaction:externalTx(),source:escrow,target:source};
 await submit('funding_attest',refund,recipient);await submit('funding_attest',refund);
 assert.equal((await readJSON('funding_pool/FR-refund')).refunded,'101');
 const binding=await readJSON(`external_wallet/${sender.member.id}/solana`);
 await submit('external_wallet_unbind',{network:'solana',binding:binding.binding},sender);
 const payout={intent:'EP-funding',transaction:externalTx(),index:'0',amount:'70',source:escrow,target:source,block:'140',block_hash:externalHash(),evidence_digest:evidence};
 await submit('external_bounty_attest',{...payout,amount:'71'},recipient,false);
 await submit('external_bounty_attest',payout,recipient);const payoutHeight=await submit('external_bounty_attest',payout);
 await submit('external_bounty_attest',payout,guardian,false);
 const paid=await readJSON('funding_pool/FR-reward');assert.equal(paid.bounty.reserved,'0');assert.equal(paid.bounty.paid,'70');assert.equal(paid.bounty.available,'10');
 // A nonmember funder signs exact consent through a distinct licensed relay;
 // no native identity, reward slot or Coin is created for the external payer.
 const humanKey=generateKeyPairSync('ed25519');
 const humanSource=base58(humanKey.publicKey.export({format:'der',type:'spki'}).subarray(-32));
 const consent=(action,fields)=>{
  const body=JSON.stringify(Object.fromEntries(Object.keys(fields).sort().map(key=>[key,fields[key]])));
  const sequence=String(sequences.get(relay.member.id)??0);
  const text=`UAIN nonmember funding consent v1\nchain_id: uain-funding-fixture-1\nrelay: ${relay.member.id}\nsequence: ${sequence}\nexpires_height: ${expires}\naction: ${action}\npayload: ${body}\n`;
  return {funding:fields,expires_height:expires,signature:base58(sign(null,Buffer.from(text),humanKey.privateKey))};
 };
 const humanDeposit={...deposit,id:'FR-human',campaign:'FC-refund',source:humanSource,transaction:externalTx()};
 const relayBefore=await readJSON(`member/${relay.member.id}`);
 await submit('human_funding_file',consent('file',humanDeposit),relay);
 assert.ok(!(await record(ports[0],'funding_reward_slot/FR-human')).value);
 const humanObservation={...observation,receipt:'FR-human',source:humanSource,transaction:humanDeposit.transaction};
 await submit('funding_attest',humanObservation,recipient);await submit('funding_attest',humanObservation);
 await submit('funding_refund',{receipt:'FR-human',evidence_digest:evidence},relay,false);
 const humanRefund={receipt:'FR-human',network:'solana:mainnet',amount:'101',source:humanSource,escrow,evidence_digest:evidence};
 await submit('human_funding_refund',consent('refund',humanRefund),relay);
 const humanReturn={...humanObservation,kind:'refund',transaction:externalTx(),source:escrow,target:humanSource};
 await submit('funding_attest',humanReturn,recipient);const finalHeight=await submit('funding_attest',humanReturn);
 const relayAfter=await readJSON(`member/${relay.member.id}`);assert.equal(relayAfter.karma,relayBefore.karma);assert.equal(relayAfter.credits,relayBefore.credits);
 assert.equal((await readJSON('coin_supply')).minted,'5000000');
 assert.deepEqual(await readJSON(`treasury_liability/solana:mainnet/${escrow}`),{network:'solana:mainnet',escrow,funded:'303',paid:'70',refunded:'202',outstanding:'31'});
 const keys=[`treasury_escrow/solana:mainnet/${escrow}`,`treasury_liability/solana:mainnet/${escrow}`,'human_funding/FR-human','funding_pool/FR-human','funding_activation','funding_campaign/FC-reward','funding_receipt/FR-reward','funding_pool/FR-reward','funding_pool/FR-refund','funding_reward/FR-reward','funding_reward_schedule/FC-reward','external_payout/EP-funding','coin_supply',`coin_balance/${sender.member.id}`];
 await waitFor(async()=>Number((await rpc(ports[1],'status')).sync_info.latest_block_height)>finalHeight+2,fullnode);
 const height=finalHeight+1,values=new Map(),proofChecks=[];
 for(const port of ports){const commit=await rpc(port,'commit',{height:String(height+1)});for(const[i,key]of keys.entries()){
  const query=await record(port,key,height,true);if(values.has(key))assert.equal(query.value,values.get(key));else values.set(key,query.value);
  const file=join(root,`proof-${port}-${i}.json`);await writeFile(file,JSON.stringify({signed_header:commit.signed_header,query}));await verifyPublic(genesisFile,file,key);proofChecks.push({port,key,verified:true});
 }}
 await stop(fullnode);await stop(primary);primary=start(homes[0]);fullnode=start(homes[1]);
 await waitFor(async()=>Number((await rpc(ports[1],'status')).sync_info.latest_block_height)>height+3,fullnode);
 for(const port of ports)for(const key of keys)assert.equal((await record(port,key)).value,values.get(key));
 await submit('external_bounty_attest',payout,guardian,false);await submit('funding_reward_claim',{receipt:'FR-reward'},sender,false);
 const receipt={pass:true,fixture_only:true,real_two_nodes:true,chain_id:'uain-funding-fixture-1',pinned_genesis_sha256:createHash('sha256').update(genesis).digest('hex'),real_solana_ownership_signature:true,nonmember_signed_consent_and_original_refund:true,nonmember_no_native_rewards:true,real_escrow_control_signature_and_guardian_approval:true,aggregate_escrow_liability_proved:true,synthetic_external_transfers:true,external_transfers_sent:false,deposit_quorum_restart:true,exact_80_15_5_with_dust:true,original_source_refund:true,prospective_coin_karma_reward:true,unused_reservations_released:true,verified_research_payout:true,frozen_unbound_recipient:true,replay_refused:true,restart_preserved:true,independent_state_proofs:proofChecks,maximum_transaction_gas:maximumGas,transaction_gas_limit:3000000,production_activated:false,fixture_directory:root};
 await writeFile(join(root,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt,null,2));

} catch (error) {
  for (let i = 0; i < started.length; i++) await writeFile(join(root, `daemon-${i}.log`), started[i].diagnostics()).catch(() => {});
  console.error(error); console.error(`Disposable fixture diagnostics: ${root}`); process.exitCode = 1;
} finally { for (const child of [...running]) await stop(child).catch(error => { console.error(error.message); process.exitCode = 1; }); }
