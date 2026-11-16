/** One additional explicitly authorized format-only attempt; never resets a
 * terminal task, provider claim, identity, submission ID or native once journal. */
import {constants} from 'node:fs';import {open,mkdir,lstat,realpath,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';import {join,dirname,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import {PINS,SURVEY_TASK,freshNativeProof,validId,openFunded} from './house-agent.mjs';
import {DEFAULT_CLAIMS,validateReturnedClaim} from './house-remote-solver.mjs';
export const RECOVERY_SOURCE_PATHS=Object.freeze(['ops/agents/house-remote-solver-host.mjs','ops/agents/house-remote-solver-runtime.mjs','ops/agents/house-remote-solver.mjs','ops/agents/claude-house-solver.mjs','ops/agents/house-fleet.mjs','ops/agents/house-agent.mjs','ops/agents/house-format-recovery.mjs','services/project-organizations/src/compute-budget.mjs','services/project-organizations/src/common.mjs']);
const sha=x=>createHash('sha256').update(x).digest('hex'),HASH=/^[a-f0-9]{64}$/,MEMBER=/^uain1[a-f0-9]{40}$/;
const need=v=>{if(!v)throw Error('Controlled format recovery refused');};
const KEYS='schema,agent,member,projectId,taskId,submissionId,originalRecordSha256,originalClaimSha256,originalPromptDigest,originalExecutionId,criteriaDigest,reviewedSourceCommit,runtimeDigest,configurationDigest,model,usageSource,correctedPromptDigest,chainId,genesisSha256,verifierSha256,authorizedAt,expiresAt,maxAdditionalAttempts'.split(',').sort().join(',');
export const recoveryTaskKey=id=>sha('task\0'+id).slice(0,32);
export function validateAuthorization(a,now=Date.now()){
 need(a&&typeof a==='object'&&!Array.isArray(a)&&Object.keys(a).sort().join(',')===KEYS&&a.schema==='uain-house-format-recovery-authorization-v1');
 need(/^[a-z0-9][a-z0-9-]{0,23}$/.test(a.agent??'')&&MEMBER.test(a.member??'')&&SURVEY_TASK.test(a.taskId??''));for(const k of ['projectId','taskId','submissionId','originalExecutionId'])validId(a[k]);
 for(const k of ['originalRecordSha256','originalClaimSha256','originalPromptDigest','criteriaDigest','runtimeDigest','configurationDigest','correctedPromptDigest'])need(HASH.test(a[k]??''));
 need(/^[a-f0-9]{40}$/.test(a.reviewedSourceCommit??'')&&a.model==='claude-sonnet-5-5'&&a.usageSource==='subscription'&&a.maxAdditionalAttempts===1&&a.chainId===PINS.chainId&&a.genesisSha256===PINS.genesisSha256&&a.verifierSha256===PINS.verifierSha256&&a.correctedPromptDigest!==a.originalPromptDigest);
 const start=Date.parse(a.authorizedAt),end=Date.parse(a.expiresAt);need(Number.isFinite(now)&&Number.isFinite(start)&&Number.isFinite(end)&&start<=now&&end>now&&end-start<=45*60*1000);return a;
}
export async function privateRecoveryRead(path,limit=1048576){
 need(resolve(path)===path&&await realpath(path)===path);const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=await fd.stat();need(s.isFile()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&0o777)===0o600&&s.size<=limit);const bytes=Buffer.alloc(limit+1);let count=0;while(count<bytes.length){const r=await fd.read(bytes,count,bytes.length-count,null);if(!r.bytesRead)break;count+=r.bytesRead;}need(count<=limit);return bytes.subarray(0,count);}finally{await fd.close();}
}
export function validateRetainedFailure(a,{recordBytes,promptBytes,claimBytes},now=Date.now()){
 validateAuthorization(a,now);need(sha(recordBytes)===a.originalRecordSha256&&sha(promptBytes)===a.originalPromptDigest&&sha(claimBytes)===a.originalClaimSha256);
 need(Buffer.from(recordBytes.toString('utf8'),'utf8').equals(recordBytes)&&Buffer.from(claimBytes.toString('utf8'),'utf8').equals(claimBytes)&&Buffer.from(promptBytes.toString('utf8'),'utf8').equals(promptBytes));
 const record=JSON.parse(recordBytes.toString('utf8')),claim=JSON.parse(claimBytes.toString('utf8')),t=record.task,prompt=promptBytes.toString('utf8');
 need(record.agent===a.agent&&record.member===a.member&&record.submissionId===a.submissionId&&a.submissionId===`HS-${a.agent}-${recoveryTaskKey(a.taskId).slice(0,20)}`&&['no-finding','solver-output-invalid'].includes(record.status)&&record.reason?.startsWith('solver output rejected:'));
 need(Object.keys(record).every(k=>['agent','member','task','firstSeen','submissionId','status','updatedAt','reason'].includes(k))&&t?.id===a.taskId&&t.project===a.projectId&&t.acceptance_digest===a.criteriaDigest&&sha(t.criteria)===a.criteriaDigest);
 const artifactBinding={author:a.member,taskId:a.taskId,submissionId:a.submissionId};need(JSON.stringify(t.artifactBinding)===JSON.stringify(artifactBinding)&&prompt.includes(`Task ${a.taskId} in project ${a.projectId}`)&&prompt.includes(`<<<CRITERIA\n${t.criteria}\nCRITERIA>>>`)&&prompt.includes('Artifact binding: '+JSON.stringify(artifactBinding)));
 need(a.originalExecutionId==='HSR-'+sha('solver\0house-fleet\0'+prompt).slice(0,48)&&claim.usageSource===a.usageSource);
 const value=validateReturnedClaim(claim,{executionId:a.originalExecutionId,role:'solver',projectId:'house-fleet',promptDigest:a.originalPromptDigest});need(value.verdict==='FINDING');
 let invalid=false;try{JSON.parse(value.evidence);}catch{invalid=true;}need(invalid);
 return{record,oldEvidenceDigest:sha(value.evidence),nativeRawDigest:claim.response.nativeRawDigest};
}
export async function loadRecoveryEvidence(config,a,{claimDirectory=DEFAULT_CLAIMS,now=Date.now()}={}){
 validateAuthorization(a,now);need(config.configurationDigest===a.configurationDigest);
 const agent=config.agents.find(v=>v.name===a.agent);need(agent);
 const recordPath=join(config.stateDir,'agents',a.agent,'tasks',recoveryTaskKey(a.taskId)+'.json'),promptPath=join(config.stateDir,'prompts',a.agent,recoveryTaskKey(a.taskId)+'-solver.txt'),claimPath=join(claimDirectory,sha(a.originalExecutionId)+'.json');
 const bytes={recordBytes:await privateRecoveryRead(recordPath),promptBytes:await privateRecoveryRead(promptPath,131072),claimBytes:await privateRecoveryRead(claimPath)};
 return{...validateRetainedFailure(a,bytes,now),recordPath,promptPath,claimPath};
}
export function validateFreshRecovery(a,r,runtime,now=Date.now()){
 validateAuthorization(a,now);need(HASH.test(runtime.manifest['ops/agents/house-agent.mjs']??''));need(r?.schema==='uain-house-recovery-check-v1'&&r.member===a.member&&r.submissionId===a.submissionId&&r.submissionAbsent===true&&r.intentIndexComplete===true&&r.journal?.complete===true&&r.journal.relatedEntries===0&&r.task?.id===a.taskId&&r.task.project===a.projectId&&openFunded(r.task)&&r.project?.id===a.projectId&&r.project.state==='active'&&r.project.safety_halted===false&&typeof r.joined==='boolean'&&Number.isInteger(r.intentCount)&&r.intentCount>=0&&r.intentCount<=256&&r.task.acceptance_digest===a.criteriaDigest&&sha(r.task.criteria)===a.criteriaDigest&&r.adapterSourceSha256===runtime.manifest['ops/agents/house-agent.mjs']);
 for(const p of [r.proof,r.absenceProof])freshNativeProof(p,now);need(runtime.digest===a.runtimeDigest);return r;
}
async function syncDir(path){const fd=await open(path,'r');try{await fd.sync();}finally{await fd.close();}}
async function privateDir(path){await mkdir(path,{recursive:true,mode:0o700});const s=await lstat(path);need(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&!(s.mode&0o077)&&await realpath(path)===path);}
export async function createRecoveryAdmission(config,a,evidence,now=Date.now()){
 validateAuthorization(a,now);const directory=join(config.stateDir,'format-recovery-admissions');await privateDir(directory);await syncDir(config.stateDir);
 const attemptId=sha('format-recovery\0'+a.agent+'\0'+a.taskId+'\0'+a.originalRecordSha256).slice(0,32),admissionPath=join(directory,a.agent+'-'+recoveryTaskKey(a.taskId)+'.json');
 const fd=await open(admissionPath,'wx',0o600);try{await fd.writeFile(JSON.stringify({schema:'uain-house-format-recovery-admission-v1',attemptId,at:new Date(now).toISOString(),authorization:a,evidence})+'\n');await fd.sync();}finally{await fd.close();}await syncDir(directory);
 const attempts=join(config.stateDir,'format-recoveries');await privateDir(attempts);await syncDir(config.stateDir);const root=join(attempts,attemptId);await mkdir(root,{mode:0o700});await syncDir(attempts);return{attemptId,admissionPath,root};
}
async function publicSourceRead(path,limit){
 need(await realpath(path)===path);const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=await fd.stat();need(s.isFile()&&s.nlink===1&&!(s.mode&0o022)&&[0,process.getuid()].includes(s.uid)&&s.size<=limit);const bytes=Buffer.alloc(limit+1);let count=0;while(count<bytes.length){const r=await fd.read(bytes,count,bytes.length-count,null);if(!r.bytesRead)break;count+=r.bytesRead;}need(count<=limit);return bytes.subarray(0,count);}finally{await fd.close();}
}
export async function verifyRecoveryRuntime(config,{sourceRoot=dirname(dirname(dirname(fileURLToPath(import.meta.url))))}={}){
 const root=sourceRoot,digest=root.split('/').at(-1);need(resolve(root)===root&&HASH.test(digest??''));
 const manifestPath=join(root,'source-manifest.json'),raw=await publicSourceRead(manifestPath,16384);need(sha(raw)===digest);const manifest=JSON.parse(raw);
 need(Object.keys(manifest).sort().join(',')===[...RECOVERY_SOURCE_PATHS].sort().join(','));
 for(const p of RECOVERY_SOURCE_PATHS){const path=join(root,p);for(let dir=dirname(path);;dir=dirname(dir)){const s=await lstat(dir);need(s.isDirectory()&&!s.isSymbolicLink()&&[0,process.getuid()].includes(s.uid)&&!(s.mode&0o022)&&await realpath(dir)===dir);if(dir===root)break;need(dir.startsWith(root+'/'));}need(sha(await publicSourceRead(path,1048576))===manifest[p]);}
 for(const [role,command]of [['solver',config.solver.command],['refuter',config.solver.refuteCommand]])need(JSON.stringify(command)===JSON.stringify([process.execPath,join(root,'ops/agents/house-remote-solver.mjs'),'--role',role,'--project','house-fleet','--usage-source','subscription']));
 return{digest,manifest,root};
}

/** Immutable phase files: a crash or collision can only consume/hold the attempt. */
export async function writeRecoverySnapshot(root,sequence,record){
 const dir=join(root,'snapshots');await privateDir(dir);await syncDir(root);
 need(Number.isInteger(sequence)&&sequence>0&&/^[a-z-]+$/.test(record.status));
 const path=join(dir,String(sequence).padStart(4,'0')+'-'+record.status+'.json'),fd=await open(path,'wx',0o600);
 try{await fd.writeFile(JSON.stringify(record,null,2)+'\n');await fd.sync();}finally{await fd.close();}await syncDir(dir);
}
export async function requireUnusedCorrectedClaim(evidence,promptDigest,prompt){
 need(sha(prompt)===promptDigest);const executionId='HSR-'+sha('solver\0house-fleet\0'+prompt).slice(0,48),path=join(dirname(evidence.claimPath),sha(executionId)+'.json');
 for(const p of [path,path+'.lock']){let present=true;try{await lstat(p);}catch(e){if(e.code==='ENOENT')present=false;else throw e;}need(!present);}
 return executionId;
}
