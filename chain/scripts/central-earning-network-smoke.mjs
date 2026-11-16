#!/usr/bin/env node
// Disposable two-node acceptance only. Never enroll fixture identities or
// activate a policy on an existing node. Only fictional fixture keys are used.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, chown } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { signedEnvelope } from '../client/signing.mjs';

const daemon = resolve(process.argv[2]);
assert.ok(process.argv[4], 'original pinned uain-state reader required');
const stateReader=resolve(process.argv[4]);
const readerPin='136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860';
assert.equal(createHash('sha256').update(await readFile(stateReader)).digest('hex'),readerPin,'reader differs from original independent pin');
let activeDaemon=process.argv[3]?resolve(process.argv[3]):daemon;
const root = await mkdtemp(join(tmpdir(), 'uain-coin-boundary-network-fixture-'));
const ports = [Number(process.env.UAIN_CENTRAL_SMOKE_PORT ?? 35657), Number(process.env.UAIN_CENTRAL_SMOKE_PORT ?? 35657) + 10];
assert.ok(ports.every(port => Number.isInteger(port) && port > 1024 && port < 65535));
const localNodeTest=false;
if (localNodeTest) ports.push(ports[0]+20);
const homes = ports.map((_,i)=>join(root,`node-${i}`));
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
    const child = spawn(activeDaemon, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
    child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(output)));
  });
}
function start(home,binary=activeDaemon) {
  const child = spawn(binary, ['start', '--home', home], { stdio: ['ignore', 'pipe', 'pipe'] }); let log = '';
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
  const response = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(method.startsWith('broadcast_tx_') ? 15000 : 3000) });
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
async function submit(operation,payload,actor=guardian,expected=true){const sequence=sequences.get(actor.member.id)??0;const command={version:1,chain_id:'uain-central-fixture-1',member:actor.member.id,sequence:String(sequence),expires_height:'10000',operation,payload};const transaction=signedEnvelope(command,Buffer.from(actor.member.public_key,'base64url'),actor.privateKey);const result=await rpc(ports[0],expected?'broadcast_tx_commit':'broadcast_tx_sync',{tx:Buffer.from(JSON.stringify(transaction)).toString('base64')});if(!expected){assert.notEqual(result.code,0,operation+' incorrectly accepted');return}assert.equal(result.check_tx.code,0,operation+': '+result.check_tx.log);assert.equal(result.tx_result.code,0,operation+': '+result.tx_result.log);sequences.set(actor.member.id,sequence+1);return Number(result.height)}
async function record(port, key, height = '0', prove = false) {
  const response = (await rpc(port, 'abci_query', { path: '/store/federation/key', data: Buffer.from(key).toString('hex'), height: String(height), prove })).response;
  assert.equal(response.code, 0); return response;
}

