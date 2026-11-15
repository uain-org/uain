import test from'node:test';import assert from'node:assert/strict';
import{createServer}from'node:http';
import{createUnifiedWork,UnifiedWorkError}from'../server/unified-work.mjs';
import{loadCatalogue}from'../server/catalogue.mjs';import{fixture}from'./http-fixture.mjs';
const row=(id,title,status='inactive',category='Medicine')=>({id,title,description:'Research '+title,category,domainId:'1',status,operationalStatus:'not_started',url:null,taskCount:0});
function setup({disabled=false,missingProposals=false,nativeUnavailable=false}={}){
 const rows=[row('OPP-00001','Cancer analysis'),row('OPP-00002','Long-lived systems'),row('PRB-00001','Cancer diagnosis')],index={records:rows.map(summary=>({summary,searchText:(summary.id+' '+summary.title+' '+summary.description+' '+summary.category).toLowerCase()})),domains:[{id:'1',name:'Medicine',count:3}],source:{status:missingProposals?'unavailable':'available',validatedCount:3,notice:'Source proposals only'}};
 let reads=0,managementReads=0;const states=new Map([['OPP-00001','active'],['native-2','stale']]);
 const service=createUnifiedWork({proposals:{available:!missingProposals,publicSummaryIndex:()=>missingProposals?{records:[],domains:[],source:index.source}:index},readNative:async()=>{reads++;return{projects:nativeUnavailable?[]:[row('OPP-00001','Cancer history','active'),row('native-2','A second native record','closed')],source:{status:nativeUnavailable?'unavailable':'live',url:'https://uain.example/api/projects',bounded:true,limit:100,fetchedAt:'2026-11-04T00:00:00Z',authority:'native'}};},getManagement:()=>{managementReads++;return{enabled:!disabled,states};}});
 return{service,get reads(){return reads;},get managementReads(){return managementReads;}};
}
test('one union keeps source/id identity, raw state, coordination and unverified funding separate',async()=>{
 const f=setup(),result=await f.service.list({q:'cancer',source:'all',page:1,pageSize:100});assert.equal(result.total,3);assert.equal(result.projects.length,3);assert.equal(new Set(result.projects.map(p=>p.key)).size,3);assert.deepEqual(result.items,result.projects);
 const proposal=result.projects.find(p=>p.source==='proposal'&&p.id==='OPP-00001'),native=result.projects.find(p=>p.source==='uain-project');assert.equal(proposal.status,'inactive');assert.equal(proposal.managementStatus,'active');assert.equal(native.status,'active');assert.equal(native.managementStatus,'unmanaged','A colliding native ID must not inherit proposal management');
 for(const p of result.projects){assert.equal(p.funded,false);assert.deepEqual(p.funding,{status:'unverified',verified:false,payable:false});}assert.equal(result.coverage.complete,false);assert.equal(result.coverage.totalMeaning,'filtered-known-source-records');assert.equal(result.sources.find(s=>s.kind==='uain-project').limit,100);assert.equal(result.sources.find(s=>s.kind==='uain-project').complete,false);assert.equal(f.managementReads,1);
});
test('filters run before stable union pagination without refetching full proposal entries',async()=>{
 const f=setup(),first=await f.service.list({page:1,pageSize:2}),second=await f.service.list({page:2,pageSize:2}),last=await f.service.list({page:3,pageSize:2});assert.equal(first.total,5);assert.equal(first.pages,3);assert.equal(new Set([...first.items,...second.items,...last.items].map(r=>r.key)).size,5);
 const active=await f.service.list({managementStatus:'active'});assert.deepEqual(active.items.map(p=>p.key),['proposal:OPP-00001']);const status=await f.service.list({status:'active'});assert.deepEqual(status.items.map(p=>p.source),['uain-project']);assert.equal((await f.service.list({source:'proposal',domain:'proposal:1'})).total,3);assert.equal((await f.service.list({source:'proposal',q:'no match'})).pages,0);
});
test('source-only queries avoid unused upstream reads and report exact selected coverage',async()=>{
 const f=setup(),result=await f.service.list({source:'proposal'});assert.equal(f.reads,0);assert.equal(result.coverage.complete,true);assert.equal(result.sources.find(s=>s.kind==='uain-project').availability,'not-requested');
});
test('unavailable and disabled sources cannot invent records, active management or full coverage',async()=>{
 const f=setup({missingProposals:true,nativeUnavailable:true,disabled:true}),result=await f.service.list({});assert.equal(result.total,0);assert.equal(result.available,false);assert.equal(result.coverage.complete,false);assert.ok(result.sources.every(s=>s.availability==='unavailable'));
 const disabled=await setup({disabled:true}).service.list({managementStatus:'active'});assert.equal(disabled.total,0);
});
test('unified query rejects unsupported, repeated, oversized and ambiguous filters',async()=>{
 const f=setup();for(const input of[{source:'funded'},{page:0},{pageSize:101},{page:'1.5'},{q:'x'.repeat(201)},{managementStatus:'paid'},{privateKey:'never'}])await assert.rejects(f.service.list(input),UnifiedWorkError);
 await assert.rejects(f.service.list(new URLSearchParams('q=a&q=b')),UnifiedWorkError);
});
test('real cached proposal index contains summaries only and preserves full validated export coverage',async()=>{
 const catalogue=await loadCatalogue(new URL('../catalogue/',import.meta.url).pathname),index=catalogue.publicSummaryIndex();assert.equal(index.records.length,21600);assert.equal(index,catalogue.publicSummaryIndex());assert.equal(index.domains.length,45);assert.ok(!Object.hasOwn(index.records[0].summary,'source_fields'));assert.ok(!Object.hasOwn(index.records[0],'detail'));
 const service=createUnifiedWork({proposals:catalogue,readNative:async()=>{throw Error('Unused native read');},getManagement:()=>({enabled:false,states:new Map()})});const result=await service.list({source:'proposal',q:'',page:216,pageSize:100});assert.equal(result.total,21600);assert.equal(result.items.length,100);assert.equal(result.coverage.complete,true);
});
test('public unified HTTP route validates queries and retains bounded native source coverage',async t=>{
 let calls=0;const upstream=createServer((req,res)=>{calls++;assert.equal(new URL(req.url,'http://test').searchParams.get('page_size'),'100');res.setHeader('content-type','application/json');res.end(JSON.stringify({projects:Array.from({length:101},(_,n)=>row('native-'+n,'Fictional native '+n,'active')),total:99999,authority:'native'}));});await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>upstream.close(r)));
 const f=await fixture(t,{projectsSource:'http://127.0.0.1:'+upstream.address().port+'/api/projects',catalogueDir:new URL('../catalogue/',import.meta.url).pathname});
 const response=await f.request(null,'GET','/api/work/projects?source=uain-project&pageSize=100');assert.equal(response.status,200);const result=response.body;assert.equal(result.total,100);assert.equal(result.items.length,100);assert.equal(result.coverage.complete,false);assert.equal(result.sources.find(s=>s.kind==='uain-project').coverage,'bounded-first-page');assert.equal(calls,1);
 await f.request(null,'GET','/api/work/projects?source=uain-project&q=native');assert.equal(calls,1,'Existing native catalogue cache is reused');
 for(const suffix of['q=a&q=b','source=other','page=-1','q=a&privateKey=x'])assert.equal((await f.request(null,'GET','/api/work/projects?'+suffix)).status,400);
});

