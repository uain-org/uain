import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemberDirectory } from '../server/members.mjs';

const address = 'uain1' + 'a'.repeat(40);
const other = 'uain1' + 'b'.repeat(40);
const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers:{'content-type':'application/json'}});
const participant = (extra={}) => ({id:'instance-one',address,name:'Public instance',member:{address,name:'Public member',licence:{status:'active'}},capabilities:['research'],...extra});
const directory = () => ({participants:[participant({private_key:'SECRET',credits:'999'})],count:1,page:1,page_size:2,pages:1,authority:'native',state_height:'123',app_hash:'c'.repeat(64)});

test('rejects non-HTTPS, credentialed, non-origin and unallowlisted source configuration', () => {
  for(const origin of ['http://uain.global','https://uain.global@evil.test','https://evil.test','https://uain.global/api','https://uain.global?x=1'])
    assert.throws(()=>createMemberDirectory({origin}), /origin|HTTPS|allowlist/i);
});

test('public directory preserves raw member/instance IDs and source claims without private data or trust inflation', async()=>{
  const service=createMemberDirectory({fetchImpl:async()=>json(directory())});
  const out=await service.list({page:1,pageSize:2});
  assert.equal(out.members[0].address,address);
  assert.equal(out.members[0].instanceId,'instance-one');
  assert.equal(out.members[0].licence.status,'active');
  assert.equal(out.members[0].trusted,false);
  assert.equal(out.source.independentlyVerified,false);
  assert.equal(out.source.authorityClaim,'native');
  assert.equal(out.source.kind,'public-http-projection');
  assert.equal(JSON.stringify(out).includes('SECRET'),false);
  assert.equal(Object.hasOwn(out.members[0],'credits'),false);
});

test('query bounds and unknown query parameters fail before any source request', async()=>{
  let calls=0;
  const service=createMemberDirectory({fetchImpl:async()=>{calls++;return json(directory());}});
  for(const query of [{page:0},{page:1001},{pageSize:101},{pageSize:0},{search:'x'.repeat(121)},{url:'https://evil.test'}])
    await assert.rejects(service.list(query),e=>e.status===400);
  await assert.rejects(service.get('uain1bad'),e=>e.status===400);
  assert.equal(calls,0);
});

test('never follows source redirects or accepts malformed or oversized JSON', async()=>{
  for(const response of [new Response('',{status:302,headers:{location:'https://evil.test'}}),new Response('{bad',{headers:{'content-type':'application/json'}}),json({participants:'bad'})]){
    const service=createMemberDirectory({fetchImpl:async(_url,options)=>{assert.equal(options.redirect,'error');return response;}});
    await assert.rejects(service.list(),e=>e.status===503);
  }
  const service=createMemberDirectory({maxBytes:1024,fetchImpl:async()=>json({...directory(),padding:'x'.repeat(2048)})});
  await assert.rejects(service.list(),e=>e.status===503);
});

test('streaming response overflow is stopped even without Content-Length',async()=>{
  const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(1025));c.close();}});
  const service=createMemberDirectory({maxBytes:1024,fetchImpl:async()=>new Response(stream,{headers:{'content-type':'application/json'}})});
  await assert.rejects(service.list(),e=>e.code==='member_source_unavailable');
});

test('a stalled source request times out with a bounded unavailable result',async()=>{
  const service=createMemberDirectory({timeoutMs:20,fetchImpl:async()=>new Promise(()=>{})});
  const start=Date.now();
  await assert.rejects(service.list(),e=>e.status===503);
  assert.ok(Date.now()-start<1000);
});

test('cache coalesces equal reads, isolates callers, expires and never serves stale data after failure',async()=>{
  let now=0,calls=0,fail=false;
  const service=createMemberDirectory({now:()=>now,cacheTtlMs:10,fetchImpl:async()=>{calls++;if(fail)throw Error('offline');return json(directory());}});
  const [a,b]=await Promise.all([service.list({pageSize:2}),service.list({pageSize:2})]);
  assert.equal(calls,1);a.members[0].name='edited';assert.equal(b.members[0].name,'Public instance');
  now=11;fail=true;await assert.rejects(service.list({pageSize:2}),e=>e.status===503);assert.equal(calls,2);
});

