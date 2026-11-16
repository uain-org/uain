// FICTIONAL local worker fixtures only: no native node, custody key, signing or network.
// trusted_verification: a custody-checked fleet verification statement used like trusted_reproduction.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openWorker, canonical, digest, validateTrustedVerification, verificationStatementDigest} from '../src/worker.mjs';
import {acquireTestLock} from './test-lock.mjs';

const evidence=Buffer.from('FICTIONAL canonical evidence artifact');
const author='uain1'+'2'.repeat(40);
const assignment={submission:'S-fleet',task:'T-fleet',reviewer:'reviewer',author,criteria:'FICTIONAL: give two factors of the pinned n',criteria_digest:digest(Buffer.from('FICTIONAL: give two factors of the pinned n')),evidence_digest:digest(evidence),proof:{verified:true},state:'under_review'};
function statement(verdict='pass',change={}) {
  return {schema:'uain-fleet-verification-attestation-v1',domain:'UAIN/fleet-verification-attestation/v1',environment:'production',submission:assignment.submission,author,task:assignment.task,project:'P-OPP-00001',evidenceClass:'finite_math_witness',criteriaDigest:assignment.criteria_digest,evidenceDigest:assignment.evidence_digest,policyDigest:'a'.repeat(64),driver:{name:'finite-math-witness',sha256:'b'.repeat(64)},verdict,reproductionAttestationDigest:null,verificationDigest:'c'.repeat(64),mainKpiSatisfied:false,attestedAt:'2026-11-06T12:00:00Z',...change};
}
async function fixture(t,{verdicts=['accept'],basis=statement(),readinessPatch={}}={}) {
  const directory=await mkdtemp(join(tmpdir(),'reviewer-verification-fixture-'));
  let now='2026-11-06T12:30:00.000Z',current=basis,providerCalls=0,custodyCalls=0;const inputs=[],sent=[];
  const readiness=()=>({ready:true,required:!!current,submission:assignment.submission,criteriaDigest:assignment.criteria_digest,evidenceDigest:assignment.evidence_digest,attestationDigest:current?verificationStatementDigest(current):null,...(current?{trusted_verification:structuredClone(current)}:{}),...readinessPatch});
  const receiptFor=(executionId,commandDigest,decisionDigest)=>({verified:true,status:'finalized',executionId,commandDigest,decisionDigest,nativeCommandDigest:'f'.repeat(64),receipt:{authority:'native',finalized:true,event:{operation:'central_review',subject:assignment.submission,member:'reviewer',command_digest:'f'.repeat(64)}}});
  const finalized=body=>receiptFor(body.executionId,digest(Buffer.from(canonical(body.command))),body.command.payload.verification_digest);
  const deps={directory,reviewer:'reviewer',clock:()=>now,...(process.platform==='linux'?{}:{acquireLock:acquireTestLock}),
    source:{read:async()=>structuredClone(assignment),fetchEvidence:async()=>({bytes:evidence,owner:author,digest:assignment.evidence_digest,immutable:true,authenticated:true})},
    provider:{assess:async input=>{inputs.push(structuredClone(input));return {verdict:verdicts[Math.min(providerCalls++,verdicts.length-1)],findings:['FICTIONAL criterion finding']};}},
    custody:{readiness:async()=>readiness(),submitCentralReview:async body=>{custodyCalls++;sent.push(structuredClone(body));return finalized(body);},readOnlyReceipt:async request=>receiptFor(request.executionId,request.commandDigest,request.decisionDigest)}};
  const worker=await openWorker(deps);
  t.after(async()=>{await worker.close();await rm(directory,{recursive:true,force:true});});
  return {worker,deps,inputs,sent,counts:()=>({providerCalls,custodyCalls}),setBasis:value=>{current=value;},setClock:value=>{now=value;}};
}

test('shared fleet vector: statement digest matches custody and fixture statements are refused',async()=>{
  const vector=JSON.parse(await readFile(new URL('../../project-organizations/test/fixtures/fleet-attestation-vector.json',import.meta.url),'utf8'));
  assert.equal(verificationStatementDigest(vector.envelope.statement),vector.envelope.statementDigest);
  assert.throws(()=>validateTrustedVerification(vector.envelope.statement),/schema/);
  assert.deepEqual(validateTrustedVerification({...vector.envelope.statement,environment:'production'}),{...vector.envelope.statement,environment:'production'});
  for(const change of [{verdict:'needs_evidence'},{mainKpiSatisfied:true},{evidenceClass:'source_code_reproduction',driver:{name:'protected-reproduction-attestation',sha256:'b'.repeat(64)},reproductionAttestationDigest:'d'.repeat(64)},{attestedAt:'2026-13-40T12:00:00Z'},{author:'solver'},{driver:{name:'pinned-dataset-analysis',sha256:'b'.repeat(64)}},{extra:true}])
    assert.throws(()=>validateTrustedVerification(statement('pass',change)),/trusted verification/);
});

