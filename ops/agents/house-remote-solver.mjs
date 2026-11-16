#!/usr/bin/env node
/** Local authoritative API admission; subscription requests are independently
 * qualified by the pinned remote runtime. SSH transports only bound requests.
 * Unknown outcomes are terminal. No credential transfer or signing capability. */
import {constants} from 'node:fs';import {spawn} from 'node:child_process';import {createHash} from 'node:crypto';
import {mkdir,open,readFile,rename,realpath,stat,unlink} from 'node:fs/promises';
import {join,resolve,isAbsolute} from 'node:path';import {pathToFileURL} from 'node:url';
import {openComputeBudget} from '../../services/project-organizations/src/compute-budget.mjs';
import {parseSolverOutput,parseRefutation} from './house-fleet.mjs';
import {subscriptionAuthentication} from './claude-house-solver.mjs';
import {homedir as homeDirectory} from 'node:os';import {join as joinPath} from 'node:path';
const homeJoin=relative=>joinPath(homeDirectory(),relative); // the operator's own home folder, as before
export const AUTHORITATIVE_BUDGET=homeJoin('.local/share/uain/project-management/state');
export const DEFAULT_CLAIMS=homeJoin('.local/share/uain/house-fleet/remote-claims');
export const SSH_ARGS=Object.freeze(['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ForwardAgent=no','-o','ClearAllForwardings=yes','-o','ControlMaster=no','-o','ControlPath=none','uain-app-1','/usr/local/sbin/uain-house-remote-solver']);
const need=(v,m)=>{if(!v)throw Error(m);};const sha=s=>createHash('sha256').update(s).digest('hex');
const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
export function validateRequest(r){need(r&&['executionId,projectId,prompt,promptDigest,role,schema','executionId,projectId,prompt,promptDigest,role,schema,usageSource'].includes(Object.keys(r).sort().join(','))&&r.schema==='uain-house-remote-request-v1'&&ID.test(r.executionId??'')&&ID.test(r.projectId??'')&&['solver','refuter'].includes(r.role)&&typeof r.prompt==='string'&&r.prompt.isWellFormed()&&r.prompt.trim()&&Buffer.byteLength(r.prompt)<=131072&&r.promptDigest===sha(r.prompt)&&(!Object.hasOwn(r,'usageSource')||['api','subscription'].includes(r.usageSource)),'remote request binding refused');return r;}
function verifiedResponse(response,binding,usageSource){
 need(response?.schema==='uain-house-remote-result-v1'&&Object.entries(binding).every(([k,v])=>response[k]===v)&&Number.isFinite(response.costUsd)&&response.costUsd>=0&&/^[a-f0-9]{64}$/.test(response.nativeRawDigest??''),'remote result binding refused');
 if(usageSource==='subscription'){
  need(response.usageSource==='subscription'&&response.costBasis==='api-equivalent-estimate','subscription result source refused');
  subscriptionAuthentication(response.authentication);
 }else need((response.usageSource??'api')==='api'&&response.costUsd<=0.50,'API result source/cost refused');
}
/** Pure read-only qualification of a known returned execution. This never
 * reserves budget, changes a claim, authenticates anew or calls transport. */
