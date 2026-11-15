import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compileVerificationContract,parseVerificationCandidate} from '../src/task-verification-contract.mjs';
import {digest,sha256} from '../src/common.mjs';

// Synthetic qualification describes compiler binding only; no real method is enabled.
const fixture=()=>{
 const criteria='Prove the stated finite combinatorial claim under the exact public premises.';
 const materialManifest={schema:'uain-task-public-input-manifest-v1',taskId:'T-OPP-00010-r1-fixture',projectId:'P-OPP-00010',criteriaDigest:sha256(criteria),inputs:[{id:'premises',mediaType:'text/plain',sha256:'1'.repeat(64),bytes:123,url:'https://example.invalid/premises.txt'}]};
 const candidate={schema:'uain-manager-verification-candidate-v1',taskId:materialManifest.taskId,projectId:materialManifest.projectId,planRevision:1,stage:1,criteria,methodId:'formal-text-assessment-v1',materialManifestDigest:digest(materialManifest)};
 const approvedPlan={projectId:candidate.projectId,revision:1,status:'approved',stage:1,planDigest:'2'.repeat(64)};
 const qualifiedMethods=[{id:'formal-text-assessment-v1',scope:'formal-text-content-and-logic-only',driverId:'formal-text-assessment',driverSha256:'3'.repeat(64),evidenceSchema:'uain-formal-text-evidence-v1',maxEvidenceBytes:16384,qualificationDigest:'4'.repeat(64)}];
 return {candidate,approvedPlan,materialManifest,qualifiedMethods};
};
const refuses=(input,code)=>assert.throws(()=>compileVerificationContract(input),e=>e.code===code);