async function verifiedSnapshot(port,keys,label){const genesis=join(homes[0],'config/genesis.json'),pin=createHash('sha256').update(await readFile(genesis)).digest('hex'),out=join(root,`verified-${label}.json`);await new Promise((resolve,reject)=>{const child=spawn(stateReader,['--genesis',genesis,'--genesis-sha256',pin,'--rpc',`http://127.0.0.1:${port}`,'--out',out,'--max-age','120s'],{stdio:['pipe','pipe','pipe']});let log='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>log+=b);child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error(log)));child.stdin.end(JSON.stringify({keys}))});const snapshot=JSON.parse(await readFile(out,'utf8'));assert.equal(snapshot.chain_id,'uain-central-fixture-1');assert.ok(snapshot.signed_header&&snapshot.app_hash&&snapshot.queries.length>=keys.length);return snapshot}
const hash=s=>createHash('sha256').update(s).digest('hex');
const evidence='a'.repeat(64),criteria='result equals 42';
let primary,fullnode;
try{
const applicationGenesis=join(root,'app-genesis.json');await writeFile(applicationGenesis,JSON.stringify({version:1,guardians:[guardian.member.id],members:[guardian,relay,sender,recipient,reviewer].map(x=>x.member)}));
for(let i=0;i<2;i++)await run(['init','--home',homes[i],'--chain-id','uain-central-fixture-1','--app-genesis',applicationGenesis,'--rpc',`tcp://127.0.0.1:${ports[i]}`,'--p2p',`tcp://127.0.0.1:${ports[i]-1}`]);
await writeFile(join(homes[1],'config/genesis.json'),await readFile(join(homes[0],'config/genesis.json')));
const id=(await run(['node-id','--home',homes[0]])).split(/\r?\n/).find(x=>/^[0-9a-f]{40}$/.test(x));const file=join(homes[1],'config/config.toml');await writeFile(file,(await readFile(file,'utf8')).replace(/^persistent_peers = .*$/m,`persistent_peers = "${id}@127.0.0.1:${ports[0]-1}"`).replace(/^addr_book_strict = .*$/m,'addr_book_strict = false'));
primary=start(homes[0]);fullnode=start(homes[1],daemon);await waitFor(async()=>Number((await rpc(ports[0],'status')).sync_info.latest_block_height)>=3,primary);
let activation=await submit('activate_storage',{policy:'compact-state-v1',evidence_digest:evidence});await waitFor(async()=>Number((await rpc(ports[0],'status')).sync_info.latest_block_height)>activation+1,primary);
await submit('activate_membership',{policy:'project-membership-v1',evidence_digest:evidence});await submit('activate_operator_rewards',{policy:'pairwise-operator-rewards-v1',evidence_digest:evidence});await submit('activate_private_exchange',{policy:'orchard-v2-reviewed-otc-v1',relayer:relay.member.id,evidence_digest:evidence});
for(const [i,actor] of [sender,recipient,guardian].entries()){await submit('identity_claim',{},actor);await submit('operator_claim',{domain:`central-${i}.example`},actor);const claim=JSON.parse(Buffer.from((await record(ports[0],`operator_claim/${actor.member.id}/`)).value,'base64'));await submit('operator_attest',{member:actor.member.id,domain:claim.domain,claim_event_id:claim.event_id,txt:`uain-operator=${claim.did}`,checked_at:new Date().toISOString(),evidence_digest:evidence})}
activation=await submit('activate_coin',{policy:'verified-bounties-108t-micro-v1',evidence_digest:evidence});await waitFor(async()=>Number((await rpc(ports[0],'status')).sync_info.latest_block_height)>activation+1,primary);
const prior_art={basis:'No discoverable answer exists for this fictional isolated central earning qualification.',searches:['first fictional prior-art search','second fictional prior-art search']};await submit('open_project',{id:'P-central',title:'Fictional central earning project',class:'benevolent',prior_art},sender);for(const actor of [recipient,guardian])await submit('project_join',{project:'P-central'},actor);
await submit('open_project',{id:'P-legacy',title:'Untouched native v1 fixture project',class:'benevolent',prior_art},sender);await submit('open_task',{id:'T-legacy',project:'P-legacy',title:'Unstarted old contract fixture',class:'benevolent',prior_art,criteria:'Independently reproduce the fictional isolated answer and examine novelty.',kind:'instant',karma_reward:13,credit_reward:'13',verifiers_required:2},sender);const openEvent=JSON.parse(Buffer.from((await record(ports[0],'event_count')).value,'base64'));const legacyQuoteHeight=await submit('coin_quote',{task:'T-legacy',open_event:String(openEvent).padStart(20,'0'),amount:'5000000',evidence_digest:evidence},sender);await submit('coin_reserve',{task:'T-legacy',evidence_digest:evidence});await waitFor(async()=>Number((await rpc(ports[1],'status')).sync_info.latest_block_height)>legacyQuoteHeight+2,fullnode);const oldResults=await rpc(ports[0],'block_results',{height:String(legacyQuoteHeight)}),newResults=await rpc(ports[1],'block_results',{height:String(legacyQuoteHeight)});assert.deepEqual(newResults.txs_results,oldResults.txs_results,'pre-activation Coin replay changed execution/gas results');assert.equal((await rpc(ports[0],'block',{height:String(legacyQuoteHeight+1)})).block.header.app_hash,(await rpc(ports[1],'block',{height:String(legacyQuoteHeight+1)})).block.header.app_hash);const historicalReplay={height:legacyQuoteHeight,gasUsed:oldResults.txs_results[0].gas_used};
const upgradeHeight=Number((await rpc(ports[0],'status')).sync_info.latest_block_height);const historicalKeys=['coin_supply','coin_activation','project/P-central','coin_quote/T-legacy','coin_reservation/T-legacy'];const historical={};for(const key of historicalKeys)historical[key]=(await record(ports[0],key)).value;await stop(primary);await stop(fullnode);activeDaemon=daemon;primary=start(homes[0]);fullnode=start(homes[1]);await waitFor(async()=>Number((await rpc(ports[0],'status')).sync_info.latest_block_height)>upgradeHeight+1,primary);for(const key of historicalKeys)assert.equal((await record(ports[0],key)).value,historical[key]);
activation=await submit('central_earning_activate',{policy:'central-earning-project-budget-v1',reviewer:guardian.member.id,evidence_digest:evidence});await waitFor(async()=>Number((await rpc(ports[0],'status')).sync_info.latest_block_height)>activation+1,primary);await submit('central_project_start',{project:'P-central',manager:sender.member.id,evidence_digest:evidence},sender);await submit('central_project_start',{project:'P-legacy',manager:sender.member.id,evidence_digest:evidence},sender,false);await submit('coin_release',{task:'T-legacy',evidence_digest:evidence},sender);
const terms={id:'CT-1',project:'P-central',title:'Check fixture bounded answer',criteria,acceptance_digest:hash(criteria),eligibility:'hard',eligibility_digest:evidence,solver_amount:'100000000',reviewer_amount:'20000000',evidence_digest:evidence};await submit('central_task_open',terms,sender);
const submission=id=>({id,task:'CT-1',evidence:'42',evidence_digest:hash('42')});const review=(submission,verdict,execution_id)=>({submission,verdict,execution_id,criteria_digest:hash(criteria),verification_digest:evidence,evidence_digest:hash('42')});
await submit('central_submit',submission('CS-self'),guardian,false);await submit('central_submit',{...submission('CS-bad'),evidence:'43'},recipient,false);await submit('central_submit',submission('CS-1'),recipient);await submit('central_submit',submission('CS-race'),sender,false);await submit('central_review',review('CS-1','accept','self'),recipient,false);await submit('central_review',review('CS-1','needs_evidence','needs'));await submit('central_reviewer_replace',{expected_reviewer:guardian.member.id,new_reviewer:reviewer.member.id,evidence_digest:evidence});await submit('central_review',review('CS-1','needs_evidence','replacement-needs'),reviewer);await submit('licence',{member:reviewer.member.id,status:'revoked',evidence_digest:evidence});await submit('central_reviewer_replace',{expected_reviewer:reviewer.member.id,new_reviewer:guardian.member.id,evidence_digest:evidence});await submit('central_review',review('CS-1','reject','reject'));await submit('central_task_fund',{task:'CT-1',evidence_digest:evidence},sender);await submit('central_submit',submission('CS-2'),sender);const paid=await submit('central_review',review('CS-2','accept','accept'));await submit('central_review',review('CS-2','accept','replay'),guardian,false);await submit('central_task_open',{...terms,id:'CT-over',solver_amount:'1000000000000000'},sender,false);await submit('coin_claim',{contribution:'CS-2'},sender,false);
const keys=['coin_supply',`coin_balance/${sender.member.id}`,`coin_balance/${guardian.member.id}`,'central_project_budget/P-central','central_task/CT-1','central_award/solver/CS-2','central_award/reviewer/CS-2','central_task_count',`central_earnings/${guardian.member.id}`];await waitFor(async()=>Number((await rpc(ports[1],'status')).sync_info.latest_block_height)>paid+2,fullnode);const saved={};for(const key of keys){const a=await record(ports[0],key,paid,true),b=await record(ports[1],key,paid,true);assert.equal(a.value,b.value);assert.ok(a.proofOps.ops.length);saved[key]=a.value}assert.equal(JSON.parse(Buffer.from(saved.coin_supply,'base64')).minted,'140000000');assert.equal(JSON.parse(Buffer.from(saved[`coin_balance/${sender.member.id}`],'base64')),'100000000');assert.equal(JSON.parse(Buffer.from(saved[`coin_balance/${guardian.member.id}`],'base64')),'40000000');await stop(primary);primary=start(homes[0]);await waitFor(async()=>Number((await rpc(ports[0],'status')).sync_info.latest_block_height)>paid+3,primary);for(const key of keys)assert.equal((await record(ports[0],key)).value,saved[key]);const readerKeys=[...keys,'coin_activation','project/P-central','central_earning_activation','central_submission/CS-1','central_submission/CS-2',`central_earnings/${sender.member.id}`,`central_award_index/${guardian.member.id}/00000000000000000001`,`central_award_index/${guardian.member.id}/00000000000000000002`];const verified=[];for(const [i,port] of ports.entries()){const snapshot=await verifiedSnapshot(port,readerKeys,`node-${i}`);for(const key of keys)assert.deepEqual(snapshot.records[key],JSON.parse(Buffer.from(saved[key],'base64')));assert.deepEqual(snapshot.records['coin_activation'],JSON.parse(Buffer.from(historical['coin_activation'],'base64')));assert.deepEqual(snapshot.records['project/P-central'],JSON.parse(Buffer.from(historical['project/P-central'],'base64')));assert.equal(snapshot.records[`central_earnings/${guardian.member.id}`].total,'40000000');assert.equal(snapshot.records[`central_earnings/${sender.member.id}`].total,'100000000');verified.push({port,height:snapshot.height,appHash:snapshot.app_hash})}
console.log(JSON.stringify({status:'CENTRAL_EARNING_NETWORK_OK',fixture:true,root,height:paid,minted:'140000000',solver:'100000000',reviewer:'40000000',replicated:true,restarted:true,historicalReplay,originalReaderVerified:true,readerPin,verified}));
}finally{for(const child of [...running])await stop(child)}
