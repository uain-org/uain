import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync,createHash,sign } from 'node:crypto';
import { createNativeProjectPilotService } from '../server/native-project-pilot.mjs';
import { researchEvidence } from '../../../chain/client/evidence-document.mjs';
import { signingBytes } from '../../../chain/client/signing.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const prior_art={basis:'Synthetic integration fixture only; this is never a production scientific novelty claim.',searches:['https://fixture.invalid/source-one','https://fixture.invalid/source-two']};
function actor(){const {publicKey,privateKey}=generateKeyPairSync('ed25519'),raw=publicKey.export({type:'spki',format:'der'}).subarray(-32);return{user:{address:'uain1'+sha(raw).slice(0,40),publicKey:raw.toString('base64')},key:raw.toString('base64url'),privateKey};}
function fixture(){
 const a=actor(),other=actor(),instance='pilot-instance';
 const config={sourceId:'OPP-00002',sourceDigest:'a'.repeat(64),projectId:'pilot-project',taskId:'pilot-task',creatorAddress:a.user.address,creatorInstance:instance,chainId:'isolated-pilot',epoch:'b'.repeat(64),projectPayload:{id:'pilot-project',title:'Synthetic native project fixture',class:'neutral',prior_art},taskPayload:{id:'pilot-task',project:'pilot-project',title:'Synthetic native task fixture',class:'neutral',prior_art,criteria:'A synthetic fixture acceptance check with no scientific or monetary entitlement.',kind:'instant',karma_reward:0,credit_reward:'0'}};
 const m={id:a.user.address,public_key:a.key,licence:'active',sequence:'1',creator:true,karma:0,active_projects:0,default_verifier:false};
 const state={chain_id:config.chainId,height:'100',app_hash:'c'.repeat(64),event_count:'0',member:m,records:{['instance/'+instance]:{id:instance,member:a.user.address,state:'active'}}};
 let data={},sends=0,lost=false,proofPatch={},receipt=null,queue=Promise.resolve();
 const store={read:()=>structuredClone(data),transact(fn){const run=queue.then(()=>{const next=structuredClone(data),value=fn(next);data=next;return structuredClone(value);});queue=run.catch(()=>{});return run;}};
 const native={configured:true,pins:{chainId:config.chainId,epoch:config.epoch,verifierSha256:'d'.repeat(64)},timeoutMs:1000,async publicState(selection){const records=Object.fromEntries((selection.keys??[]).map(k=>[k,state.records[k]??null]));return{state:{...structuredClone(state),records,...(selection.receipt?{receipt:structuredClone(receipt)}:{})},proof:{authority:'native',chainId:state.chain_id,height:state.height,appHash:state.app_hash,epoch:config.epoch,verifierSha256:'d'.repeat(64),headerTime:new Date().toISOString(),maxAgeSeconds:120,...proofPatch}};},async broadcastResearch(envelope){sends++;assert.ok(Object.values(data.nativeProjectPilotIntents).find(i=>i.envelope&&i.sendAttemptedAt));if(lost)throw Error('lost response');return{accepted:true,code:0,transactionHash:sha(JSON.stringify(envelope)).toUpperCase()};}};
 let service=createNativeProjectPilotService({store,native,config,enabled:true,sourceDigest:()=>config.sourceDigest});
 const body=(operation='open_project',payload=config.projectPayload)=>({clientRequestId:'request-'+operation,sourceDigest:config.sourceDigest,operation,instance,payload:structuredClone(payload)});
 const signed=intent=>({envelope:{command:structuredClone(intent.command),public_key:a.key,signature:sign(null,Buffer.from(intent.signingBytesBase64,'base64'),a.privateKey).toString('base64url')}});
 function finalize(intent){const c=intent.command,p=c.payload,id=String(BigInt(state.event_count)+1n),e={id,member:a.user.address,instance,operation:c.operation,subject:p.id??p.contribution??p.project,command_digest:intent.commandDigest};state.event_count=id;state.height=String(BigInt(state.height)+1n);m.sequence=String(BigInt(m.sequence)+1n);state.records['event/'+id.padStart(20,'0')]=e;
  if(c.operation==='open_project')state.records['project/'+config.projectId]={...p,lead:a.user.address,lead_instance:instance,state:'active',budget:'0'};
  if(c.operation==='open_task')state.records['task/'+config.taskId]={...p,opened_by_instance:instance,state:'open'};
  if(c.operation==='project_join')state.records[`participation/${config.projectId}/${a.user.address}/${instance}`]={project:config.projectId,member:a.user.address,instance};
  if(c.operation==='submit')state.records['contribution/'+p.id]={id:p.id,task:p.task,author:a.user.address,author_instance:instance,evidence_digest:p.evidence_digest,state:'held'};
  receipt={authority:'native',finalized:true,chain_id:state.chain_id,state_height:state.height,app_hash:state.app_hash,event:e};
 }
 return{a,other,instance,config,m,state,native,store,body,signed,finalize,get service(){return service;},get sends(){return sends;},get receipt(){return receipt;},get data(){return data;},restart(){service=createNativeProjectPilotService({store,native,config,enabled:true,sourceDigest:()=>config.sourceDigest});},lose(){lost=true;},patchProof(x){proofPatch=x;}};
}
const rejects=(p,code)=>assert.rejects(p,e=>e.code===code);
async function sendFinal(f,body){const {intent}=await f.service.prepare(f.a.user,body);await f.service.submit(f.a.user,intent.id,f.signed(intent));f.finalize(intent);return(await f.service.receipt(f.a.user,intent.id,{})).intent;}
function existing(f){f.state.records['project/'+f.config.projectId]={id:f.config.projectId,lead:f.a.user.address,lead_instance:f.instance,state:'active'};f.state.records['task/'+f.config.taskId]={...f.config.taskPayload,state:'open'};}

