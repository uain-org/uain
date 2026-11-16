import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,realpath,rm,readFile,readdir,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as fleet from './house-fleet.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const member='uain1'+'a'.repeat(40);
const EVIDENCE='A genuinely new fictional fixture result with prior-art searches listed.';
const task=(id,extra={})=>({id,project:'P-house',title:'Find X',criteria:'Must be new. Excludes known results.',acceptance_digest:'d'.repeat(64),eligibility:'new',solver_amount:'5',reviewer_amount:'1',joined:false,eligibleForSubmit:true,...extra});
const finding=(evidence=EVIDENCE)=>JSON.stringify({verdict:'FINDING',evidence,selfCheck:'Checked each criterion and searched prior art.'});
const upheld=JSON.stringify({verdict:'UPHELD',reasons:'Could not refute.'});

async function setup(t,{tasks=[task('T1')],solver=finding(),refuter=upheld,dryRun=false,agent}={}){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'house-fleet-')));t.after(()=>rm(dir,{recursive:true,force:true}));
 const config=fleet.loadConfig({stateDir:dir,agents:[{name:'alpha',run:'/holder/house/alpha/run'}],evidenceDir:{host:join(dir,'evidence'),agent:'/holder/house/evidence'}},{dryRun});
 const calls=[],solves=[];
 const deps={now:()=>'2026-11-06T00:00:00.000Z',log:()=>{},
  solve:async(prompt,{role})=>{solves.push({role,prompt});return typeof (role==='solver'?solver:refuter)==='function'?(role==='solver'?solver:refuter)():(role==='solver'?solver:refuter);},
  runAgent:async(a,args)=>{calls.push(args);if(agent)return agent(args);
   if(args[0]==='tasks')return{member,tasks};
   if(args[0]==='join')return{finalized:true,paid:false,project:args[args.indexOf('--project')+1]};
   if(args[0]==='submit')return{finalized:true,paid:false,submissionId:args[args.indexOf('--submission')+1],evidenceDigest:sha(EVIDENCE),intentId:'i'};
   throw Error('unexpected '+args[0]);}};
 const record=async(root=dir)=>{const d=join(root,'agents','alpha','tasks');const n=(await readdir(d)).filter(x=>x.endsWith('.json'));return Promise.all(n.map(async x=>JSON.parse(await readFile(join(d,x),'utf8'))));};
 return{dir,config,calls,solves,deps,record,writes:()=>calls.filter(a=>['join','submit','receipt-join','receipt-submit'].includes(a[0]))};
}

test('strict solver and refutation JSON, with size limits',()=>{
 assert.equal(fleet.parseSolverOutput(finding()).verdict,'FINDING');
 assert.equal(fleet.parseSolverOutput(JSON.stringify({verdict:'NO_FINDING',evidence:'',selfCheck:''})).verdict,'NO_FINDING');
 for(const bad of ['', 'Here is my answer: '+finding(), '```json\n'+finding()+'\n```', JSON.stringify({verdict:'FINDING',evidence:EVIDENCE}),
  JSON.stringify({verdict:'FINDING',evidence:EVIDENCE,selfCheck:'x',extra:1}), JSON.stringify({verdict:'MAYBE',evidence:EVIDENCE,selfCheck:'x'}),
  finding(''), finding('   '), finding('a'.repeat(16385)), JSON.stringify({verdict:'FINDING',evidence:EVIDENCE,selfCheck:'x'.repeat(4097)}), JSON.stringify({verdict:'FINDING',evidence:EVIDENCE,selfCheck:' '})])
  assert.throws(()=>fleet.parseSolverOutput(bad),undefined,bad.slice(0,60));
 assert.equal(fleet.parseSolverOutput(finding('a'.repeat(16384))).evidence.length,16384);
 assert.equal(fleet.parseRefutation(upheld).verdict,'UPHELD');
 for(const bad of ['UPHELD','{"verdict":"UPHELD"}','{"verdict":"OK","reasons":""}','{"verdict":"UPHELD","reasons":"","x":1}'])assert.throws(()=>fleet.parseRefutation(bad));
});

