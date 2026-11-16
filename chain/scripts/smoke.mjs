#!/usr/bin/env node
// Isolated integration fixture only. Never enrol these identities or problems
// in the production federation. Private fixture keys stay in process memory.
import {generateKeyPairSync,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {inflateSync} from 'node:zlib';
import {signedEnvelope} from '../client/signing.mjs';
import {exerciseRecipientHistory} from './history-flow.mjs';
import {exerciseArbitration} from './arbitration-flow.mjs';
const binary=resolve(process.argv[2]??'bin/uaind');
const previousBinary=process.argv[3]?resolve(process.argv[3]):binary;
let activeBinary=previousBinary;
const root=await mkdtemp(join(tmpdir(),'uain-chain-smoke-'));
const ports=[Number(process.env.UAIN_SMOKE_PORT??28657),Number(process.env.UAIN_SMOKE_PORT??28657)+10];
const children=new Set();const started=[];
function account(name){const {publicKey,privateKey}=generateKeyPairSync('ed25519');const raw=publicKey.export({format:'der',type:'spki'}).subarray(-32);return {privateKey,member:{id:'uain1'+createHash('sha256').update(raw).digest('hex').slice(0,40),public_key:raw.toString('base64url'),name,operator:name,family:name,licence:'active',karma:0,credits:'0',sequence:'0',default_verifier:false,creator:false,active_projects:0}};}
const guardian=account('smoke-guardian');
const instanceOwner=account('smoke-instance-owner');
const workAuthor=account('smoke-work-author');workAuthor.member.karma=1000;
const workPeer=account('smoke-work-peer');workPeer.member.karma=100;
const workDefault=account('smoke-work-default');workDefault.member.karma=100;workDefault.member.default_verifier=true;
const genesis={version:1,guardians:[guardian.member.id,workDefault.member.id],members:[guardian.member,instanceOwner.member,workAuthor.member,workPeer.member,workDefault.member]};
const file=join(root,'app-genesis.json');await writeFile(file,JSON.stringify(genesis));
function run(args){return new Promise((resolve,reject)=>{const child=spawn(activeBinary,args,{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('error',reject);child.on('exit',code=>code===0?resolve(output.trim()):reject(Error(output)));});}
function start(home){const child=spawn(activeBinary,['start','--home',home],{stdio:['ignore','pipe','pipe']});children.add(child);started.push(child);child.on('exit',()=>children.delete(child));let logs='';child.stdout.on('data',b=>logs=(logs+b).slice(-16000));child.stderr.on('data',b=>logs=(logs+b).slice(-16000));child.diagnostics=()=>logs;return child;}
async function stop(child){if(child.exitCode!==null)return;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('node did not shut down cleanly'));},15000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function rpc(port,method,params={}){const response=await fetch(`http://127.0.0.1:${port}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(method==='broadcast_tx_commit'?15000:3000)});const data=await response.json();if(data.error)throw Error(JSON.stringify(data.error));return data.result;}
async function waitFor(fn,child){let last;for(let i=0;i<80;i++){if(child&&child.exitCode!==null)throw Error(child.diagnostics());try{const value=await fn();if(value)return value;}catch(e){last=e;}await pause(500);}throw Error(`wait failed: ${last?.message}\n${child?.diagnostics()}`);}
function envelope(sequence,operation,payload,actor=guardian,instance){const command={version:1,chain_id:'uain-smoke-1',member:actor.member.id,sequence:String(sequence),expires_height:'1000',operation,payload};if(instance)command.instance=instance;return Buffer.from(JSON.stringify(signedEnvelope(command,Buffer.from(actor.member.public_key,'base64url'),actor.privateKey))).toString('base64');}
try{
 const homes=[join(root,'one'),join(root,'two')];
 for(let i=0;i<2;i++)await run(['init','--home',homes[i],'--chain-id','uain-smoke-1','--app-genesis',file,'--rpc',`tcp://127.0.0.1:${ports[i]}`,'--p2p',`tcp://127.0.0.1:${ports[i]-1}`]);
 const primaryGenesis=await readFile(join(homes[0],'config/genesis.json'));await writeFile(join(homes[1],'config/genesis.json'),primaryGenesis);
 const id=(await run(['node-id','--home',homes[0]])).split(/\r?\n/).find(line=>/^[0-9a-f]{40}$/.test(line));assert.ok(id,'node ID not returned');
 const secondConfig=join(homes[1],'config/config.toml');let cfg=await readFile(secondConfig,'utf8');cfg=cfg.replace(/^persistent_peers = .*$/m,`persistent_peers = "${id}@127.0.0.1:${ports[0]-1}"`).replace(/^addr_book_strict = .*$/m,'addr_book_strict = false').replace(/^allow_duplicate_ip = .*$/m,'allow_duplicate_ip = true');await writeFile(secondConfig,cfg);
 let primary=start(homes[0]);let fullnode=start(homes[1]);await waitFor(async()=>Number((await rpc(ports[0],'status')).sync_info.latest_block_height)>=2,primary);
 const tx=envelope(0,'withdraw',{});const result=await rpc(ports[0],'broadcast_tx_commit',{tx});assert.equal(result.check_tx.code,0);assert.equal(result.tx_result.code,0);
 let cachedRejected=false;
 try { const replay=await rpc(ports[0],'broadcast_tx_sync',{tx});cachedRejected=replay.code!==0; }
 catch(e){if(!e.message.includes('tx already exists in cache'))throw e;cachedRejected=true;}
 assert.ok(cachedRejected,'identical replay accepted');
 const reencoded=Buffer.from(JSON.stringify(JSON.parse(Buffer.from(tx,'base64')),null,2)).toString('base64');
 const applicationReplay=await rpc(ports[0],'broadcast_tx_sync',{tx:reencoded});assert.notEqual(applicationReplay.code,0,'application accepted reencoded replay');
 const height=Number(result.height)+1;await waitFor(async()=>Number((await rpc(ports[1],'status')).sync_info.latest_block_height)>height,fullnode);
 const query={path:'/store/federation/key',data:Buffer.from('member/'+guardian.member.id).toString('hex'),height:String(height),prove:true};
 const first=(await rpc(ports[0],'abci_query',query)).response;const second=(await rpc(ports[1],'abci_query',query)).response;
 assert.equal(first.code,0);assert.equal(second.value,first.value);assert.ok(first.proofOps.ops.length>0);assert.equal(JSON.parse(Buffer.from(first.value,'base64')).licence,'withdrawn');
 const block1=await rpc(ports[0],'block',{height:String(height+1)});const block2=await rpc(ports[1],'block',{height:String(height+1)});assert.equal(block1.block.header.app_hash,block2.block.header.app_hash);
 await stop(fullnode);await stop(primary);activeBinary=binary;
 primary=start(homes[0]);fullnode=start(homes[1]);await waitFor(async()=>Number((await rpc(ports[0],'status')).sync_info.latest_block_height)>height+1,primary);
 const after=(await rpc(ports[0],'abci_query',{...query,height:'0',prove:false})).response;assert.equal(after.value,first.value,'restart lost member state');
 const resumed=Number((await rpc(ports[0],'status')).sync_info.latest_block_height)-1;
 await waitFor(async()=>Number((await rpc(ports[1],'status')).sync_info.latest_block_height)>resumed,fullnode);
 const resumed1=await rpc(ports[0],'block',{height:String(resumed+1)});const resumed2=await rpc(ports[1],'block',{height:String(resumed+1)});assert.equal(resumed1.block.header.app_hash,resumed2.block.header.app_hash,'resumed nodes disagree');
 // Exercise new instance commands only after upgrading both nodes. The old
 // binary receives only previously supported transactions during rehearsal.
 const instanceCreate=await rpc(ports[0],'broadcast_tx_commit',{tx:envelope(0,'instance_create',{id:'fixture-instance',name:'Smoke fixture instance',family:'fixture'},instanceOwner)});
 assert.equal(instanceCreate.check_tx.code,0);assert.equal(instanceCreate.tx_result.code,0);
 const instancePause=await rpc(ports[0],'broadcast_tx_commit',{tx:envelope(1,'instance_state',{id:'fixture-instance',state:'paused'},instanceOwner,'fixture-instance')});
 assert.equal(instancePause.check_tx.code,0);assert.equal(instancePause.tx_result.code,0);
 const instanceHeight=Number(instancePause.height)+1;
 await waitFor(async()=>Number((await rpc(ports[1],'status')).sync_info.latest_block_height)>instanceHeight,fullnode);
 const instanceQuery={path:'/store/federation/key',data:Buffer.from('instance/fixture-instance').toString('hex'),height:String(instanceHeight),prove:true};
 const instanceState=(await rpc(ports[0],'abci_query',instanceQuery)).response;
 const instanceReplica=(await rpc(ports[1],'abci_query',instanceQuery)).response;
 assert.equal(instanceState.code,0);assert.equal(instanceReplica.code,0);assert.equal(instanceReplica.value,instanceState.value);assert.ok(instanceState.proofOps.ops.length);
 const profile=JSON.parse(Buffer.from(instanceState.value,'base64'));assert.equal(profile.member,instanceOwner.member.id);assert.equal(profile.state,'paused');assert.equal(profile.credits,'0');assert.equal(profile.karma,0);
 const headerA=await rpc(ports[0],'block',{height:String(instanceHeight+1)});const headerB=await rpc(ports[1],'block',{height:String(instanceHeight+1)});assert.equal(headerA.block.header.app_hash,headerB.block.header.app_hash);
 // New credit commands execute only after the old-to-new persisted-state upgrade.
 const basis={basis:'This bounded synthetic fixture has no discoverable public solution.',searches:['first synthetic prior-art search','second synthetic prior-art search']};
 const evidence='a'.repeat(64);
 async function submitCommand(actor,seq,op,payload){const result=await rpc(ports[0],'broadcast_tx_commit',{tx:envelope(seq,op,payload,actor)});assert.equal(result.check_tx.code,0,`${op} CheckTx: ${result.check_tx.log}`);assert.equal(result.tx_result.code,0,`${op} execution: ${result.tx_result.log}`);return result;}
 await submitCommand(workAuthor,0,'open_project',{id:'fixture-project',title:'Synthetic accounting project',class:'benevolent',prior_art:basis});
 await submitCommand(workDefault,0,'allocate_budget',{project:'fixture-project',credits:'13',evidence_digest:evidence});
 await submitCommand(workAuthor,1,'open_task',{id:'fixture-task',project:'fixture-project',title:'Synthetic accounting task',class:'benevolent',prior_art:basis,criteria:'Independently reproduce this synthetic isolated result and examine its novelty.',kind:'instant',karma_reward:13,credit_reward:'13'});
 await submitCommand(workAuthor,2,'submit',{id:'fixture-result',task:'fixture-task',evidence_digest:evidence});
 const check={contribution:'fixture-result',verdict:'confirm',novelty:'new',searches:basis.searches,evidence_digest:evidence};
 await submitCommand(workPeer,0,'verify',check);
 const award=await submitCommand(workDefault,1,'verify',check);
 const creditHeight=Number(award.height)+1;
 await waitFor(async()=>Number((await rpc(ports[1],'status')).sync_info.latest_block_height)>creditHeight,fullnode);
 const creditQuery={path:'/store/federation/key',data:Buffer.from('credit/00000000000000000001').toString('hex'),height:String(creditHeight),prove:true};
 const creditState=(await rpc(ports[0],'abci_query',creditQuery)).response;
 const creditReplica=(await rpc(ports[1],'abci_query',creditQuery)).response;
 assert.equal(creditState.code,0);assert.equal(creditReplica.value,creditState.value);assert.ok(creditState.proofOps.ops.length);
 const credit=JSON.parse(Buffer.from(creditState.value,'base64'));assert.equal(credit.member,workAuthor.member.id);assert.equal(credit.amount,'13');assert.equal(credit.minted,'13');assert.equal(credit.deferred,'0');
 const creditHeaderA=await rpc(ports[0],'block',{height:String(creditHeight+1)});const creditHeaderB=await rpc(ports[1],'block',{height:String(creditHeight+1)});assert.equal(creditHeaderA.block.header.app_hash,creditHeaderB.block.header.app_hash);
 // Activate prospectively only in this synthetic network. The production
 // shadow is never sent fixture policy approvals or member commands.
 const activation=await submitCommand(workDefault,2,'activate_membership',{policy:'project-membership-v1',evidence_digest:evidence});
 await waitFor(async()=>Number((await rpc(ports[0],'status')).sync_info.latest_block_height)>Number(activation.height)+1,primary);
 await submitCommand(workAuthor,3,'open_project',{id:'membership-project',title:'Synthetic membership project',class:'benevolent',prior_art:basis});
 await submitCommand(workAuthor,4,'open_task',{id:'membership-task',project:'membership-project',title:'Synthetic challenge task',class:'benevolent',prior_art:basis,criteria:'Independently examine this synthetic isolated result and its prior-art basis.',kind:'instant',karma_reward:13,credit_reward:'13'});
 await submitCommand(workAuthor,5,'submit',{id:'membership-answer',task:'membership-task',evidence_digest:evidence});
 const rejectedJoin=await rpc(ports[0],'broadcast_tx_sync',{tx:envelope(1,'challenge_prior_art',{id:'outside-challenge',task:'membership-task',source:'https://example.invalid/prior-art',note:'This source contains the task answer in the public literature.'},workPeer)});
 assert.notEqual(rejectedJoin.code,0,'outsider challenge accepted');
 await submitCommand(workPeer,1,'project_join',{project:'membership-project'});
 await submitCommand(workPeer,2,'challenge_prior_art',{id:'membership-challenge',task:'membership-task',source:'https://example.invalid/prior-art',note:'This source contains the task answer in the public literature.'});
 await submitCommand(workDefault,3,'project_join',{project:'membership-project'});
 const decision=await submitCommand(workDefault,4,'decide_prior_art',{challenge:'membership-challenge',decision:'upheld',note:'The examined source demonstrates that the fixture answer is already public.'});
 const membershipHeight=Number(decision.height)+1;
 await waitFor(async()=>Number((await rpc(ports[1],'status')).sync_info.latest_block_height)>membershipHeight,fullnode);
 const membershipQuery={path:'/store/federation/key',data:Buffer.from('task/membership-task').toString('hex'),height:String(membershipHeight),prove:true};
 const membershipState=(await rpc(ports[0],'abci_query',membershipQuery)).response;
 const membershipReplica=(await rpc(ports[1],'abci_query',membershipQuery)).response;
 assert.equal(membershipState.code,0);assert.equal(membershipReplica.value,membershipState.value);assert.ok(membershipState.proofOps.ops.length);
 const membershipTask=JSON.parse(Buffer.from(membershipState.value,'base64'));assert.equal(membershipTask.state,'known');assert.equal(membershipTask.prior_art_decision,'membership-challenge');assert.equal(membershipTask.budget_reserved,'0');
 const membershipHeaderA=await rpc(ports[0],'block',{height:String(membershipHeight+1)});const membershipHeaderB=await rpc(ports[1],'block',{height:String(membershipHeight+1)});assert.equal(membershipHeaderA.block.header.app_hash,membershipHeaderB.block.header.app_hash);
 const compactValues=new Map();let compactHeight=null;let compactAppHash=null;
 let censusStateChecked=false,censusInvalidationChecked=false;
 if(process.env.UAIN_SMOKE_COMPACT==='1'){
  const scheduled=await submitCommand(workDefault,5,'activate_storage',{policy:'compact-state-v1',evidence_digest:evidence});
  await waitFor(async()=>Number((await rpc(ports[0],'status')).sync_info.latest_block_height)>Number(scheduled.height)+1,primary);
  const operatorActivation=await submitCommand(workDefault,6,'activate_operator_rewards',{policy:'pairwise-operator-rewards-v1',evidence_digest:evidence});
  await waitFor(async()=>Number((await rpc(ports[0],'status')).sync_info.latest_block_height)>Number(operatorActivation.height)+1,primary);
  await submitCommand(workAuthor,6,'project_state',{project:'fixture-project',state:'complete'});
  const largeBasis={basis:'b'+'"'.repeat(3999),searches:Array.from({length:20},(_,i)=>String(i).padStart(2,'0')+'"'.repeat(998))};
  await submitCommand(workAuthor,7,'open_project',{id:'compact-project',title:'Synthetic compact project',class:'benevolent',prior_art:largeBasis});
  await submitCommand(workAuthor,8,'open_task',{id:'compact-task',project:'compact-project',title:'Synthetic compact task',class:'benevolent',prior_art:largeBasis,criteria:'c'+'"'.repeat(3999),kind:'instant',karma_reward:13,credit_reward:'13'});
  await submitCommand(workAuthor,9,'submit',{id:'compact-answer',task:'compact-task',evidence_digest:evidence});
  await submitCommand(workPeer,3,'identity_claim',{});
  await submitCommand(workPeer,4,'operator_claim',{domain:'fixture.example'});
  const claim=JSON.parse(Buffer.from((await rpc(ports[0],'abci_query',{path:'/store/federation/key',data:Buffer.from('operator_claim/'+workPeer.member.id+'/').toString('hex'),height:'0',prove:false})).response.value,'base64'));
  await submitCommand(workDefault,7,'operator_attest',{member:workPeer.member.id,domain:claim.domain,claim_event_id:claim.event_id,txt:'uain-operator='+claim.did,checked_at:new Date().toISOString(),evidence_digest:evidence});
  await submitCommand(workPeer,5,'project_join',{project:'compact-project'});
  await submitCommand(workPeer,6,'verify',{...check,contribution:'compact-answer',searches:largeBasis.searches});
  await submitCommand(workDefault,8,'project_join',{project:'compact-project'});
  const compactAward=await submitCommand(workDefault,9,'verify',{...check,contribution:'compact-answer',searches:largeBasis.searches});
  const instanceAward=await submitCommand(workPeer,7,'instance_create',{id:'compact-instance',name:'Compact fixture instance',family:'fixture'});
  const standingAward=await submitCommand(workAuthor,10,'research_standing',{contributions:['compact-answer']});
  let finalAward=standingAward;
  if(process.env.UAIN_SMOKE_CENSUS==='1'){
   const activation=await submitCommand(workDefault,10,'activate_operator_census',{policy:'bounded-operator-census-v1',threshold:3,evidence_digest:evidence});
   await waitFor(async()=>Number((await rpc(ports[0],'status')).sync_info.latest_block_height)>Number(activation.height)+1,primary);
   await submitCommand(workAuthor,11,'operator_census_page',{});
   const readCurrent=async key=>JSON.parse(Buffer.from((await rpc(ports[0],'abci_query',{path:'/store/federation/key',data:Buffer.from(key).toString('hex'),height:'0',prove:false})).response.value,'base64'));
   const completed=await readCurrent('operator_census');assert.equal(completed.complete,true);assert.equal(completed.representatives.length,3);
   await submitCommand(instanceOwner,2,'instance_state',{id:'fixture-instance',state:'active'});
   const dirty=await readCurrent('operator_census_revision');assert.notEqual(dirty.value,completed.revision,'instance lifecycle retained a stale census');censusInvalidationChecked=true;
   finalAward=await submitCommand(workAuthor,12,'operator_census_page',{});
  }
  compactHeight=Number(finalAward.height)+1;
  await waitFor(async()=>Number((await rpc(ports[1],'status')).sync_info.latest_block_height)>compactHeight,fullnode);
  async function compareRecord(key){
   const q={path:'/store/federation/key',data:Buffer.from(key).toString('hex'),height:String(compactHeight),prove:true};
   const a=(await rpc(ports[0],'abci_query',q)).response,b=(await rpc(ports[1],'abci_query',q)).response;
   assert.equal(a.code,0);assert.equal(b.code,0);assert.equal(a.value,b.value);assert.ok(a.proofOps.ops.length);assert.ok(b.proofOps.ops.length);compactValues.set(key,a.value);return Buffer.from(a.value,'base64');
  }
  if(process.env.UAIN_SMOKE_CENSUS==='1'){
   const activation=JSON.parse(await compareRecord('operator_census_activation'));
   const revision=JSON.parse(await compareRecord('operator_census_revision'));
   const progress=JSON.parse(await compareRecord('operator_census'));
   assert.equal(activation.policy,'bounded-operator-census-v1');assert.equal(activation.threshold,3);
   assert.equal(progress.revision,revision.value);assert.equal(progress.complete,true);assert.equal(progress.representatives.length,3);censusStateChecked=true;
  }
  const policy=JSON.parse(await compareRecord('operator_reward_activation'));assert.equal(policy.policy,'pairwise-operator-rewards-v1');
  const standing=JSON.parse(await compareRecord('research_standing/'+workAuthor.member.id+'/'));assert.deepEqual(standing.contributions,['compact-answer']);
  const project=JSON.parse(await compareRecord('project/compact-project'));assert.equal(project.operator_policy,'pairwise-operator-rewards-v1');
  const projectMeta=await compareRecord('project_metadata/compact-project');
  assert.equal(project.storage_policy,'compact-state-v1');assert.equal(createHash('sha256').update(inflateSync(projectMeta)).digest('hex'),project.metadata_digest);assert.deepEqual(JSON.parse(inflateSync(projectMeta)).prior_art,largeBasis);
  const task=JSON.parse(await compareRecord('task/compact-task')),taskMeta=await compareRecord('task_metadata/compact-task');
  assert.equal(task.state,'settled');assert.equal(task.winner,'compact-answer');assert.equal(createHash('sha256').update(inflateSync(taskMeta)).digest('hex'),task.metadata_digest);
  const answer=JSON.parse(await compareRecord('contribution/compact-answer'));
  assert.equal(answer.state,'settled');assert.equal(answer.settlement.check_refs.length,2);assert.equal(answer.verifications[0].searches,null);
  for(const v of answer.verifications){const raw=await compareRecord('verification_evidence/compact-answer/'+v.record_digest);assert.equal(createHash('sha256').update(inflateSync(raw)).digest('hex'),v.record_digest);assert.deepEqual(JSON.parse(inflateSync(raw)).check.searches,largeBasis.searches);await compareRecord('verification_summary/compact-answer/'+v.record_digest);}
  for(const actor of [workAuthor,workPeer,workDefault]){const m=JSON.parse(await compareRecord('member/'+actor.member.id)),raw=await compareRecord('member_metadata/'+actor.member.id);assert.equal(m.account_policy,'compact-account-v1');assert.equal(createHash('sha256').update(inflateSync(raw)).digest('hex'),m.metadata_digest);const full=JSON.parse(inflateSync(raw));assert.equal(full.name,actor.member.name);assert.equal(full.operator,actor.member.operator);assert.equal(full.id,actor.member.id);}
  const compactInstance=JSON.parse(await compareRecord('instance/compact-instance')),instanceMetadata=await compareRecord('instance_metadata/compact-instance');assert.equal(compactInstance.account_policy,'compact-account-v1');assert.equal(createHash('sha256').update(inflateSync(instanceMetadata)).digest('hex'),compactInstance.metadata_digest);assert.equal(JSON.parse(inflateSync(instanceMetadata)).member,workPeer.member.id);
  const observed=JSON.parse(await compareRecord('operator_proof/'+workPeer.member.id+'/'));assert.equal(observed.did,claim.did);assert.equal(observed.trust,'guardian-dns-observation');
  const hA=await rpc(ports[0],'block',{height:String(compactHeight+1)}),hB=await rpc(ports[1],'block',{height:String(compactHeight+1)});assert.equal(hA.block.header.app_hash,hB.block.header.app_hash);compactAppHash=hA.block.header.app_hash;
 }
 let arbitrationReceipt=null;
 if(process.env.UAIN_SMOKE_ARBITRATION==='1'){
  assert.equal(process.env.UAIN_SMOKE_COMPACT,'1','arbitration fixture requires compact foundation');
  const arbitration=await exerciseArbitration({root,homes,ports,rpc,submit:submitCommand,envelope,author:workAuthor,arbiter:workPeer,guardian:workDefault,waitFor,fullnode,proofBinary:join(dirname(binary),'uain-proof')});
  for(const [key,value] of arbitration.values)compactValues.set(key,value);
  // New rewards/sequences legitimately advance earlier mutable account proofs.
  for(const key of compactValues.keys()){const q=(await rpc(ports[0],'abci_query',{path:'/store/federation/key',data:Buffer.from(key).toString('hex'),height:'0',prove:false})).response;compactValues.set(key,q.value);}
  arbitrationReceipt=arbitration.receipt;
 }
 let historyReceipt=null;
 if(process.env.UAIN_SMOKE_HISTORY==='1'){
  const history=await exerciseRecipientHistory({root,homes,ports,rpc,submit:submitCommand,actor:workDefault,owners:[{member:workAuthor.member.id},{member:workPeer.member.id},...(process.env.UAIN_SMOKE_COMPACT==='1'?[{member:workPeer.member.id,instance:'compact-instance'}]:[])],waitFor,fullnode,proofBinary:join(dirname(binary),'uain-proof')});
  for(const [key,value] of history.values)compactValues.set(key,value);
  historyReceipt=history.receipt;
 }
 await stop(fullnode);await stop(primary);primary=start(homes[0]);fullnode=start(homes[1]);
 await waitFor(async()=>Number((await rpc(ports[1],'status')).sync_info.latest_block_height)>membershipHeight+1,fullnode);
 const creditAfter=(await rpc(ports[0],'abci_query',{...creditQuery,height:'0',prove:false})).response;assert.equal(creditAfter.value,creditState.value,'restart lost credit journal');
 const instanceAfter=(await rpc(ports[0],'abci_query',{...instanceQuery,height:'0',prove:false})).response;if(process.env.UAIN_SMOKE_CENSUS==='1')assert.equal(JSON.parse(Buffer.from(instanceAfter.value,'base64')).state,'active');else assert.equal(instanceAfter.value,instanceState.value,'restart lost instance');
 const membershipAfter=(await rpc(ports[0],'abci_query',{...membershipQuery,height:'0',prove:false})).response;assert.equal(membershipAfter.value,membershipState.value,'restart lost prior-art closure');
 for(const [key,value] of compactValues){const after=(await rpc(ports[0],'abci_query',{path:'/store/federation/key',data:Buffer.from(key).toString('hex'),height:'0',prove:false})).response;assert.equal(after.value,value,'restart lost compact evidence '+key);}
 await stop(fullnode);await stop(primary);
 const summary={pass:true,chain:'uain-smoke-1',height,app_hash:block1.block.header.app_hash,replay_rejected:true,fullnode_state_matches:true,state_proof_present:true,restart_preserved_state:true,upgrade_from:previousBinary!==binary?previousBinary:null,resumed_nodes_agree:true,instance_height:instanceHeight,instance_app_hash:headerA.block.header.app_hash,instance_state_matches:true,instance_restart_preserved:true,credit_height:creditHeight,credit_app_hash:creditHeaderA.block.header.app_hash,credit_state_matches:true,credit_restart_preserved:true,membership_height:membershipHeight,membership_app_hash:membershipHeaderA.block.header.app_hash,membership_state_matches:true,membership_restart_preserved:true,outsider_challenge_rejected:true,compact_height:compactHeight,compact_app_hash:compactAppHash,compact_records_checked:compactValues.size,compact_restart_preserved:compactValues.size>0,census_state_checked:censusStateChecked,census_invalidation_checked:censusInvalidationChecked,fixture_directory:root};
 summary.recipient_history=historyReceipt;if(historyReceipt)historyReceipt.restart_preserved=true;
 summary.arbitration=arbitrationReceipt;if(arbitrationReceipt)arbitrationReceipt.restart_preserved=true;
 await writeFile(join(root,'result.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));
}catch(error){for(let i=0;i<started.length;i++)await writeFile(join(root,`daemon-${i}.log`),started[i].diagnostics()).catch(()=>{});console.error(error);console.error(`Fixture diagnostics: ${root}`);process.exitCode=1;}finally{for(const child of [...children])await stop(child).catch(e=>console.error(e.message));}
