#!/usr/bin/env node
/** Bounded Claude primitive and web-only house adapter. No signing authority.
 * API uncertainty retains its compute reservation; verified subscription mode
 * treats CLI dollar estimates as usage metadata, not an invoice or spend cap. */
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {open,realpath,mkdtemp,rm,stat,mkdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {openComputeBudget} from '../../services/project-organizations/src/compute-budget.mjs';
import {parseSolverOutput,parseRefutation} from './house-fleet.mjs';
const MODEL='claude-sonnet-5-5',MAX_PROMPT=131072,MAX_OUTPUT=262144;
const need=(ok,message)=>{if(!ok)throw Error(message);};
const schema=role=>({type:'object',additionalProperties:false,required:role==='solver'?['verdict','evidence','selfCheck']:['verdict','reasons'],properties:role==='solver'?{verdict:{type:'string',enum:['FINDING','NO_FINDING']},evidence:{type:'string'},selfCheck:{type:'string'}}:{verdict:{type:'string',enum:['UPHELD','REFUTED']},reasons:{type:'string'}}});
async function pinnedExecutable(path,digest){
 need(isAbsolute(path??'')&&resolve(path)===path&&/^[a-f0-9]{64}$/.test(digest??''),'invalid executable pin');
 need(await realpath(path)===path,'executable must be canonical');
 const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=await fd.stat();need(s.isFile()&&s.nlink===1&&[0,process.getuid()].includes(s.uid)&&!(s.mode&0o022)&&(s.mode&0o111)&&s.size<=512*1024*1024,'unsafe executable metadata');
  const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);
  for(;;){const {bytesRead}=await fd.read(buffer,0,buffer.length,null);if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));}
  need(hash.digest('hex')===digest,'executable hash differs');
 }finally{await fd.close();}
}
async function budgetPath(path){
 need(isAbsolute(path??'')&&resolve(path)===path,'absolute budget directory required');
 await mkdir(path,{recursive:true,mode:0o700});
 const s=await stat(path);need(await realpath(path)===path&&s.isDirectory()&&s.uid===process.getuid()&&!(s.mode&0o077),'unsafe budget directory');
}
function call(executable,args,{prompt,cwd,env,timeoutMs}){
 return new Promise((resolvePromise,reject)=>{
  const child=spawn(executable,args,{cwd,env,stdio:['pipe','pipe','pipe'],detached:true,shell:false});let size=0,err=0,failed=null;const chunks=[];
  const stop=reason=>{failed??=reason;try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}};
  const timer=setTimeout(()=>stop('provider timeout'),timeoutMs);
  child.stdout.on('data',b=>{size+=b.length;if(size>MAX_OUTPUT)stop('provider output limit');else chunks.push(b);});
  child.stderr.on('data',b=>{err+=b.length;if(err>MAX_OUTPUT)stop('provider output limit');});
  child.stdin.on('error',()=>{});
  child.on('error',()=>{clearTimeout(timer);reject(Error('provider spawn failed'));});
  child.on('close',code=>{clearTimeout(timer);if(failed||code!==0)return reject(Error(failed??'provider exited unsuccessfully'));resolvePromise(Buffer.concat(chunks).toString('utf8'));});
  child.stdin.end(prompt);
 });
}
/** Authentication is checked by the pinned CLI, with the exact isolated child
 * environment. Token presence or a caller-supplied usage label is insufficient. */
