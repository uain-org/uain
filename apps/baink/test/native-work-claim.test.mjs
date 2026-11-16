import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeWorkClaim } from '../server/native-work-claim.mjs';
import { nativeWorkCurrentFixture } from './fixtures/native-work-current-fixture.mjs';
const WHEN = Date.parse('2026-11-01T00:00:01Z');
function fixture(options = {}) {
  const f = nativeWorkCurrentFixture(options.headerTime ? {headerTime:options.headerTime} : {});
  const markerKey = `legacy_answer_claim/${f.query.workId}`;
  const claimId = 'CL-native-00000000000000000042';
  const revision = {id:'native:00000000000000000042',base:'',state:'believed',action:'create',statement:'Sourced claim, not independently scientifically verified.',sources:[f.query.workId],author:f.query.authorInstanceId,member:f.actor.address,reviews:[]};
  f.state.records[markerKey] = {contribution:f.query.workId,claim:claimId,revision:revision.id,check_refs:[]};
  f.state.records[`legacy_claim/${claimId}`] = {id:claimId,project:f.query.projectId,revisions:[revision]};
  f.state.records[`legacy/claim/${claimId}`] = null;
  const calls = []; let clock = WHEN;
  const native = {configured:true,pins:f.pins,timeoutMs:options.timeoutMs ?? 8000,publicState:async (selection,opts) => {calls.push({selection,opts}); return structuredClone(f.context);}};
  const makeReader = () => createNativeWorkClaim({native,now:()=>clock,timeoutMs:options.timeoutMs ?? 8000});
  return {...f,markerKey,claimId,revision,calls,native,makeReader,setTime:v=>clock=v};
}
const get = f => f.makeReader().get(f.actor,f.query);
function unavailable(out) {
 assert.equal(out.status,'unavailable');
 for(const key of ['association','claim','proof']) assert.equal(out[key],null);
 assert.equal(out.complete,false);
 assert.equal(out.aiDollarPayment,'not-established-by-this-record');
 assert.equal(out.trust,'not-evaluated');
}
test('two bounded proofs bind holder and native-colon revision; project only reviewed fields',async()=>{
 const f=fixture(),out=await get(f);
 assert.equal(out.status,'available'); assert.equal(out.scope,'native-selected-work-claim');
 assert.equal(out.association,'present'); assert.deepEqual(out.binding,f.query);
 assert.equal(out.claim.associatedRevision.id,f.revision.id);
 assert.equal(out.claim.believedRevision.id,f.revision.id);
 assert.equal(f.calls.length,2); assert.equal(f.calls[0].selection.keys.length,15);assert.equal(f.calls[1].selection.keys.length,17);
 assert.equal(out.claim.sourceKey,`legacy_claim/${f.claimId}`);
 assert.equal(Object.hasOwn(out.claim.associatedRevision,'reviews'),false);
 assert.equal(JSON.stringify(out).includes('never-return'),false);
 assert.ok(f.calls[1].opts.timeoutMs<=f.calls[0].opts.timeoutMs);
});
test('absence is available only after full ownership proof; foreign ownership never becomes empty history',async()=>{
 const f=fixture(); f.state.records[f.markerKey]=null;
 const out=await get(f);assert.equal(out.status,'available');assert.equal(out.association,'absent');assert.equal(out.claim,null);assert.ok(out.proof);assert.equal(f.calls.length,1);
 f.state.records[`legacy/task/${f.query.taskId}`].contributions=[];unavailable(await get(f));
});
test('frozen fallback only with proved absence; superseded association and current retraction remain separate',async()=>{
 const f=fixture(),r=f.state.records,claim=r[`legacy_claim/${f.claimId}`];
 claim.revisions[0].state='superseded';claim.revisions.push({...f.revision,id:'native:00000000000000000043',base:f.revision.id,state:'believed',action:'retract',sources:['RC-999']});
 r[`legacy/claim/${f.claimId}`]=claim;r[`legacy_claim/${f.claimId}`]=null;
 const out=await get(f);assert.equal(out.status,'available');assert.equal(out.claim.associatedRevision.state,'superseded');assert.equal(out.claim.believedRevision.action,'retract');assert.equal(out.claim.sourceKey,`legacy/claim/${f.claimId}`);
 r[`legacy_claim/${f.claimId}`]={};unavailable(await get(f));
});
test('omission/malformed claims, path IDs, duplicate revisions, missing references and ambiguous beliefs fail closed',async()=>{
 const changes=[
 f=>delete f.state.records[f.markerKey],
 f=>{f.state.records[f.markerKey].claim='../escape';},
 f=>{f.state.records[f.markerKey].contribution='RC-foreign';},
 f=>{f.state.records[f.markerKey].revision='missing';},
 f=>delete f.state.records[`legacy/claim/${f.claimId}`],
 f=>{f.state.records[`legacy_claim/${f.claimId}`].project='foreign';},
 f=>{f.state.records[`legacy_claim/${f.claimId}`].revisions.push({...f.revision});},
 f=>{f.state.records[`legacy_claim/${f.claimId}`].revisions.push({...f.revision,id:'native:43'});},
 f=>{f.revision.sources=['../private'];},
 f=>{f.revision.action='pay';},
 f=>{f.revision.state='paid';},
 f=>{f.revision.statement='x'.repeat(4001);},
 f=>{f.revision.reviews=Array(33).fill({});},
 f=>{f.revision.sources=[];},
 f=>{f.state.records[`instance/${f.query.authorInstanceId}`].member='uain1'+'d'.repeat(40);},
 f=>{f.proof.epoch='d'.repeat(64);},
 f=>{f.proof.headerTime='2020-01-01T00:00:00Z';}
 ];
 for(const change of changes){const f=fixture();change(f);unavailable(await get(f));}
});
test('phase-two values only; changing association, owner, pins or proof selection cannot mix snapshots',async()=>{
 for(const change of [
 f=>{f.state.records[f.markerKey].revision='native:43';},
 f=>{f.state.records[f.markerKey]=null;},
 f=>{f.state.records[`legacy/task/${f.query.taskId}`].contributions=[];},
 f=>{f.native.pins={...f.pins,epoch:'e'.repeat(64)};},
 f=>{delete f.state.records[`legacy_claim/${f.claimId}`];}
 ]){
  const f=fixture();f.native.publicState=async(selection,opts)=>{f.calls.push({selection,opts});const out=structuredClone(f.context);if(f.calls.length===1)change(f);return out;};unavailable(await get(f));
 }
 const f=fixture();f.native.publicState=async(selection,opts)=>{f.calls.push({selection,opts});if(f.calls.length===2){f.revision.statement='Only final proof statement';f.state.height='1025788';f.proof.height='1025788';}return structuredClone(f.context);};
 const out=await get(f);assert.equal(out.claim.associatedRevision.statement,'Only final proof statement');assert.equal(out.proof.height,'1025788');
});
test('no believed revision is distinct from absent association, with bounded valid draft revision',async()=>{const f=fixture();f.revision.state='draft';const out=await get(f);assert.equal(out.status,'available');assert.equal(out.claim.believedRevision,null);assert.equal(out.association,'present');});
test('strict actor/query fails before any proof; no config returns unavailable without calls',async()=>{
 const f=fixture(),reader=f.makeReader();for(const query of [{...f.query,address:f.actor.address},{...f.query,workId:'../x'},{}])await assert.rejects(reader.get(f.actor,query),e=>e.status===400);
 await assert.rejects(reader.get({...f.actor,publicKey:'x'},f.query),e=>e.status===400);assert.equal(f.calls.length,0);f.native.configured=false;unavailable(await get(f));assert.equal(f.calls.length,0);
});
test('cache isolates returned objects, expires exactly with proof, and holds no stale positive on pin change',async()=>{
 const f=fixture(),reader=f.makeReader();f.proof.maxAgeSeconds=3;let out=await reader.get(f.actor,f.query);out.claim.associatedRevision.sources.push('poison');out=await reader.get(f.actor,f.query);assert.deepEqual(out.claim.associatedRevision.sources,[f.query.workId]);assert.equal(f.calls.length,2);
 f.setTime(WHEN+2000);unavailable(await reader.get(f.actor,f.query));assert.equal(f.calls.length,3);
});
test('coalesced actual-job slot remains held after ignored total deadline, then releases',async()=>{
 const f=fixture({timeoutMs:15});let resolve;f.native.publicState=()=>new Promise(r=>resolve=r);const reader=f.makeReader();
 const a=reader.get(f.actor,f.query),b=reader.get(f.actor,f.query);await Promise.all([a,b]).then(xs=>xs.forEach(unavailable));
 await assert.rejects(reader.get(f.actor,{...f.query,workId:'RC-999'}),e=>e.status===503&&e.code==='claim_read_busy');
 resolve(structuredClone(f.context));await new Promise(r=>setTimeout(r,0));f.native.publicState=async()=>structuredClone(f.context);const out=await reader.get(f.actor,{...f.query,workId:'RC-999'});unavailable(out);
});
test('phase two shares total deadline and cannot continue using a fresh per-call timeout',async()=>{
 const f=fixture({timeoutMs:35});f.native.publicState=async(selection,opts)=>{f.calls.push({selection,opts});await new Promise(r=>setTimeout(r,22));return structuredClone(f.context);};
 unavailable(await get(f));assert.equal(f.calls.length,2);assert.ok(f.calls[1].opts.timeoutMs<25);await new Promise(r=>setTimeout(r,25));
});
test('six cold reads per holder per minute; unavailable2s caching and minute reset',async()=>{
 const f=fixture(),reader=f.makeReader();f.native.publicState=async()=>{f.calls.push({});throw Error('unavailable');};
 unavailable(await reader.get(f.actor,f.query));unavailable(await reader.get(f.actor,f.query));assert.equal(f.calls.length,1);
 for(let i=1;i<6;i++){f.setTime(WHEN+i*2001);unavailable(await reader.get(f.actor,f.query));}
 f.setTime(WHEN+12006);await assert.rejects(reader.get(f.actor,f.query),e=>e.status===429&&e.code==='claim_read_rate_limited');
 f.setTime(WHEN+60001);unavailable(await reader.get(f.actor,f.query));assert.equal(f.calls.length,7);
});