test('one frozen source opens project and task using canonical CLI-compatible bytes and exact finalized receipts',async()=>{
 const f=fixture(),first=await f.service.prepare(f.a.user,f.body());assert.equal(f.sends,0);assert.deepEqual(Buffer.from(first.intent.signingBytesBase64,'base64'),signingBytes(first.intent.command));assert.equal((await f.service.prepare(f.a.user,f.body())).intent.id,first.intent.id);
 await f.service.submit(f.a.user,first.intent.id,f.signed(first.intent));f.finalize(first.intent);assert.equal((await f.service.receipt(f.a.user,first.intent.id,{})).intent.finalized,true);
 const task=await sendFinal(f,f.body('open_task',f.config.taskPayload));assert.equal(task.finalized,true);assert.equal(f.sends,2);assert.equal((await f.service.snapshot(f.a.user)).task.id,f.config.taskId);
});
test('join, domain-bound research body and independent review use actual native operations, not local acceptance',async()=>{
 const f=fixture();existing(f);await sendFinal(f,f.body('project_join',{project:f.config.projectId}));
 const body={title:'Synthetic fixture only',detail:'This is a synthetic isolated integration fixture; never a production discovery.',evidence:{nested:[true,false,null,1.25]},sources:['https://fixture.invalid']},doc=researchEvidence(body),b={...f.body('submit',{id:'result-one',task:f.config.taskId,evidence_digest:doc.digest}),body};
 const result=await sendFinal(f,b);assert.equal((await f.service.prepare(f.a.user,b)).intent.id,result.id);assert.equal(result.finalized,true);assert.deepEqual(result.publicBody,doc.body);assert.equal((await f.service.snapshot(f.a.user,{contributionId:'result-one'})).contribution.state,'held');
 await rejects(f.service.prepare(f.a.user,f.body('verify',{contribution:'result-one',verdict:'confirm',novelty:'new',searches:prior_art.searches,evidence_digest:'e'.repeat(64)})),'native_self_review');
 f.state.records['contribution/peer-result']={id:'peer-result',task:f.config.taskId,author:f.other.user.address,state:'held'};f.m.karma=100;
 assert.equal((await sendFinal(f,f.body('verify',{contribution:'peer-result',verdict:'confirm',novelty:'new',searches:prior_art.searches,evidence_digest:'e'.repeat(64)}))).finalized,true);
});
test('source/op/payload/evidence and actor scope cannot be widened by API caller',async()=>{
 for(const [mutate,code] of [
  [b=>{b.sourceDigest='e'.repeat(64);},'native_source_changed'],
  [b=>{b.operation='coin_claim';},'invalid_native_pilot_payload'],
  [b=>{b.payload.title='Changed title';},'native_pilot_scope_mismatch'],
  [b=>{b.payload.extra=true;},'invalid_native_pilot_payload'],
  [b=>{b.instance='other-instance';},'native_instance_not_owned'],
 ]){const f=fixture(),b=f.body();mutate(b);await rejects(f.service.prepare(f.a.user,b),code);assert.equal(f.sends,0);}
 const f=fixture();existing(f);await rejects(f.service.prepare(f.a.user,{...f.body('submit',{id:'result',task:f.config.taskId,evidence_digest:'e'.repeat(64)}),body:{title:'Fixture',detail:'Enough fixture detail to be valid but the digest does not match.'}}),'native_evidence_digest_mismatch');
 await rejects(f.service.snapshot(f.a.user,{contributionId:'../escape'}),'invalid_native_pilot_fields');
 f.state.records['contribution/other-task']={id:'other-task',task:'not-pilot'};await rejects(f.service.snapshot(f.a.user,{contributionId:'other-task'}),'native_pilot_contribution_missing');
});
test('ownership, licence, Creator and reviewer gates fail closed without fake roles',async()=>{
 for(const [mutate,code] of [[f=>{f.m.licence='pending';},'native_licence_inactive'],[f=>{f.m.creator=false;},'native_creator_required'],[f=>{f.state.records['instance/'+f.instance].member=f.other.user.address;},'native_instance_not_owned'],[f=>{f.m.public_key='bad';},'native_proof_unavailable']]){const f=fixture();mutate(f);await rejects(f.service.prepare(f.a.user,f.body()),code);}
 const f=fixture();existing(f);f.state.records['contribution/peer-result']={id:'peer-result',task:f.config.taskId,author:f.other.user.address,state:'held'};
 await rejects(f.service.prepare(f.a.user,f.body('verify',{contribution:'peer-result',verdict:'confirm',novelty:'new',searches:prior_art.searches,evidence_digest:'e'.repeat(64)})),'native_reviewer_required');
});
test('lost broadcast response is durable across restart; never signs or sends replacement',async()=>{
 const f=fixture(),{intent}=await f.service.prepare(f.a.user,f.body());f.lose();assert.equal((await f.service.submit(f.a.user,intent.id,f.signed(intent))).intent.status,'unknown');f.restart();
 assert.equal((await f.service.submit(f.a.user,intent.id,f.signed(intent))).attempted,false);assert.equal(f.sends,1);
 await rejects(f.service.prepare(f.a.user,{...f.body(),clientRequestId:'replacement-id'}),'native_pilot_intent_pending');
 assert.equal(f.service.list(f.other.user).intents.length,0);await rejects(f.service.receipt(f.other.user,intent.id,{}),'native_pilot_intent_missing');
 f.finalize(intent);assert.equal((await f.service.receipt(f.a.user,intent.id,{})).intent.finalized,true);assert.equal(f.sends,1);
});
test('wrong or stale proof, changed sequence/signature and misleading receipt cannot finalize',async()=>{
 for(const patch of [{epoch:'e'.repeat(64)},{headerTime:new Date(0).toISOString()},{chainId:'other'},{verifierSha256:'f'.repeat(64)}]){const f=fixture();f.patchProof(patch);await rejects(f.service.prepare(f.a.user,f.body()),'native_proof_unavailable');}
 const f=fixture(),{intent}=await f.service.prepare(f.a.user,f.body());const bad=f.signed(intent);bad.envelope.command.payload.title='Altered';await rejects(f.service.submit(f.a.user,intent.id,bad),'native_envelope_mismatch');
 f.m.sequence='2';await rejects(f.service.submit(f.a.user,intent.id,f.signed(intent)),'native_sequence_changed');f.m.sequence='1';await f.service.submit(f.a.user,intent.id,f.signed(intent));f.finalize(intent);f.receipt.event.instance='wrong-instance';await rejects(f.service.receipt(f.a.user,intent.id,{}),'native_proof_unavailable');
});
test('disabled/missing configuration cannot prepare and configuration freezes against caller mutation',async()=>{
 const f=fixture();assert.equal(createNativeProjectPilotService({store:f.store,native:f.native}).enabled,false);await rejects(createNativeProjectPilotService({store:f.store,native:f.native}).prepare(f.a.user,f.body()),'native_pilot_disabled');
 f.config.projectPayload.title='Mutation';assert.equal(f.service.configView().projectPayload.title,'Synthetic native project fixture');
 const another=createNativeProjectPilotService({store:f.store,native:f.native,config:{...f.config,sourceDigest:'e'.repeat(64)},enabled:true,sourceDigest:()=> 'e'.repeat(64)});await rejects(another.prepare(f.a.user,f.body()),'native_source_changed');
});
test('current catalogue digest is checked before prepare/send while receipt recovery survives source drift',async()=>{
 const f=fixture();let current=f.config.sourceDigest;
 const service=createNativeProjectPilotService({store:f.store,native:f.native,config:f.config,enabled:true,sourceDigest:()=>current});
 const {intent}=await service.prepare(f.a.user,f.body());current='f'.repeat(64);
 await rejects(service.submit(f.a.user,intent.id,f.signed(intent)),'native_source_changed');assert.equal(f.sends,0);
 current=f.config.sourceDigest;await service.submit(f.a.user,intent.id,f.signed(intent));f.finalize(intent);current='f'.repeat(64);
 assert.equal((await service.receipt(f.a.user,intent.id,{})).intent.finalized,true);
});
test('public evidence publication requires finalized exact owned submission, separate from chain acceptance',async()=>{
 const f=fixture();existing(f);
 const body={title:'Synthetic fixture',detail:'This exact public fixture is not a scientific discovery or a monetary claim.'},doc=researchEvidence(body),b={...f.body('submit',{id:'publish-one',task:f.config.taskId,evidence_digest:doc.digest}),body};
 const {intent}=await f.service.prepare(f.a.user,b);
 await rejects(f.service.publish(f.a.user,intent.id,{}),'native_pilot_publication_not_ready');
 await f.service.submit(f.a.user,intent.id,f.signed(intent));f.finalize(intent);await f.service.receipt(f.a.user,intent.id,{});
 await rejects(f.service.publish(f.other.user,intent.id,{}),'native_pilot_intent_missing');
 let publishes=0;
 f.native.publishResearch=async(request,expected)=>{publishes++;assert.deepEqual(request.body,doc.body);assert.equal(request.envelope.signature,f.signed(intent).envelope.signature);assert.equal(request.event_id,'1');return{published:true,...expected};};
 assert.equal((await f.service.publish(f.a.user,intent.id,{})).intent.publication.status,'published');
 assert.equal((await f.service.publish(f.a.user,intent.id,{})).intent.publication.status,'published');assert.equal(publishes,1);assert.equal(f.sends,1);
});
test('cross-service unresolved sends block new pilot command and input config drift cannot resume old intent',async()=>{
 const f=fixture();await f.store.transact(s=>{s.nativeInstanceIntents={other:{member:f.a.user.address,status:'unknown',sendAttemptedAt:new Date().toISOString()}};});
 await rejects(f.service.prepare(f.a.user,f.body()),'native_pilot_other_intent_pending');
 const g=fixture(),{intent}=await g.service.prepare(g.a.user,g.body());
 const changed={...g.config,sourceDigest:'e'.repeat(64)};
 const service=createNativeProjectPilotService({store:g.store,native:g.native,config:changed,enabled:true,sourceDigest:()=>changed.sourceDigest});
 await rejects(service.submit(g.a.user,intent.id,g.signed(intent)),'native_pilot_config_changed');
});
test('actual persisted store survives recreation after lost response and marker precedes network call',async t=>{
 const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'pilot-restart-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'state.json');
 const f=fixture();let data={},queue=Promise.resolve(),sends=0;
 const store={read:()=>structuredClone(data),transact(fn){const op=queue.then(async()=>{const next=structuredClone(data),answer=fn(next);await writeFile(path,JSON.stringify(next));data=next;return structuredClone(answer);});queue=op.catch(()=>{});return op;}};
 const native={...f.native,async broadcastResearch(){sends++;assert.ok(Object.values(JSON.parse(await readFile(path))).flatMap(x=>Object.values(x)).find(i=>i.sendAttemptedAt&&i.envelope));throw Error('response lost');}};
 let service=createNativeProjectPilotService({store,native,config:f.config,enabled:true,sourceDigest:()=>f.config.sourceDigest});
 const {intent}=await service.prepare(f.a.user,f.body());await service.submit(f.a.user,intent.id,f.signed(intent));data=JSON.parse(await readFile(path));
 service=createNativeProjectPilotService({store,native,config:f.config,enabled:true,sourceDigest:()=>f.config.sourceDigest});
 assert.equal((await service.submit(f.a.user,intent.id,f.signed(intent))).attempted,false);assert.equal(sends,1);assert.equal(service.list(f.a.user).intents[0].status,'unknown');
});
test('explicit proved expired-unincluded recovery unlocks a new deliberate intent but never replays the old send',async()=>{
 const f=fixture(),{intent}=await f.service.prepare(f.a.user,f.body());f.lose();await f.service.submit(f.a.user,intent.id,f.signed(intent));
 await rejects(f.service.recover(f.a.user,intent.id,{}),'native_pilot_not_expired');
 f.state.height='201';const recovered=await f.service.recover(f.a.user,intent.id,{});assert.equal(recovered.intent.status,'expired_unincluded');assert.equal(f.sends,1);
 const next=await f.service.prepare(f.a.user,{...f.body(),clientRequestId:'deliberate-new-intent'});assert.notEqual(next.intent.id,intent.id);assert.equal(f.sends,1);
 assert.equal((await f.service.submit(f.a.user,intent.id,f.signed(intent))).attempted,false);assert.equal(f.sends,1);
});
test('expired recovery scans bounded pages, proves all events, and prefers found finality over expiry',async()=>{
 const f=fixture(),{intent}=await f.service.prepare(f.a.user,f.body());f.lose();await f.service.submit(f.a.user,intent.id,f.signed(intent));
 f.state.height='250';f.state.event_count='33';for(let n=1;n<=33;n++)f.state.records['event/'+String(n).padStart(20,'0')]={id:String(n),command_digest:'f'.repeat(64)};
 const partial=await f.service.recover(f.a.user,intent.id,{});assert.equal(partial.recoveryPending,true);assert.equal(partial.intent.scanCursor,'32');assert.notEqual(partial.intent.status,'expired_unincluded');
 assert.equal((await f.service.recover(f.a.user,intent.id,{})).intent.status,'expired_unincluded');assert.equal(f.sends,1);
 const g=fixture(),{intent:i}=await g.service.prepare(g.a.user,g.body());await g.service.submit(g.a.user,i.id,g.signed(i));g.finalize(i);g.state.height='250';g.receipt.state_height='250';assert.equal((await g.service.recover(g.a.user,i.id,{})).intent.finalized,true);assert.equal(g.sends,1);
});
test('native enrolment journal uses actual nativeIntents collection and prevents racing pilot signing',async()=>{
 const f=fixture();await f.store.transact(s=>{s.nativeIntents={enrol:{member:f.a.user.address,status:'unknown',sendAttemptedAt:'2026-11-05T00:00:00Z'}};});await rejects(f.service.prepare(f.a.user,f.body()),'native_pilot_other_intent_pending');
});
test('compact native record snapshots keep authoritative state without pretending missing metadata is local acceptance',async()=>{
 const f=fixture();existing(f);f.state.records['project/'+f.config.projectId]={id:f.config.projectId,lead:f.a.user.address,lead_instance:f.instance,state:'active',metadata_digest:'e'.repeat(64),storage_policy:'compact-state-v1'};
 const got=await f.service.snapshot(f.a.user,{});assert.equal(got.authority,'native');assert.equal(got.project.state,'active');assert.equal(got.project.title,undefined);assert.equal(got.config.scientificAcceptance,false);
 await rejects(f.service.snapshot(f.a.user,{contributionId:'none',owner:'someone'}),'invalid_native_pilot_fields');
});
test('proof is rechecked inside queued prepare and irreversible send marker transactions',async()=>{
 for(const phase of ['prepare','submit']){
  const f=fixture();let shift=false;
  const store={read:f.store.read,transact(fn){return f.store.transact(s=>{if(!shift)return fn(s);const original=Date.now;Date.now=()=>original()+180000;try{return fn(s);}finally{Date.now=original;}});}};
  const service=createNativeProjectPilotService({store,native:f.native,config:f.config,enabled:true,sourceDigest:()=>f.config.sourceDigest});
  if(phase==='prepare'){shift=true;await rejects(service.prepare(f.a.user,f.body()),'native_proof_unavailable');assert.equal(service.list(f.a.user).intents.length,0);}
  else{const {intent}=await service.prepare(f.a.user,f.body());shift=true;await rejects(service.submit(f.a.user,intent.id,f.signed(intent)),'native_proof_unavailable');assert.equal(service.list(f.a.user).intents[0].sendAttemptedAt,null);}
  assert.equal(f.sends,0);
 }
});
test('interleaving an unresolved other-service transaction after prepare prevents pilot network send',async()=>{
 for(const collection of ['nativeIntents','nativeInstanceIntents','nativeEarningIntents','centralEarningIntents','nativePaymentIntents']){
  const f=fixture(),{intent}=await f.service.prepare(f.a.user,f.body());
  await f.store.transact(s=>{s[collection]={other:{[collection==='nativePaymentIntents'?'payer':'member']:f.a.user.address,status:'unknown',sendAttemptedAt:'2026-11-05T00:00:00Z'}};});
  await rejects(f.service.submit(f.a.user,intent.id,f.signed(intent)),'native_pilot_other_intent_pending');assert.equal(f.sends,0);assert.equal(f.service.list(f.a.user).intents[0].sendAttemptedAt,null);
 }
});
test('actual payer-shaped private payment journals block prepare until ledger finality, not merely accepted status',async()=>{
 for(const status of ['unknown','accepted','ledger-recorded','recipient-confirmed-paid']){
  const f=fixture();await f.store.transact(s=>{s.nativePaymentIntents={payment:{payer:f.a.user.address,status,sendAttemptedAt:'2026-11-05T00:00:00Z'}};});
  if(['ledger-recorded','recipient-confirmed-paid'].includes(status))assert.equal((await f.service.prepare(f.a.user,f.body())).created,true);
  else await rejects(f.service.prepare(f.a.user,f.body()),'native_pilot_other_intent_pending');
  assert.equal(f.sends,0);
 }
});
test('slow durable fsync resolving after the send budget keeps unknown journal and never broadcasts',async()=>{
 const f=fixture(),original=Date.now;let late=false,shifted=false;
 const store={read:f.store.read,async transact(fn){const result=await f.store.transact(fn);if(late&&!shifted){shifted=true;Date.now=()=>original()+180000;}return result;}};
 const service=createNativeProjectPilotService({store,native:f.native,config:f.config,enabled:true,sourceDigest:()=>f.config.sourceDigest});
 const {intent}=await service.prepare(f.a.user,f.body());late=true;
 try{const result=await service.submit(f.a.user,intent.id,f.signed(intent));assert.equal(result.attempted,false);assert.equal(result.intent.status,'unknown');assert.ok(result.intent.envelope);assert.ok(result.intent.sendAttemptedAt);assert.equal(f.sends,0);}finally{Date.now=original;}
 assert.equal((await service.submit(f.a.user,intent.id,f.signed(intent))).attempted,false);assert.equal(f.sends,0);
});
test('pinned reader exact int64 strings and safe fixture integers enforce identical reviewer thresholds',async()=>{
 for(const karma of ['100',100,'9223372036854775807']){
  const f=fixture();existing(f);f.m.karma=karma;f.state.records['contribution/peer-result']={id:'peer-result',task:f.config.taskId,author:f.other.user.address,state:'held'};
  assert.equal((await f.service.prepare(f.a.user,f.body('verify',{contribution:'peer-result',verdict:'confirm',novelty:'new',searches:prior_art.searches,evidence_digest:'e'.repeat(64)}))).created,true);
 }
 for(const karma of ['99',99,'0100','100.0','-100',-100,100.1,'9223372036854775808',9007199254740992,null]){
  const f=fixture();existing(f);f.m.karma=karma;f.state.records['contribution/peer-result']={id:'peer-result',task:f.config.taskId,author:f.other.user.address,state:'held'};
  await rejects(f.service.prepare(f.a.user,f.body('verify',{contribution:'peer-result',verdict:'confirm',novelty:'new',searches:prior_art.searches,evidence_digest:'e'.repeat(64)})),'native_reviewer_required');assert.equal(f.sends,0);
 }
});
test('creator Karma allowance works on exact standing strings without loosening project limit',async()=>{
 for(const [karma,active,allowed] of [['1000','0',true],[1000,0,true],['1010','1',true],['1000','1',false],['999','0',false],['1000','00',false],['1000','-1',false],['9223372036854775808','0',false]]){
  const f=fixture();f.m.creator=false;f.m.karma=karma;f.m.active_projects=active;
  if(allowed)assert.equal((await f.service.prepare(f.a.user,f.body())).created,true);
  else await rejects(f.service.prepare(f.a.user,f.body()),'native_creator_required');
 }
});

