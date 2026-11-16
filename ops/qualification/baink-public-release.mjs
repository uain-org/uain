#!/usr/bin/env node
// Public read-only release acceptance. The two empty unsigned POST probes must
// be rejected before authentication; no account, nonce or financial command is made.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const BASES=['https://baink.money','https://aidollar.money/baink'];
const HASH=/^[a-f0-9]{64}$/;
const GENESIS='54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff';
const READER='136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860';
const sha=b=>createHash('sha256').update(b).digest('hex');
const insist=(ok,message)=>{if(!ok)throw Error(message);};
export function parseArgs(args){const out={output:'output/baink-public-release-acceptance.json'};for(let n=0;n<args.length;n++){const key=args[n];insist(['--manifest','--output'].includes(key)&&args[n+1]&&!args[n+1].startsWith('--'),'Usage: --manifest FILE [--output FILE]');insist(!out[key.slice(2)]||key==='--output'&&out.output==='output/baink-public-release-acceptance.json','Duplicate argument');out[key.slice(2)]=args[++n];}insist(out.manifest,'--manifest FILE is required');return out;}
export function publicAssets(manifest){
 const primary=Object.fromEntries(Object.entries(manifest.files??{}).filter(([p])=>p.startsWith('dist/')).map(([p,s])=>[p.slice(5),s]));
 const preview=manifest.preview_files;
 for(const files of [primary,preview]){insist(files&&typeof files==='object'&&!Array.isArray(files)&&HASH.test(files['index.html']??''),'Manifest requires exact primary and preview index hashes');for(const [p,h]of Object.entries(files))insist(/^[A-Za-z0-9._/-]+$/.test(p)&&p.split('/').every(x=>x&&x!=='.'&&x!=='..')&&HASH.test(h),'Unsafe or unhashed public artifact');}
 return [primary,preview];
}
export function validatePublicOnboarding(x){insist(x?.available===true&&x.url==='https://baink.money/wallet/'&&x.platform==='linux/amd64','Published wallet onboarding/owned guide unavailable');return x.url;}
export function validateNativeAsset(x,now=Date.now()){
 const n=x?.native,p=n?.proof,s=n?.supply,a=x?.asset;
 insist(n?.status==='ready'&&n.verified===true&&n.assetStatus==='active'&&n.privateStatus==='active','Native policies are not verified active');
 insist(a?.id==='uain-native-coin'&&a.symbol==='AI$'&&a.coinPolicy==='verified-bounties-108t-micro-v1'&&a.sameLedger===true&&a.reputationCreditsAreMoney===false,'Unexpected monetary source');
 insist(p?.authority==='native'&&p.chainId==='uain-shadow-20261008-1'&&p.epoch===GENESIS&&p.genesisSha256===GENESIS&&p.verifierSha256===READER&&HASH.test(p.appHash??'')&&/^[1-9][0-9]{0,18}$/.test(p.height??'')&&BigInt(p.height)>=1179371n,'Native proof pin mismatch');
 const age=now-Date.parse(p.headerTime);insist(Number.isFinite(age)&&age>=-60000&&Number.isInteger(p.maxAgeSeconds)&&p.maxAgeSeconds>=1&&p.maxAgeSeconds<=120&&age<=p.maxAgeSeconds*1000,'Native proof is not fresh');
 const quantity=v=>typeof v==='string'&&/^(0|[1-9][0-9]{0,20})$/.test(v);
 insist(s&&['minted','reserved','transparent','shielded'].every(k=>quantity(s[k]))&&quantity(a.supplyCapUnits),'Invalid native supply');
 insist(BigInt(s.minted)+BigInt(s.reserved)<=BigInt(a.supplyCapUnits)&&BigInt(s.transparent)+BigInt(s.shielded)===BigInt(s.minted),'Native supply conservation failed');
 insist(x.balance===null&&n.balanceUnits===null&&n.memberStatus==='not_selected','Visitor response unexpectedly selected a member');
 return {height:p.height,genesisSha256:p.genesisSha256,verifierSha256:p.verifierSha256,supply:s};
}
async function bounded(items,fn){for(let i=0;i<items.length;i+=4)await Promise.all(items.slice(i,i+4).map(fn));}
export function retryAfterMs(value,now=Date.now()){if(typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value.trim()))return Math.ceil(Number(value)*1000);const date=Date.parse(value);return Number.isFinite(date)?Math.max(0,date-now):60000;}
export async function runAcceptance(manifest,{fetchImpl=fetch,now=()=>Date.now(),paceMs=1600,maxDurationMs=480000,sleepImpl=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 const maps=publicAssets(manifest),rows=[],native=[],wireAttempts=[];const startedAt=new Date().toISOString(),deadline=now()+maxDurationMs;let nextApiAt=now();
 async function pause(ms){insist(Number.isFinite(ms)&&ms>=0&&now()+ms<deadline,'Public acceptance deadline exceeded');while(ms>0){const part=Math.min(ms,30000);await sleepImpl(part);ms-=part;}}
 async function check(url,test,{method='GET'}={}){
  const row={url,method};rows.push(row);
  try{
   for(let attempt=1;attempt<=3;attempt++){
    const api=new URL(url).pathname.includes('/api/');
    if(api){await pause(Math.max(0,nextApiAt-now()));nextApiAt=now()+paceMs;}
    insist(now()<deadline,'Public acceptance deadline exceeded');
    const r=await fetchImpl(url,{method,redirect:'manual',signal:AbortSignal.timeout(Math.min(15000,Math.max(1,deadline-now()))),...(method==='POST'?{headers:{Origin:'https://baink.money','Content-Type':'application/json'},body:'{}'}:{})});const bytes=Buffer.from(await r.arrayBuffer());insist(bytes.length<=8*1024*1024,'Public response exceeded bound');
    const wire={url,method,attempt,status:r.status,sha256:sha(bytes),retryAfter:r.headers.get('retry-after')};wireAttempts.push(wire);Object.assign(row,{status:r.status,sha256:wire.sha256,attempts:attempt});
    // Only public GETs and these exact empty unsigned rejection probes exist.
    // Never retry any signed/account/financial operation or ambiguous network loss.
    if(r.status===429&&attempt<3){await pause(retryAfterMs(wire.retryAfter,now()));continue;}
    await test(r,bytes);row.passed=true;break;
   }
  }catch(e){row.passed=false;row.error=String(e.message).slice(0,500);}

 }
 const json=(r,b)=>{insist(r.status===200,'Expected HTTP200');return JSON.parse(b);};
 for(const [index,base] of BASES.entries()){
  await bounded(Object.entries(maps[index]),([path,digest])=>check(base+'/'+path,(r,b)=>insist(r.status===200&&sha(b)===digest,'Public artifact hash mismatch: '+path)));
  await check(base+'/api/health',(r,b)=>{const x=json(r,b);insist(x.ok===true&&x.service==='baink'&&x.storage==='ready','Health/storage unavailable');});
  await check(base+'/api/management/status',(r,b)=>{const x=json(r,b);insist(x.active>=70&&x.reviewRequired>=10&&x.autonomousResearch===false&&x.payments===false,'Coordination policy/count mismatch');});
  let active=[];
  await check(base+'/api/proposals?managementStatus=active&pageSize=100',(r,b)=>{const x=json(r,b);insist(x.total>=70&&Array.isArray(x.projects)&&x.projects.length>=70&&new Set(x.projects.map(p=>p.id)).size===x.projects.length&&x.projects.every(p=>p.status==='inactive'&&p.management?.status==='active'),'Source and coordination states/count mismatch');active=x.projects;});
  // Verify every returned coordination record once, without implying research execution.
  if(index===0)for(const p of active)await check(base+'/api/management/projects/'+encodeURIComponent(p.id),(r,b)=>{const x=json(r,b);insist(x.status==='active'&&x.tasks?.length>=1&&x.manager&&x.starterContribution,'Active coordination detail missing');});
  await check(base+'/api/proposals?managementStatus=review-required&pageSize=100',(r,b)=>insist(json(r,b).total>=10,'Held proposal count mismatch'));
  await check(base+'/api/account/metadata',r=>insist(r.status===401,'Private account metadata must require authentication'));
  await check(base+'/llms.txt',(r,b)=>{const t=b.toString('utf8');insist(r.status===200&&t.includes('GET /api/account/metadata')&&t.includes('not-requested')&&t.includes('null balance')&&t.includes('GET /api/account separately'),'Published metadata authority/refresh documentation missing');});
  await check(base+'/api/management/projects/OPP-00002/chat',r=>insist(r.status===401,'Private chat must require authentication'));
  for(const path of ['/api/native/earning','/api/native/earning/materials','/api/native/payments','/api/native/instances'])await check(base+path,r=>insist(r.status===401,'Financial/instance authorization failed'));
  for(const path of ['/api/trade/terms/00000000-0000-4000-8000-000000000001/payment-request','/api/native/earning/00000000-0000-4000-8000-000000000001/reconcile'])await check(base+path,r=>insist(r.status===401,'New financial route must reject unsigned caller'),{method:'POST'});
  await check(base+'/api/work/projects?q=senescent&source=all&pageSize=12',(r,b)=>{const x=json(r,b);insist(Array.isArray(x.projects)&&x.projects.length>0&&x.coverage,'Unified source discovery unavailable');});
  await check(base+'/api/config',(r,b)=>{const x=json(r,b);validatePublicOnboarding(x.walletOnboarding);insist(x.nativeRegistration?.instance?.enabled===true&&x.nativeEarning?.enabled===true&&x.nativePayments?.holderSubmissionRequired===true&&x.projectFunding?.policyAdopted===false&&x.projectFunding?.allocationAvailable===false,'Capability boundaries changed');});
  await check(base+'/api/native/asset',(r,b)=>native.push({base,...validateNativeAsset(json(r,b),now())}));
 }
 await check('https://aidollar.money/?qa=preserved',r=>insist(r.status===308&&r.headers.get('location')==='https://baink.money/?qa=preserved','Canonical redirect/query mismatch'));
 return {schema:'baink-public-release-acceptance-v1',release:manifest.release,version:manifest.version,startedAt,completedAt:new Date().toISOString(),publicReadOnly:true,unsignedRejectionProbesOnly:true,financialMutations:false,accountsCreated:false,researchExecutionClaimed:false,checks:rows.length,wireAttempts:wireAttempts.length,rateRefusals:wireAttempts.filter(x=>x.status===429).length,paceMs,maxDurationMs,passed:rows.every(x=>x.passed),native,rows,wire:wireAttempts};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const args=parseArgs(process.argv.slice(2)),report=await runAcceptance(JSON.parse(await readFile(args.manifest,'utf8')));await mkdir(dirname(resolve(args.output)),{recursive:true});await writeFile(args.output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({release:report.release,version:report.version,checks:report.checks,wireAttempts:report.wireAttempts,rateRefusals:report.rateRefusals,passed:report.passed,output:args.output,failures:report.rows.filter(x=>!x.passed)}));if(!report.passed)process.exitCode=1;}catch(e){console.error(e.message);process.exitCode=1;}
}
