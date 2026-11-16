import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {evaluateProjectAdmission,runEvaluatedAdmission} from '../ops/project-admission-worker.mjs';
const scope={chainId:'isolated-test',genesisSha256:'a'.repeat(64),member:'uain1'+'b'.repeat(40),instance:'fixture'};
const source={project:{id:'OPP-00002',title:'Synthetic source only',description:'A synthetic isolated research proposal'},source:{revision:'fixture'}};
const draft={title:'A bounded synthetic question',question:'Which explicitly bounded fixture mechanism remains unresolved in the supplied primary evidence?',criteria:'An isolated fixture condition that can be independently reproduced with the declared bounded input.',class:'neutral',queries:['fixture mechanism evidence','fixture mechanism limitations']};
function fixture({decision={},primary=true,empty=false,fail=false,citation=false}={}){
 const requests=[],calls=[],clock=()=>Date.parse('2026-11-05T12:00:00Z');
 const catalogue={available:true,detail:()=>structuredClone(source)};
 const fetchImpl=async url=>{requests.push(url);if(fail)throw Error('fixture transport unavailable');const u=new URL(url);if(u.hostname==='api.crossref.org')return new Response(JSON.stringify({status:'ok',message:{items:empty?[]:[{DOI:'10.1234/fixture',title:['Actual supplied fixture metadata']}]}}));if(u.pathname.endsWith('/search'))return new Response(JSON.stringify({resultList:{result:primary?[{doi:'10.1234/fixture',pmcid:'PMC1234'}]:[]}}));return new Response('<article><article-title>Fixture primary text</article-title><body>Actual fixture limitation and unresolved question evidence.</body></article>');};
 const modelCall=async request=>{calls.push(request);return request.phase==='scope'?structuredClone(draft):{status:'approved',basis:'The supplied primary evidence explicitly leaves this bounded fixture question unanswered; this is an admission assessment only.',citations:[citation?'invented':primary?'primary-1':'search-1'],unresolved:true,coverageSufficient:true,...decision};};
 return{requests,calls,catalogue,clock,deps:{catalogue,fetchImpl,modelCall,clock}};
}
const options={sourceId:'OPP-00002',scope};
test('automatic model scope, actual searches/primary reads and evaluated decision create exact frozen single-project plan',async()=>{
 const f=fixture(),r=await evaluateProjectAdmission(options,f.deps);
 assert.equal(r.effectiveStatus,'approved');assert.equal(r.scientificNoveltyProven,false);assert.equal(r.evidence.filter(x=>x.kind==='search').length,2);assert.equal(r.evidence.filter(x=>x.kind==='primary').length,1); // same DOI is deduplicated
 assert.equal(f.calls.length,2);assert.match(f.calls[1].prompt,/Actual fixture limitation/);assert.ok(f.requests.every(url=>['api.crossref.org','www.ebi.ac.uk'].includes(new URL(url).hostname)));
 assert.equal(r.pilotConfig.sourceDigest,r.sourceDigest);assert.equal(r.plan.scope.member,scope.member);assert.match(r.plan.task.criteria,/Research question:/);assert.ok(r.plan.task.criteria.includes(draft.question));
 for(const e of r.evidence)assert.equal(e.sha256,createHash('sha256').update(e.text).digest('hex'));
});
test('metadata-only, weak coverage, known answer and retrieval failure never auto-approve',async()=>{
 for(const variant of [{primary:false},{decision:{coverageSufficient:false}},{decision:{unresolved:false}},{fail:true},{empty:true}]){
  const f=fixture(variant),r=await evaluateProjectAdmission(options,f.deps);assert.equal(r.effectiveStatus,'held');assert.equal(r.pilotConfig,null);
 }
 const f=fixture({decision:{status:'rejected',unresolved:false,basis:'The retrieved primary source already gives the exact answer, so this fixture cannot justify a new task.'}}),r=await evaluateProjectAdmission(options,f.deps);assert.equal(r.effectiveStatus,'rejected');assert.equal(r.pilotConfig,null);
});
test('fabricated citations, arbitrary query shape and source drift are rejected',async()=>{
 await assert.rejects(()=>evaluateProjectAdmission(options,fixture({citation:true}).deps),/not retrieved/);
 const f=fixture();f.deps.modelCall=async()=>({...draft,queries:['only one query']});await assert.rejects(()=>evaluateProjectAdmission(options,f.deps),/Two distinct/);
 const g=fixture();let n=0;g.catalogue.detail=()=>({...source,source:{revision:n++===0?'first':'second'}});await assert.rejects(()=>evaluateProjectAdmission(options,g.deps),/Source changed/);
});
test('bounded response and redirects/refusals are fail-closed without arbitrary model URL fetch',async()=>{
 const f=fixture();f.deps.fetchImpl=async()=>new Response('x'.repeat(2*1024*1024+1));const r=await evaluateProjectAdmission(options,f.deps);assert.equal(r.effectiveStatus,'held');assert.match(r.retrievalError,/bound/);
 const g=fixture();g.deps.fetchImpl=async()=>new Response('refused',{status:403});assert.equal((await evaluateProjectAdmission(options,g.deps)).effectiveStatus,'held');
});
test('durable evidence and expected digest bind automatic execution to the evaluated plan',async t=>{
 const directory=await realpath(await mkdtemp(join(tmpdir(),'uain-admission-evaluator-')));t.after(()=>rm(directory,{recursive:true,force:true}));
 const f=fixture(),r=await evaluateProjectAdmission({...options,outDir:directory},f.deps);const names=await readdir(directory);assert.equal(names.length,1);assert.deepEqual(JSON.parse(await readFile(join(directory,names[0]),'utf8')),r);
 let invoked=0;const capability={currentEvaluationDigest:()=>r.evaluationDigest,currentScope:()=>scope,sourceDigest:()=>r.sourceDigest,invoke:async(name,input)=>{invoked++;return{authority:'native',request_id:input.request_id,finalized:true,event:{id:String(invoked),operation:input.operation,subject:input.payload.id,member:scope.member,instance:scope.instance}};}};
 assert.equal((await runEvaluatedAdmission(r,capability,{expectedEvaluationDigest:r.evaluationDigest,now:f.clock()})).state,'admitted');assert.equal(invoked,2);
 await assert.rejects(()=>runEvaluatedAdmission({...r,effectiveStatus:'rejected'},capability,{expectedEvaluationDigest:r.evaluationDigest,now:f.clock()}),/changed/);
 await assert.rejects(()=>runEvaluatedAdmission(r,capability,{expectedEvaluationDigest:r.evaluationDigest,now:f.clock()+900001}),/stale/);
 await assert.rejects(()=>runEvaluatedAdmission(r,capability,{expectedEvaluationDigest:'wrong',now:f.clock()}),/changed/);
});
test('held evaluator result cannot be executed even with valid receipt capability',async()=>{
 const f=fixture({primary:false}),r=await evaluateProjectAdmission(options,f.deps);let calls=0;
 await assert.rejects(()=>runEvaluatedAdmission(r,{invoke:()=>calls++},{expectedEvaluationDigest:r.evaluationDigest,now:f.clock()}),/held or rejected/);assert.equal(calls,0);
});

