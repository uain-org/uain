import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture,member} from './http-fixture.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');

test('signed owner HTTP history exposes only the native-committed feedback, never another authors packet',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'feedback-http-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const owner=member(),other=member(),reviewer=member(),id='CS-feedback',task='CT-feedback',executionId='review-feedback',criteria='Produce a supported finding';
 const genesis=JSON.stringify({chain_id:'isolated-feedback-http'}),binaryText='synthetic public verifier fixture',binary=join(dir,'reader'),genesisFile=join(dir,'genesis.json');
 await writeFile(binary,binaryText,{mode:0o700});await writeFile(genesisFile,genesis,{mode:0o600});
 const config={binary,binaryHash:sha(binaryText),genesis:genesisFile,genesisHash:sha(genesis),chainId:'isolated-feedback-http',rpc:'http://127.0.0.1:1',timeoutMs:8000,maxAgeSeconds:120};
 const decision={completed_at:'2026-11-08T20:00:01.000Z',criteria_digest:sha(criteria),domain:'UAIN/central-research-review/v1',evidence_digest:sha('Original finding'),execution_id:executionId,findings:['Provide the treatment-arm counts.'],reviewer:reviewer.address,schema:'uain-central-research-decision-v1',started_at:'2026-11-08T20:00:00.000Z',submission:id,task,verdict:'needs_evidence'};
 const review={submission:id,execution_id:executionId,criteria_digest:decision.criteria_digest,evidence_digest:decision.evidence_digest,verification_digest:sha('UAIN/central-research-review/v1\n'+JSON.stringify(decision)),reviewer:reviewer.address,height:'15',verdict:'needs_evidence'};
 const records={guardians:[],legacy_import:null,event_count:'1',
  ['central_submission/'+id]:{id,task,author:owner.address,state:'under_review',height:'10',evidence:'Original finding',evidence_digest:decision.evidence_digest},
  ['central_task/'+task]:{id:task,project:'P-feedback',title:'A genuine finding',criteria,acceptance_digest:sha(criteria),eligibility:'new',eligibility_digest:'e'.repeat(64),evidence_digest:'e'.repeat(64),solver_amount:'1000000',reviewer_amount:'200000',state:'under_review',pending:id,winner:'',reserved:'1200000',paid:'0'},
  ['central_review/'+id+'/'+sha(executionId)]:review};
 for(const who of [owner,other,reviewer])records['member/'+who.address]={id:who.address,public_key:Buffer.from(who.publicKey,'base64').toString('base64url'),sequence:'0',licence:'active'};
 const transport={profile:{chainId:config.chainId,genesisSha256:config.genesisHash,verifierSha256:config.binaryHash,maxAgeSeconds:120},prepare:async()=>{},close:async()=>{},read:async selection=>{
  const keys=[...new Set(['legacy_import','guardians','event_count',...(selection.keys??[])])],selected=Object.fromEntries(keys.map(key=>[key,structuredClone(records[key]??null)]));
  return Buffer.from(JSON.stringify({chain_id:config.chainId,height:'20',header_time:new Date().toISOString(),app_hash:'c'.repeat(64),event_count:'1',records:selected,queries:keys.map(key=>({key:Buffer.from(key).toString('base64'),proof:'fixture-only'})),...(selection.member?{member:records['member/'+selection.member]}:{})}));
 }};
 let reads=0;const f=await fixture(t,{nativeConfig:config,nativeStateTransport:transport,publicReviewEnabled:true,publicReviewRuntime:{health:async()=>({configured:false}),close:async()=>{}},publicReviewRootAction:async(action,jobId,request)=>{reads++;assert.equal(action,'central-feedback');assert.match(jobId,/^[a-f0-9]{32}$/);assert.equal(request.submission,id);assert([null,executionId].includes(request.executionId));return{schema:'uain-central-review-feedback-v1',submission:id,executionId,author:owner.address,task,project:'P-feedback',chainId:config.chainId,genesisSha256:config.genesisHash,nativeReview:review,decision,native:{height:'20',appHash:'c'.repeat(64),headerTime:new Date().toISOString(),verifierSha256:config.binaryHash}};}});
 for(const who of [owner,other])assert.equal((await f.request(who,'POST','/api/account',{displayName:'Fixture member'})).status,201);
 const path='/api/native/central/submissions/'+id+'?executionId='+executionId;
 assert.equal((await f.request(null,'GET',path)).status,401);assert.equal((await f.request(other,'GET',path)).status,403);assert.equal(reads,0);
 const response=await f.request(owner,'GET',path);assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(response.body.feedback.available,true);assert.deepEqual(response.body.feedback.packet.decision.findings,['Provide the treatment-arm counts.']);assert.equal(response.body.outcome,'needs_evidence');assert.equal(reads,1);
 const discovered=await f.request(owner,'GET','/api/native/central/submissions/'+id);assert.equal(discovered.status,200,JSON.stringify(discovered.body));assert.equal(discovered.body.feedback.available,true);assert.equal(discovered.body.feedback.scope,'retained-review');assert.equal(discovered.body.review.record.execution_id,executionId);assert.equal(reads,2);
});
