/** Fictional survey, public test keys and fixed semantic driver; no network or custody. */
import test from 'node:test';import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import * as v from '../src/verification.mjs';import * as review from '../src/review-input.mjs';
import {canonical,digest,sha256,FLEET_NATIVE_NETWORK} from '../src/common.mjs';import {SURVEY_HOSTS} from '../src/survey-sources.mjs';
const author='uain1'+'a'.repeat(40),criteria='Fictional prior-art survey criteria.',assignment={taskId:'T-survey-fixture',projectId:'P-fixture',submissionId:'S-fixture',author,criteriaDigest:sha256(criteria)};
const policy={schema:v.POLICY_SCHEMA,class:'prior_art_survey',taskId:assignment.taskId,projectId:assignment.projectId,criteriaDigest:assignment.criteriaDigest,inputs:[],primarySourceHosts:[...SURVEY_HOSTS],driver:{name:'prior-art-survey',sha256:v.driverDigest('prior-art-survey')},successTests:[{id:'survey',mainKpi:'Fictional bounded Main KPI for verification only.',minIncluded:1,minKinds:1,requiredIds:[]}]};
const artifact={schema:v.ARTIFACT_SCHEMA,author,taskId:assignment.taskId,submissionId:assignment.submissionId,survey:{mainKpi:policy.successTests[0].mainKpi,asOf:'2026-11-06',items:[{kind:'nct',id:'NCT00000001',title:'FICTIONAL fixture record',relation:'partial',note:'Fictional tested inventory.'}],conclusion:{meetsMainKpi:false,gaps:['Fictional remaining gap for this bounded test fixture.']}}};
const raw=JSON.stringify(artifact,null,2),canonicalSHA=digest(artifact),rawSHA=sha256(raw);
const retriever={observe:async url=>({url,status:200,bytes:Buffer.from(JSON.stringify({protocolSection:{identificationModule:{nctId:'NCT00000001',briefTitle:'FICTIONAL fixture record'}}}))})};
const pacing={sleep:async()=>{},now:()=>0};
const network={...FLEET_NATIVE_NETWORK},input={taskPolicy:policy,assignment,nativeEvidence:raw,network};
const submission={submission:assignment.submissionId,task:assignment.taskId,author,state:'under_review',criteria,criteria_digest:sha256(criteria),evidence_digest:rawSHA,proof:{verified:true}};
const keys=generateKeyPairSync('ed25519'),publicKey=keys.publicKey.export({format:'der',type:'spki'}).subarray(12).toString('base64');
function envelope(payload,verdict='pass'){
 const statement={schema:'uain-fleet-verification-attestation-v2',domain:'UAIN/fleet-verification-attestation/v2',environment:'fixture',submission:assignment.submissionId,author,task:assignment.taskId,project:assignment.projectId,evidenceClass:'prior_art_survey',criteriaDigest:assignment.criteriaDigest,evidenceDigest:rawSHA,canonicalArtifactDigest:canonicalSHA,policyDigest:digest(policy),driver:policy.driver,verdict,reproductionAttestationDigest:null,verificationDigest:digest(payload),mainKpiSatisfied:false,attestedAt:'2026-11-08T20:00:00Z',...network};
 const bytes=Buffer.from(statement.domain+'\n'+canonical(statement));return{statement,statementDigest:sha256(bytes),publicKey,signature:sign(null,bytes,keys.privateKey).toString('base64')};
}
test('dual digest semantic verifier uses real fixed driver and versions payload without changing raw wire',async()=>{
 const result=await v.verifyEvidenceV2(input,{retriever,runner:v.createRunner(),surveyPacing:pacing});assert.equal(result.verdict,'pass',JSON.stringify(result.findings));assert.equal(result.attestation.schema,'uain-task-verification-attestation-v2');assert.equal(result.attestation.domain,'UAIN/task-verification-attestation/v2');assert.equal(result.attestation.nativeEvidenceDigest,rawSHA);assert.equal(result.attestation.canonicalArtifactDigest,canonicalSHA);assert.notEqual(rawSHA,canonicalSHA);assert.equal(result.mainKpiSatisfied,false);
 assert.equal(raw,JSON.stringify(artifact,null,2));assert.equal(result.attestationDigest,digest(result.attestation));
 const failed=await v.verifyEvidenceV2({...input,nativeEvidence:JSON.stringify({...artifact,survey:{...artifact.survey,conclusion:{meetsMainKpi:true,gaps:[]}}})},{retriever,runner:v.createRunner(),surveyPacing:pacing});assert.equal(failed.verdict,'fail');
});
test('raw JS consumer requires explicit v2 admission and derives both digests, with real signature verification',async()=>{
 const result=await v.verifyEvidenceV2(input,{retriever,runner:v.createRunner(),surveyPacing:pacing}),attestation=envelope(result.attestation),args={submission,taskPolicy:policy,attestation,trustedKeys:[{publicKey,environment:'fixture'}],environment:'fixture',nativeEvidence:raw,network};
 assert.throws(()=>review.reviewInput(args),/attestation_version_not_allowed/);
 assert.equal(review.reviewInput({...args,allowedVersions:[1,2]}).verdict,'accept');
 for(const change of [{nativeEvidence:raw+' '},{nativeEvidence:undefined},{allowedVersions:[true]},{allowedVersions:[2,2]},{network:{...network,chainId:'other-chain'}},{network:{...network,genesisSha256:'f'.repeat(64)}}])assert.throws(()=>review.reviewInput({...args,allowedVersions:[2],...change}));
 for(const field of ['evidenceDigest','canonicalArtifactDigest','chainId','genesisSha256']){const bad=structuredClone(attestation);bad.statement[field]=field==='chainId'?'other-chain':'f'.repeat(64);const bytes=Buffer.from(bad.statement.domain+'\n'+canonical(bad.statement));bad.statementDigest=sha256(bytes);bad.signature=sign(null,bytes,keys.privateKey).toString('base64');assert.throws(()=>review.reviewInput({...args,allowedVersions:[2],attestation:bad}));}
 const wrongDomain=structuredClone(attestation);wrongDomain.statement.domain='UAIN/fleet-verification-attestation/v1';assert.throws(()=>review.reviewInput({...args,allowedVersions:[2],attestation:wrongDomain}));
});
test('strict duplicate/float/surrogate/bound/binding checks refuse before retrieval or driver',async()=>{
 let calls=0;const dependencies={retriever:{observe:async()=>{calls++;throw Error('must not fetch');}},runner:{run:async()=>{calls++;throw Error('must not run');}}};
 for(const nativeEvidence of ['{"x":1,"\\u0078":2}','{"x":1.0}','{"x":1.5}','{"x":9007199254740992}','{"\\ud800":0}','{"x":'+'['.repeat(80)+'0'+']'.repeat(80)+'}',raw+' '.repeat(16384),JSON.stringify({...artifact,author:'uain1'+'b'.repeat(40)}),JSON.stringify({...artifact,attestation:{forged:true}})]){
  await assert.rejects(v.verifyEvidenceV2({...input,nativeEvidence},dependencies));assert.equal(calls,0);
 }
});