test('accepted trusted_verification flow records the statement digest and commits the v2 decision to it',async t=>{
  const f=await fixture(t);await f.worker.enqueue(assignment.submission);const job=await f.worker.run(assignment.submission);const attestation=verificationStatementDigest(statement());
  assert.equal(job.state,'completed');assert.equal(job.decision.schema,'uain-central-research-decision-v2');assert.equal(job.decision.verification_attestation_digest,attestation);assert.equal(job.decision.verdict,'accept');
  assert.equal(job.attestation_digest,attestation);assert.deepEqual(job.used_attestation_digests,[attestation]);assert.deepEqual(job.trusted_verification,statement());assert.equal(job.trusted_reproduction,undefined);
  assert.deepEqual(f.inputs[0].trusted_verification,statement());assert.equal(f.inputs[0].trusted_reproduction,undefined);assert.match(f.inputs[0].instruction,/never return accept when it says fail\. A pass is necessary, not sufficient/);
  // Native payload shape is unchanged; verification_digest is the v2 decision digest.
  assert.deepEqual(Object.keys(job.command.payload).sort(),['criteria_digest','evidence_digest','execution_id','submission','verdict','verification_digest']);
  assert.equal(job.command.payload.verification_digest,digest(Buffer.from('UAIN/central-research-review/v1\n'+canonical(job.decision))));
  assert.equal(f.counts().custodyCalls,1);assert.deepEqual(f.sent[0].decision,job.decision);
});

test('a driver fail is carried as a reject and needs_evidence stays allowed',async t=>{
  const f=await fixture(t,{verdicts:['reject'],basis:statement('fail')});await f.worker.enqueue(assignment.submission);const job=await f.worker.run(assignment.submission);
  assert.equal(job.state,'completed');assert.equal(job.decision.verdict,'reject');assert.equal(job.decision.verification_attestation_digest,verificationStatementDigest(statement('fail')));
  const g=await fixture(t,{verdicts:['needs_evidence']});await g.worker.enqueue(assignment.submission);const held=await g.worker.run(assignment.submission);
  assert.equal(held.state,'awaiting_evidence');assert.equal(held.decision.schema,'uain-central-research-decision-v2');assert.equal(g.counts().custodyCalls,1);
});

test('SV-1: a fixed-driver pass is necessary, not sufficient: the reviewer can still reject it (13 November 2026)',async t=>{
  // A fixed-driver fail never reaches the provider since 10 November 2026 (rule-decided, fair-share.test.mjs).
  const f=await fixture(t,{verdicts:['reject']});await f.worker.enqueue(assignment.submission);const job=await f.worker.run(assignment.submission);
  assert.equal(job.state,'completed');assert.equal(job.decision.verdict,'reject');assert.equal(job.decision.schema,'uain-central-research-decision-v2');assert.equal(job.decision.verification_attestation_digest,verificationStatementDigest(statement()));
  assert.equal(f.counts().providerCalls,1);assert.equal(f.counts().custodyCalls,1);assert.equal(f.sent[0].decision.verdict,'reject');
  assert.doesNotMatch(f.inputs[0].instruction,/never return a verdict that contradicts it/);assert.match(f.inputs[0].instruction,/never return accept when it says fail/);
});

test('SV-1: a final-round needs_evidence over a pass ends as reject and reaches custody (13 November 2026)',async t=>{
  const f=await fixture(t,{verdicts:['needs_evidence']});f.deps.source.read=async()=>({...structuredClone(assignment),revises:'S-original'});
  await f.worker.enqueue(assignment.submission);const job=await f.worker.run(assignment.submission);
  assert.equal(job.state,'completed');assert.equal(job.decision.verdict,'reject');assert.match(job.decision.findings[0],/Only one evidence request/);assert.equal(f.counts().custodyCalls,1);
});

