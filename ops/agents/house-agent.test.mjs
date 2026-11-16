import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,realpath,rm,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as api from './house-agent.mjs';
import {canonical} from '../../apps/baink/web/identity.js';
import * as driver from '../qualification/baink-earned-service-transaction.mjs';
import {centralEarningSigningBytes,verifyCentralEnvelope} from '../../apps/baink/server/central-earning-command.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const member='uain1'+'a'.repeat(40);
const IDS={project:'P-house-demo.1',task:'T-house-demo_1',submission:'S-house-demo-1'};
const EVIDENCE='Fictional fixture evidence π; not a production submission.\n';

async function tempDir(t){const d=await realpath(await mkdtemp(join(tmpdir(),'house-agent-')));t.after(()=>rm(d,{recursive:true,force:true}));return d;}

/** Fake server and in-memory journal with the same claim semantics as driver.once. */
function fixture(kind='join',{lose=false}={}){
 const journal=new Map(),calls=[];let reconciles=0;
 const operation=kind==='join'?'project_join':'central_submit',payload=api.payloadFor(kind,{...IDS,evidence:EVIDENCE});
 const command={operation,payload,member,chain_id:api.PINS.chainId};
 const envelope={command,public_key:'public',signature:'signature'};
 const bytes=Buffer.from('fictional signing bytes'),digest=sha(bytes);
 const intent={id:'12345678-1234-1234-1234-123456789abc',member,status:'prepared',command,commandDigest:digest,signingBytesBase64:bytes.toString('base64')};
 const subject=kind==='join'?IDS.project:IDS.submission,recordKey=kind==='join'?`participation/${IDS.project}/${member}/`:`central_submission/${IDS.submission}`;
 const final=()=>{const proof={authority:'native',chainId:api.PINS.chainId,genesisSha256:api.PINS.genesisSha256,epoch:api.PINS.genesisSha256,verifierSha256:api.PINS.verifierSha256,height:'101',appHash:'a'.repeat(64)};
  return{intent:{...intent,status:'finalized',finalized:true,historicalReceipt:true,transactionHash:sha(JSON.stringify(envelope)).toUpperCase(),
   receipt:{authority:'native',finalized:true,chain_id:proof.chainId,state_height:'101',app_hash:proof.appHash,proof,event:{id:'1',height:'100',member,operation,subject,command_digest:digest}},
   result:{verified:true,status:kind==='join'?'joined':'submitted',paid:false,recordKey}}};};
 const state={lose,pendingReconciles:1};
 const deps={
  once:async(_,name,request,send)=>{if(journal.has(name)){const saved=journal.get(name);if(JSON.stringify(saved.request)!==JSON.stringify(request))throw Error('Journal request changed');if(!saved.response)throw Error('Uncertain operation');return saved.response;}journal.set(name,{request});const response=await send();journal.get(name).response=response;return response;},
  load:async(name,expected)=>{const saved=journal.get(name);assert.deepEqual(saved.request,expected);assert(saved.response);return saved.response;},
  sign:async(i,r)=>{calls.push('sign');assert.deepEqual(r.expectedPayload,i.command.payload);return envelope;},
  verifyEnvelope:()=>{},wait:async()=>{},
  http:async(path,{body})=>{calls.push(path);
   if(path.endsWith('/prepare')){assert.deepEqual(body,{operation,payload});return{intent};}
   if(path.endsWith('/submit')){if(state.lose)throw Error('lost response');return{intent:{...intent,status:'accepted'}};}
   if(path.endsWith('/reconcile')){if(reconciles++<state.pendingReconciles)return{intent:{...intent,status:'accepted'}};return final();}
   throw Error('unexpected');}};
 const options={executeProduction:true,member,...IDS,evidence:kind==='submit'?EVIDENCE:undefined,journal:'/fictional'};
 return{deps,calls,journal,options,state,final};
}

test('IDs follow the server character rule and are never inferred',()=>{
 for(const ok of ['P','a.b-c_d','A'.repeat(96),'T-service-integrity-20261105'])assert.equal(api.validId(ok),ok);
 for(const bad of ['','.lead','-lead','_lead','has space','a/b','a'.repeat(97),'ü',undefined,7,'a\n'])assert.throws(()=>api.validId(bad));
 assert.throws(()=>api.payloadFor('join',{}));
 assert.throws(()=>api.payloadFor('join',{project:'../x'}));
 assert.throws(()=>api.payloadFor('submit',{task:'T',submission:'bad id',evidence:'x'}));
 assert.throws(()=>api.payloadFor('submit',{task:'',submission:'S',evidence:'x'}));
 assert.deepEqual(api.payloadFor('join',{project:IDS.project,task:'ignored'}),{project:IDS.project});
});

