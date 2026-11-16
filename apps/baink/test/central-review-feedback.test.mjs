import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {FEEDBACK_SCHEMA,validateFeedbackRequest,feedbackJobId,validateReviewFeedback} from '../shared/central-review-feedback.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex'),canon=v=>JSON.stringify(v,Object.keys(v).sort());
const now=Date.parse('2026-11-09T00:00:02Z'),author='uain1'+'a'.repeat(40),reviewer='uain1'+'b'.repeat(40);
function fixture(version=2){
 const decision={schema:`uain-central-research-decision-v${version}`,domain:'UAIN/central-research-review/v1',submission:'S-feedback',task:'T-feedback',reviewer,execution_id:'R-feedback',criteria_digest:'c'.repeat(64),evidence_digest:'d'.repeat(64),verdict:'needs_evidence',findings:['Enrollment is not the same as the treated-arm count.'],started_at:'2026-11-09T00:00:00.000Z',completed_at:'2026-11-09T00:00:01.000Z',...(version===2?{verification_attestation_digest:'e'.repeat(64)}:{})};
 const review={submission:decision.submission,execution_id:decision.execution_id,criteria_digest:decision.criteria_digest,evidence_digest:decision.evidence_digest,verification_digest:sha(decision.domain+'\n'+canon(decision)),reviewer,height:'10',verdict:decision.verdict};
 const packet={schema:FEEDBACK_SCHEMA,submission:decision.submission,executionId:decision.execution_id,author,task:decision.task,project:'P-feedback',chainId:'fixture-feedback-network',genesisSha256:'f'.repeat(64),nativeReview:review,decision,native:{height:'11',appHash:'1'.repeat(64),headerTime:'2026-11-09T00:00:02Z',verifierSha256:'2'.repeat(64)}};
 const expected={submission:packet.submission,executionId:packet.executionId,author,task:packet.task,project:packet.project,review,chainId:packet.chainId,genesisSha256:packet.genesisSha256,verifierSha256:packet.native.verifierSha256};return{packet,expected};
}
test('exact fixed request derives the same bounded purpose ID without caller-selected path',async()=>{
 const request={submission:'S-feedback',executionId:'R-feedback'};assert.deepEqual(validateFeedbackRequest(request),request);assert.equal(await feedbackJobId(request),sha('UAIN/central-review-feedback-request/v1\n'+JSON.stringify({executionId:'R-feedback',submission:'S-feedback'})).slice(0,32));
 for(const bad of [{...request,path:'/keys'},{...request,submission:'../keys'},{...request,executionId:'x'.repeat(97)}])assert.throws(()=>validateFeedbackRequest(bad));
});
test('both historical decision schemas verify native-committed findings without new signing or mutation',async()=>{
 for(const v of [1,2]){const{packet,expected}=fixture(v);const before=JSON.stringify(packet);const result=await validateReviewFeedback(packet,expected,{now});assert.deepEqual(result,packet);assert.notEqual(result,packet);assert.equal(JSON.stringify(packet),before);}
});
test('changed findings, bindings, network or private/unknown fields are refused',async()=>{
 for(const change of [p=>p.decision.findings.push('An uncommitted claim'),p=>p.author=reviewer,p=>p.executionId='another',p=>p.project='P-another',p=>p.chainId='another-chain',p=>p.genesisSha256='0'.repeat(64),p=>p.decision.domain='other-domain',p=>p.decision.private_prompt='never expose',p=>p.nativeReview.height='12',p=>p.native.verifierSha256='0'.repeat(64),p=>p.native.headerTime='2026-11-08T00:00:00Z']){const{packet,expected}=fixture();change(packet);await assert.rejects(validateReviewFeedback(packet,expected,{now}));}
});
test('unknown schema, malformed Unicode and byte/shape bounds fail closed',async()=>{
 for(const change of [p=>p.decision.schema='uain-central-research-decision-v3',p=>p.decision.findings=['\ud800'],p=>p.decision.findings=['é'.repeat(4097)],p=>p.decision.findings=[],p=>p.decision.findings=Array(65).fill('finding'),p=>p.native.height='01',p=>p.decision.completed_at='not-a-date']){const{packet,expected}=fixture();change(packet);await assert.rejects(validateReviewFeedback(packet,expected,{now}));}
});
test('validation snapshots packet and context before digest awaits',async()=>{
 const{packet,expected}=fixture(),before=structuredClone(packet);const original=Object.getOwnPropertyDescriptor(globalThis,'crypto');let unblock,entered;const gate=new Promise(r=>unblock=r),started=new Promise(r=>entered=r);const real=globalThis.crypto;
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:{subtle:{digest:async(...args)=>{entered();await gate;return real.subtle.digest(...args);}}}});
 try{const validating=validateReviewFeedback(packet,expected,{now});await started;packet.decision.findings[0]='Unverified mutation after validation';packet.native.appHash='9'.repeat(64);expected.review.verification_digest='0'.repeat(64);unblock();assert.deepEqual(await validating,before);}finally{unblock();Object.defineProperty(globalThis,'crypto',original);}
});
test('finding array accessors and serialization hooks are refused without invocation',async()=>{
 for(const accessor of [true,false]){const{packet,expected}=fixture();let invoked=false;const a=['Finding'];if(accessor)Object.defineProperty(a,'0',{get(){invoked=true;return'Finding';},enumerable:true});else a.toJSON=()=>{invoked=true;return['Finding'];};packet.decision.findings=a;await assert.rejects(validateReviewFeedback(packet,expected,{now}));assert.equal(invoked,false);}
});
test('null execution is a distinct purpose-bound locator request, never a packet execution',async()=>{
 const request={submission:'S-feedback',executionId:null};assert.deepEqual(validateFeedbackRequest(request),request);assert.equal(await feedbackJobId(request),sha('UAIN/central-review-feedback-request/v1\n'+JSON.stringify({executionId:null,submission:'S-feedback'})).slice(0,32));const{packet,expected}=fixture();packet.executionId=null;await assert.rejects(validateReviewFeedback(packet,{...expected,executionId:null},{now}));
});
test('Python retained projection interoperates with browser codec and historical Unicode decision hashing',async()=>{
 const{spawnSync}=await import('node:child_process');const{fileURLToPath}=await import('node:url');const directory=fileURLToPath(new URL('../../../ops/custody/',import.meta.url));
 const code="import sys,json;sys.path.insert(0,sys.argv[1]);import central_reviewer_server as s;import test_central_review_feedback as f;p,state,d,j,runtime,reader,body=f.FeedbackTests().fixture();print(json.dumps(s.feedback_projection(p,body,runtime,reader)))";
 const result=spawnSync('/usr/bin/python3',['-B','-c',code,directory],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},timeout:10000});assert.equal(result.status,0,result.stderr);const packet=JSON.parse(result.stdout);const expected={submission:packet.submission,executionId:packet.executionId,author:packet.author,task:packet.task,project:packet.project,review:packet.nativeReview,chainId:'uain-shadow-20261008-1',genesisSha256:'54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff',verifierSha256:'136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860'};assert.deepEqual(await validateReviewFeedback(packet,expected),packet);
 const decision=fixture().packet.decision;decision.findings=['Quoted "text" <>&\u2028 astral 🔬 and newline\nremain exact.'];const digestCode="import sys,json;sys.path.insert(0,sys.argv[1]);import central_reviewer as r;print(r.decision_digest(json.load(sys.stdin)))";const d=spawnSync('/usr/bin/python3',['-B','-c',digestCode,directory],{encoding:'utf8',input:JSON.stringify(decision),env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},timeout:10000});assert.equal(d.status,0,d.stderr);assert.equal(d.stdout.trim(),sha(decision.domain+'\n'+canon(decision)));
});