test('cross-language real root issuer reruns the fixed driver and signs both digests; JS verifies exact authority',async()=>{
 const {spawnSync}=await import('node:child_process'),{fileURLToPath}=await import('node:url'),{createPrivateKey,createPublicKey}=await import('node:crypto');
 const service=await v.verifyEvidenceV2(input,{retriever,runner:v.createRunner(),surveyPacing:pacing});
 const nodeScript=`import{readFileSync}from'node:fs';import{verifyEvidenceV2,createRunner}from${JSON.stringify(new URL('../src/verification.mjs',import.meta.url).href)};const i=JSON.parse(readFileSync(0,'utf8'));const retriever={observe:async url=>({url,status:200,bytes:Buffer.from(JSON.stringify({protocolSection:{identificationModule:{nctId:'NCT00000001',briefTitle:'FICTIONAL fixture record'}}}))})};console.log(JSON.stringify(await verifyEvidenceV2(i,{retriever,runner:createRunner(),surveyPacing:{sleep:async()=>{},now:()=>0}})));`;
 const python=`import sys,json,tempfile,os,subprocess,shutil
from pathlib import Path
sys.path.insert(0,'ops/custody')
import fleet_attestation as f
import native_migration as native
x=json.load(sys.stdin);p=x['policy'];a=x['assignment'];raw=x['raw'];c=x['criteria'];artifact=json.loads(raw)
t=dict(id=a['taskId'],project=a['projectId'],state='under_review',pending=a['submissionId'],criteria=c,acceptance_digest=f.sha(c.encode()))
s=dict(id=a['submissionId'],task=a['taskId'],author=a['author'],state='under_review',evidence=raw,evidence_digest=f.sha(raw.encode()))
assert f.expected_payload_v2(p,t,s,'pass',None,network=x['network'])==x['payload']
with tempfile.TemporaryDirectory() as directory:
 root=Path(directory).resolve();script=root/'rerun-fixture.mjs';script.write_text(x['nodeScript']);policy=root/'policy.json';policy.write_text(json.dumps(p));os.chmod(policy,0o600);drivers=root/'drivers';drivers.mkdir();shutil.copyfile('services/project-organizations/verifiers/prior-art-survey.mjs',drivers/'prior-art-survey.mjs');os.chmod(drivers/'prior-art-survey.mjs',0o600)
 def rerun(driver,policy_copy,artifact_copy):
  assert f.sha(driver['source'])==p['driver']['sha256'] and policy_copy==p and artifact_copy==artifact
  result=subprocess.run([x['node'],str(script)],input=json.dumps(dict(taskPolicy=p,assignment=a,nativeEvidence=raw,network=x['network'])),text=True,capture_output=True,timeout=30,check=True,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'})
  claim=json.loads(result.stdout);assert claim['attestation']==x['payload'];return dict(verdict=claim['verdict'],reproductionAttestationDigest=None)
 pub,sign=native.ed25519(bytes(range(32)))
 envelope=f.attest_v2(policy,x['payload'],f.js_digest(x['payload']),t,s,rerun,lambda message:dict(public_key=pub,signature=sign(message)),'fixture',allowed_versions=(2,),trusted_uids=(0,os.getuid()),driver_directory=drivers,boundary=root,network=x['network'])
 f.check_review_bindings(envelope,pub,'fixture',p,t,s,allowed_versions=(2,),network=x['network'])
 print(json.dumps(dict(envelope=envelope,canonicalVector=f.js_canonical(x['canonicalVector']))))
`;
 const vector={'\u{10000}':1,'\ue000':2};
 const run=spawnSync(process.env.UAIN_CRYPTO_PYTHON??(process.platform==='darwin'?'/usr/bin/python3':'python3'),['-c',python],{cwd:fileURLToPath(new URL('../../../',import.meta.url)),encoding:'utf8',timeout:60000,maxBuffer:1024*1024,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},input:JSON.stringify({policy,assignment,raw,criteria,payload:service.attestation,node:process.execPath,nodeScript,canonicalVector:vector,network})});
 assert.equal(run.status,0,run.stderr);const result=JSON.parse(run.stdout);assert.equal(result.canonicalVector,canonical(vector));
 const fixturePrivate=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(Array.from({length:32},(_,i)=>i))]),format:'der',type:'pkcs8'});
 const expectedPublic=createPublicKey(fixturePrivate).export({format:'der',type:'spki'}).subarray(12).toString('base64');assert.equal(result.envelope.publicKey,expectedPublic);
 assert.equal(review.reviewInput({submission,taskPolicy:policy,attestation:result.envelope,trustedKeys:[{publicKey:expectedPublic,environment:'fixture'}],environment:'fixture',nativeEvidence:raw,allowedVersions:[2],network}).verdict,'accept');
});