test('argument parser is strict per mode',()=>{
 assert.equal(api.parseArgs(['inspect']).mode,'inspect');
 assert.equal(api.parseArgs(['tasks','--run','/r/run']).run,'/r/run');
 const s=api.parseArgs(['submit','--run','/r/run','--task','T1','--submission','S1','--evidence','/r/e.txt','--execute-production']);
 assert.deepEqual([s.task,s.submission,s.evidencePath,s.executeProduction],['T1','S1','/r/e.txt',true]);
 for(const bad of [[],['deploy'],['inspect','--run','/r'],['tasks','--execute-production'],['join','--execute-production'],['join','--project','P'],
  ['join','--project','bad id','--execute-production'],['join','--project','P','--project','Q','--execute-production'],['join','--project','P','--task','T','--execute-production'],
  ['submit','--task','T','--submission','S','--execute-production'],['submit','--task','T','--submission','S','--evidence','rel.txt','--execute-production'],
  ['tasks','--run','relative'],['tasks','--run','/a/../b'],['join','--project','--execute-production'],['tasks','--bogus','x']])
  assert.throws(()=>api.parseArgs(bad),undefined,JSON.stringify(bad));
});

test('evidence size limits: empty and over 16384 bytes refused before any HTTP',async()=>{
 for(const bad of ['','  \n\t','a'.repeat(16385),'π'.repeat(8193),'\uD800x',null])assert.throws(()=>api.payloadFor('submit',{task:'T',submission:'S',evidence:bad}),/16384/);
 assert.equal(api.payloadFor('submit',{task:'T',submission:'S',evidence:'a'.repeat(16384)}).evidence.length,16384);
 const f=fixture('submit');
 await assert.rejects(api.execute('submit',{...f.options,evidence:'a'.repeat(16385)},f.deps),/16384/);
 await assert.rejects(api.execute('submit',{...f.options,evidence:''},f.deps),/16384/);
 await assert.rejects(api.execute('join',{...f.options,executeProduction:false},f.deps),/execute-production/);
 assert.equal(f.calls.length,0);
});

test('join: one prepare, one signature, one send, bounded reconcile, finalized and unpaid; rerun sends nothing new',async()=>{
 const f=fixture('join');const r=await api.execute('join',f.options,f.deps);
 assert.equal(r.finalized,true);assert.equal(r.paid,false);assert.equal(r.project,IDS.project);assert.equal(r.outsideAdoption,false);
 const sends=()=>f.calls.filter(x=>x.endsWith('/submit')).length;
 assert.equal(sends(),1);assert.equal(f.calls.filter(x=>x==='sign').length,1);
 await api.execute('join',f.options,f.deps);assert.equal(sends(),1);
 assert.ok([...f.journal.keys()].every(k=>/^house-join-[a-f0-9]{32}-/.test(k)));
});

test('submit result carries the digest, never the evidence text, and paid:true is refused',async()=>{
 const f=fixture('submit');const r=await api.execute('submit',f.options,f.deps);
 assert.equal(r.evidenceDigest,sha(EVIDENCE));assert.equal(r.submissionId,IDS.submission);assert.equal(r.paid,false);
 assert.ok(!JSON.stringify(r).includes('Fictional fixture evidence'));
 const g=fixture('submit');const http=g.deps.http;g.deps.http=async(...a)=>{const x=await http(...a);if(x.intent?.result)x.intent.result.paid=true;return x;};
 await assert.rejects(api.execute('submit',g.options,g.deps),/finalized receipt/);
 const h=fixture('submit');const http2=h.deps.http;h.deps.http=async(...a)=>{const x=await http2(...a);if(x.intent?.receipt)x.intent.receipt.event.subject='S-other';return x;};
 await assert.rejects(api.execute('submit',h.options,h.deps),/finalized receipt/);
});