export function validateReturnedClaim(old,binding){
 need(old?.schema==='uain-house-remote-claim-v1'&&old.status==='returned'&&old.value&&old.response?.schema==='uain-house-remote-result-v1'&&JSON.stringify(old.binding)===JSON.stringify(binding),'remote execution uncertain; retain original reservation');
 verifiedResponse(old.response,binding,old.usageSource??'api');
 const value=(binding.role==='solver'?parseSolverOutput:parseRefutation)(JSON.stringify(old.value));
 need(JSON.stringify(value)===JSON.stringify(old.response.value),'retained response binding changed');return value;
}
export async function privateDirectory(path){need(isAbsolute(path??'')&&resolve(path)===path,'unsafe state path');await mkdir(path,{recursive:true,mode:0o700});const s=await stat(path);need(await realpath(path)===path&&s.isDirectory()&&s.uid===process.getuid()&&!(s.mode&0o077),'unsafe state directory');}
export function boundedProcess(command,args,input,{timeoutMs=1260000,maxBytes=1048576}={}){return new Promise((res,rej)=>{const child=spawn(command,args,{shell:false,detached:true,stdio:['pipe','pipe','pipe']});let n=0,e=0,failed=false;const chunks=[];const fail=()=>{failed=true;try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}};const timer=setTimeout(fail,timeoutMs);child.stdout.on('data',b=>{n+=b.length;if(n>maxBytes)fail();else chunks.push(b);});child.stderr.on('data',b=>{e+=b.length;if(e>maxBytes)fail();});child.stdin.on('error',()=>{});child.on('error',()=>{clearTimeout(timer);rej(Error('remote transport failed'));});child.on('close',code=>{clearTimeout(timer);if(failed||code!==0)return rej(Error('remote transport uncertain'));try{res(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{rej(Error('remote response invalid'));}});child.stdin.end(input);});}
const sshTransport=req=>boundedProcess('/usr/bin/ssh',SSH_ARGS,JSON.stringify(req));
async function retained(path){const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=await fd.stat();need(s.isFile()&&s.nlink===1&&s.uid===process.getuid()&&!(s.mode&0o077)&&s.size<=1048576,'unsafe retained claim');return JSON.parse(await fd.readFile('utf8'));}finally{await fd.close();}}
async function syncDirectory(path){const f=await open(path,'r');try{await f.sync();}finally{await f.close();}}
async function save(path,value){const temp=path+'.tmp';const f=await open(temp,'wx',0o600);try{await f.writeFile(JSON.stringify(value));await f.sync();}finally{await f.close();}await rename(temp,path);await syncDirectory(resolve(path,'..'));}
export async function runRemoteSolver({executionId,role,projectId,prompt,claimDirectory=DEFAULT_CLAIMS,budgetDirectory=AUTHORITATIVE_BUDGET,usageSource='api'},{transport=sshTransport,now=()=>Date.now()}={}){
 need(['api','subscription'].includes(usageSource),'invalid usage source');
 executionId??='HSR-'+sha(role+'\0'+projectId+'\0'+prompt).slice(0,48);
 const request=validateRequest({schema:'uain-house-remote-request-v1',executionId,role,projectId,prompt,promptDigest:sha(prompt),...(usageSource==='subscription'?{usageSource}:{})});
 await privateDirectory(claimDirectory);if(usageSource==='api')await privateDirectory(budgetDirectory);
 const path=join(claimDirectory,sha(executionId)+'.json'),binding={executionId,role,projectId,promptDigest:request.promptDigest};
 const lockPath=path+'.lock';let lock;
 try{lock=await open(lockPath,'wx',0o600);}catch(e){
  if(e.code!=='EEXIST')throw e;
  // A crash lock is intentionally terminal: never steal it, including when its
  // PID is dead. Reserve/remote completion may already have happened.
  throw Error('execution locked; inspect original claim');
 }
 await lock.writeFile(JSON.stringify({pid:process.pid}));await lock.sync();
 try{
 let claim;
 try{const f=await open(path,'wx',0o600);claim={schema:'uain-house-remote-claim-v1',binding,status:'claimed',usageSource};try{await f.writeFile(JSON.stringify(claim));await f.sync();}finally{await f.close();}await syncDirectory(claimDirectory);}
 catch(e){if(e.code!=='EEXIST')throw e;const old=await retained(path);need(JSON.stringify(old.binding)===JSON.stringify(binding),'execution claim binding changed');need(old.schema==='uain-house-remote-claim-v1','invalid claim');
 if(old.status==='budget-denied'&&!old.reservationId){claim=old;}
 else return validateReturnedClaim(old,binding);}
 // Claims bind every run before transport. A source switch is permitted only
 // from the proven no-reservation denial above, never an unknown API outcome.
 let budget,reservation;
 if(usageSource==='api'){
  // Persist ambiguity BEFORE entering reserve: a crash cannot masquerade as denial.
  claim={...claim,status:'reserving',usageSource};await save(path,claim);
  budget=openComputeBudget({directory:budgetDirectory,now});
  reservation=budget.reserve({purpose:'remote-house-'+role,projectIds:[projectId],model:'claude-sonnet-5-5'});
  if(!reservation.id){claim={...claim,status:'budget-denied'};await save(path,claim);return {schema:'uain-house-compute-pause-v1',phase:'pre-execution',reason:'authoritative_compute_budget',role,executionId,promptDigest:request.promptDigest};}
  claim={...claim,status:'reserved',reservationId:reservation.id};await save(path,claim);
 }else{
  // The pinned dispatcher independently verifies subscription authentication
  // before inference and cannot fall back to API credentials for this request.
  claim={...claim,status:'executing-subscription',usageSource};await save(path,claim);
 }
 const response=await transport(request);
 verifiedResponse(response,binding,usageSource);
 const value=(role==='solver'?parseSolverOutput:parseRefutation)(JSON.stringify(response.value));
 // Durable reply precedes settlement; a crash can overcharge but cannot rerun.
 claim={...claim,status:'returned',value,response};await save(path,claim);
 if(budget)budget.settle(reservation.id,{costUsd:response.costUsd,stopReason:'authenticated-ssh-return'});
 return value;
 }finally{await lock.close();await unlink(lockPath);}
}
async function cli(args){const o={};for(let i=0;i<args.length;i+=2){need(['--execution-id','--role','--project','--usage-source'].includes(args[i])&&args[i+1]&&!o[args[i]],'invalid arguments');o[args[i]]=args[i+1];}let n=0;const chunks=[];for await(const b of process.stdin){n+=b.length;need(n<=131072,'prompt over limit');chunks.push(b);}return runRemoteSolver({executionId:o['--execution-id'],role:o['--role'],projectId:o['--project'],usageSource:o['--usage-source']??'api',prompt:new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))});}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){try{process.stdout.write(JSON.stringify(await cli(process.argv.slice(2)))+'\n');}catch{process.stderr.write('Remote house solver paused or uncertain; inspect owner-only claims and compute journal.\n');process.exitCode=1;}}