test('approved admission config loads and prepares exact multiline native payloads',async()=>{
 const {freezeProjectAdmission,projectAdmissionPilotConfig}=await import('../../../chain/client/project-admission.mjs');
 const f=fixture();
 const plan=freezeProjectAdmission({scope:{chainId:f.config.chainId,genesisSha256:f.config.epoch,member:f.a.user.address,instance:f.instance},source:{id:f.config.sourceId,digest:f.config.sourceDigest},decision:{status:'approved',...prior_art},project:f.config.projectPayload,task:{...f.config.taskPayload,criteria:'Research question: test an isolated bounded fixture.\nAcceptance criteria: verify its exact output.'}});
 const config=projectAdmissionPilotConfig(plan),service=createNativeProjectPilotService({store:f.store,native:f.native,config,enabled:true,sourceDigest:()=>config.sourceDigest});
 const prepared=await service.prepare(f.a.user,f.body('open_project',config.projectPayload));
 assert.deepEqual(Buffer.from(prepared.intent.signingBytesBase64,'base64'),signingBytes(prepared.intent.command));
 assert.ok(prepared.intent.command.payload.prior_art.basis.includes('\nSource '));
});
test('changed pilot config retains original finality recovery and cannot send an old action',async()=>{
 const f=fixture(),{intent}=await f.service.prepare(f.a.user,f.body());await f.service.submit(f.a.user,intent.id,f.signed(intent));f.finalize(intent);
 const config={...f.config,sourceDigest:'f'.repeat(64),projectId:'replacement-project',taskId:'replacement-task',projectPayload:{...f.config.projectPayload,id:'replacement-project'},taskPayload:{...f.config.taskPayload,id:'replacement-task',project:'replacement-project'}};
 const service=createNativeProjectPilotService({store:f.store,native:f.native,config,enabled:true,sourceDigest:()=>config.sourceDigest});
 assert.equal(service.list(f.a.user).intents[0]?.id,intent.id);
 await rejects(service.submit(f.a.user,intent.id,f.signed(intent)),'native_pilot_config_changed');
 assert.equal((await service.receipt(f.a.user,intent.id,{})).intent.finalized,true);assert.equal(f.sends,1);
});
test('removed configuration permits proved noninclusion recovery and releases sequence fence',async()=>{
 const {hasPendingPilotSend}=await import('../server/native-pilot-sequence.mjs');
 const f=fixture(),{intent}=await f.service.prepare(f.a.user,f.body());f.lose();await f.service.submit(f.a.user,intent.id,f.signed(intent));f.state.height='250';
 const service=createNativeProjectPilotService({store:f.store,native:f.native});
 assert.equal(service.list(f.a.user).intents[0]?.id,intent.id);
 await rejects(service.recover(f.other.user,intent.id,{}),'native_pilot_intent_missing');
 assert.equal((await service.recover(f.a.user,intent.id,{})).intent.status,'expired_unincluded');
 assert.equal(Boolean(hasPendingPilotSend(f.store.read(),f.a.user.address)),false);assert.equal(f.sends,1);
});
test('historical recovery refuses a reader repinned to a different epoch',async()=>{
 const f=fixture(),{intent}=await f.service.prepare(f.a.user,f.body());await f.service.submit(f.a.user,intent.id,f.signed(intent));f.state.height='250';
 f.native.pins.epoch='f'.repeat(64);
 const service=createNativeProjectPilotService({store:f.store,native:f.native});
 await rejects(service.recover(f.a.user,intent.id,{}),'native_proof_unavailable');assert.equal(f.sends,1);
});