test('real frozen once: a lost submit response is never rebroadcast',async t=>{
 const dir=await tempDir(t);const f=fixture('submit',{lose:true});f.deps.once=driver.once;f.options.journal=dir;
 await assert.rejects(api.execute('submit',f.options,f.deps),/lost/);
 f.state.lose=false;
 await assert.rejects(api.execute('submit',f.options,f.deps),/Uncertain/);
 assert.equal(f.calls.filter(x=>x.endsWith('/submit')).length,1);
 const files=await readdir(dir);
 assert.ok(files.some(n=>/^house-submit-[a-f0-9]{32}-submit\.request\.json$/.test(n)));
 assert.ok(!files.some(n=>n.endsWith('-submit.receipt.json')));
});

test('real frozen once: another submission ID or other evidence for the same task is refused (no rotation)',async t=>{
 const dir=await tempDir(t);const f=fixture('submit');f.deps.once=driver.once;f.options.journal=dir;
 await api.execute('submit',f.options,f.deps);
 const prepares=()=>f.calls.filter(x=>x.endsWith('/prepare')).length;assert.equal(prepares(),1);
 await assert.rejects(api.execute('submit',{...f.options,submission:'S-house-demo-2'},f.deps),/Journal request changed/);
 await assert.rejects(api.execute('submit',{...f.options,evidence:EVIDENCE+'more'},f.deps),/Journal request changed/);
 assert.equal(prepares(),1);
 const claim=JSON.parse(await readFile(join(dir,api.journalPrefix('submit',{task:IDS.task})+'-prepare.request.json'),'utf8'));
 assert.equal(claim.request.body.payload.id,IDS.submission);
});

test('pending receipt stops after 8 fresh polls; receipt mode finishes without signing or sending again',async()=>{
 const f=fixture('join');f.state.pendingReconciles=9;
 const first=await api.execute('join',f.options,f.deps);
 assert.equal(first.receiptPending,true);assert.equal(first.paid,false);
 assert.equal([...f.journal.keys()].filter(k=>k.includes('-receipt-')).length,8);
 const done=await api.execute('receipt-join',f.options,f.deps);
 assert.equal(done.finalized,true);
 assert.equal(f.calls.filter(x=>x==='sign').length,1);assert.equal(f.calls.filter(x=>x.endsWith('/submit')).length,1);assert.equal(f.calls.filter(x=>x.endsWith('/prepare')).length,1);
});

test('tasks lists only open funded tasks with eligibility from the signed detail read',async()=>{
 const task=(id,extra={})=>({id,project:'P1',title:'t',criteria:'c',acceptance_digest:'d',eligibility:'new',eligibility_digest:'e',solver_amount:'5',reviewer_amount:'1',evidence_digest:'f',state:'open',pending:'',winner:'',reserved:'6',paid:'0',...extra});
 const pages={'0':{tasks:[task('T1'),task('T2',{reserved:'0'}),task('T3',{pending:'S9'})],nextCursor:'3',more:true},'3':{tasks:[task('T4',{state:'accepted'}),task('T5')],nextCursor:'5',more:false}};
 const paths=[];
 const get=async path=>{paths.push(path);
  if(path==='/api/native/central/status')return{authority:'native',verified:true,member,active:true,enabled:true,activation:{reviewer:'uain1'+'b'.repeat(40)},earnings:{total:'0'},balanceUnits:'0'};
  const m=path.match(/^\/api\/native\/central\/tasks\?cursor=(\d+)&limit=12$/);if(m)return{authority:'native',verified:true,cursor:m[1],...pages[m[1]]};
  const id=path.split('/').pop();return{authority:'native',verified:true,active:true,task:task(id),project:{state:id==='T5'?'paused':'active',safety_halted:false},joined:id==='T1'};};
 const r=await api.listTasks(get,member);
 assert.deepEqual(r.tasks.map(t=>[t.id,t.joined,t.eligibleForSubmit]),[['T1',true,true],['T5',false,false]]);
 assert.ok(!('state' in r.tasks[0])&&'criteria' in r.tasks[0]);
 assert.equal(r.truncated,false);assert.equal(paths.length,5);
 await assert.rejects(api.listTasks(async p=>p.endsWith('status')?{authority:'native',verified:true,member}:{authority:'native',verified:true,tasks:[task('bad id')],nextCursor:'1',more:false},member),/Invalid task ID/);
 await assert.rejects(api.listTasks(async()=>({authority:'native',verified:true,member:'uain1'+'c'.repeat(40)}),member),/status/);
});

