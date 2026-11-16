import {test} from 'node:test';
import assert from 'node:assert/strict';
const mod=await import('../dist/src/native/public-read.js');

// project() proves one participation record for every member that joined a project. Each used to
// be a proof read of its own (55 single-key proofs in every view of 69 projects, 10 November 2026).
// The census warm-up now plans them in its shared batches; every record is still checked.
function fixture(){
 const joins=[{project:'P1',member:'M1',instance:'I1'},{project:'P1',member:'M2',instance:null},{project:'P2',member:'M1',instance:'I1'},{project:'hidden',member:'M3',instance:null}];
 const records={
  'project/P1':{id:'P1',title:'First',lead:'L1',state:'open'},'project/P2':{id:'P2',title:'Second',lead:'L2',state:'open'},'project/hidden':{id:'hidden',title:'Hidden',lead:'L3',state:'open'},
  'participation/P1/M1/I1':{project:'P1',member:'M1',instance:'I1'},'participation/P1/M2/':{project:'P1',member:'M2'},'participation/P2/M1/I1':{project:'P2',member:'M1',instance:'I1'},'participation/hidden/M3/':{project:'hidden',member:'M3'},
 };
 const calls=[],sql=[];
 const query=async(text,args)=>{sql.push(text);
  if(text.includes("'project_join'"))return{rows:text.includes('AS project')?joins:joins.filter(j=>j.project===args[1]).map(({member,instance})=>({member,instance}))};
  if(text.includes('AS id')&&args[1].includes('open_project'))return{rows:[{id:'P1'},{id:'P2'},{id:'hidden'}]};
  return{rows:[]}};
 const make=()=>mod.createNativePublicReader({epoch:'e',visibility:{isProjectVisible:id=>id!=='hidden'},query,read:async s=>{calls.push([...s.keys]);return{chain_id:'c',height:'42',event_count:'0',records:Object.fromEntries(s.keys.map(k=>[k,structuredClone(records[k]??null)]))}}});
 return{joins,records,calls,sql,make};
}
const participation=calls=>calls.flat().filter(k=>k.startsWith('participation/'));

test('a census plans every participation record in its shared batches, not one proof each',async()=>{
 const f=fixture(),reader=f.make();
 await reader.warm(['project','participant','member']);
 const warmed=f.calls.length,planned=f.calls.filter(keys=>keys.some(k=>k.startsWith('participation/')));
 assert.equal(planned.length,1,'one batch carries the participation records');
 assert.deepEqual(participation(planned).sort(),['participation/P1/M1/I1','participation/P1/M2/','participation/P2/M1/I1']);
 assert(planned[0].length>3,'they share a batch with the rest of the census');assert(f.calls.every(keys=>keys.length<=32));
 assert(!f.calls.flat().includes('participation/hidden/M3/'),'nothing is proved for a project that is not public');
 const first=await reader.project('P1'),second=await reader.project('P2');
 assert.deepEqual(first.members.recent.map(m=>m.member).sort(),['I1','L1','M2']);assert.equal(first.member_count,3);
 assert.deepEqual(second.members.recent.map(m=>m.member).sort(),['I1','L2']);
 assert.deepEqual(participation(f.calls.slice(warmed)),[],'building the project pages proves no participation record again');
 assert.equal(await reader.project('hidden'),null);
});

test('a planned participation record is still checked against its join event',async()=>{
 for(const tamper of[r=>{r['participation/P1/M2/']={project:'P1',member:'someone-else'}},r=>{r['participation/P1/M2/']=null},r=>{r['participation/P1/M1/I1']={project:'P2',member:'M1',instance:'I1'}}]){
  const f=fixture();tamper(f.records);const reader=f.make();
  await reader.warm(['project','participant','member']);
  await assert.rejects(()=>reader.project('P1'),/native project participation proof differs/);
  assert.equal((await reader.project('P2')).member_count,2,'another project is not affected');
 }
});

test('a project read without a census, or a join the census did not plan, is proved on demand as before',async()=>{
 const f=fixture(),reader=f.make();
 const first=await reader.project('P1');
 assert.equal(first.member_count,3);assert.deepEqual(participation(f.calls).sort(),['participation/P1/M1/I1','participation/P1/M2/']);
 // A join event with an identifier the reader refuses is not planned, and the project read refuses it as before.
 const g=fixture();g.joins.push({project:'P2',member:'not a valid id',instance:null});const strict=g.make();
 await strict.warm(['project','participant','member']);
 assert(!g.calls.flat().some(k=>k.includes('not a valid id')));
 await assert.rejects(()=>strict.project('P2'),/native project participant identity differs/);
 assert.equal((await strict.project('P1')).member_count,3);
});

test('a reader plans a census once, and a failed census is planned again',async()=>{
 const f=fixture(),reader=f.make();
 await reader.warm(['project','participant','member']);const reads=f.calls.length,queries=f.sql.length;
 await reader.warm(['project','participant','member']);await reader.warm(['member']);
 assert.equal(f.calls.length,reads,'a census already planned proves nothing');assert.equal(f.sql.length,queries,'and asks the database nothing');
 await reader.warm(['project','task']);assert(f.sql.length>queries,'a kind not planned yet is still planned');
 assert.equal(f.sql.filter(text=>text.includes('AS project')).length,1,'the join events are listed once for each reader');
 // A census that failed is not remembered as done: the next one plans it in full.
 const g=fixture(),answer=g.make().query;let fail=true;
 const flaky=mod.createNativePublicReader({epoch:'e',query:async(text,args)=>{if(fail&&text.includes('AS project'))throw Error('database busy');return answer(text,args)},read:async s=>{g.calls.push([...s.keys]);return{chain_id:'c',height:'42',event_count:'0',records:Object.fromEntries(s.keys.map(k=>[k,structuredClone(g.records[k]??null)]))}}});
 await assert.rejects(()=>flaky.warm(['project']),/database busy/);fail=false;
 await flaky.warm(['project']);assert(participation(g.calls).includes('participation/P1/M1/I1'));
});