test('finalized original evidence can publish after config removal without another chain send',async()=>{
 const f=fixture();existing(f);const body={title:'Historical fixture',detail:'An immutable historical fixture body retained until the holder publishes it.'};
 const intent=await sendFinal(f,{...f.body('submit',{id:'historical-result',task:f.config.taskId,evidence_digest:researchEvidence(body).digest}),body});
 const service=createNativeProjectPilotService({store:f.store,native:f.native});let calls=0;
 f.native.publishResearch=async(document,expected)=>{calls++;assert.deepEqual(document.body,body);assert.equal(expected.epoch,f.config.epoch);assert.equal(document.event_id,intent.receipt.event.id);return{published:true,...expected};};
 await rejects(service.publish(f.other.user,intent.id,{}),'native_pilot_intent_missing');
 f.native.pins.epoch='f'.repeat(64);await rejects(service.publish(f.a.user,intent.id,{}),'native_pilot_publication_unavailable');assert.equal(calls,0);f.native.pins.epoch=f.config.epoch;
 assert.equal((await service.publish(f.a.user,intent.id,{})).intent.publication.status,'published');
 assert.equal((await service.publish(f.a.user,intent.id,{})).intent.publication.status,'published');assert.equal(calls,1);assert.equal(f.sends,1);
});