test('SV-1: a provider accept over a driver fail can never be signed, even if a fail reached the provider',async t=>{
  // Rule-decided fails never call the provider; this guards the check itself with a verdict the provider is never asked for.
  const f=await fixture(t,{verdicts:['accept'],basis:statement('fail')});await f.worker.enqueue(assignment.submission);const job=await f.worker.run(assignment.submission);
  assert.equal(job.decision.verdict,'reject');assert.equal(f.counts().providerCalls,0);assert.ok(f.sent.every(body=>body.decision.verdict!=='accept'));
});

test('SV-1: a definite custody refusal leaves the same decision awaiting a later send, never uncertain forever (13 November 2026)',async t=>{
  // An older custody refuses reject-over-pass with HTTP 409; the custody client reports that as code custody_refused.
  const f=await fixture(t,{verdicts:['reject']});let refuse=true;const submit=f.deps.custody.submitCentralReview;
  f.deps.custody.submitCentralReview=async body=>{if(refuse){f.sent.push(structuredClone(body));throw Object.assign(Error('custody refused the decision'),{code:'custody_refused'});}return submit(body);};
  await f.worker.enqueue(assignment.submission);const held=await f.worker.run(assignment.submission);
  assert.equal(held.state,'awaiting_verification');assert.equal(held.blocked_reason,'custody_refused');assert.equal(held.decision.verdict,'reject');assert.equal(held.phase,'custody');
  const again=await f.worker.run(assignment.submission);assert.equal(again.state,'awaiting_verification');
  refuse=false;const done=await f.worker.run(assignment.submission);
  assert.equal(done.state,'completed');assert.equal(done.decision.verdict,'reject');assert.equal(done.execution_id,held.execution_id);assert.equal(f.counts().providerCalls,1);
  assert.deepEqual(f.sent.map(body=>body.executionId),[held.execution_id,held.execution_id,held.execution_id]);assert.ok(f.sent.every(body=>canonical(body.decision)===canonical(held.decision)));
  // Any other custody failure is still an unknown outcome that is only reconciled, never resent.
  const g=await fixture(t,{verdicts:['reject']});g.deps.custody.submitCentralReview=async()=>{throw Error('custody outcome unknown');};
  await g.worker.enqueue(assignment.submission);const unknown=await g.worker.run(assignment.submission);assert.equal(unknown.state,'uncertain');assert.equal(unknown.reason,'custody_outcome_unknown');
});

test('wrong digest, environment or binding is refused before any provider call',async t=>{
  const cases=[{readinessPatch:{attestationDigest:'0'.repeat(64)}},{basis:statement('pass',{environment:'fixture'})},{basis:statement('pass',{evidenceDigest:'0'.repeat(64)})},{basis:statement('pass',{author:'uain1'+'3'.repeat(40)})},{basis:statement('pass',{submission:'S-other'})},{basis:statement('pass',{criteriaDigest:'0'.repeat(64)})},{readinessPatch:{trusted_reproduction:{schema:'uain-trusted-reproduction-v1'}}}];
  for(const options of cases){
    const f=await fixture(t,options);await f.worker.enqueue(assignment.submission);await assert.rejects(f.worker.run(assignment.submission));
    assert.deepEqual(f.counts(),{providerCalls:0,custodyCalls:0});
  }
});

test('required verification that is not ready keeps the job queued with zero model cost',async t=>{
  const f=await fixture(t,{readinessPatch:{ready:false,reason:'fleet_verification_required'}});await f.worker.enqueue(assignment.submission);const job=await f.worker.run(assignment.submission);
  assert.equal(job.state,'queued');assert.equal(job.blocked_reason,'independent_reproduction_required');assert.deepEqual(f.counts(),{providerCalls:0,custodyCalls:0});
});

test('re-review on a later fleet statement records its digest, archives history and runs once',async t=>{
  const f=await fixture(t,{verdicts:['needs_evidence','accept'],basis:null});await f.worker.enqueue(assignment.submission);const first=await f.worker.run(assignment.submission);
  assert.equal(first.state,'awaiting_evidence');assert.equal(first.decision.schema,'uain-central-research-decision-v1');
  const later=statement('pass',{attestedAt:'2026-11-06T13:00:00Z'}),attestation=verificationStatementDigest(later);f.setBasis(later);f.setClock('2026-11-06T13:05:00.000Z');
  const next=await f.worker.run(assignment.submission);
  assert.equal(next.state,'completed');assert.notEqual(next.execution_id,first.execution_id);assert.equal(next.required_attestation_digest,attestation);assert.equal(next.attestation_digest,attestation);assert.ok(next.used_attestation_digests.includes(attestation));
  assert.equal(next.history.length,1);assert.equal(next.history[0].execution_id,first.execution_id);assert.deepEqual(next.history[0].decision,first.decision);assert.equal(next.history[0].trusted_verification,undefined);
  assert.equal(next.decision.schema,'uain-central-research-decision-v2');assert.equal(next.decision.verification_attestation_digest,attestation);assert.deepEqual(f.inputs[1].trusted_verification,later);assert.equal(f.counts().providerCalls,2);
});