test('prompts carry the public criteria and the novelty rules',()=>{
 const p=fleet.solverPrompt(task('T1')),r=fleet.refutationPrompt(task('T1'),EVIDENCE);
 for(const s of [p,r]){assert.match(s,/Excludes known results/);assert.match(s,/no open-source or discoverable solution/);assert.match(s,/fabricated/);}
 assert.match(r,/genuinely new fictional fixture/);assert.match(r,/If in doubt, refute/);
 assert.throws(()=>fleet.loadConfig({stateDir:'/s',agents:[{name:'Bad Name',run:'/r'}]}));
 assert.throws(()=>fleet.loadConfig({stateDir:'/s',agents:[{name:'a',run:'/r'},{name:'b',run:'/r'}]}));
 assert.deepEqual(fleet.loadConfig({stateDir:'/s',agents:[{name:'a',run:'/r'}]}).solver.command,['claude','--model','claude-sonnet-5-5','-p']);
});

test('NO_FINDING is logged and never joins or submits',async t=>{
 const s=await setup(t,{solver:JSON.stringify({verdict:'NO_FINDING',evidence:'',selfCheck:'Prior art exists.'})});
 await fleet.runCycle(s.config,s.deps);
 assert.equal(s.writes().length,0);assert.deepEqual(s.solves.map(x=>x.role),['solver']);
 assert.equal((await s.record())[0].status,'no-finding');
 await fleet.runCycle(s.config,s.deps);assert.equal(s.solves.length,1,'a recorded task is not solved again');
});

test('malformed or oversized solver output is terminal solver-output-invalid',async t=>{
 for(const solver of ['not json',finding('a'.repeat(16385)),finding('')]){
  const s=await setup(t,{solver});await fleet.runCycle(s.config,s.deps);
  assert.equal(s.writes().length,0);assert.equal((await s.record())[0].status,'solver-output-invalid');
 }
});

test('a FINDING the independent check refutes, or that the check cannot confirm, is not submitted',async t=>{
 for(const refuter of [JSON.stringify({verdict:'REFUTED',reasons:'Known since 2019.'}),'garbage',()=>{throw Error('solver timeout');}]){
  const s=await setup(t,{refuter});await fleet.runCycle(s.config,s.deps);
  assert.deepEqual(s.solves.map(x=>x.role),['solver','refuter']);
  assert.equal(s.writes().length,0);assert.equal((await s.record())[0].status,'refuted');
 }
});

test('an upheld FINDING joins then submits exactly once, with a fixed submission ID',async t=>{
 const s=await setup(t);await fleet.runCycle(s.config,s.deps);
 const w=s.writes();assert.deepEqual(w.map(a=>a[0]),['join','submit']);
 assert.ok(w.every(a=>a.at(-1)==='--execute-production'));
 const rec=(await s.record())[0];assert.equal(rec.status,'submitted');assert.equal(rec.evidenceDigest,sha(EVIDENCE));
 const sub=w[1];assert.equal(sub[sub.indexOf('--submission')+1],rec.submissionId);assert.match(rec.submissionId,/^HS-alpha-[a-f0-9]{20}$/);
 assert.ok(sub[sub.indexOf('--evidence')+1].startsWith('/holder/house/evidence/'));
 const file=join(s.dir,'evidence',(await readdir(join(s.dir,'evidence')))[0]);
 assert.equal(await readFile(file,'utf8'),EVIDENCE);assert.equal((await stat(file)).mode&0o777,0o600);
 const log=await readFile(join(s.dir,'fleet.jsonl'),'utf8');assert.ok(!log.includes(EVIDENCE),'log holds digests, not evidence');
 await fleet.runCycle(s.config,s.deps);assert.equal(s.writes().length,2,'one submission per task per agent');
});

test('already joined project skips join; ineligible task is not solved',async t=>{
 const s=await setup(t,{tasks:[task('T1',{joined:true}),task('T2',{eligibleForSubmit:false})]});
 await fleet.runCycle(s.config,s.deps);
 assert.deepEqual(s.writes().map(a=>a[0]),['submit']);assert.equal(s.solves.filter(x=>x.role==='solver').length,1);
});