test('fixed survey wrapper selects an exact version with no fallback and retains v1 output',async()=>{
 const {verifySurvey}=await import('../ops/verify-survey.mjs');let calls=0;
 const deps={retriever:{observe:async(...args)=>{calls++;return retriever.observe(...args);}},runner:v.createRunner()};
 const legacy=await verifySurvey({policy,assignment,artifact},deps);assert.equal(legacy.attestation.schema,'uain-task-verification-attestation-v1');assert.equal(legacy.attestation.artifactDigest,canonicalSHA);
 const current=await verifySurvey({policy,assignment,version:2,nativeEvidence:raw,network},deps);assert.equal(current.attestation.nativeEvidenceDigest,rawSHA);assert.equal(current.attestation.canonicalArtifactDigest,canonicalSHA);assert.equal(current.driverSha256,policy.driver.sha256);
 const before=calls;for(const version of [0,3,true,'2'])await assert.rejects(verifySurvey({policy,assignment,artifact,version},deps));
 await assert.rejects(verifySurvey({policy,assignment,artifact,version:2},deps));assert.equal(calls,before);
});

test('wrong independent native network fails before retrieval or scientific driver',async()=>{let calls=0;for(const network of [undefined,{chainId:'other',genesisSha256:'f'.repeat(64)},{chainId:'uain-shadow-20261008-1',genesisSha256:'f'.repeat(64)}]){await assert.rejects(v.verifyEvidenceV2({...input,network},{retriever:{observe:async()=>{calls++;}},runner:{run:async()=>{calls++;}}}),/attestation_network_mismatch/);assert.equal(calls,0);}});