test('a used or stale fleet statement never authorizes another model attempt',async t=>{
  const used=await fixture(t,{verdicts:['needs_evidence']});await used.worker.enqueue(assignment.submission);const first=await used.worker.run(assignment.submission);
  assert.equal(first.attestation_digest,verificationStatementDigest(statement()));await used.worker.run(assignment.submission);assert.equal(used.counts().providerCalls,1);assert.equal(used.worker.status(assignment.submission).execution_id,first.execution_id);
  const stale=await fixture(t,{verdicts:['needs_evidence'],basis:null});await stale.worker.enqueue(assignment.submission);await stale.worker.run(assignment.submission);
  stale.setBasis(statement('pass',{attestedAt:'2026-11-06T12:00:00Z'}));await stale.worker.run(assignment.submission);assert.equal(stale.counts().providerCalls,1);
});

test('V2 dual digests are recomputed before provider, and full signed statement binds the unchanged decision-v2',async t=>{
 const artifact={schema:'uain-evidence-artifact-v1',taskId:assignment.task,submissionId:assignment.submission,author,survey:{mainKpi:'FICTIONAL test KPI'}},bytes=Buffer.from(JSON.stringify(artifact,null,2)),raw=digest(bytes),encoded=digest(Buffer.from(canonical(artifact)));
 const basis=statement('pass',{schema:'uain-fleet-verification-attestation-v2',domain:'UAIN/fleet-verification-attestation/v2',chainId:'uain-shadow-20261008-1',genesisSha256:'54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff',evidenceClass:'prior_art_survey',driver:{name:'prior-art-survey',sha256:'b'.repeat(64)},evidenceDigest:raw,canonicalArtifactDigest:encoded});
 const f=await fixture(t,{basis,readinessPatch:{evidenceDigest:raw}});
 f.deps.source.read=async()=>({...assignment,evidence_digest:raw,proof:{verified:true,authority:'native',chainId:basis.chainId,genesisSha256:basis.genesisSha256}});f.deps.source.fetchEvidence=async()=>({bytes,owner:author,digest:raw,immutable:true,authenticated:true});
 await f.worker.enqueue(assignment.submission);const job=await f.worker.run(assignment.submission);
 assert.equal(job.state,'completed');assert.equal(job.decision.schema,'uain-central-research-decision-v2');assert.equal(job.decision.verification_attestation_digest,digest(Buffer.from(basis.domain+'\n'+canonical(basis))));assert.deepEqual(job.trusted_verification,basis);assert.equal(job.command.payload.evidence_digest,raw);assert.equal(job.command.payload.verification_digest,digest(Buffer.from('UAIN/central-research-review/v1\n'+canonical(job.decision))));
 const g=await fixture(t,{basis:{...basis,canonicalArtifactDigest:'f'.repeat(64)},readinessPatch:{evidenceDigest:raw}});g.deps.source.read=f.deps.source.read;g.deps.source.fetchEvidence=f.deps.source.fetchEvidence;
 await g.worker.enqueue(assignment.submission);await assert.rejects(g.worker.run(assignment.submission));assert.deepEqual(g.counts(),{providerCalls:0,custodyCalls:0});
 const h=await fixture(t,{basis,readinessPatch:{evidenceDigest:raw}});h.deps.source.read=async()=>({...await f.deps.source.read(),proof:{verified:true,authority:'native',chainId:'other-chain',genesisSha256:basis.genesisSha256}});h.deps.source.fetchEvidence=f.deps.source.fetchEvidence;await h.worker.enqueue(assignment.submission);await assert.rejects(h.worker.run(assignment.submission));assert.deepEqual(h.counts(),{providerCalls:0,custodyCalls:0});
 const foreign=Object.assign(Object.create({foreign:true}),basis);assert.throws(()=>validateTrustedVerification(foreign));
 for(const bad of [{...basis,domain:'UAIN/fleet-verification-attestation/v1'},{...basis,evidenceClass:'finite_math_witness'}, {...basis,canonicalArtifactDigest:'bad'}])assert.throws(()=>validateTrustedVerification(bad));
});
