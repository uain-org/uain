import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm,readdir,symlink,chmod} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {PINS} from './house-agent.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex'),member='uain1'+'a'.repeat(40),now=Date.parse('2026-11-08T19:00:00Z');
function fixture(){
 const id='T-OPP-00014-1-prior-art-survey',project='P-OPP-00014',criteria='Exact Main KPI criteria';
 const submissionId='HS-alpha-'+sha('task\0'+id).slice(0,20),artifactBinding={author:member,taskId:id,submissionId};
 const prompt=`Task ${id} in project ${project}\n<<<CRITERIA\n${criteria}\nCRITERIA>>>\nArtifact binding: ${JSON.stringify(artifactBinding)}`;
 const executionId='HSR-'+sha('solver\0house-fleet\0'+prompt).slice(0,48),binding={executionId,role:'solver',projectId:'house-fleet',promptDigest:sha(prompt)};
 const record={agent:'alpha',member,task:{id,project,criteria,acceptance_digest:sha(criteria),artifactBinding},submissionId,status:'no-finding',reason:'solver output rejected: Unexpected trailing JSON text'};
 const value={verdict:'FINDING',evidence:'{"schema":"uain-evidence-artifact-v1"}\nprose suffix',selfCheck:'Fixture checks'};
 const claim={schema:'uain-house-remote-claim-v1',binding,status:'returned',usageSource:'subscription',value,response:{schema:'uain-house-remote-result-v1',...binding,value,costUsd:1,nativeRawDigest:'a'.repeat(64),usageSource:'subscription',costBasis:'api-equivalent-estimate',authentication:{loggedIn:true,authMethod:'oauth_token',apiProvider:'firstParty'}}};
 const bytes={recordBytes:Buffer.from(JSON.stringify(record)),claimBytes:Buffer.from(JSON.stringify(claim)),promptBytes:Buffer.from(prompt)};
 const auth={schema:'uain-house-format-recovery-authorization-v1',agent:'alpha',member,projectId:project,taskId:id,submissionId,originalRecordSha256:sha(bytes.recordBytes),originalClaimSha256:sha(bytes.claimBytes),originalPromptDigest:sha(prompt),originalExecutionId:executionId,criteriaDigest:sha(criteria),reviewedSourceCommit:'b'.repeat(40),runtimeDigest:'c'.repeat(64),configurationDigest:'d'.repeat(64),model:'claude-sonnet-5-5',usageSource:'subscription',correctedPromptDigest:'e'.repeat(64),chainId:PINS.chainId,genesisSha256:PINS.genesisSha256,verifierSha256:PINS.verifierSha256,authorizedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+600000).toISOString(),maxAdditionalAttempts:1};
 return{auth,record,claim,bytes};
}
test('recovery authorization and returned invalid artifact are exact, bounded and read-only',async()=>{
 const api=await import('./house-format-recovery.mjs'),f=fixture(),before=Object.fromEntries(Object.entries(f.bytes).map(([k,v])=>[k,sha(v)]));
 assert.deepEqual(api.validateAuthorization(f.auth,now),f.auth);const full={...f.auth,expiresAt:new Date(Date.parse(f.auth.authorizedAt)+45*60000).toISOString()};assert.deepEqual(api.validateAuthorization(full,now),full);assert.throws(()=>api.validateAuthorization({...full,expiresAt:new Date(Date.parse(full.expiresAt)+1).toISOString()},now));assert.equal(api.validateRetainedFailure(f.auth,f.bytes,now).record.submissionId,f.auth.submissionId);
 assert.deepEqual(Object.fromEntries(Object.entries(f.bytes).map(([k,v])=>[k,sha(v)])),before);
 for(const patch of [{extra:true},{maxAdditionalAttempts:2},{model:'other'},{usageSource:'api'},{chainId:'other'},{expiresAt:new Date(now-1).toISOString()},{correctedPromptDigest:f.auth.originalPromptDigest}])assert.throws(()=>api.validateAuthorization({...f.auth,...patch},now));
});
test('recovery never admits unknown claims, changed old bytes, no finding or valid old artifacts',async()=>{
 const api=await import('./house-format-recovery.mjs');
 for(const change of [f=>f.bytes.recordBytes=Buffer.from('changed'),f=>{f.claim.status='executing-subscription';},f=>{f.claim.value.verdict='NO_FINDING';f.claim.value.evidence='';},f=>{f.claim.value.evidence='{"valid":"json"}';},f=>{f.record.status='uncertain';},f=>{f.record.joined=true;}]){
  const f=fixture();change(f);
  if(f.bytes.recordBytes.toString()!=='changed'){f.bytes.recordBytes=Buffer.from(JSON.stringify(f.record));f.auth.originalRecordSha256=sha(f.bytes.recordBytes);}
  f.bytes.claimBytes=Buffer.from(JSON.stringify(f.claim));f.auth.originalClaimSha256=sha(f.bytes.claimBytes);
  assert.throws(()=>api.validateRetainedFailure(f.auth,f.bytes,now));
 }
});
test('one durable exclusive recovery admission consumes the slot without rewriting original files',async t=>{
 const api=await import('./house-format-recovery.mjs'),f=fixture(),root=await realpath(await mkdtemp(join(tmpdir(),'format-recovery-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const config={stateDir:root,configurationDigest:f.auth.configurationDigest};const result=await api.createRecoveryAdmission(config,f.auth,{nativeHeight:'100'},now);assert.match(result.attemptId,/^[a-f0-9]{32}$/);assert.equal(JSON.parse(await readFile(result.admissionPath,'utf8')).authorization.originalRecordSha256,f.auth.originalRecordSha256);
 await assert.rejects(api.createRecoveryAdmission(config,f.auth,{nativeHeight:'101'},now));
 const changed={...f.auth,originalRecordSha256:'f'.repeat(64)};await assert.rejects(api.createRecoveryAdmission(config,changed,{nativeHeight:'101'},now));
 assert.equal((await readdir(join(root,'format-recovery-admissions'))).length,1);
});

test('immutable runtime closure includes recovery and binds every executable source before recovery',async t=>{
 const api=await import('./house-format-recovery.mjs'),host=await import('./house-remote-solver-host.mjs');assert.deepEqual(host.CLOSURE,api.RECOVERY_SOURCE_PATHS);
 const {rename}=await import('node:fs/promises'),base=await realpath(await mkdtemp(join(tmpdir(),'recovery-source-')));t.after(()=>rm(base,{recursive:true,force:true}));const temp=join(base,'preparing');await mkdir(temp,{mode:0o700});const manifest={};
 for(const path of api.RECOVERY_SOURCE_PATHS){const bytes=await readFile(new URL('../../'+path,import.meta.url));manifest[path]=sha(bytes);await mkdir(join(temp,path,'..'),{recursive:true,mode:0o700});await writeFile(join(temp,path),bytes,{mode:0o644});}
 const raw=JSON.stringify(manifest),digest=sha(raw),root=join(base,digest);await writeFile(join(temp,'source-manifest.json'),raw,{mode:0o644});await rename(temp,root);
 const command=role=>[process.execPath,join(root,'ops/agents/house-remote-solver.mjs'),'--role',role,'--project','house-fleet','--usage-source','subscription'];const config={solver:{command:command('solver'),refuteCommand:command('refuter')}};
 assert.equal((await api.verifyRecoveryRuntime(config,{sourceRoot:root})).digest,digest);
 await writeFile(join(root,'ops/agents/house-format-recovery.mjs'),'changed');await assert.rejects(api.verifyRecoveryRuntime(config,{sourceRoot:root}));
});

test('private retained evidence refuses linked/public inputs and immutable snapshots never replace bytes',async t=>{
 const api=await import('./house-format-recovery.mjs'),root=await realpath(await mkdtemp(join(tmpdir(),'recovery-private-')));t.after(()=>rm(root,{recursive:true,force:true}));const file=join(root,'authorization.json');await writeFile(file,'{}',{mode:0o600});assert.equal((await api.privateRecoveryRead(file)).toString(),'{}');await chmod(file,0o644);await assert.rejects(api.privateRecoveryRead(file));await chmod(file,0o600);await symlink(file,join(root,'alias'));await assert.rejects(api.privateRecoveryRead(join(root,'alias')));
 await api.writeRecoverySnapshot(root,1,{status:'solving'});await assert.rejects(api.writeRecoverySnapshot(root,1,{status:'solving',changed:true}));assert.deepEqual(JSON.parse(await readFile(join(root,'snapshots/0001-solving.json'))),{status:'solving'});
});
