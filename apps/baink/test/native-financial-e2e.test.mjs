// Opt-in disposable qualification ONLY. Never points at an existing chain or
// seeds production. Every identity, role, prior-art statement and result below
// is explicitly fictional; distinct fixture operators are not real participants.
// Setup follows chain/scripts/coin-boundary-network-smoke.mjs. Unlike the HTTP
// unit fixtures, every native.publicState call executes the real pinned reader.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture,member} from './http-fixture.mjs';
import {createNativeAssetAdapter} from '../server/native-asset.mjs';
import {signedEnvelope} from '../../../chain/client/signing.mjs';
import {e2eSkip} from '../../../ops/ci/e2e-gate.mjs';

const enabled=process.env.UAIN_FINANCIAL_E2E==='1';
const privateEnabled=process.env.UAIN_FINANCIAL_PRIVATE_E2E==='1';
const holderHTTPEnabled=process.env.UAIN_FINANCIAL_HOLDER_HTTP_E2E==='1';
const recipientHTTPEnabled=process.env.UAIN_FINANCIAL_RECIPIENT_HTTP_E2E==='1';
const ownedNotesEnabled=process.env.UAIN_FINANCIAL_OWNED_NOTES_E2E==='1';
const publicCourierEnabled=process.env.UAIN_FINANCIAL_PUBLIC_COURIER_E2E==='1';
const bountyEnabled=process.env.UAIN_FINANCIAL_BOUNTY_E2E==='1';
const earningRecoveryEnabled=process.env.UAIN_FINANCIAL_EARNING_RECOVERY_E2E==='1';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// uaind 0.4.1 orchard (b525c808…), the release production runs since the 10 November 2026 stopped upgrade; was 715a3a6b… (0.3.x).
const TOOL_PINS={daemon:'b525c808aa017865ec798869f2d72f5ba5ce0e6fb432cb7700bb8a2a29260024',reader:'136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860'};

