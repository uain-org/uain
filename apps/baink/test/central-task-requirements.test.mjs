import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm,symlink} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createCentralTaskRequirements,validatePublicRequirements,publicPolicyDigest} from '../server/central-task-requirements.mjs';
const H='a'.repeat(64),E='b'.repeat(64);
function fixture(){
 const policy={schema:'uain-task-verification-policy-v1',class:'prior_art_survey',taskId:'T-one',projectId:'P-one',criteriaDigest:H,inputs:[],primarySourceHosts:['api.crossref.org'],driver:{name:'prior-art-survey',sha256:H},successTests:[{id:'survey',mainKpi:'A bounded and exact Main KPI',minIncluded:8,minKinds:2,requiredIds:[{kind:'doi',id:'10.1000/example'},{kind:'github',id:'fixture/repo'}]}]};
 return {taskId:'T-one',projectId:'P-one',criteriaDigest:H,evidenceDigest:E,policyDigest:publicPolicyDigest(policy),policy};
}
async function load(t,row=fixture(),options={}){const dir=await mkdtemp(join(homedir(),'.baink-public-task-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'public.json');await writeFile(path,JSON.stringify({schema:'baink-public-task-requirements-v1',chainId:'fixture',genesisSha256:H,tasks:[row]}),{mode:0o600});return{path,service:await createCentralTaskRequirements({path:await (await import('node:fs/promises')).realpath(path),pins:{chainId:'fixture',epoch:H},...options})};}
const task={id:'T-one',project:'P-one',acceptance_digest:H,evidence_digest:E};
test('unconfigured publication is explicitly unavailable, never empty guessed requirements',async()=>{const s=await createCentralTaskRequirements();assert.deepEqual(s.forTask(task),{available:false,reason:'not_published'});});
test('full exact policy and every required identifier are operator-published, not a native proof',async t=>{const {service}=await load(t);const r=service.forTask(task);assert.equal(r.authority,'operator-published');assert.equal(r.available,true);assert.equal(r.policy.successTests[0].requiredIds.length,2);assert.deepEqual(r.policy,fixture().policy);r.policy.successTests[0].requiredIds.pop();assert.equal(service.forTask(task).policy.successTests[0].requiredIds.length,2);});
test('task/project/criteria/evidence changes never reuse another contract',async t=>{const {service}=await load(t);for(const delta of [{project:'P-other'},{acceptance_digest:E},{evidence_digest:H}])assert.deepEqual(service.forTask({...task,...delta}),{available:false,reason:'task_binding_changed'});assert.equal(service.forTask({...task,id:'T-other'}).reason,'not_published');});
test('policy tampering and foreign task or criteria bindings fail closed',()=>{for(const mutate of [r=>r.policy.successTests[0].requiredIds.pop(),r=>r.policy.taskId='T-other',r=>r.policy.criteriaDigest=E,r=>r.policy.driver.sha256='bad']){const r=fixture();mutate(r);assert.throws(()=>validatePublicRequirements(r));}});
test('unlisted policy secrets, unsafe fields and duplicated IDs are rejected not silently published',()=>{for(const mutate of [r=>r.policy.privateKey='forbidden',r=>r.policy.driver.path='/private/key',r=>r.policy.successTests[0].requiredIds.push(r.policy.successTests[0].requiredIds[0]),r=>r.policy.successTests[0].requiredIds[0].id='bad\nvalue',r=>r.policy.inputs.push({path:'/private'}),r=>r.policy.successTests[0].requiredIds[0].kind='url']){const r=fixture();mutate(r);r.policyDigest=publicPolicyDigest(r.policy);assert.throws(()=>validatePublicRequirements(r));}});
test('canonical policy hash matches project-organizations sorted-key encoding including Unicode',async()=>{const {digest}=await import('../../../services/project-organizations/src/common.mjs');const r=fixture();r.policy.successTests[0].mainKpi='A < B & café — unicode';assert.equal(publicPolicyDigest(r.policy),digest(r.policy));});
test('unsafe file permissions and symlink source are refused',async t=>{const {path}=await load(t);await chmod(path,0o666);await assert.rejects(createCentralTaskRequirements({path,pins:{chainId:'fixture',epoch:H}}));await chmod(path,0o600);const link=path+'.link';await symlink(path,link);await assert.rejects(createCentralTaskRequirements({path:link}));});
test('configured missing, oversized and malformed files never silently become a valid contract',async t=>{const{path}=await load(t);await writeFile(path,'{');await assert.rejects(createCentralTaskRequirements({path,pins:{chainId:'fixture',epoch:H}}));await writeFile(path,'x'.repeat(1024*1024+1));await assert.rejects(createCentralTaskRequirements({path,pins:{chainId:'fixture',epoch:H}}));await assert.rejects(createCentralTaskRequirements({path:path+'.missing'}));});

test('group-writable ancestor directories are refused even with a safe file',async t=>{const {path}=await load(t);const dir=(await import('node:path')).dirname(path);await chmod(dir,0o770);await assert.rejects(createCentralTaskRequirements({path,pins:{chainId:'fixture',epoch:H}}));await chmod(dir,0o700);});

test('foreign network publication is refused',async t=>{const {path}=await load(t);await assert.rejects(createCentralTaskRequirements({path,pins:{chainId:'other',epoch:H}}));});

test('canonical required identifiers match the pinned survey verifier normalizer',async()=>{
 const {normalizeId}=await import('../../../services/project-organizations/verifiers/prior-art-survey.mjs');
 for(const [kind,id] of [['doi','10.1000/example'],['arxiv','2401.01234'],['github','fixture/repo'],['pubmed','12345'],['nct','NCT00000001'],['wikidata','Q42']]){
  assert.equal(normalizeId(kind,id),id);const r=fixture();r.policy.successTests[0].requiredIds=[{kind,id}];r.policyDigest=publicPolicyDigest(r.policy);assert.doesNotThrow(()=>validatePublicRequirements(r));
 }
 for(const [kind,id] of [['doi','not-a-doi'],['arxiv','2401.01234v2'],['github','Fixture/Repo'],['nct','nct00000001'],['wikidata','Q0']]){
  const r=fixture();r.policy.successTests[0].requiredIds=[{kind,id}];r.policyDigest=publicPolicyDigest(r.policy);assert.throws(()=>validatePublicRequirements(r));
 }
 const r=fixture();r.policy.successTests[0].minIncluded=61;r.policyDigest=publicPolicyDigest(r.policy);assert.throws(()=>validatePublicRequirements(r));
});

test('offline exporter validates reviewed digest, emits only public schema and never overwrites',async t=>{
 const {spawnSync}=await import('node:child_process');const{realpath,readFile}=await import('node:fs/promises');
 const dir=await mkdtemp(join(homedir(),'.baink-requirements-export-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const r=fixture(),taskFile=join(dir,'task.json'),policyFile=join(dir,'policy.json'),out=join(dir,'output.json');await writeFile(taskFile,JSON.stringify(task));await writeFile(policyFile,JSON.stringify(r.policy));
 const script=new URL('../ops/export-task-requirements.mjs',import.meta.url);
 const run=pin=>spawnSync(process.execPath,[script.pathname,out,taskFile,policyFile,pin,'fixture',H],{encoding:'utf8'});
 assert.notEqual(run(E).status,0);assert.equal(run(r.policyDigest).status,0);assert.notEqual(run(r.policyDigest).status,0);
 const service=await createCentralTaskRequirements({path:await realpath(out),pins:{chainId:'fixture',epoch:H}});assert.equal(service.forTask(task).available,true);
 assert.deepEqual(Object.keys(JSON.parse(await readFile(out,'utf8'))),['schema','chainId','genesisSha256','tasks']);
});