test('fictional submit through the real runtime signer, envelope verifier and once journal',async t=>{
 const parent=await tempDir(t),root=join(parent,'run');
 const config={schema:'baink-controlled-service-transaction-v1',origin:'https://baink.money',operator:'House agent fixture',amountUnits:'1',payerHolder:'http://127.0.0.1:18848',payeeHolder:'http://127.0.0.1:18849',
  service:{title:'Fixture',scope:'Fixture scope only.',deliverables:'Fixture deliverable.',timeline:'Test only',acceptanceCriteria:'Fixture criteria.'},
  reader:{executable:'/tools/uain-state',executableSha256:api.PINS.verifierSha256,genesis:'/tools/native-admission-genesis.json',genesisSha256:api.PINS.genesisSha256,rpc:'http://127.0.0.1:27657',maxAgeSeconds:120}};
 const identities=await driver.prepareTransaction(root,config),m=identities.payer.member;
 const payload=api.payloadFor('submit',{...IDS,evidence:EVIDENCE}),command={version:1,chain_id:api.PINS.chainId,member:m,sequence:'2',expires_height:'200',operation:'central_submit',payload};
 const bytes=centralEarningSigningBytes(command);
 const proof={authority:'native',chainId:api.PINS.chainId,epoch:api.PINS.genesisSha256,genesisSha256:api.PINS.genesisSha256,verifierSha256:api.PINS.verifierSha256,height:'101',appHash:'b'.repeat(64),headerTime:new Date().toISOString(),maxAgeSeconds:120};
 const intent={id:'12345678-1234-1234-1234-123456789abc',member:m,publicKey:identities.payer.publicKey,status:'prepared',command,commandDigest:sha(bytes),signingBytesBase64:bytes.toString('base64'),proof};
 let sent,sends=0;const verify=e=>verifyCentralEnvelope(e,{chainId:api.PINS.chainId,operations:['central_submit']});
 const r=await api.execute('submit',{executeProduction:true,member:m,...IDS,evidence:EVIDENCE,journal:join(root,'journal')},{once:driver.once,sign:(i,rv)=>driver.signCentralFromRuntime(root,i,rv),verifyEnvelope:verify,wait:async()=>{},
  http:async(path,{body})=>{if(path.endsWith('/prepare'))return{intent};if(path.endsWith('/submit')){sends++;sent=body.envelope;verify(sent);return{intent:{...intent,status:'accepted'}};}
   return{intent:{...intent,status:'finalized',finalized:true,historicalReceipt:true,transactionHash:sha(JSON.stringify(sent)).toUpperCase(),
    receipt:{authority:'native',finalized:true,chain_id:api.PINS.chainId,state_height:proof.height,app_hash:proof.appHash,proof,event:{id:'3',height:'101',member:m,operation:'central_submit',subject:IDS.submission,command_digest:intent.commandDigest}},
    result:{verified:true,status:'submitted',paid:false,recordKey:'central_submission/'+IDS.submission}}};}});
 assert.equal(sends,1);assert.equal(r.finalized,true);assert.equal(r.paid,false);assert.equal(r.evidenceDigest,sha(EVIDENCE));
});

test('survey templates are fetched read-only and bound to native criteria and project',async()=>{
 const id='T-OPP-00004-1-prior-art-survey',criteria='Prior-art survey for "fixture". Main KPI: "Fixture exact main KPI". No novelty claim is made or rewarded;';
 const digest=createHash('sha256').update(criteria).digest('hex');
 const task={id,project:'P-OPP-00004',criteria,acceptance_digest:digest,state:'open',pending:'',winner:'',reserved:'6',solver_amount:'5',reviewer_amount:'1'};
 const template={taskId:id,project:task.project,criteriaDigest:digest,mainKpi:'Fixture exact main KPI',minIncluded:8,minKinds:2,required:[{kind:'doi',id:'10.1234/fixture',title:'Fixture'}]};
 const paths=[];
 const get=async p=>{paths.push(p);if(p.endsWith('/status'))return{authority:'native',verified:true,member};
 if(p.includes('?'))return{authority:'native',verified:true,tasks:[task],nextCursor:'1',more:false};
 if(p.includes('/survey-template/'))return template;
 return{authority:'native',verified:true,active:true,task,project:{state:'active',safety_halted:false},joined:false};};
 const result=await api.listTasks(get,member);
 assert.deepEqual(result.tasks[0].surveyTemplate,template);
 assert.ok(paths.includes('/api/native/central/survey-template/'+id));
 for(const changed of [{project:'P-OPP-00005'},{criteriaDigest:'0'.repeat(64)},{taskId:'T-OPP-00005-1-prior-art-survey'},{mainKpi:'Wrong KPI'}]){
  await assert.rejects(api.listTasks(p=>p.includes('/survey-template/')?{...template,...changed}:get(p),member),/survey template/i);
 }
});