test('a refused or lost submit is marked uncertain and never retried',async t=>{
 const s=await setup(t,{agent:args=>{if(args[0]==='tasks')return{member,tasks:[task('T1',{joined:true})]};throw Error('lost response');}});
 await fleet.runCycle(s.config,s.deps);await fleet.runCycle(s.config,s.deps);
 assert.equal(s.writes().length,1);assert.equal((await s.record())[0].status,'uncertain');
});

test('a pending submit receipt is followed up with receipt-submit only',async t=>{
 let pending=true;
 const s=await setup(t,{agent:args=>{if(args[0]==='tasks')return{member,tasks:[task('T1',{joined:true})]};
  if(args[0]==='submit')return{finalized:false,receiptPending:true,paid:false,intentId:'i'};
  if(args[0]==='receipt-submit'){if(pending){pending=false;return{finalized:false,receiptPending:true,paid:false,intentId:'i'};}return{finalized:true,paid:false,submissionId:args[args.indexOf('--submission')+1],evidenceDigest:sha(EVIDENCE),intentId:'i'};}
  throw Error('unexpected');}});
 for(let i=0;i<4;i++)await fleet.runCycle(s.config,s.deps);
 assert.deepEqual(s.writes().map(a=>a[0]),['submit','receipt-submit','receipt-submit']);
 assert.equal((await s.record())[0].status,'submitted');
});

test('STOP file: no agent call at all; STOP during a cycle blocks the production write',async t=>{
 const s=await setup(t);await writeFile(join(s.dir,'STOP'),'');
 assert.deepEqual(await fleet.runCycle(s.config,s.deps),{paused:'operator_stop'});
 assert.equal(s.calls.length,0);assert.equal(s.solves.length,0);
 const m=await setup(t,{refuter:async()=>{await writeFile(join(m.dir,'STOP'),'');return upheld;}});
 const r=await fleet.runCycle(m.config,m.deps);
 assert.equal(r.paused,'operator_stop');assert.equal(m.writes().length,0);
 assert.equal((await m.record())[0].status,'qualified','qualified work waits; it is not lost or marked uncertain');
 await rm(join(m.dir,'STOP'));await fleet.runCycle(m.config,m.deps);
 assert.deepEqual(m.writes().map(a=>a[0]),['join','submit']);
});

test('dry run solves and checks but never joins or submits, and keeps separate state',async t=>{
 const s=await setup(t,{dryRun:true});await fleet.runCycle(s.config,s.deps);
 assert.equal(s.writes().length,0);assert.deepEqual(s.solves.map(x=>x.role),['solver','refuter']);
 assert.equal((await s.record(join(s.dir,'dry-run')))[0].status,'dry-run-qualified');
 await assert.rejects(readdir(join(s.dir,'agents')),{code:'ENOENT'});
});

test('a held lock refuses a second concurrent cycle',async t=>{
 const s=await setup(t);await writeFile(join(s.dir,'cycle.lock'),'{}');
 await assert.rejects(fleet.runCycle(s.config,s.deps),/cycle_already_running/);assert.equal(s.calls.length,0);
});

test('default process adapters: fake solver command on stdin, fake agent command, bounded output',async t=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'house-fleet-proc-')));t.after(()=>rm(dir,{recursive:true,force:true}));
 const agentScript=join(dir,'agent.mjs'),solverScript=join(dir,'solver.mjs');
 await writeFile(agentScript,`const a=process.argv.slice(2);if(a[0]==='tasks')console.log(JSON.stringify({member:'${member}',tasks:[${JSON.stringify(task('T1'))}]}));else{console.error('refused');process.exit(1);}`);
 await writeFile(solverScript,`let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(s.includes('independent reviewer')?${JSON.stringify(JSON.stringify({verdict:'REFUTED',reasons:'Known.'}))}:${JSON.stringify(finding())});});`);
 const config=fleet.loadConfig({stateDir:join(dir,'state'),agents:[{name:'alpha',run:'/r/alpha'}],agentCommand:[process.execPath,agentScript],solver:{command:[process.execPath,solverScript],timeoutMs:20000}});
 const r=await fleet.runCycle(config,{...fleet.defaultDeps(config),log:()=>{}});
 assert.deepEqual(r.agents[0].outcomes,[{task:'T1',status:'refuted'}]);
 await assert.rejects(fleet.runProcess(process.execPath,['-e','process.stdout.write("x".repeat(5000))'],{maxOutputBytes:1024}),/output limit/);
 await assert.rejects(fleet.runProcess(process.execPath,['-e','setTimeout(()=>{},10000)'],{timeoutMs:1000}),/timeout/);
});

