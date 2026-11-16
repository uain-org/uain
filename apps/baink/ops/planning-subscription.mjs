/** Subscription-only intake execution. No credential reads/copies, billing changes
 * or signing capability. Unknown executions and old overlapping API reservations
 * are held; estimated CLI dollar totals never become subscription spend caps. */
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,mkdtemp,open,realpath,readdir,rm,unlink} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {tmpdir,userInfo} from 'node:os';
import {subscriptionAuthentication} from '../../../ops/agents/claude-house-solver.mjs';
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const need=(value,code)=>{if(!value)throw Error(code);};
const MAX=1024*1024,PROJECT=/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const ISOLATION=['--settings','{"disableAllHooks":true}','--setting-sources','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-chrome','--disable-slash-commands','--no-session-persistence'];
async function directory(path){
 need(isAbsolute(path??'')&&resolve(path)===path,'planning_subscription_directory');
 await mkdir(path,{recursive:true,mode:0o700});const h=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 try{const s=await h.stat();need(s.isDirectory()&&s.uid===process.getuid()&&!(s.mode&0o077)&&await realpath(path)===path,'planning_subscription_directory');}finally{await h.close();}
}
async function privateRead(path,max=4*MAX){
 const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const s=await h.stat();need(s.isFile()&&s.nlink===1&&s.uid===process.getuid()&&!(s.mode&0o077)&&s.size<=max,'planning_subscription_retained_file');const raw=await h.readFile();const a=await h.stat();need(raw.length===s.size&&a.ino===s.ino&&a.size===s.size&&a.mtimeMs===s.mtimeMs&&a.ctimeMs===s.ctimeMs,'planning_subscription_retained_changed');return raw;}finally{await h.close();}
}
async function writeOnce(path,value){
 const raw=Buffer.from(JSON.stringify(value)+'\n');need(raw.length<=4*MAX,'planning_subscription_retained_limit');const h=await open(path,'wx',0o600);
 try{await h.writeFile(raw);await h.sync();}finally{await h.close();}const d=await open(resolve(path,'..'),'r');try{await d.sync();}finally{await d.close();}
}
async function pin(executable,digest){
 need(isAbsolute(executable??'')&&resolve(executable)===executable&&/^[a-f0-9]{64}$/.test(digest??'')&&await realpath(executable)===executable,'planning_subscription_executable');
 const h=await open(executable,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=await h.stat();need(s.isFile()&&s.nlink===1&&[0,process.getuid()].includes(s.uid)&&!(s.mode&0o022)&&(s.mode&0o111)&&s.size<=512*MAX,'planning_subscription_executable');const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(MAX);for(;;){const{bytesRead}=await h.read(buffer,0,buffer.length,null);if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));}need(hash.digest('hex')===digest,'planning_subscription_executable');}finally{await h.close();}
}
export function planningSubscriptionEnvironment(env){
 need(env&&isAbsolute(env.HOME??'')&&resolve(env.HOME)===env.HOME,'planning_subscription_home');
 need(!Object.keys(env).some(k=>typeof env[k]==='string'&&env[k].length&&(k.startsWith('ANTHROPIC_')||/^CLAUDE_CODE_USE_(?:BEDROCK|VERTEX|FOUNDRY)$/.test(k))),'planning_subscription_provider_override');
 // macOS keychain account lookup requires USER, even with the correct HOME.
 // Bind it to the operating-system identity rather than a caller-selected value.
 return {HOME:env.HOME,USER:userInfo().username,PATH:'/usr/bin:/bin',LANG:'C.UTF-8',...(env.CLAUDE_CODE_OAUTH_TOKEN?{CLAUDE_CODE_OAUTH_TOKEN:env.CLAUDE_CODE_OAUTH_TOKEN}:{})};
}
function call(executable,args,prompt,{env,cwd,timeoutMs}){
 return new Promise((resolvePromise,reject)=>{
  const p=spawn(executable,args,{env,cwd,detached:true,shell:false,stdio:['pipe','pipe','pipe']});const chunks=[];let n=0,e=0,failed=false;
  const stop=()=>{failed=true;try{process.kill(-p.pid,'SIGKILL');}catch{p.kill('SIGKILL');}};
  const timer=setTimeout(stop,timeoutMs);p.stdin.on('error',()=>{});p.stdout.on('data',b=>{n+=b.length;if(n>MAX)stop();else chunks.push(b);});p.stderr.on('data',b=>{e+=b.length;if(e>MAX)stop();});p.on('error',()=>{clearTimeout(timer);reject(Error('planning_subscription_spawn_failed'));});p.on('close',code=>{clearTimeout(timer);if(failed||code!==0)return reject(Error('planning_subscription_execution_failed'));resolvePromise(Buffer.concat(chunks).toString('utf8'));});p.stdin.end(prompt);
 });
}
async function legacyUnknownProjects(root){
 const held=new Set();
 let raw;try{raw=await privateRead(join(root,'receipts.jsonl'),16*MAX);}catch(e){if(e.code==='ENOENT')return held;throw e;}
 for(const line of raw.toString('utf8').split('\n').filter(x=>x.trim())){
  let row;try{row=JSON.parse(line);}catch{throw Error('planning_legacy_receipts_invalid');}
  need(row&&['reserved','returned'].includes(row.status)&&Number.isFinite(row.costUsd)&&row.costUsd>=0,'planning_legacy_receipts_invalid');
  need(row.purpose==null||typeof row.purpose==='string'&&/^[a-z][a-z0-9_.-]{0,63}$/.test(row.purpose),'planning_legacy_receipts_invalid');
  if(row.status!=='reserved'||row.purpose&&row.purpose!=='project_manager_plan')continue;
  need(Array.isArray(row.projectIds)&&row.projectIds.length>0&&row.projectIds.every(x=>typeof x==='string'&&PROJECT.test(x)),'planning_subscription_uncertain_legacy');
  for(const id of row.projectIds)held.add(id);
 }
 return held;
}
async function refuseLegacyUnknown(root,ids){const held=await legacyUnknownProjects(root);need(!ids.some(id=>held.has(id)),'planning_subscription_uncertain_legacy');}
function validResult(stdout){const r=JSON.parse(stdout);need(r?.type==='result'&&r.subtype==='success'&&r.is_error===false&&Number.isFinite(r.total_cost_usd)&&r.total_cost_usd>=0,'planning_subscription_result_refused');return r;}
async function retainedResponse(path,key){
 let saved;try{saved=JSON.parse(await privateRead(path));}catch{throw Error('planning_subscription_uncertain_response');}
 need(saved?.bindingDigest===key&&typeof saved.stdout==='string'&&sha(saved.stdout)===saved.rawDigest,'planning_subscription_uncertain_response');
 const result=validResult(saved.stdout);
 need(saved.metadata?.usageSource==='subscription'&&saved.metadata.costBasis==='api-equivalent-estimate'&&saved.metadata.estimatedCostUsd===result.total_cost_usd,'planning_subscription_uncertain_response');
 subscriptionAuthentication(saved.metadata.authentication);return saved;
}
/** Read-only queue projection: unknown jobs hold their projects, not unrelated
 * new intake. The executor still independently checks overlap before dispatch. */