test('advertised non-ASCII domain identifiers round-trip through the same bounded query',async()=>{
 const category='研究'.repeat(60),service=createUnifiedWork({proposals:{available:true,publicSummaryIndex:()=>({records:[],domains:[],source:{}})},readNative:async()=>({projects:[row('native-unicode','International research','active',category)],source:{status:'live'}})});
 const first=await service.list({source:'uain-project'});assert.equal(first.domains.length,1);assert.equal((await service.list({source:'uain-project',domain:first.domains[0].id})).total,1);
});

test('prototype-shaped query keys cannot evade unsupported-field validation',async()=>{
 const f=setup();for(const text of['__proto__=ignored','constructor=x','prototype=y','__proto__=a&__proto__=b'])await assert.rejects(f.service.list(new URLSearchParams(text)),UnifiedWorkError);
});

test('source-qualified domain selectors never bleed through another source category alias',async()=>{
 const proposal=row('P1','Proposal','inactive','uain-project:medicine'),native=row('N1','Native','active','proposal:1'),ordinary=row('N2','Ordinary native','active','Medicine');
 const service=createUnifiedWork({proposals:{available:true,publicSummaryIndex:()=>({records:[{summary:proposal,searchText:'proposal'}],domains:[{id:'1',name:proposal.category,count:1}],source:{}})},readNative:async()=>({projects:[native,ordinary],source:{status:'live'}})});
 assert.deepEqual((await service.list({domain:'proposal:1'})).items.map(r=>r.key),['proposal:P1']);assert.deepEqual((await service.list({domain:'uain-project:medicine'})).items.map(r=>r.key),['uain-project:N2']);assert.deepEqual((await service.list({domain:'uain-project:proposal:1'})).items.map(r=>r.key),['uain-project:N1']);
});
test('case-insensitive native domain selectors advertise one accurate grouped count',async()=>{
 const service=createUnifiedWork({proposals:{available:true,publicSummaryIndex:()=>({records:[],domains:[],source:{}})},readNative:async()=>({projects:[row('A','First','active','Medicine'),row('B','Second','active','medicine')],source:{status:'live'}})}),result=await service.list({source:'uain-project'});assert.equal(result.domains.length,1);assert.equal(result.domains[0].count,2);assert.equal((await service.list({domain:result.domains[0].id})).total,2);
});