const surveyTask=()=>{
 const id='T-OPP-00004-1-prior-art-survey',criteria='Prior-art survey for "fixture". Main KPI: "Fixture exact main KPI". No novelty claim is made or rewarded;';
 return task(id,{project:'P-OPP-00004',criteria,acceptance_digest:sha(criteria),surveyTemplate:{taskId:id,project:'P-OPP-00004',criteriaDigest:sha(criteria),mainKpi:'Fixture exact main KPI',minIncluded:8,minKinds:2,required:[{kind:'doi',id:'10.1234/fixture',title:'Fixture'}]}});
};
test('bound survey prompts request existing-work inventory with exact artifact binding and central review',async t=>{
 const task=surveyTask(),submissionId=`HS-alpha-${sha('task\0'+task.id).slice(0,20)}`;
 const artifact={schema:'uain-evidence-artifact-v1',author:member,taskId:task.id,submissionId,survey:{mainKpi:task.surveyTemplate.mainKpi,asOf:'2026-11-06',items:[],conclusion:{meetsMainKpi:false,gaps:['Fixture gap; deliberately incomplete evidence for mocked preflight only.']}}};
 const s=await setup(t,{tasks:[task],solver:finding(JSON.stringify(artifact)),dryRun:true});
 await fleet.runCycle(s.config,s.deps);
 assert.equal((await s.record(join(s.dir,'dry-run')))[0].status,'dry-run-qualified');
 assert.deepEqual(s.solves.map(x=>x.role),['solver','refuter']);
 for(const {prompt} of s.solves){
  assert.match(prompt,/dated inventory of existing work/);assert.match(prompt,/central UAIN/);
  assert.ok(prompt.includes(task.surveyTemplate.required[0].id));assert.ok(prompt.includes(submissionId));assert.ok(prompt.includes(member));
  assert.ok(!prompt.includes('Never report known results'));assert.ok(!prompt.includes('is already known or discoverable'));
 }
 assert.equal(s.writes().length,0);
});
test('survey template and returned artifact binding fail closed before submission',async t=>{
 for(const change of [{surveyTemplate:undefined},{surveyTemplate:{...surveyTask().surveyTemplate,project:'P-other'}}]){
  const s=await setup(t,{tasks:[{...surveyTask(),...change}],dryRun:true});await fleet.runCycle(s.config,s.deps);
  assert.equal(s.solves.length,0);assert.equal(s.writes().length,0);
 }
 const task=surveyTask(),artifact={schema:'uain-evidence-artifact-v1',author:member,taskId:task.id,submissionId:`HS-alpha-${sha('task\0'+task.id).slice(0,20)}`,survey:{mainKpi:task.surveyTemplate.mainKpi}};
 for(const changed of [{author:'uain1'+'b'.repeat(40)},{taskId:'T-wrong'},{submissionId:'wrong'},{survey:{mainKpi:'Wrong KPI'}},{schema:'wrong'}]){
  const s=await setup(t,{tasks:[task],solver:finding(JSON.stringify({...artifact,...changed}))});
  await fleet.runCycle(s.config,s.deps);assert.deepEqual(s.solves.map(x=>x.role),['solver']);assert.equal(s.writes().length,0);
 }
});