async function freePorts() {
 const listeners=[];
 try {
  for(let n=0;n<4;n++){const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});listeners.push(server)}
  return listeners.map(server=>server.address().port);
 } finally {await Promise.all(listeners.map(server=>new Promise(resolve=>server.close(resolve))))}
}
function fictionalIdentity(label,karma=0) {
 const holder=member();
 return {...holder,member:{id:holder.address,public_key:Buffer.from(holder.publicKey,'base64').toString('base64url'),name:`Fictional ${label}`,operator:`Fictional ${label} fixture operator`,family:`Fictional ${label} fixture family`,licence:'active',karma,credits:'0',sequence:'0',default_verifier:false,creator:false,active_projects:0}};
}
async function disposableNetwork(t) {
 const daemon=process.env.UAIN_FINANCIAL_E2E_DAEMON??'/tools/uaind',reader=process.env.UAIN_FINANCIAL_E2E_STATE_BINARY??'/tools/uain-state';
 // Expected pins come from the reviewed runtime, never from the tested file.
 assert.equal(sha(await readFile(daemon)),TOOL_PINS.daemon,'Unreviewed native daemon');assert.equal(sha(await readFile(reader)),TOOL_PINS.reader,'Unreviewed public reader');
 const root=await mkdtemp(join(tmpdir(),'baink-fictional-financial-e2e-')),chainId=`baink-fictional-e2e-${randomBytes(6).toString('hex')}`;
 const ports=await freePorts(),homes=[join(root,'node-0'),join(root,'node-1')],running=new Set(),started=[];
 t.after(async()=>{for(const child of [...running])await stop(child);await rm(root,{recursive:true,force:true})});
 async function command(args) {
  return new Promise((resolve,reject)=>{const child=spawn(daemon,args,{stdio:['ignore','pipe','pipe']}),parts=[];const timer=setTimeout(()=>child.kill('SIGKILL'),15000);for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>parts.push(bytes));child.once('error',reject);child.once('close',code=>{clearTimeout(timer);const output=Buffer.concat(parts).toString();code===0?resolve(output):reject(new Error(`Fixture daemon command failed (${code}): ${output.slice(-4000)}`))})});
 }
 function start(index) {
  const child=spawn(daemon,['start','--home',homes[index]],{stdio:['ignore','pipe','pipe']});let log='';for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{log=(log+bytes).slice(-12000)});child.diagnostics=()=>log;running.add(child);started.push(child);child.once('exit',()=>running.delete(child));return child;
 }
 async function stop(child) {
  if(child.exitCode!==null||child.signalCode!==null)return;
  await new Promise(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),10000);child.once('exit',()=>{clearTimeout(timer);resolve()});child.kill('SIGTERM')});
 }
 async function rpc(index,method,params={}) {
  const response=await fetch(`http://127.0.0.1:${ports[index*2]}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(method.startsWith('broadcast')?20000:3000)}),body=await response.json();assert.ok(!body.error,JSON.stringify(body.error));return body.result;
 }
 async function waitFor(action,label) {
  let last;
  for(let attempt=0;attempt<100;attempt++) {
   try {const value=await action();if(value)return value}catch(error){last=error}
   if([...running].length<2)throw new Error(`Fixture exited during ${label}: ${started.map(child=>child.diagnostics()).join('\n')}`);
   await pause(300);
  }
  throw new Error(`${label}: ${last?.stack??'condition not reached'}\n${started.map(child=>child.diagnostics()).join('\n')}`);
 }
 const guardian=fictionalIdentity('guardian-checker'),sender=fictionalIdentity('author',1000),checker=fictionalIdentity('independent-checker',100),relay=fictionalIdentity('relay'),reviewer=fictionalIdentity('private-reviewer',100);
 guardian.member.default_verifier=true;sender.member.creator=true;
 const people={guardian,sender,checker,relay,reviewer},appGenesis=join(root,'app-genesis.json');
 await writeFile(appGenesis,JSON.stringify({version:1,guardians:[guardian.address],members:Object.values(people).map(actor=>actor.member)}),{mode:0o600});
 for(let index=0;index<2;index++)await command(['init','--home',homes[index],'--chain-id',chainId,'--app-genesis',appGenesis,'--rpc',`tcp://127.0.0.1:${ports[index*2]}`,'--p2p',`tcp://127.0.0.1:${ports[index*2+1]}`]);
 const genesis=join(homes[0],'config/genesis.json'),genesisBytes=await readFile(genesis);await writeFile(join(homes[1],'config/genesis.json'),genesisBytes);
 const nodeID=(await command(['node-id','--home',homes[0]])).split(/\r?\n/).find(line=>/^[a-f0-9]{40}$/.test(line));assert.ok(nodeID);
 const configFile=join(homes[1],'config/config.toml');await writeFile(configFile,(await readFile(configFile,'utf8')).replace(/^persistent_peers = .*$/m,`persistent_peers = "${nodeID}@127.0.0.1:${ports[1]}"`).replace(/^addr_book_strict = .*$/m,'addr_book_strict = false').replace(/^allow_duplicate_ip = .*$/m,'allow_duplicate_ip = true'));
 let nodes=[start(0),start(1)];await waitFor(async()=>Number((await rpc(1,'status')).sync_info.latest_block_height)>=3,'two disposable nodes ready');
 const config={binary:reader,binaryHash:TOOL_PINS.reader,genesis,genesisHash:sha(genesisBytes),chainId,rpc:`http://127.0.0.1:${ports[0]}`,timeoutMs:10000,maxAgeSeconds:120};
 const native=createNativeAssetAdapter({config}),peer=createNativeAssetAdapter({config:{...config,rpc:`http://127.0.0.1:${ports[2]}`}});
 const read=(selection={})=>native.publicState(selection);
 async function submit(operation,payload,actor=guardian,expected=true) {
  const current=await read({member:actor.address}),command={version:1,chain_id:chainId,member:actor.address,sequence:current.state.member.sequence,expires_height:String(BigInt(current.state.height)+300n),operation,payload},envelope=signedEnvelope(command,Buffer.from(actor.member.public_key,'base64url'),actor.privateKey);
  const result=await rpc(0,expected?'broadcast_tx_commit':'broadcast_tx_sync',{tx:Buffer.from(JSON.stringify(envelope)).toString('base64')});
  if(!expected){assert.notEqual(result.code,0,`${operation} must be refused`);return}
  assert.equal(result.check_tx.code,0,result.check_tx.log);assert.equal(result.tx_result.code,0,result.tx_result.log);
  await waitFor(async()=>Number((await rpc(0,'status')).sync_info.latest_block_height)>Number(result.height)+1,`${operation} finality`);return {envelope,height:result.height};
 }
 async function restart(){for(const child of nodes)await stop(child);nodes=[start(0),start(1)];await waitFor(async()=>{await read({});return true},'reader after restart')}
 return {root,people,native,peer,config,read,submit,rpc,waitFor,restart,daemonPid:()=>nodes[0].pid};
}

test('real two-node native earning through signed BAINK HTTP, prospective pricing, frozen novelty and restart receipts', {skip:e2eSkip(enabled,'UAIN_FINANCIAL_E2E=1 and the pinned native /tools'),timeout:privateEnabled||earningRecoveryEnabled?900000:360000}, async t=>{
 assert.ok(!privateEnabled&&!holderHTTPEnabled&&!recipientHTTPEnabled&&!ownedNotesEnabled,'The holder-route payment stages were removed with the Docker holder (9 November 2026); Trade payments qualify in apps/baink/agents/trade-real-daemon-stage.mjs');
 assert.ok(!bountyEnabled||privateEnabled,'Bounty and invoice-index qualification requires the complete original private-payment stage');
 assert.ok(!ownedNotesEnabled||privateEnabled,'Owned notes qualification requires the complete original private-payment stage');
 assert.ok(!holderHTTPEnabled||privateEnabled,'Actual holder HTTP stage requires the complete private-payment qualification stage');
 assert.ok(!recipientHTTPEnabled||holderHTTPEnabled,'Actual recipient HTTP stage requires the actual holder HTTP shield source');
 assert.ok(!publicCourierEnabled||recipientHTTPEnabled,'Public courier qualification requires the six original stages');
 const network=await disposableNetwork(t),{guardian,sender,checker,relay}=network.people,{read,submit,waitFor}=network;
 const f=await fixture(t,{nativeConfig:network.config,nativeEarningEnabled:true,nativePaymentEnabled:true});
 for(const actor of Object.values(network.people)){const registration=await f.request(actor,'POST','/api/account',{displayName:actor.member.name});assert.equal(registration.status,201,JSON.stringify(registration.body))}
 const evidence=sha('Fictional disposable BAINK E2E evidence; no research or production claim');
 const activationEvidence=bountyEnabled?'c8467e4fd7624d7744f6d44a947513b8e4d94becd6f5a7189ff55648384b6fe4':evidence;
 for(const [operation,policy,extra] of [['activate_storage','compact-state-v1',{}],['activate_membership','project-membership-v1',{}],['activate_operator_rewards','pairwise-operator-rewards-v1',{}],['activate_private_exchange','orchard-v2-reviewed-otc-v1',{relayer:relay.address}],['activate_coin','verified-bounties-108t-micro-v1',{}]])await submit(operation,{policy,evidence_digest:activationEvidence,...extra});
 // These are fictional operator proofs on the private genesis only. They do
 // not attest DNS control or imply independence of any real production actor.
 for(const [index,actor] of [sender,checker,guardian].entries()) {
  await submit('identity_claim',{operator:actor.member.operator},actor);
  await submit('operator_claim',{domain:`fictional-e2e-${index}.example`},actor);
  const claim=(await read({keys:[`operator_claim/${actor.address}/`]})).state.records[`operator_claim/${actor.address}/`];
  await submit('operator_attest',{member:actor.address,domain:claim.domain,claim_event_id:claim.event_id,txt:`uain-operator=${claim.did}`,checked_at:new Date().toISOString(),evidence_digest:evidence});
 }
 const priorArt={basis:'Fictional disposable qualification problem only, never production research or a real novelty assertion.',searches:['first fictional prior-art query','second fictional prior-art query']};
 await submit('open_project',{id:'P-fictional-baink',title:'Fictional BAINK earning qualification',class:'benevolent',prior_art:priorArt},sender);
 for(const actor of [checker,guardian])await submit('project_join',{project:'P-fictional-baink'},actor);
 await submit('open_task',{id:'T-fictional-baink',project:'P-fictional-baink',title:'Fictional prospective bounty',class:'benevolent',prior_art:priorArt,criteria:'Fictional independent novelty checks against disposable data only.',kind:'instant',karma_reward:13,credit_reward:'13',verifiers_required:2},sender);
 const openEvent=(await read({})).state.event_count.padStart(20,'0');
 async function request(actor,path,body={},status=200){const response=await f.request(actor,'POST',path,body);assert.equal(response.status,status,`${path}: ${JSON.stringify(response.body)}`);return response.body}
 async function prepare(actor,operation,payload,key){return (await request(actor,'/api/native/earning/prepare',{clientRequestId:key,operation,payload},201)).intent}
 async function sendAndFinalize(actor,intent) {
  const envelope=signedEnvelope(intent.command,Buffer.from(actor.member.public_key,'base64url'),actor.privateKey);
  const result=await request(actor,`/api/native/earning/${intent.id}/submit`,{envelope},202);assert.equal(result.attempted,true);assert.equal(result.intent.status,'accepted');
  const finalized=await waitFor(async()=>{const response=await f.request(actor,'POST',`/api/native/earning/${intent.id}/receipt`,{});if(response.status===200&&response.body.intent?.result?.verified&&response.body.intent.finalized)return response.body.intent;throw new Error(`Receipt pending: ${response.status} ${JSON.stringify(response.body)}`)},`BAINK exact ${intent.command.operation} receipt`);
  assert.equal(finalized.receipt.event.command_digest,intent.commandDigest);assert.equal(finalized.receipt.authority,'native');assert.equal(finalized.result.proof.verifierSha256,TOOL_PINS.reader);assert.equal(finalized.result.proof.genesisSha256,network.config.genesisHash);return {intent:finalized,envelope};
 }
 const quote=await prepare(sender,'coin_quote',{task:'T-fictional-baink',open_event:openEvent,amount:'5000000',evidence_digest:evidence},'fictional-quote-001');
 const altered={...quote.command,payload:{...quote.command.payload,amount:'5000001'}};
 await request(sender,`/api/native/earning/${quote.id}/submit`,{envelope:signedEnvelope(altered,Buffer.from(sender.member.public_key,'base64url'),sender.privateKey)},400);
 const duplicate=await f.request(sender,'POST','/api/native/earning/prepare',{clientRequestId:'fictional-quote-002',operation:'coin_quote',payload:quote.command.payload});assert.equal(duplicate.status,409,'second unfinalized intent must not compete for one sequence');
 await sendAndFinalize(sender,quote);
 const reserve=await prepare(guardian,'coin_reserve',{task:'T-fictional-baink',evidence_digest:evidence},'fictional-reserve-001');await sendAndFinalize(guardian,reserve);
 const discovery=await request(sender,'/api/native/earning/discover',{afterEvent:'0'});assert.ok(JSON.stringify(discovery).includes('T-fictional-baink'),'discovery lists only actual reserved native task');
 await submit('submit',{id:'RC-fictional-baink',task:'T-fictional-baink',evidence_digest:evidence},sender);
 await request(sender,'/api/native/earning/prepare',{clientRequestId:'fictional-too-early-claim',operation:'coin_claim',payload:{contribution:'RC-fictional-baink'}},409);
 const check={contribution:'RC-fictional-baink',verdict:'confirm',novelty:'new',searches:priorArt.searches,evidence_digest:evidence};await submit('verify',check,checker);await submit('verify',check,guardian);
 const contribution=(await read({keys:['contribution/RC-fictional-baink']})).state.records['contribution/RC-fictional-baink'];assert.equal(contribution.settlement.factor_numerator,1);assert.equal(contribution.settlement.factor_denominator,1);assert.ok(contribution.settlement.independent_operators>=2);assert.equal(contribution.settlement.other_family,true);assert.equal(contribution.settlement.check_refs.length,2);
 const claim=await prepare(sender,'coin_claim',{contribution:'RC-fictional-baink'},'fictional-claim-001'),earned=await sendAndFinalize(sender,claim);assert.equal(earned.intent.result.status,'earned');assert.equal(earned.intent.result.amountUnits,'5000000');
 const repeated=await request(sender,`/api/native/earning/${claim.id}/submit`,{envelope:earned.envelope});assert.equal(repeated.attempted,false);
 await request(sender,'/api/native/earning/prepare',{clientRequestId:'fictional-claim-replay',operation:'coin_claim',payload:{contribution:'RC-fictional-baink'}},409);
 await submit('coin_claim',{contribution:'RC-fictional-baink'},sender,false);
 const keys=['coin_supply',`coin_balance/${sender.address}`,'coin_reward/RC-fictional-baink','coin_reservation/T-fictional-baink'];
 const before=await read({keys});assert.deepEqual(before.state.records.coin_supply,{minted:'5000000',reserved:'0',transparent:'5000000',shielded:'0'});assert.equal(before.state.records[`coin_balance/${sender.address}`],'5000000');
 await waitFor(async()=>{const peer=await network.peer.publicState({keys});assert.deepEqual(peer.state.records,before.state.records);return true},'two-node proven earning convergence');
 await f.restart();await network.restart();
 const recovered=await waitFor(async()=>{const response=await f.request(sender,'POST',`/api/native/earning/${claim.id}/receipt`,{});if(response.status===200&&response.body.intent?.result?.verified)return response.body.intent;throw new Error(`Restart receipt pending: ${response.status} ${JSON.stringify(response.body)}`)},'exact receipt after BAINK and daemon restart');assert.equal(recovered.receipt.event.command_digest,claim.commandDigest);assert.equal(recovered.result.status,'earned');
 assert.deepEqual((await read({keys})).state.records,before.state.records);await waitFor(async()=>{assert.deepEqual((await network.peer.publicState({keys})).state.records,before.state.records);return true},'two-node proven convergence after restart');await submit('coin_claim',{contribution:'RC-fictional-baink'},sender,false);
 const account=await f.request(sender,'GET','/api/account');assert.equal(account.status,200);assert.equal(account.body.account.native.balanceUnits,'5000000');assert.equal(account.body.account.native.verified,true);
 if(earningRecoveryEnabled){const {exerciseNativeEarningRecovery}=await import('./native-earning-recovery-e2e-stage.mjs');await exerciseNativeEarningRecovery({t,network})}
 if(bountyEnabled){const {exerciseNativeBountyOpening}=await import('./native-bounty-opening-e2e-stage.mjs');await exerciseNativeBountyOpening({t,network})}
 if(publicCourierEnabled){const{exerciseNativePublicCourier}=await import('./native-public-review-e2e-stage.mjs');await exerciseNativePublicCourier({t,network});}
 t.diagnostic(JSON.stringify({fixtureOnly:true,chainId:network.config.chainId,genesisSha256:network.config.genesisHash,daemonSha256:TOOL_PINS.daemon,readerSha256:TOOL_PINS.reader,realDaemonProcesses:2,independentProductionOperators:false,earningHttpVerified:true,exactReceiptAfterRestart:true,fixtureMintedUnits:'5000000',privatePaymentStage:privateEnabled?'actual Orchard and BAINK stage completed':'not exercised by earning qualification',productionWrites:false}));
});