export async function planningSubscriptionHeldProjects(root,{includeLegacy=true}={}){
 need(typeof includeLegacy==='boolean','planning_subscription_input');
 await directory(root);const held=includeLegacy?await legacyUnknownProjects(root):new Set(),store=join(root,'subscription-executions');
 let entries;try{entries=await readdir(store);}catch(e){if(e.code==='ENOENT')return [...held].sort();throw e;}
 await directory(store);need(entries.length<=10000,'planning_subscription_execution_limit');
 for(const name of entries.filter(n=>/^[a-f0-9]{64}\.request\.json$/.test(n))){
  const request=JSON.parse(await privateRead(join(store,name)));need(sha(JSON.stringify(request))===name.slice(0,64)&&request.schema==='baink-planning-subscription-claim-v1'&&Array.isArray(request.sources)&&request.sources.length>0&&request.sources.every(s=>PROJECT.test(s?.projectId??'')),'planning_subscription_uncertain');
  try{await retainedResponse(join(store,name.replace('.request.','.response.')),name.slice(0,64));}
  catch{for(const source of request.sources)held.add(source.projectId);}
 }
 return [...held].sort();
}
export async function runPlanningSubscription({directory:root,executable,executableSha256,model,prompt,schema,sources,env=process.env,timeoutMs=240000}){
 need(typeof model==='string'&&model.length>0&&model.length<=96&&typeof prompt==='string'&&prompt.isWellFormed()&&Buffer.byteLength(prompt)<=131072&&typeof schema==='string'&&Buffer.byteLength(schema)<=65536,'planning_subscription_input');
 need(Number.isInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=240000&&Array.isArray(sources)&&sources.length>=1&&sources.length<=10&&sources.every(s=>PROJECT.test(s?.projectId??'')&&/^[a-f0-9]{64}$/.test(s?.sourceDigest??''))&&new Set(sources.map(s=>s.projectId)).size===sources.length,'planning_subscription_input');
 const childEnv=planningSubscriptionEnvironment(env);await pin(executable,executableSha256);await directory(root);const store=join(root,'subscription-executions');await directory(store);
 const binding={schema:'baink-planning-subscription-claim-v1',model,executableSha256,promptDigest:sha(prompt),schemaDigest:sha(schema),sources:sources.map(({projectId,sourceDigest})=>({projectId,sourceDigest}))},key=sha(JSON.stringify(binding)),claim=join(store,key+'.request.json'),response=join(store,key+'.response.json');
 let cwd,lock;try{lock=await open(join(store,'execution.lock'),'wx',0o600);}catch(e){if(e.code==='EEXIST')throw Error('planning_subscription_execution_locked');throw e;}
 try{
  try{const old=JSON.parse(await privateRead(claim));need(JSON.stringify(old)===JSON.stringify(binding),'planning_subscription_binding_changed');const saved=await retainedResponse(response,key);return{stdout:saved.stdout,metadata:saved.metadata,cached:true};}catch(e){if(e.code!=='ENOENT')throw e;}
  await refuseLegacyUnknown(root,sources.map(s=>s.projectId));
  const entries=await readdir(store);need(entries.length<=10000,'planning_subscription_execution_limit');
  for(const name of entries.filter(n=>/^[a-f0-9]{64}\.request\.json$/.test(n))){
   const request=JSON.parse(await privateRead(join(store,name)));need(sha(JSON.stringify(request))===name.slice(0,64)&&request.schema==='baink-planning-subscription-claim-v1'&&Array.isArray(request.sources),'planning_subscription_uncertain');
   if(request.sources.some(s=>sources.some(t=>t.projectId===s.projectId)))await retainedResponse(join(store,name.replace('.request.','.response.')),name.slice(0,64));
  }
  await writeOnce(claim,binding);
  // Keep the owning HOME only for keychain login; never load project context
  // from the repository/state directory or copy credentials into this cwd.
  cwd=await realpath(await mkdtemp(join(tmpdir(),'uain-intake-subscription-')));
  const status=JSON.parse(await call(executable,[...ISOLATION,'auth','status','--json'],'',{env:childEnv,cwd,timeoutMs:Math.min(timeoutMs,15000)}));
  const authentication=subscriptionAuthentication(status);need(childEnv.CLAUDE_CODE_OAUTH_TOKEN?authentication.authMethod==='oauth_token':authentication.authMethod==='claude.ai','planning_subscription_authentication_changed');
  await pin(executable,executableSha256);
  const stdout=await call(executable,[...ISOLATION,'--print','--model',model,'--json-schema',schema,'--tools','','--allowedTools','','--permission-mode','dontAsk','--output-format','json'],prompt,{env:childEnv,cwd,timeoutMs});
  const result=validResult(stdout),metadata={usageSource:'subscription',costBasis:'api-equivalent-estimate',estimatedCostUsd:result.total_cost_usd,authentication};
  await writeOnce(response,{bindingDigest:key,rawDigest:sha(stdout),stdout,metadata});return{stdout,metadata,cached:false};
 }finally{if(cwd)await rm(cwd,{recursive:true,force:true});await lock.close();await unlink(join(store,'execution.lock'));}
}