test('default empty qualification registry cannot enable a manager method',()=>{
 const x=fixture();delete x.qualifiedMethods;refuses(x,'verification_adapter_required');
});
test('compiler binds exact plan, criteria and public input commitments without mutation',()=>{
 const x=fixture(),before=structuredClone(x),r=compileVerificationContract(x);
 assert.deepEqual(r.contract,{schema:'uain-task-verification-contract-v1',verificationRequired:true,taskId:x.candidate.taskId,projectId:'P-OPP-00010',planRevision:1,stage:1,planDigest:'2'.repeat(64),criteriaDigest:sha256(x.candidate.criteria),materialManifestDigest:x.candidate.materialManifestDigest,method:x.qualifiedMethods[0]});
 assert.equal(r.contract.criteriaDigest,sha256(x.candidate.criteria));assert.equal(r.contract.materialManifestDigest,digest(x.materialManifest));assert.equal(r.contract.planDigest,x.approvedPlan.planDigest);
 assert.equal(r.contractDigest,digest(r.contract));assert.deepEqual(compileVerificationContract(x),r);assert.deepEqual(x,before);
 r.contract.method.scope='changed';assert.deepEqual(x,before);
});
test('unknown and D2 survey methods never inherit formal-text qualification',()=>{
 for(const methodId of ['prior-art-survey','experimental-reproduction','/tmp/driver.mjs']){const x=fixture();x.candidate.methodId=methodId;refuses(x,'verification_adapter_required');}
});
test('foreign stale or wrong-stage plan refuses compilation',()=>{
 for(const [key,value]of [['projectId','P-OPP-00009'],['revision',2],['stage',2],['status','pending']]){const x=fixture();x.approvedPlan[key]=value;assert.throws(()=>compileVerificationContract(x));}
});
test('wrong public material commitment or subject refuses compilation',()=>{
 for(const key of ['taskId','projectId','criteriaDigest']){const x=fixture();x.materialManifest[key]=key==='criteriaDigest'?'a'.repeat(64):'foreign';x.candidate.materialManifestDigest=digest(x.materialManifest);assert.throws(()=>compileVerificationContract(x));}
 const x=fixture();x.candidate.materialManifestDigest='a'.repeat(64);assert.throws(()=>compileVerificationContract(x));
});
test('strict candidate parser rejects duplicate keys and oversized JSON',()=>{
 assert.throws(()=>parseVerificationCandidate('{"schema":1,"schema":2}'),e=>e.code==='duplicate_key');
 assert.throws(()=>parseVerificationCandidate(' '.repeat(16385)));assert.deepEqual(parseVerificationCandidate(JSON.stringify(fixture().candidate)),fixture().candidate);
});
test('criteria uses raw UTF8 digest and never JSON string or whitespace normalization',()=>{
 const x=fixture();x.candidate.criteria+=' ';x.materialManifest.criteriaDigest=sha256(x.candidate.criteria);x.candidate.materialManifestDigest=digest(x.materialManifest);
 assert.equal(compileVerificationContract(x).contract.criteriaDigest,sha256(x.candidate.criteria));
 x.materialManifest.criteriaDigest=digest(x.candidate.criteria);x.candidate.materialManifestDigest=digest(x.materialManifest);assert.throws(()=>compileVerificationContract(x));
});
test('object entry refuses executable or lossy JSON without running accessors',()=>{
 let called=0;const x=fixture();Object.defineProperty(x.candidate,'methodId',{get(){called++;return 'formal-text-assessment-v1';},enumerable:true});
 assert.throws(()=>compileVerificationContract(x));assert.equal(called,0);
 for(const modify of [x=>x.candidate.criteria+='\ud800',x=>x.candidate[Symbol('extra')]=1,x=>Object.setPrototypeOf(x.candidate,{extra:1}),x=>x.candidate.extra=undefined,x=>x.candidate.criteria=new Proxy({}, {get(){throw Error('must not run');}}),x=>x.materialManifest.inputs.length=2,x=>x.candidate.extra=x]){const a=fixture();modify(a);assert.throws(()=>compileVerificationContract(a));}
});
test('input URLs are bounded inert commitments and duplicate or oversized materials refuse',()=>{
 for(const url of ['http://example.invalid/a','https://user:pass@example.invalid/a','https://example.invalid/a?token=1','https://example.invalid/a#fragment']){const x=fixture();x.materialManifest.inputs[0].url=url;x.candidate.materialManifestDigest=digest(x.materialManifest);assert.throws(()=>compileVerificationContract(x));}
 for(const modify of [x=>x.materialManifest.inputs.push({...x.materialManifest.inputs[0]}),x=>x.materialManifest.inputs[0].bytes=1048577,x=>x.materialManifest.inputs[0].bytes=true,x=>x.materialManifest.inputs[0].extra='/tmp/secret',x=>x.qualifiedMethods[0].scope='experimental-reproduction',x=>x.qualifiedMethods.push({...x.qualifiedMethods[0]}),x=>x.candidate.verificationRequired=false]){const x=fixture();modify(x);x.candidate.materialManifestDigest=digest(x.materialManifest);assert.throws(()=>compileVerificationContract(x));}
});
test('direct oversized string is refused before allocating serialized JSON',()=>{
 const x=fixture();x.candidate.criteria='x'.repeat(1048576);
 const original=JSON.stringify;let serializations=0;
 JSON.stringify=(...args)=>{serializations++;return original(...args);};
 try{assert.throws(()=>compileVerificationContract(x),e=>e.code==='verification_data_limit');assert.equal(serializations,0);}
 finally{JSON.stringify=original;}
});
test('overbound own-key graph refuses before allocating its descriptor map',()=>{
 const x=fixture();for(let i=0;i<5000;i++)x.candidate['extra'+i]=null;
 const original=Object.getOwnPropertyDescriptors;let candidateMaps=0;
 Object.getOwnPropertyDescriptors=v=>{if(v===x.candidate)candidateMaps++;return original(v);};
 try{assert.throws(()=>compileVerificationContract(x),e=>e.code==='verification_data_limit');assert.equal(candidateMaps,0);}
 finally{Object.getOwnPropertyDescriptors=original;}
});