test('trusted bridge budget pause defers a task and resumes it next cycle without terminal no-finding',async t=>{
 const s=await setup(t);let n=0;
 s.deps.budgetPauseTrusted=()=>true;
 s.deps.solve=async(prompt,{role})=>{n++;return n===1?JSON.stringify({schema:'uain-house-compute-pause-v1',phase:'pre-execution',reason:'authoritative_compute_budget',role,executionId:'HSR-fixture',promptDigest:sha(prompt)}):JSON.stringify({verdict:'NO_FINDING',evidence:'',selfCheck:'Fixture no finding after budget recovery'});};
 const first=await fleet.runCycle(s.config,s.deps);assert.equal(first.paused,'compute_budget');assert.equal((await s.record())[0].status,'budget-deferred');assert.equal(s.writes().length,0);
 await fleet.runCycle(s.config,s.deps);assert.equal(n,2);assert.equal((await s.record())[0].status,'no-finding');
});
test('untrusted model cannot choose the budget pause protocol',async t=>{
 const s=await setup(t,{solver:JSON.stringify({schema:'uain-house-compute-pause-v1',phase:'pre-execution',reason:'authoritative_compute_budget',role:'solver',executionId:'fixture',promptDigest:'a'.repeat(64)})});
 await fleet.runCycle(s.config,s.deps);assert.equal((await s.record())[0].status,'solver-output-invalid');assert.equal(s.writes().length,0);
});

test('refuter budget pause replays the same solver prompt and defers until next cycle',async t=>{
 const s=await setup(t,{dryRun:true});let refutes=0;const prompts=[];s.deps.budgetPauseTrusted=()=>true;
 s.deps.solve=async(prompt,{role})=>{prompts.push({role,prompt});if(role==='solver')return finding();refutes++;return refutes===1?JSON.stringify({schema:'uain-house-compute-pause-v1',phase:'pre-execution',reason:'authoritative_compute_budget',role,executionId:'HSR-fixture',promptDigest:sha(prompt)}):upheld;};
 await fleet.runCycle(s.config,s.deps);assert.equal((await s.record(join(s.dir,'dry-run')))[0].status,'budget-deferred');
 await fleet.runCycle(s.config,s.deps);assert.equal((await s.record(join(s.dir,'dry-run')))[0].status,'dry-run-qualified');assert.equal(prompts[0].prompt,prompts[2].prompt);assert.equal(s.writes().length,0);
});

test('survey output contract keeps verification prose out of the exact JSON artifact and rejects trailing text without retry',async t=>{const task=surveyTask(),p=fleet.solverPrompt(task);assert.match(p,/evidence: for FINDING, exactly one JSON artifact serialized as a string/);assert.match(p,/Put verification steps and search rationale in selfCheck/);assert.ok(!p.includes('with the result, how to verify it, and the prior-art searches'));assert.match(fleet.solverPrompt({id:'ordinary',project:'P-house',criteria:'fixture',acceptance_digest:'d'.repeat(64)}),/with the result, how to verify it, and the prior-art searches/);const artifact={schema:'uain-evidence-artifact-v1',author:member,taskId:task.id,submissionId:`HS-alpha-${sha('task\0'+task.id).slice(0,20)}`,survey:{mainKpi:task.surveyTemplate.mainKpi}};const valid=await setup(t,{tasks:[task],solver:finding(JSON.stringify(artifact)),dryRun:true});await fleet.runCycle(valid.config,valid.deps);assert.equal((await valid.record(join(valid.dir,'dry-run')))[0].status,'dry-run-qualified');const s=await setup(t,{tasks:[task],solver:finding(JSON.stringify(artifact)+'\nHow to verify: fictional steps\nSearches run: fictional search')});await fleet.runCycle(s.config,s.deps);assert.equal((await s.record())[0].status,'solver-output-invalid');assert.equal(s.writes().length,0);assert.deepEqual(s.solves.map(x=>x.role),['solver']);await fleet.runCycle(s.config,s.deps);assert.equal(s.solves.length,1,'Invalid completed output remains terminal and is never repaired or replayed');});