test('held task pages and a newly-held detail are skipped before template/provider work',async()=>{const task=id=>({id,project:'P1',state:'open',pending:'',winner:'',reserved:'6',solver_amount:'5',reviewer_amount:'1'}),hold={authority:'uain-operator',available:false,reason:'task_specification_unusable'};const paths=[];const result=await api.listTasks(async p=>{paths.push(p);if(p.endsWith('/status'))return{authority:'native',verified:true,member,active:true};if(p.includes('?cursor='))return{authority:'native',verified:true,tasks:[{...task('T-held-page'),availability:hold},task('T-held-detail')],nextCursor:'2',more:false};return{authority:'native',verified:true,active:true,task:task('T-held-detail'),availability:hold,project:{state:'active',safety_halted:false},joined:false};},member);assert.deepEqual(result.tasks,[]);assert.equal(paths.some(p=>p.endsWith('/T-held-page')),false);});

const recoveryTask='T-OPP-00014-1-prior-art-survey',recoveryProject='P-OPP-00014',recoverySubmission='HS-alpha-12345678901234567890';
function recoveryFixture(){
 const now=Date.parse('2026-11-08T19:00:00Z'),proof={authority:'native',chainId:api.PINS.chainId,genesisSha256:api.PINS.genesisSha256,epoch:api.PINS.genesisSha256,verifierSha256:api.PINS.verifierSha256,height:'100',appHash:'a'.repeat(64),headerTime:new Date(now).toISOString(),maxAgeSeconds:120};
 const criteria='Exact reviewed criteria',task={id:recoveryTask,project:recoveryProject,criteria,acceptance_digest:sha(criteria),state:'open',pending:'',winner:'',reserved:'6',solver_amount:'5',reviewer_amount:'1'};
 const replies={
  '/api/native/central/status':{authority:'native',verified:true,member,active:true,enabled:true,activation:{reviewer:'uain1'+'b'.repeat(40)},proof},
  ['/api/native/central/tasks/'+recoveryTask]:{authority:'native',verified:true,active:true,task,project:{id:recoveryProject,state:'active',safety_halted:false},joined:false,proof},
  ['/api/native/central/submissions/'+recoverySubmission]:{authority:'native',verified:true,member,outcome:'not-recorded',submission:null,provenAbsent:['central_submission/'+recoverySubmission],proof},
  '/api/native/central/intents':{intents:[]}};
 const calls=[],get=async path=>{calls.push(path);return structuredClone(replies[path]);};
 return{now,proof,task,replies,calls,get,options:{project:recoveryProject,task:recoveryTask,submission:recoverySubmission},deps:{now:()=>now,journalCheck:async()=>({complete:true,relatedEntries:0})}};
}
test('read-only recovery admission binds fresh native absence and complete own intent/journal checks',async()=>{
 const f=recoveryFixture(),r=await api.recoveryCheck(f.get,member,f.options,f.deps);
 assert.equal(r.member,member);assert.equal(r.task.acceptance_digest,f.task.acceptance_digest);assert.equal(r.submissionAbsent,true);assert.equal(r.intentIndexComplete,true);assert.equal(r.journal.complete,true);
 assert.deepEqual(api.parseArgs(['recovery-check','--run','/r/run','--project',recoveryProject,'--task',recoveryTask,'--submission',recoverySubmission]).mode,'recovery-check');
 assert.equal(api.parseArgs(['submission-status','--run','/r/run','--submission',recoverySubmission]).mode,'submission-status');
 for(const args of [['recovery-check','--task',recoveryTask],['submission-status','--submission',recoverySubmission,'--execute-production']])assert.throws(()=>api.parseArgs(args));
});
test('read-only recovery refuses false/stale/foreign absence, closed tasks and incomplete or related journals/intents',async()=>{
 const changes=[f=>f.replies['/api/native/central/submissions/'+recoverySubmission].provenAbsent=[],f=>f.replies['/api/native/central/submissions/'+recoverySubmission].member='uain1'+'c'.repeat(40),f=>f.replies['/api/native/central/submissions/'+recoverySubmission].proof.headerTime='2026-11-07T00:00:00Z',f=>f.replies['/api/native/central/tasks/'+recoveryTask].task.state='under_review',f=>f.replies['/api/native/central/intents'].more=true,f=>f.replies['/api/native/central/intents'].intents=[{id:'i',member,command:{member,operation:'central_submit',payload:{id:'other',task:recoveryTask}},status:'unknown'}],f=>f.deps.journalCheck=async()=>({complete:false,relatedEntries:0}),f=>f.deps.journalCheck=async()=>({complete:true,relatedEntries:1})];
 for(const change of changes){const f=recoveryFixture();change(f);await assert.rejects(api.recoveryCheck(f.get,member,f.options,f.deps));}
});

