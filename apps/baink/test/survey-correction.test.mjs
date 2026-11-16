import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
const codec=await import('../shared/survey-correction.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;});
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const sha=v=>createHash('sha256').update(v).digest('hex');
const hash='a'.repeat(64);
function fixture(){
 const keys=generateKeyPairSync('ed25519'),publicKey=keys.publicKey.export({format:'jwk'}).x,member='uain1'+sha(Buffer.from(publicKey,'base64url')).slice(0,40);
 const body={schema:'uain-survey-author-correction-v1',chainId:'fixture-chain',genesisSha256:hash,author:{member,instance:null},projectId:'project-1',taskId:'task-1',submissionId:'submission-1',original:{nativeEvidenceDigest:hash,canonicalArtifactDigest:hash,criteriaDigest:hash,policyDigest:hash,attestationDigest:hash},priorReview:{executionId:'review-1',verificationDigest:hash,reviewRecordDigest:hash,feedbackDecisionDigest:hash},correctionIndex:1,previousCorrectionDigest:null,edits:[{kind:'doi',id:'10.1234/fictional',oldNoteSha256:hash,newNote:'A corrected fictional note with no achievement claim.',sourceRefs:[{kind:'doi',id:'10.1234/fictional'}]}],correctedArtifactDigest:hash,consent:{nonce:'b'.repeat(32),issuedAt:'2026-11-09T00:00:00.000Z',expiresAt:'2026-11-09T00:10:00.000Z'}};
 const envelope={schema:'uain-survey-author-envelope-v1',body,publicKey,signature:sign(null,Buffer.from('UAIN/central-survey-correction/author/v1\n'+canonical(body)),keys.privateKey).toString('base64url')};return{envelope,keys,member};
}
test('canonical raw author wire parses without changing signed body or Unicode',()=>{
 const{envelope}=fixture();assert.equal(typeof codec.parseAuthorEnvelope,'function','author wire codec is missing');
 const bytes=Buffer.from(canonical(envelope));assert.deepEqual(codec.parseAuthorEnvelope(bytes),envelope);
});
test('new author wire rejects noncanonical aliases, duplicate keys, invalid UTF8 and unbounded structure',()=>{
 const{envelope}=fixture(),wire=canonical(envelope);
 for(const bad of [wire+'\n',' '+wire,wire.replace('"schema":','"schema":"duplicate","schema":'),wire.replace('"correctionIndex":1','"correctionIndex":1.0'),wire.replace('"correctionIndex":1','"correctionIndex":-0'),Buffer.from([0xff]),'\ufeff'+wire,'['.repeat(65)+'0'+']'.repeat(65)])assert.throws(()=>codec.parseAuthorEnvelope(bad));
});
test('author wire refuses unknown private fields and invalid closed body/instance/note/reference/timestamp shapes',()=>{
 const{envelope}=fixture();
 const changes=[e=>e.body.genesisSha256=[e.body.genesisSha256],e=>e.body.author.member=[e.body.author.member],e=>e.privatePrompt='not public',e=>e.body.author.extra=true,e=>e.body.author.instance='',e=>e.body.consent.issuedAt='2026-11-09T00:00:00Z',e=>e.body.consent.expiresAt='2026-11-09T00:10:00.001Z',e=>e.body.edits[0].newNote='x'.repeat(401),e=>e.body.edits[0].sourceRefs[0].url='https://untrusted.invalid',e=>e.body.previousCorrectionDigest=hash,e=>e.body.priorReview.feedbackDecisionDigest='c'.repeat(64)];
 for(const change of changes){const e=structuredClone(envelope);change(e);assert.throws(()=>codec.parseAuthorEnvelope(canonical(e)));}
});
function expectedFor(envelope,{instance=envelope.body.author.instance,chainHead=null}={}){const b=envelope.body;return{chainId:b.chainId,genesisSha256:b.genesisSha256,author:{...b.author,instance,publicKey:envelope.publicKey},projectId:b.projectId,taskId:b.taskId,submissionId:b.submissionId,original:structuredClone(b.original),priorReview:{...b.priorReview,verdict:'needs_evidence',finalized:true},chainHead};}
const clock=()=>Date.parse('2026-11-09T00:05:00.000Z');
test('real author signature binds independent network, exact native instance and finalized prior review',async()=>{
 const{envelope}=fixture();assert.equal(typeof codec.validateAuthorCorrection,'function','signature/context validator missing');
 assert.deepEqual(await codec.validateAuthorCorrection(envelope,expectedFor(envelope),{now:clock}),envelope);
 for(const edit of [e=>e.genesisSha256='c'.repeat(64),e=>e.author.instance='foreign-instance',e=>e.priorReview.finalized=false,e=>e.priorReview.verdict='accept']){const expected=expectedFor(envelope);edit(expected);await assert.rejects(codec.validateAuthorCorrection(envelope,expected,{now:clock}));}
 const tampered=structuredClone(envelope);tampered.body.edits[0].newNote='A changed fictional note after signing.';await assert.rejects(codec.validateAuthorCorrection(tampered,expectedFor(tampered),{now:clock}));
});
test('consent skew and expiry use strict UTC boundaries and a fresh trusted clock',async()=>{
 const f=fixture();assert.equal(typeof codec.validateAuthorCorrection,'function','signature/context validator missing');const signBody=e=>({...e,signature:sign(null,Buffer.from('UAIN/central-survey-correction/author/v1\n'+canonical(e.body)),f.keys.privateKey).toString('base64url')});
 for(const [issued,at,accept]of[['2026-11-09T00:05:30.000Z','2026-11-09T00:05:00.000Z',true],['2026-11-09T00:05:30.001Z','2026-11-09T00:05:00.000Z',false]]){const e=structuredClone(f.envelope);e.body.consent.issuedAt=issued;const signed=signBody(e),call=codec.validateAuthorCorrection(signed,expectedFor(signed),{now:()=>Date.parse(at)});if(accept)await call;else await assert.rejects(call);}
 await assert.rejects(codec.validateAuthorCorrection(f.envelope,expectedFor(f.envelope),{now:()=>Date.parse(f.envelope.body.consent.expiresAt)}));
});
function correctionChain(){
 const f=fixture(),artifact={schema:'uain-evidence-artifact-v1',taskId:'task-1',submissionId:'submission-1',author:f.member,survey:{mainKpi:'Fictional research goal',asOf:'2026-11-09',items:[{kind:'doi',id:'10.1234/fictional',title:'Fictional primary record',relation:'partial',note:'Original fictional note about the record.'}],conclusion:{meetsMainKpi:false,gaps:['No scientific achievement is claimed by this fixture.']}}};
 const raw=Buffer.from(JSON.stringify(artifact,null,2)),one=structuredClone(f.envelope);one.body.original.nativeEvidenceDigest=sha(raw);one.body.original.canonicalArtifactDigest=sha(canonical(artifact));one.body.edits[0].oldNoteSha256=sha(artifact.survey.items[0].note);const first=structuredClone(artifact);first.survey.items[0].note=one.body.edits[0].newNote;one.body.correctedArtifactDigest=sha(canonical(first));
 const resign=e=>({...e,signature:sign(null,Buffer.from('UAIN/central-survey-correction/author/v1\n'+canonical(e.body)),f.keys.privateKey).toString('base64url')});const previous=resign(one),two=structuredClone(one);two.body.correctionIndex=2;two.body.previousCorrectionDigest=sha('UAIN/central-survey-correction/author-envelope/v1\n'+canonical(previous));two.body.priorReview={executionId:'review-after-correction-1',verificationDigest:'c'.repeat(64),feedbackDecisionDigest:'c'.repeat(64),reviewRecordDigest:'d'.repeat(64)};two.body.consent={nonce:'e'.repeat(32),issuedAt:'2026-11-09T00:20:00.000Z',expiresAt:'2026-11-09T00:30:00.000Z'};two.body.edits[0].oldNoteSha256=sha(first.survey.items[0].note);two.body.edits[0].newNote='A second corrected fictional note answering the next finding.';const second=structuredClone(first);second.survey.items[0].note=two.body.edits[0].newNote;two.body.correctedArtifactDigest=sha(canonical(second));const current=resign(two),head={index:1,authorEnvelopeDigest:two.body.previousCorrectionDigest,correctedArtifactDigest:one.body.correctedArtifactDigest,reviewExecutionId:two.body.priorReview.executionId,reviewVerificationDigest:'c'.repeat(64),status:'finalized-needs-evidence'};return{...f,raw,artifact,previous,current,head,second,resign};
}
test('complete chained note corrections derive from original pretty bytes without rewriting any predecessor',async()=>{
 const f=correctionChain(),before=f.raw.toString();assert.equal(typeof codec.deriveCorrectedArtifact,'function','complete-chain derivation missing');
 const result=await codec.deriveCorrectedArtifact(f.raw,f.current,{previousEnvelopes:[f.previous]});assert.deepEqual(result.artifact,f.second);assert.equal(result.correctedArtifactDigest,sha(canonical(f.second)));assert.equal(f.raw.toString(),before);assert.equal(f.previous.body.edits[0].newNote,'A corrected fictional note with no achievement claim.');
 await codec.validateAuthorCorrection(f.current,expectedFor(f.current,{chainHead:f.head}),{now:()=>Date.parse('2026-11-09T00:25:00.000Z')});
});
test('missing or gapped predecessor and an unknown head cannot advance a correction',async()=>{
 const f=correctionChain();assert.equal(typeof codec.deriveCorrectedArtifact,'function','complete-chain derivation missing');await assert.rejects(codec.deriveCorrectedArtifact(f.raw,f.current));
 const gap=structuredClone(f.current);gap.body.correctionIndex=3;await assert.rejects(codec.deriveCorrectedArtifact(f.raw,f.resign(gap),{previousEnvelopes:[f.previous]}));
 const expected=expectedFor(f.current,{chainHead:{...f.head,status:'provider-unknown'}});await assert.rejects(codec.validateAuthorCorrection(f.current,expected,{now:()=>Date.parse('2026-11-09T00:25:00.000Z')}));
});
test('each old-note hash binds the previous effective note, not the native original or an unsigned replacement',async()=>{
 const f=correctionChain();assert.equal(typeof codec.deriveCorrectedArtifact,'function','complete-chain derivation missing');const wrong=structuredClone(f.current);wrong.body.edits[0].oldNoteSha256=sha(f.artifact.survey.items[0].note);await assert.rejects(codec.deriveCorrectedArtifact(f.raw,f.resign(wrong),{previousEnvelopes:[f.previous]}));
});
test('duplicate keys in original noncanonical native JSON refuse even when raw digest and signature match',async()=>{
 const f=correctionChain();assert.equal(typeof codec.deriveCorrectedArtifact,'function','complete-chain derivation missing');const duplicate=f.raw.toString().replace('"schema":','"schema":"shadowed","schema":'),e=structuredClone(f.previous);e.body.original.nativeEvidenceDigest=sha(duplicate);await assert.rejects(codec.deriveCorrectedArtifact(Buffer.from(duplicate),f.resign(e)));
});
test('replacement note follows the actual fixed survey driver UTF8/trim/control contract',()=>{
 const{envelope}=fixture();const unicode=structuredClone(envelope);unicode.body.edits[0].newNote='😀😀😀';assert.doesNotThrow(()=>codec.parseAuthorEnvelope(canonical(unicode)),'12 UTF8 bytes pass even with six UTF16 units');
 for(const note of ['  A padded fictional note.','A carriage\rreturn is not allowed.','😀😀']){const e=structuredClone(envelope);e.body.edits[0].newNote=note;assert.throws(()=>codec.parseAuthorEnvelope(canonical(e)));}
 const github=structuredClone(envelope);github.body.edits[0].kind='github';github.body.edits[0].id='fictional/record.git';assert.throws(()=>codec.parseAuthorEnvelope(canonical(github)));
});
test('verified return is an independent snapshot and expired-after-crypto consent refuses',async()=>{
 const f=fixture(),original=structuredClone(f.envelope),expected=expectedFor(f.envelope);let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r),verify=crypto.subtle.verify;
 crypto.subtle.verify=async function(...args){entered();await gate;return verify.apply(this,args);};
 try{const pending=codec.validateAuthorCorrection(f.envelope,expected,{now:clock});await ready;f.envelope.body.edits[0].newNote='Caller mutation during asynchronous verification.';expected.author.instance='changed-after-check';release();assert.deepEqual(await pending,original);}finally{crypto.subtle.verify=verify;}
 const e=fixture().envelope;let reads=0;await assert.rejects(codec.validateAuthorCorrection(e,expectedFor(e),{now:()=>++reads===1?Date.parse('2026-11-09T00:05:00.000Z'):Date.parse('2026-11-09T00:10:00.000Z')}));assert.equal(reads,2);
});
test('structured internal objects cannot invoke a getter or custom serialization hook',async()=>{
 const{envelope}=fixture(),expected=expectedFor(envelope);let touched=0;Object.defineProperty(envelope.body.edits[0],'newNote',{enumerable:true,get(){touched++;return 'A getter cannot supply signed text.';}});await assert.rejects(codec.validateAuthorCorrection(envelope,expected,{now:clock}));assert.equal(touched,0);
});
test('non-null original native instance is preserved under the same member key',async()=>{
 const f=fixture();f.envelope.body.author.instance='owned-instance';f.envelope.signature=sign(null,Buffer.from('UAIN/central-survey-correction/author/v1\n'+canonical(f.envelope.body)),f.keys.privateKey).toString('base64url');const result=await codec.validateAuthorCorrection(f.envelope,expectedFor(f.envelope),{now:clock});assert.equal(result.body.author.instance,'owned-instance');assert.equal(result.publicKey,f.envelope.publicKey);
});
test('prior native review commitment hashes all eight proved fields under its own domain',async()=>{
 const record={submission:'submission-1',execution_id:'review-1',criteria_digest:hash,evidence_digest:hash,verification_digest:'b'.repeat(64),reviewer:'uain1'+'c'.repeat(40),height:'123',verdict:'needs_evidence'};assert.equal(typeof codec.priorReviewRecordDigest,'function','native record commitment missing');assert.equal(await codec.priorReviewRecordDigest(record),sha('UAIN/central-survey-correction/prior-native-record/v1\n'+canonical(record)));await assert.rejects(codec.priorReviewRecordDigest({...record,privatePrompt:'not public'}));await assert.rejects(codec.priorReviewRecordDigest({...record,height:'9223372036854775808'}));
});
test('current head digest is a typed scalar rather than a coercible array',async()=>{
 const f=correctionChain(),expected=expectedFor(f.current,{chainHead:{...f.head,correctedArtifactDigest:[f.head.correctedArtifactDigest]}});await assert.rejects(codec.validateAuthorCorrection(f.current,expected,{now:()=>Date.parse('2026-11-09T00:25:00.000Z')}));
});
test('malformed wire has a fixed refusal rather than a raw JSON diagnostic',()=>{
 assert.throws(()=>codec.parseAuthorEnvelope('never-returned-sensitive-body'),error=>error.message==='survey_correction_refused');
 const{envelope}=fixture();envelope.body.edits[0].kind=['doi'];assert.throws(()=>codec.parseAuthorEnvelope(canonical(envelope)));
});
test('bounded full 32-round chain replays every predecessor and refuses a 33rd or reused review',async()=>{
 const f=correctionChain(),chain=[f.previous],view=structuredClone(f.artifact);view.survey.items[0].note=f.previous.body.edits[0].newNote;
 for(let index=2;index<=32;index++){
  const prior=chain.at(-1),e=structuredClone(prior);e.body.correctionIndex=index;e.body.previousCorrectionDigest=sha('UAIN/central-survey-correction/author-envelope/v1\n'+canonical(prior));e.body.consent.nonce=index.toString(16).padStart(32,'0');e.body.priorReview={executionId:`review-${index}`,verificationDigest:sha(`review-${index}`),feedbackDecisionDigest:sha(`review-${index}`),reviewRecordDigest:sha(`record-${index}`)};e.body.edits[0].oldNoteSha256=sha(view.survey.items[0].note);e.body.edits[0].newNote=`Corrected fictional note for review round ${index}.`;view.survey.items[0].note=e.body.edits[0].newNote;e.body.correctedArtifactDigest=sha(canonical(view));chain.push(f.resign(e));
 }
 const result=await codec.deriveCorrectedArtifact(f.raw,chain.at(-1),{previousEnvelopes:chain.slice(0,-1)});assert.deepEqual(result.artifact,view);assert.equal(result.chainDigest,sha('UAIN/central-survey-correction/author-chain/v1\n'+canonical(chain)));
 const tooMany=structuredClone(chain.at(-1));tooMany.body.correctionIndex=33;assert.throws(()=>codec.parseAuthorEnvelope(canonical(tooMany)));
 const reused=structuredClone(chain.at(-1));reused.body.priorReview=structuredClone(chain[0].body.priorReview);await assert.rejects(codec.deriveCorrectedArtifact(f.raw,f.resign(reused),{previousEnvelopes:chain.slice(0,-1)}));
});
test('Node-signed chain and malformed raw vectors verify independently in Python',async()=>{
 const {spawnSync}=await import('node:child_process'),{fileURLToPath}=await import('node:url');
 const f=correctionChain(),packet={raw:f.raw.toString(),current:f.current,previous:f.previous,expected:expectedFor(f.current,{chainHead:f.head}),wire:canonical(f.current),invalid:[canonical(f.current)+'\n',canonical(f.current).replace('"correctionIndex":2','"correctionIndex":2e0'),canonical(f.current).replace('"schema":','"\\u0073chema":"duplicate","schema":')]};
 const script=`import sys,json\nif len(sys.argv)>2:sys.path.append(sys.argv[2])\nsys.path.insert(0,sys.argv[1])\nimport survey_correction as m\np=json.load(sys.stdin)\ne=m.parse_author_envelope(p['wire'].encode())\nm.validate_author_correction(e,p['expected'],now=lambda:1794183900000)\nr=m.derive_corrected_artifact(p['raw'].encode(),e,previous_envelopes=[p['previous']])\nfor raw in p['invalid']:\n try:m.parse_author_envelope(raw.encode())\n except m.Refused:pass\n else:raise AssertionError('malformed input accepted')\nprint(json.dumps(r,ensure_ascii=False))`;
 const python=process.platform==='darwin'?'/usr/bin/python3':'python3',fixtureDeps=process.platform==='darwin'?[(await import('node:os')).homedir()+'/Library/Python/3.9/lib/python/site-packages']:[],run=spawnSync(python,['-I','-B','-c',script,fileURLToPath(new URL('../../../ops/custody/',import.meta.url)),...fixtureDeps],{input:JSON.stringify(packet),encoding:'utf8',timeout:15000,maxBuffer:1048576,env:{PATH:process.env.PATH,HOME:'/nonexistent',LANG:'C.UTF-8'}});assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),await codec.deriveCorrectedArtifact(f.raw,f.current,{previousEnvelopes:[f.previous]}));
});
