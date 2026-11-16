// FICTIONAL local worker fixtures only: no native node, keys, signing or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openWorker, canonical, digest} from '../src/worker.mjs';
import {acquireTestLock} from './test-lock.mjs';

const evidence=Buffer.from('FICTIONAL fixed submission evidence');
const assignment={submission:'S-recovery',task:'T-recovery',reviewer:'reviewer',author:'solver',criteria:'Check the fixed fictional evidence',criteria_digest:digest(Buffer.from('Check the fixed fictional evidence')),evidence_digest:digest(evidence),proof:{verified:true},state:'under_review'};
function summary(hash='a') {
  return {schema:'uain-trusted-reproduction-v1',digest:hash.repeat(64),native_binary_sha256:'b'.repeat(64),live_source_sha256:'c'.repeat(64),corrected_source_sha256:'d'.repeat(64),reproducer_sha256:'e'.repeat(64),before_outcome:'failed',after_outcome:'passed',reviewed_at:'2026-11-05T21:00:00.000Z',review_notes:'FICTIONAL independently reviewed reproduction; not a live attestation'};
}
function finalized(executionId,commandDigest,decisionDigest) {
  return {verified:true,status:'finalized',executionId,commandDigest,decisionDigest,nativeCommandDigest:'f'.repeat(64),receipt:{authority:'native',finalized:true,chain_id:'FICTIONAL-only',event:{id:'1',height:'100',operation:'central_review',subject:assignment.submission,member:assignment.reviewer,command_digest:'f'.repeat(64)}}};
}
async function fixture(t,{secondVerdict='accept',initialBasis=null,ambiguous=false,workerOptions={}}={}) {
  const directory=await mkdtemp(join(tmpdir(),'reviewer-recovery-fixture-'));
  let now='2026-11-05T20:00:00.000Z',basis=initialBasis,receiptMode='finalized',providerCalls=0,custodyCalls=0,receiptCalls=0;
  const inputs=[],sent=[];let current=structuredClone(assignment);
  const readiness=()=>({ready:true,required:!!basis,submission:assignment.submission,criteriaDigest:assignment.criteria_digest,evidenceDigest:assignment.evidence_digest,attestationDigest:basis?.digest??null,trusted_reproduction:basis?structuredClone(basis):null});
  const deps={directory,reviewer:'reviewer',clock:()=>now,...(process.platform==='linux'?{}:{acquireLock:acquireTestLock}),source:{read:async()=>structuredClone(current),fetchEvidence:async()=>({bytes:evidence,owner:'solver',digest:assignment.evidence_digest,immutable:true,authenticated:true})},provider:{assess:async input=>{inputs.push(structuredClone(input));providerCalls++;return {verdict:providerCalls===1?'needs_evidence':secondVerdict,findings:['FICTIONAL criterion finding']};}},custody:{readiness:async()=>readiness(),submitCentralReview:async body=>{custodyCalls++;sent.push(structuredClone(body));if(ambiguous)throw Error('FICTIONAL lost custody outcome');return finalized(body.executionId,digest(Buffer.from(canonical(body.command))),body.command.payload.verification_digest);},readOnlyReceipt:async request=>{receiptCalls++;return receiptMode==='unknown'?{status:'unknown'}:finalized(request.executionId,request.commandDigest,request.decisionDigest);}},...workerOptions};
  const worker=await openWorker(deps);
  t.after(async()=>{await worker.close();await rm(directory,{recursive:true,force:true});});
  return {worker,deps,inputs,sent,counts:()=>({providerCalls,custodyCalls,receiptCalls}),setBasis:value=>{basis=value;now=new Date(Date.parse(value?.reviewed_at??'2026-11-05T21:00:00.000Z')+1000).toISOString();},setAssignment:value=>{current=value;},setReceiptMode:value=>{receiptMode=value;},setClock:value=>{now=value;}};
}
async function initialNeeds(f) {
  await f.worker.enqueue(assignment.submission);
  const first=await f.worker.run(assignment.submission);
  assert.equal(first.state,'awaiting_evidence');
  assert.equal(first.decision.verdict,'needs_evidence');
  return first;
}