test('read-only submission status remains bound to exact owner/id and current pinned proof',async()=>{
 const f=recoveryFixture();assert.equal((await api.submissionStatus(f.get,member,recoverySubmission,{now:()=>f.now})).outcome,'not-recorded');
 f.replies['/api/native/central/submissions/'+recoverySubmission]={authority:'native',verified:true,member,outcome:'accepted',submission:{id:recoverySubmission,task:recoveryTask,author:member},proof:f.proof};
 assert.equal((await api.submissionStatus(f.get,member,recoverySubmission,{now:()=>f.now})).outcome,'accepted');f.replies['/api/native/central/submissions/'+recoverySubmission].submission.author='uain1'+'b'.repeat(40);await assert.rejects(api.submissionStatus(f.get,member,recoverySubmission,{now:()=>f.now}));
 assert.equal(await api.adapterSourceDigest(),sha(await readFile(new URL('./house-agent.mjs',import.meta.url))));
});

test('recovery journal scan is bounded/complete and refuses archive remnants or linked metadata',async t=>{
 const {mkdir,writeFile,symlink}=await import('node:fs/promises'),root=await tempDir(t),journal=join(root,'journal');await mkdir(journal,{mode:0o700});const owner={uid:process.getuid(),gid:process.getgid(),canonical};
 assert.deepEqual(await api.recoveryJournal(journal,IDS.project,IDS.task,owner),{complete:true,relatedEntries:0,entries:0});
 const archive=join(journal,'archive');await mkdir(archive,{mode:0o700});await writeFile(join(archive,api.journalPrefix('submit',{task:IDS.task})+'-envelope.request.json'),JSON.stringify({fingerprint:sha(canonical({path:'/api/native/central/prepare',method:'POST',body:{operation:'central_submit',payload:api.payloadFor('submit',{...IDS,evidence:EVIDENCE})}})),request:{path:'/api/native/central/prepare',method:'POST',body:{operation:'central_submit',payload:api.payloadFor('submit',{...IDS,evidence:EVIDENCE})}}}),{mode:0o600});assert.equal((await api.recoveryJournal(journal,IDS.project,IDS.task,owner)).relatedEntries,1);
 await symlink(root,join(journal,'escape'));await assert.rejects(api.recoveryJournal(journal,IDS.project,IDS.task,owner));
});

test('recovery journal refuses opaque archives and unknown metadata instead of claiming complete absence',async t=>{
 const {mkdir,writeFile}=await import('node:fs/promises'),root=await tempDir(t),journal=join(root,'journal');await mkdir(journal,{mode:0o700});const owner={uid:process.getuid(),gid:process.getgid(),canonical};
 await writeFile(join(journal,'journal-backup.tar'),'opaque archive of a prior native claim',{mode:0o600});await assert.rejects(api.recoveryJournal(journal,IDS.project,IDS.task,owner));
});