test('pre-output transport failure is terminal solver-unavailable, never a scientific verdict or automatic retry',async t=>{const s=await setup(t,{solver:async()=>{throw Error('Retained remote transport uncertain; original claim held');}});await fleet.runCycle(s.config,s.deps);assert.equal((await s.record())[0].status,'solver-unavailable');assert.equal(s.writes().length,0);assert.deepEqual(s.solves.map(x=>x.role),['solver']);await fleet.runCycle(s.config,s.deps);assert.equal(s.solves.length,1);assert.equal(s.writes().length,0);});

test('future survey wire is canonical before refutation and digest, with raw evidence provenance retained',async t=>{
 const {canonical}=await import('../../services/project-organizations/src/common.mjs');
 const task=surveyTask(),artifact={schema:'uain-evidence-artifact-v1',author:member,taskId:task.id,submissionId:`HS-alpha-${sha('task\0'+task.id).slice(0,20)}`,survey:{mainKpi:task.surveyTemplate.mainKpi,items:[],conclusion:{meetsMainKpi:false}}};
 const raw=JSON.stringify(artifact,null,2),wire=canonical(artifact),provider=finding(raw);
 assert.notEqual(raw,wire);
 const s=await setup(t,{tasks:[task],solver:provider,dryRun:true});await fleet.runCycle(s.config,s.deps);
 const [rec]=await s.record(join(s.dir,'dry-run'));
 assert.equal(rec.status,'dry-run-qualified');assert.equal(rec.evidenceDigest,sha(wire));assert.equal(rec.rawEvidenceDigest,sha(raw));
 assert.ok(s.solves[1].prompt.includes(wire));assert.ok(!s.solves[1].prompt.includes(raw));
 const saved=await readFile(join(s.dir,'dry-run','evidence',(await readdir(join(s.dir,'dry-run','evidence')))[0]),'utf8');assert.equal(saved,wire);
 const {spawnSync}=await import('node:child_process');
 const result=spawnSync('python3',['-c',`import sys,json,hashlib;sys.path.insert(0,'ops/custody');import fleet_attestation as f;x=json.load(sys.stdin);a=x['artifact'];c=x['criteria'];p=dict(taskId=a['taskId'],projectId='P-OPP-00004',criteriaDigest=hashlib.sha256(c.encode()).hexdigest());t=dict(id=a['taskId'],project=p['projectId'],criteria=c,acceptance_digest=p['criteriaDigest'],state='under_review',pending=a['submissionId']);s=dict(id=a['submissionId'],task=t['id'],author=a['author'],state='under_review',evidence=x['wire'],evidence_digest=hashlib.sha256(x['wire'].encode()).hexdigest());assert f._evidence_artifact(p,t,s)==a`],{input:JSON.stringify({artifact,criteria:task.criteria,wire:saved}),encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.equal(provider,finding(raw),'provider output bytes remain unchanged');
});
test('survey duplicate keys, floats and excessive nesting fail before refuter or native effects',async t=>{
 const task=surveyTask(),base={schema:'uain-evidence-artifact-v1',author:member,taskId:task.id,submissionId:`HS-alpha-${sha('task\0'+task.id).slice(0,20)}`,survey:{mainKpi:task.surveyTemplate.mainKpi}};
 for(const raw of [JSON.stringify(base).replace('"survey":','"author":"uain1'+'b'.repeat(40)+'","survey":'),JSON.stringify(base).replace('"survey":','"\\u0061uthor":"'+member+'","survey":'),JSON.stringify({...base,survey:{...base.survey,n:1.5}}),JSON.stringify(base).replace('"survey":','"n":1.0,"survey":'),JSON.stringify({...base,survey:{...base.survey,n:9007199254740992}}),JSON.stringify({...base,survey:{...base.survey,n:JSON.parse('['.repeat(80)+'0'+']'.repeat(80))}})]){
  const s=await setup(t,{tasks:[task],solver:finding(raw)});await fleet.runCycle(s.config,s.deps);assert.equal((await s.record())[0].status,'solver-output-invalid');assert.deepEqual(s.solves.map(x=>x.role),['solver']);assert.equal(s.writes().length,0);
 }
});