export function subscriptionAuthentication(status){
 need(status&&status.loggedIn===true&&status.apiProvider==='firstParty','subscription authentication unverified');
 // Official setup-token authenticates a subscription and is model-request-only;
 // auth status therefore legitimately omits profile-derived subscriptionType.
 // https://code.claude.com/docs/en/authentication#generate-a-long-lived-token
 need(status.authMethod==='oauth_token'||status.authMethod==='claude.ai'
  &&['pro','max','ultra','team','enterprise'].includes(status.subscriptionType),'subscription authentication unverified');
 return {loggedIn:true,authMethod:status.authMethod,apiProvider:status.apiProvider,...(typeof status.subscriptionType==='string'?{subscriptionType:status.subscriptionType}:{})};
}
// usageSource selects admission policy. Legacy capped mode can still use OAuth;
// CLI token-price totals are estimates in both modes, never invoice evidence.
export async function runClaudeStructured({executable,sha256,prompt,budgetDirectory,projectId,timeoutMs=600000,env=process.env,tools='',outputSchema,validateOutput,purpose,usageSource='api'}){
 need(['api','subscription'].includes(usageSource),'invalid usage source');
 need(['','WebSearch,WebFetch'].includes(tools)&&typeof validateOutput==='function'&&outputSchema&&typeof outputSchema==='object','invalid structured configuration');
 need(typeof prompt==='string'&&prompt.isWellFormed()&&prompt.trim()&&Buffer.byteLength(prompt)<=MAX_PROMPT,'invalid prompt');
 need(Number.isInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=1200000,'invalid timeout');
 const auth=typeof env.CLAUDE_CODE_OAUTH_TOKEN==='string'&&env.CLAUDE_CODE_OAUTH_TOKEN.length>0?{CLAUDE_CODE_OAUTH_TOKEN:env.CLAUDE_CODE_OAUTH_TOKEN}:typeof env.ANTHROPIC_API_KEY==='string'&&env.ANTHROPIC_API_KEY.length>0?{ANTHROPIC_API_KEY:env.ANTHROPIC_API_KEY}:null;
 need(auth,'runtime authentication required');
 await pinnedExecutable(executable,sha256);
 let budget,reservation;
 if(usageSource==='api'){await budgetPath(budgetDirectory);budget=openComputeBudget({directory:budgetDirectory});reservation=budget.reserve({purpose,projectIds:[projectId],model:MODEL});need(reservation.id,'shared compute budget exhausted');}
 const cwd=await mkdtemp(join(tmpdir(),'uain-house-solver-'));
 try{
  const childEnv={PATH:'/usr/bin:/bin',HOME:cwd,TMPDIR:cwd,LANG:'C.UTF-8',...auth};
  let authentication=null;
  if(usageSource==='subscription'){
   need(Object.hasOwn(auth,'CLAUDE_CODE_OAUTH_TOKEN')&&!['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN'].some(k=>typeof env[k]==='string'&&env[k].length),'subscription OAuth-only authentication required');
   const rawAuth=await call(executable,['auth','status','--json'],{prompt:'',cwd,env:childEnv,timeoutMs:Math.min(timeoutMs,15000)});
   let status;try{status=JSON.parse(rawAuth);}catch{throw Error('subscription authentication response invalid');}
   authentication=subscriptionAuthentication(status);
  }
  const args=['--print','--model',MODEL,'--output-format','json','--json-schema',JSON.stringify(outputSchema),
   '--tools',tools,'--allowedTools',tools,'--permission-mode','dontAsk','--strict-mcp-config','--mcp-config','{"mcpServers":{}}',
   '--settings','{"disableAllHooks":true}','--setting-sources','','--disable-slash-commands','--no-chrome','--no-session-persistence',...(usageSource==='api'?['--max-budget-usd','0.50']:[])];
  // Recheck immediately before spawn. No credentials files, settings, browser or
  // external provider URLs are inherited from the owner's ambient environment.
  await pinnedExecutable(executable,sha256);
  const raw=await call(executable,args,{prompt,cwd,timeoutMs,env:childEnv});
  let result;try{result=JSON.parse(raw);}catch{throw Error('provider JSON invalid');}
  need(result?.type==='result'&&result.subtype==='success'&&result.is_error===false&&Number.isFinite(result.total_cost_usd)&&result.total_cost_usd>=0&&(usageSource==='subscription'||result.total_cost_usd<=0.50),'provider result refused');
  let out;try{out=validateOutput(result.structured_output);}catch{throw Error('provider structured output refused');}
  if(budget)budget.settle(reservation.id,{costUsd:result.total_cost_usd,stopReason:'structured-success'});
  return {value:out,metadata:{provider:'claude',model:MODEL,modelAttribution:'requested-cli-model',
   nativeRawDigest:createHash('sha256').update(raw).digest('hex'),executableSha256:sha256,
   reportedModels:Object.keys(result.modelUsage??{}),costUsd:result.total_cost_usd,usageSource,costBasis:'api-equivalent-estimate',...(authentication?{authentication}:{})}};
 }finally{await rm(cwd,{recursive:true,force:true});}
}
export async function runClaude(options){
 const {role}=options;need(['solver','refuter'].includes(role),'invalid role');
 const result=await runClaudeStructured({...options,tools:'WebSearch,WebFetch',outputSchema:schema(role),purpose:'house-'+role,
  validateOutput:v=>(role==='solver'?parseSolverOutput:parseRefutation)(JSON.stringify(v))});
 return result.value;
}
async function cli(args){
 const options={},allowed=new Set(['--executable','--sha256','--role','--budget-dir','--project','--timeout-ms','--usage-source']);
 for(let i=0;i<args.length;i+=2){need(allowed.has(args[i])&&args[i+1]&&!Object.hasOwn(options,args[i]),'invalid arguments');options[args[i]]=args[i+1];}
 let bytes=0;const chunks=[];for await(const b of process.stdin){bytes+=b.length;need(bytes<=MAX_PROMPT,'prompt over limit');chunks.push(b);}
 const prompt=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
 return runClaude({executable:options['--executable'],sha256:options['--sha256'],role:options['--role'],budgetDirectory:options['--budget-dir'],projectId:options['--project'],usageSource:options['--usage-source']??'api',prompt,...(options['--timeout-ms']?{timeoutMs:Number(options['--timeout-ms'])}:{})});
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{process.stdout.write(JSON.stringify(await cli(process.argv.slice(2)))+'\n');}
 catch{process.stderr.write('House Claude solver refused; inspect retained execution evidence. No automatic retry.\n');process.exitCode=1;}
}