test('journal metadata identifies renamed relevant records and validates known audit references',async t=>{
 const {mkdir,writeFile,unlink}=await import('node:fs/promises'),root=await tempDir(t),journal=join(root,'journal');await mkdir(journal,{mode:0o700});const owner={uid:process.getuid(),gid:process.getgid(),canonical},path=join(journal,'renamed.request.json'),bytes=JSON.stringify({fingerprint:sha(canonical({path:'/api/native/central/prepare',method:'POST',body:{operation:'central_submit',payload:api.payloadFor('submit',{...IDS,evidence:EVIDENCE})}})),request:{path:'/api/native/central/prepare',method:'POST',body:{operation:'central_submit',payload:api.payloadFor('submit',{...IDS,evidence:EVIDENCE})}}});await writeFile(path,bytes,{mode:0o600});assert.equal((await api.recoveryJournal(journal,IDS.project,IDS.task,owner)).relatedEntries,1);
 const audit={schema:'uain-controlled-journal-recovery-v1',at:new Date().toISOString(),by:'fixture',reason:'retained fixture',files:{'renamed.request.json':sha(bytes)}};await writeFile(join(journal,'AUDIT.json'),JSON.stringify(audit),{mode:0o600});assert.ok((await api.recoveryJournal(journal,IDS.project,IDS.task,owner)).relatedEntries>0);
 await unlink(path);await assert.rejects(api.recoveryJournal(journal,IDS.project,IDS.task,owner));
 await writeFile(path,JSON.stringify({fingerprint:'a'.repeat(64),request:'opaque compressed payload'}),{mode:0o600});await assert.rejects(api.recoveryJournal(journal,IDS.project,IDS.task,owner));
});

test('recovery refuses unclassifiable empty requests, bad fingerprints and unpaired receipts',async t=>{
 const {mkdir,writeFile,unlink}=await import('node:fs/promises'),{canonical}=await import('../../apps/baink/web/identity.js'),root=await tempDir(t),journal=join(root,'journal');await mkdir(journal,{mode:0o700});const owner={uid:process.getuid(),gid:process.getgid(),canonical},file=join(journal,'renamed.request.json');
 for(const request of [{},{archive:{encoded:'opaque'}}]){await writeFile(file,JSON.stringify({fingerprint:sha(canonical(request)),request}),{mode:0o600});await assert.rejects(api.recoveryJournal(journal,IDS.project,IDS.task,owner));}
 const request={path:'/api/native/central/prepare',method:'POST',body:{operation:'project_join',payload:{project:'P-other'}}};await writeFile(file,JSON.stringify({fingerprint:'a'.repeat(64),request}),{mode:0o600});await assert.rejects(api.recoveryJournal(journal,IDS.project,IDS.task,owner));
 await unlink(file);await writeFile(join(journal,'orphan.receipt.json'),JSON.stringify({fingerprint:sha(canonical(request)),response:{intent:{}}}),{mode:0o600});await assert.rejects(api.recoveryJournal(journal,IDS.project,IDS.task,owner));
});

test('recognized journal receipts require matching request fingerprints and classified response context',async t=>{
 const {mkdir,writeFile}=await import('node:fs/promises'),root=await tempDir(t),journal=join(root,'journal');await mkdir(journal,{mode:0o700});const owner={uid:process.getuid(),gid:process.getgid(),canonical};
 const request={path:'/api/native/central/prepare',method:'POST',body:{operation:'project_join',payload:{project:'P-other'}}},fingerprint=sha(canonical(request)),intent={id:'12345678-1234-1234-1234-123456789abc',member,commandDigest:'d'.repeat(64),command:{chain_id:api.PINS.chainId,member,operation:'project_join',payload:{project:'P-other'}}};
 await writeFile(join(journal,'known.request.json'),JSON.stringify({fingerprint,request}),{mode:0o600});const receipt=join(journal,'known.receipt.json');await writeFile(receipt,JSON.stringify({fingerprint,response:{intent}}),{mode:0o600});assert.equal((await api.recoveryJournal(journal,IDS.project,IDS.task,owner)).relatedEntries,0);
 await writeFile(receipt,JSON.stringify({fingerprint:'b'.repeat(64),response:{intent}}),{mode:0o600});await assert.rejects(api.recoveryJournal(journal,IDS.project,IDS.task,owner));await writeFile(receipt,JSON.stringify({fingerprint,response:{unknown:{}}}),{mode:0o600});await assert.rejects(api.recoveryJournal(journal,IDS.project,IDS.task,owner));
});