test('finalized needs-evidence resumes once on a new root basis with a distinct execution and retained history',async t=>{
  const f=await fixture(t);const first=await initialNeeds(f);f.setBasis(summary());
  const next=await f.worker.run(assignment.submission);
  assert.equal(next.state,'completed');assert.equal(next.decision.verdict,'accept');
  assert.notEqual(next.execution_id,first.execution_id);assert.equal(f.counts().providerCalls,2);assert.equal(f.counts().custodyCalls,2);assert.ok(f.counts().receiptCalls>=1);
  assert.equal(next.history.length,1);assert.equal(next.history[0].execution_id,first.execution_id);assert.deepEqual(next.history[0].decision,first.decision);assert.deepEqual(next.history[0].receipt,first.receipt);
  assert.deepEqual(f.inputs[1].trusted_reproduction,summary());assert.equal(f.inputs[1].evidence,evidence.toString());
});

test('no new root basis leaves the retained lock without another provider or custody attempt',async t=>{
  const f=await fixture(t);const first=await initialNeeds(f);await f.worker.run(assignment.submission);await f.worker.enqueue(assignment.submission);
  assert.equal(f.worker.status(assignment.submission).execution_id,first.execution_id);assert.equal(f.counts().providerCalls,1);assert.equal(f.counts().custodyCalls,1);
});

test('a previously used root basis cannot authorize another model attempt',async t=>{
  const basis=summary();const f=await fixture(t,{initialBasis:basis});const first=await initialNeeds(f);f.setBasis(basis);await f.worker.run(assignment.submission);
  assert.equal(f.counts().providerCalls,1);assert.equal(f.worker.status(assignment.submission).execution_id,first.execution_id);
});

test('unconfirmed original receipt cannot be replaced by a fresh reproduction',async t=>{
  const f=await fixture(t);const first=await initialNeeds(f);f.setBasis(summary());f.setReceiptMode('unknown');await f.worker.run(assignment.submission);
  assert.equal(f.counts().providerCalls,1);assert.equal(f.counts().custodyCalls,1);assert.equal(f.worker.status(assignment.submission).execution_id,first.execution_id);
});

test('a fresh proof with a changed author or evidence never starts the re-review',async t=>{
  for(const changed of [{author:'another-author'},{evidence_digest:'0'.repeat(64)},{criteria_digest:'0'.repeat(64)},{task:'another-task'}]){
    const f=await fixture(t);const first=await initialNeeds(f);f.setBasis(summary());f.setAssignment({...assignment,...changed});
    try{await f.worker.run(assignment.submission);}catch{}
    assert.equal(f.counts().providerCalls,1);assert.equal(f.counts().custodyCalls,1);assert.equal(f.worker.status(assignment.submission).execution_id,first.execution_id);
  }
});

test('a second inconclusive result cannot consume a third model attempt even with another root digest',async t=>{
  const f=await fixture(t,{secondVerdict:'needs_evidence'});await initialNeeds(f);f.setBasis(summary());const second=await f.worker.run(assignment.submission);assert.equal(f.counts().providerCalls,2);
  f.setBasis({...summary('9'),reviewed_at:'2026-11-05T22:00:00.000Z'});await f.worker.run(assignment.submission);
  assert.equal(f.counts().providerCalls,2);assert.equal(f.counts().custodyCalls,2);assert.equal(f.worker.status(assignment.submission).execution_id,second.execution_id);assert.equal(f.worker.status(assignment.submission).history.length,1);
});

test('new attestation data cannot reset an unknown custody outcome',async t=>{
  const f=await fixture(t,{ambiguous:true});await f.worker.enqueue(assignment.submission);const first=await f.worker.run(assignment.submission);assert.equal(first.state,'uncertain');f.setBasis(summary());await f.worker.run(assignment.submission);
  assert.equal(f.counts().providerCalls,1);assert.equal(f.counts().custodyCalls,1);assert.equal(f.worker.status(assignment.submission).execution_id,first.execution_id);
});