test('invalid public scope refuses model/network work before spending or reading secrets',async()=>{const f=fixture();await assert.rejects(()=>evaluateProjectAdmission({...options,scope:{...scope,privateKey:'do-not-use'}},f.deps),/public native scope/);assert.equal(f.requests.length,0);assert.equal(f.calls.length,0);});

test('a successful primary endpoint error body is not treated as a read paper',async()=>{const f=fixture({decision:{citations:['search-1']}}),fetch=f.deps.fetchImpl;f.deps.fetchImpl=async url=>url.endsWith('/fullTextXML')?new Response('<error>not available</error>'):fetch(url);const r=await evaluateProjectAdmission(options,f.deps);assert.equal(r.effectiveStatus,'held');assert.equal(r.evidence.some(r=>r.kind==='primary'),false);});

test('stage2 model failure preserves retrieved evidence as durable held evaluation',async()=>{const f=fixture(),call=f.deps.modelCall;f.deps.modelCall=async x=>{if(x.phase==='evaluate')throw Error('provider failed with private diagnostics');return call(x);};const r=await evaluateProjectAdmission(options,f.deps);assert.equal(r.effectiveStatus,'held');assert.equal(r.modelError,'admission_model_unavailable');assert.equal(r.evidence.filter(x=>x.kind==='primary').length,1);assert.equal(JSON.stringify(r).includes('private diagnostics'),false);});

test('a newer held evaluation supersedes earlier approval even within freshness window',async()=>{const f=fixture(),r=await evaluateProjectAdmission(options,f.deps);let invoked=0;await assert.rejects(()=>runEvaluatedAdmission(r,{currentEvaluationDigest:()=> 'newer-held',invoke:()=>invoked++},{expectedEvaluationDigest:r.evaluationDigest,now:f.clock()}),/superseded/);assert.equal(invoked,0);});
test('admission output collision preserves existing bytes rather than replacing evidence',async t=>{
 const directory=await realpath(await mkdtemp(join(tmpdir(),'uain-admission-collision-')));t.after(()=>rm(directory,{recursive:true,force:true}));const f=fixture();const r=await evaluateProjectAdmission({...options,outDir:directory},f.deps);const{writeAdmissionEvaluation}=await import('../ops/admission-model.mjs'),path=join(directory,'admission-'+r.evaluationDigest+'.json');const original=await readFile(path);await assert.rejects(writeAdmissionEvaluation(directory,{...r,effectiveStatus:'rejected'}),/conflict/);assert.deepEqual(await readFile(path),original);await writeAdmissionEvaluation(directory,r);assert.deepEqual(await readFile(path),original);
});
test('admission CLI requires explicit pinned runner and usage selection cannot smuggle flags',async()=>{
 const{parseAdmissionArguments}=await import('../ops/project-admission-worker.mjs');const base=['OPP-00002','scope.json','out','--claude','/pinned/claude','--claude-sha256','a'.repeat(64),'--execution-directory','/private/state'];assert.equal(parseAdmissionArguments(base).usageSource,undefined);assert.equal(parseAdmissionArguments([...base,'--usage-source','subscription']).usageSource,'subscription');assert.throws(()=>parseAdmissionArguments(base.slice(0,3)),/pinned/);assert.throws(()=>parseAdmissionArguments([...base,'--usage-source','other']),/pinned/);assert.throws(()=>parseAdmissionArguments([...base,'--claude','/other']),/arguments/);
});
test('evaluator retains initial owner scope across asynchronous model and retrieval boundaries',async()=>{const mutable=structuredClone(scope),f=fixture(),base=f.deps.modelCall;f.deps.modelCall=async request=>{if(request.phase==='scope')mutable.instance='changed-after-start';return base(request);};const result=await evaluateProjectAdmission({...options,scope:mutable},f.deps);assert.equal(result.scope.instance,'fixture');assert.equal(result.plan.scope.instance,'fixture');assert.equal(mutable.instance,'changed-after-start');});

test('evaluator does not accept a non-plain scope by erasing its prototype during snapshot',async()=>{await assert.rejects(evaluateProjectAdmission({...options,scope:Object.assign(Object.create({unexpected:true}),scope)},fixture().deps),/scope/);});