test('proved expired-unused earning sends do not strand a new pilot action',async()=>{
 const f=fixture();await f.store.transact(s=>{s.nativeEarningIntents={old:{member:f.a.user.address,status:'expired-unused',sendAttemptedAt:'2026-11-05T00:00:00Z'}};});
 assert.equal((await f.service.prepare(f.a.user,f.body())).created,true);assert.equal(f.sends,0);
});

test('a member retrying an unpublished submission reaches uain.global at most four times a minute',async()=>{
 const f=fixture();existing(f);
 const body={title:'Synthetic fixture',detail:'This exact public fixture is not a scientific discovery or a monetary claim.'},doc=researchEvidence(body),b={...f.body('submit',{id:'publish-retry',task:f.config.taskId,evidence_digest:doc.digest}),body};
 const {intent}=await f.service.prepare(f.a.user,b);
 await f.service.submit(f.a.user,intent.id,f.signed(intent));f.finalize(intent);await f.service.receipt(f.a.user,intent.id,{});
 let calls=0;f.native.publishResearch=async()=>{calls++;throw new Error('upstream refused');};
 for(let i=0;i<4;i++)await rejects(f.service.publish(f.a.user,intent.id,{}),'native_pilot_publication_unavailable');
 await rejects(f.service.publish(f.a.user,intent.id,{}),'native_pilot_publication_rate_limited');
 assert.equal(calls,4,'the fifth attempt in a minute never reaches uain.global');
});