test('malformed or stale trusted summaries do not authorize the re-review',async t=>{
  for(const changed of [{before_outcome:'passed'},{digest:'bad'},{reviewed_at:'2026-11-05T19:00:00.000Z'},{raw_logs:'must never enter the model'}]){
    const f=await fixture(t);await initialNeeds(f);f.setBasis({...summary(),...changed});try{await f.worker.run(assignment.submission);}catch{}
    assert.equal(f.counts().providerCalls,1);assert.equal(f.counts().custodyCalls,1);
  }
});


test('one-time re-review and its immutable archive survive restart',async t=>{
  const f=await fixture(t,{secondVerdict:'needs_evidence'});const first=await initialNeeds(f);f.setBasis(summary());const second=await f.worker.run(assignment.submission);
  const archived=JSON.stringify(second.history);await f.worker.close();
  const again=await openWorker(f.deps);
  try{
    f.setBasis({...summary('9'),reviewed_at:'2026-11-05T22:00:00.000Z'});await again.run(assignment.submission);
    const retained=again.status(assignment.submission);assert.equal(retained.execution_id,second.execution_id);assert.equal(JSON.stringify(retained.history),archived);assert.equal(retained.history[0].execution_id,first.execution_id);assert.equal(f.counts().providerCalls,2);assert.equal(f.counts().custodyCalls,2);
  }finally{await again.close();}
});


test('a budget-delayed re-review rechecks its original assignment before later provider work',async t=>{
  const f=await fixture(t,{workerOptions:{hourlyAttempts:1,dailyAttempts:1}});await initialNeeds(f);f.setBasis(summary());
  const waiting=await f.worker.run(assignment.submission);assert.equal(waiting.state,'queued');assert.equal(waiting.blocked_reason,'provider_attempt_budget');assert.equal(f.counts().providerCalls,1);
  f.setAssignment({...assignment,author:'changed-after-archive'});f.setClock('2026-11-06T22:00:00.000Z');
  await assert.rejects(f.worker.run(assignment.submission),/fresh re-review assignment/);assert.equal(f.counts().providerCalls,1);assert.equal(f.counts().custodyCalls,1);assert.equal(f.worker.status(assignment.submission).history.length,1);
});

test('S6: an author-requested reassessment re-reviews once without a new root basis; a second evidence request becomes a reject',async t=>{
  const f=await fixture(t,{secondVerdict:'needs_evidence'});const first=await initialNeeds(f);
  f.setAssignment({...structuredClone(assignment),reassess:true,evidence_deadline:'200'});
  const next=await f.worker.run(assignment.submission);
  assert.equal(next.state,'completed');assert.equal(next.decision.verdict,'reject');assert.match(next.decision.findings[0],/Only one evidence request/);
  assert.notEqual(next.execution_id,first.execution_id);assert.equal(next.reassessed,true);assert.equal(next.history.at(-1).reason,'reassessment');
  assert.equal(f.counts().providerCalls,2);assert.equal(f.counts().custodyCalls,2);
  // Once only.
  await f.worker.run(assignment.submission);assert.equal(f.counts().providerCalls,2);
});
test('S6: without a reassessment flag the awaiting job keeps its lock',async t=>{
  const f=await fixture(t);await initialNeeds(f);f.setAssignment({...structuredClone(assignment),evidence_deadline:'200'});
  const again=await f.worker.run(assignment.submission);assert.equal(again.state,'awaiting_evidence');assert.equal(f.counts().providerCalls,1);
});
test('S6: a linked revision cannot receive a second evidence request',async t=>{
  const f=await fixture(t);f.setAssignment({...structuredClone(assignment),revises:'S-original'});
  await f.worker.enqueue(assignment.submission);const r=await f.worker.run(assignment.submission);
  assert.equal(r.decision.verdict,'reject');assert.equal(r.state,'completed');assert.equal(f.counts().custodyCalls,1);
});