test('concurrency overload fails without launching more requests',async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const service=createMemberDirectory({maxConcurrent:1,fetchImpl:async()=>{await gate;return json(directory());}});
  const first=service.list({page:1,pageSize:2});
  await assert.rejects(service.list({page:2,pageSize:2}),e=>e.status===503&&e.code==='member_source_busy');
  release();await first;
});

test('member lookup labels unsupported native track record and preserves actual held work without calling it an achievement',async()=>{
  const service=createMemberDirectory({fetchImpl:async url=>{
    const path=new URL(url).pathname;
    if(path.endsWith('/track-record'))return json({error:'native_route_required'},409);
    if(path.startsWith('/api/members/'))return json({id:address,address,name:'Public member',agents:[participant()],licence:{status:'active'},authority:'native'});
    return json(participant({work:{contributed:[{id:'RC-held',contributor:'instance-one',member_id:address,title:'Forecast',state:'held',settled_at:null,credits_awarded:'12',private_key:'SECRET'}],verified:[]}}));
  }});
  const out=await service.get(address);
  assert.equal(out.member.address,address);
  assert.equal(out.trackRecord.status,'unavailable');
  assert.equal(out.trackRecord.reason,'native_route_required');
  assert.equal(out.work.contributed[0].state,'held');
  assert.equal(out.work.contributed[0].achieved,false);
  assert.equal(out.work.complete,false);
  assert.equal(JSON.stringify(out).includes('SECRET'),false);
  assert.equal(Object.hasOwn(out.work.contributed[0],'credits_awarded'),false);
});

test('member/address mismatches and forged instance ownership are rejected instead of merging another account',async()=>{
  const service=createMemberDirectory({fetchImpl:async()=>json({address:other,id:other,agents:[],name:'Wrong member'})});
  await assert.rejects(service.get(address),e=>e.status===503);
  const forged=createMemberDirectory({fetchImpl:async url=>new URL(url).pathname.endsWith('/track-record')?json({error:'native_route_required'},409):json({address,id:address,agents:[participant({address:other,member:{address:other}})]})});
  await assert.rejects(forged.get(address),e=>e.status===503);
});

test('source member not found is explicit and makes no private-account fallback',async()=>{
  const service=createMemberDirectory({fetchImpl:async()=>json({error:'not_found'},404)});
  await assert.rejects(service.get(address),e=>e.status===404&&e.code==='member_missing');
});

test('bounded work detail failures retain member identity with unavailable work rather than fabricated empty success',async()=>{
  const service=createMemberDirectory({fetchImpl:async url=>{
    const path=new URL(url).pathname;
    if(path.endsWith('/track-record'))return json({error:'native_route_required'},409);
    if(path.startsWith('/api/members/'))return json({address,id:address,agents:[participant()]});
    throw Error('detail unavailable');
  }});
  const out=await service.get(address);
  assert.equal(out.member.address,address);assert.equal(out.work.status,'unavailable');assert.equal(out.work.contributed,null);
});

test('track records cannot attribute a foreign instance to the requested member',async()=>{
  const service=createMemberDirectory({fetchImpl:async url=>{
    const path=new URL(url).pathname;
    if(path.endsWith('/track-record'))return json({subject:{address},contributions:[{id:'RC-other',agent:'someone-else',state:'settled'}]});
    if(path.startsWith('/api/members/'))return json({address,id:address,agents:[participant()]});
    return json(participant({work:{contributed:[],verified:[]}}));
  }});
  const out=await service.get(address);
  assert.equal(out.trackRecord.status,'unavailable');
  assert.equal(out.trackRecord.contributions,null);
});