test('bounded32 cache and128 actor buckets do not evict unexpired admission records',async()=>{
 const {createHash}=await import('node:crypto');const f=fixture(),reader=f.makeReader(),actors=[];
 for(let i=0;i<128;i++){
  const actor=nativeWorkCurrentFixture({publicKey:createHash('sha256').update('claim-synthetic-'+i).digest('base64')}).actor;actors.push(actor);unavailable(await reader.get(actor,f.query));
 }
 assert.equal(f.calls.length,128);
 unavailable(await reader.get(actors[127],f.query));assert.equal(f.calls.length,128);
 unavailable(await reader.get(actors[0],f.query));assert.equal(f.calls.length,129);
 const next=nativeWorkCurrentFixture({publicKey:createHash('sha256').update('claim-new-holder').digest('base64')}).actor;
 await assert.rejects(reader.get(next,f.query),e=>e.status===503&&e.code==='claim_read_busy');
 f.setTime(WHEN+60001);unavailable(await reader.get(next,f.query));assert.equal(f.calls.length,130);
});
test('successful coalesced calls share two proofs and20second cache, pending callers receive independent copies',async()=>{
 const f=fixture(),reader=f.makeReader();const [a,b]=await Promise.all([reader.get(f.actor,f.query),reader.get(f.actor,f.query)]);assert.equal(f.calls.length,2);a.claim.associatedRevision.sources.push('mutated');assert.deepEqual(b.claim.associatedRevision.sources,[f.query.workId]);
 f.setTime(WHEN+19999);assert.equal((await reader.get(f.actor,f.query)).status,'available');assert.equal(f.calls.length,2);
 f.setTime(WHEN+20001);assert.equal((await reader.get(f.actor,f.query)).status,'available');assert.equal(f.calls.length,4);
});
test('missing base, revision cycles and excessive counts are unavailable rather than truncated history',async()=>{
 for(const change of [f=>f.revision.base='missing',f=>f.revision.base=f.revision.id,f=>{f.revision.base='native:43';f.state.records[`legacy_claim/${f.claimId}`].revisions.push({...f.revision,id:'native:43',base:f.revision.id,state:'draft'});},f=>f.state.records[`legacy_claim/${f.claimId}`].revisions=Array(129).fill(f.revision),f=>f.revision.sources=Array.from({length:33},(_,i)=>'RC-'+i)]){const f=fixture();change(f);unavailable(await get(f));}
});
test('claim status waits across consumers while preserving the shared adapter two-process cap', async (t) => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const { createNativeAssetAdapter } =
    await import('../server/native-asset.mjs');
  const sha = (value) => createHash('sha256').update(value).digest('hex'),
    dir = await mkdtemp(join(tmpdir(), 'baink-claim-pool-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = fixture({ headerTime: new Date().toISOString() }),
    genesis = JSON.stringify({ chain_id: f.pins.chainId }),
    genesisPath = join(dir, 'genesis.json'),
    binary = join(dir, 'reader'),
    trace = join(dir, 'trace');
  // Isolated synthetic executable qualifies pin/selection/pool plumbing only;
  // it is not a consensus verifier and never contacts the RPC or writes state.
  const script = `#!${process.execPath}\nconst fs=require('fs');let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',()=>{const q=JSON.parse(raw);fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({event:'start',pid:process.pid})+'\\n');setTimeout(()=>{const s=${JSON.stringify(f.state)};const records=s.records;s.records=Object.fromEntries(['legacy_import',...(q.keys||[])].map(k=>[k,Object.hasOwn(records,k)?records[k]:null]));fs.writeFileSync(process.argv[process.argv.indexOf('--out')+1],JSON.stringify(s),{mode:384,flag:'wx'});fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({event:'end',pid:process.pid})+'\\n');},100);});\n`;
  await writeFile(binary, script, { mode: 0o700 });
  await writeFile(genesisPath, genesis);
  const native = createNativeAssetAdapter({
    config: {
      binary,
      binaryHash: sha(script),
      genesis: genesisPath,
      genesisHash: sha(genesis),
      rpc: 'http://127.0.0.1:1',
      chainId: f.pins.chainId,
      timeoutMs: 2000,
      maxAgeSeconds: 120,
    },
  });
  const a = native.publicState({ member: f.actor.address, keys: f.keys }),
    b = native.publicState({ member: f.actor.address, keys: f.keys });
  const queued = await createNativeWorkClaim({ native }).get(f.actor, f.query);
  assert.equal(queued.status, 'available', 'A short shared-pool wait does not turn a valid native result unavailable');
  await Promise.all([a, b]);
  const traceState = async () => {
    const entries = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
    let active = 0, maximum = 0;
    for (const entry of entries) { active += entry.event === 'start' ? 1 : -1; maximum = Math.max(maximum, active); assert.ok(active >= 0 && active <= 2); }
    assert.equal(active, 0); assert.equal(maximum, 2);
    return entries.filter(entry => entry.event === 'start').length;
  };
  assert.equal(await traceState(), 4);
  const out = await createNativeWorkClaim({ native }).get(f.actor, f.query);
  assert.equal(out.status, 'available');
  assert.equal(await traceState(), 6);
});
test('literal source text x0 is allowed while actual control bytes are refused',async()=>{
 const f=fixture();f.revision.statement='A source value x0 is plain text.';assert.equal((await get(f)).status,'available');
 f.revision.statement='A source\u0000hidden';unavailable(await get(f));
});
test('legacy assert and empty unrelated draft sources are preserved without claiming validity',async()=>{
 const f=fixture();f.state.records[`legacy_claim/${f.claimId}`].revisions.unshift({...f.revision,id:'old-assert',state:'rejected',action:'assert',sources:[]});
 assert.equal((await get(f)).status,'available');
});
test('unprojected historical Go zero values do not hide valid associated and believed revisions', async (t) => {
  // cb0402fe legacy_research_test.go:79 omits statement; legacyClaim's Go
  // decoding/writes preserve empty strings and nil slices in older revisions.
  for (const [name, patch] of [
    ['missing statement', (old) => { delete old.statement; }],
    ['empty statement', (old) => { old.statement = ''; }],
    ['null statement', (old) => { old.statement = null; }],
    ['nil sources', (old) => { old.sources = null; }],
    ['omitted sources', (old) => { delete old.sources; }],
    ['missing statement and nil sources', (old) => { delete old.statement; old.sources = null; }],
  ]) await t.test(name, async () => {
    const f = fixture();
    const old = { id: '73', base: '', state: 'superseded', action: 'assert', statement: 'Historical body must not be emitted', sources: [], reviews: [] };
    patch(old);
    f.revision.base = old.id;
    f.revision.action = 'edit';
    f.state.records[`legacy_claim/${f.claimId}`].revisions.unshift(old);
    const out = await get(f);
    assert.equal(out.status, 'available');
    assert.equal(out.claim.associatedRevision.id, f.revision.id);
    assert.equal(out.claim.associatedRevision.statement, f.revision.statement);
    assert.deepEqual(out.claim.associatedRevision.sources, [f.query.workId]);
    assert.deepEqual(out.claim.believedRevision, out.claim.associatedRevision);
    assert.equal(Object.hasOwn(out.claim, 'revisions'), false);
    assert.equal(JSON.stringify(out).includes('Historical body must not be emitted'), false);
  });
});
test('historical zero-value compatibility never admits malformed or oversized unprojected bodies', async () => {
  for (const patch of [
    (old) => { old.statement = 123; },
    (old) => { old.statement = 'x'.repeat(4001); },
    (old) => { old.statement = 'hidden\u0000text'; },
    (old) => { old.sources = 'RC-999'; },
    (old) => { old.sources = Array.from({ length: 33 }, (_, i) => 'RC-' + i); },
    (old) => { old.sources = ['../private']; },
    (old) => { old.sources = ['RC-999', 'RC-999']; },
    (old) => { old.reviews = Array(33).fill({}); },
  ]) {
    const f = fixture();
    const old = { id: '73', base: '', state: 'superseded', action: 'assert', statement: '', sources: [], reviews: [] };
    patch(old);
    f.state.records[`legacy_claim/${f.claimId}`].revisions.unshift(old);
    unavailable(await get(f));
  }
});
test('associated and current believed projections still reject missing empty or nil bodies', async () => {
  for (const selected of ['associated', 'believed']) for (const patch of [
    (revision) => { delete revision.statement; },
    (revision) => { revision.statement = null; },
    (revision) => { revision.statement = ''; },
    (revision) => { revision.sources = null; },
    (revision) => { delete revision.sources; },
  ]) {
    const f = fixture();
    f.revision.state = 'superseded';
    const current = { ...f.revision, id: 'native:00000000000000000043', base: f.revision.id, state: 'believed', sources: ['RC-999'] };
    f.state.records[`legacy_claim/${f.claimId}`].revisions.push(current);
    patch(selected === 'associated' ? f.revision : current);
    unavailable(await get(f));
  }
});
