import assert from 'node:assert/strict';
import test from 'node:test';
import {Readable} from 'node:stream';
import {validateFrame} from '../../../ops/chain/native-rpc-transport.mjs';
import {createNativeRpcPublicHandler} from '../dist/src/api/native-rpc-public-routes.js';
const env={UAIN_AUTHORITY:'native',UAIN_NATIVE_CHAIN_ID:'uain-shadow-20261008-1',UAIN_NATIVE_RPC:'http://127.0.0.1:26667'};
const frame={jsonrpc:'2.0',id:1,method:'commit',params:{}};
async function invoke(handler,body,options={}){const req=Readable.from([Buffer.from(typeof body==='string'?body:JSON.stringify(body))]);req.method='POST';req.headers={'content-type':'application/json'};Object.assign(req,options);let answer;await handler(req,{setHeader(){}},new URL('https://uain.test/api/native/rpc'),(_,status,body)=>{answer={status,body}});return answer}
test('public RPC forwards only the existing bounded native allowlist to fixed loopback',async()=>{
 let calls=0;const handler=createNativeRpcPublicHandler({env,validate:validateFrame,transport:async(url,options)=>{calls++;assert.equal(url,'http://127.0.0.1:26667');assert.equal(JSON.parse(options.body).method,'commit');return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{signed_header:{}}}))}});
 assert.equal((await invoke(handler,frame)).status,200);
 for(const bad of [{...frame,method:'status'},{...frame,method:'unsafe_flush_mempool'},[frame],{...frame,method:'abci_query',params:{path:'/store/federation/key',data:'61',height:'1',prove:false}},{...frame,params:{height:'1',extra:true}}])assert.equal((await invoke(handler,bad)).status,400);
 assert.equal(calls,1);
 assert.equal((await invoke(handler,'x'.repeat(96*1024+1))).status,413);
 assert.equal((await invoke(handler,frame,{method:'GET'})).status,405);
});
test('public RPC refuses non-loopback configuration, response confusion and concurrent overload',async()=>{
 let calls=0;
 const external=createNativeRpcPublicHandler({env:{...env,UAIN_NATIVE_RPC:'https://other.example'},validate:validateFrame,transport:async()=>{calls++;throw Error('not allowed')}});
 assert.equal((await invoke(external,frame)).status,503);assert.equal(calls,0);
 const confused=createNativeRpcPublicHandler({env,validate:validateFrame,transport:async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:2,result:{}}))});assert.equal((await invoke(confused,frame)).status,503);
 let finish;const blocked=new Promise(r=>{finish=r});
 const limited=createNativeRpcPublicHandler({env,validate:validateFrame,maxConcurrent:1,transport:async()=>{await blocked;return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{}}))}});
 const first=invokeAs(limited,frame,'caller-a');await new Promise(r=>setImmediate(r));assert.equal((await invokeAs(limited,frame,'caller-b')).status,503,'the pod cap still holds across callers');finish();assert.equal((await first).status,200);
});
test('a slow inbound body hits the deadline and releases its concurrency permit',async()=>{
 const h=createNativeRpcPublicHandler({env,validate:validateFrame,maxConcurrent:1,deadlineMs:20,transport:async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{}}))});
 const req=new Readable({read(){}});req.method='POST';req.headers={'content-type':'application/json'};
 let status;const alive=setTimeout(()=>{},200);
 try{await h(req,{setHeader(){}},new URL('https://uain.test/api/native/rpc'),(_,s)=>{status=s});assert.equal(status,503);assert.equal(req.destroyed,true);assert.equal((await invoke(h,frame)).status,200)}finally{clearTimeout(alive)}
});
// Audit E-6 (15 November 2026): one caller could hold both slots of a pod with slow uploads.
async function invokeAs(handler,body,caller,options={}){const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method='POST';req.headers={'content-type':'application/json'};Object.assign(req,options);let answer;const headers={};await handler(req,{setHeader(k,v){headers[k.toLowerCase()]=v}},new URL('https://uain.test/api/native/rpc'),(_,status,b)=>{answer={status,body:b}},caller);return{...answer,headers}}
test('one caller holds at most one slot; another caller still gets the second (E-6)',async()=>{
 let finish;const blocked=new Promise(r=>{finish=r});let calls=0;
 const h=createNativeRpcPublicHandler({env,validate:validateFrame,transport:async()=>{calls++;await blocked;return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{}}))}});
 const first=invokeAs(h,frame,'caller-a');await new Promise(r=>setImmediate(r));
 const second=invokeAs(h,frame,'caller-a');const other=invokeAs(h,frame,'caller-b');await new Promise(r=>setImmediate(r));
 finish();
 const [a1,a2,b]=await Promise.all([first,second,other]);
 assert.equal(a1.status,200);assert.equal(b.status,200,'another caller is served');
 assert.equal(a2.status,429);assert.equal(a2.body.error,'native_rpc_caller_busy');assert.equal(a2.headers['retry-after'],'1');
 assert.equal(calls,2,'the refused request is not sent upstream');
 assert.equal((await invokeAs(h,frame,'caller-a')).status,200,'the slot is released afterwards');
});
test('a body still arriving after the body deadline is cut long before the overall deadline (E-6)',async()=>{
 const h=createNativeRpcPublicHandler({env,validate:validateFrame,deadlineMs:10000,bodyDeadlineMs:30,transport:async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{}}))});
 const req=new Readable({read(){}});req.method='POST';req.headers={'content-type':'application/json'};req.push('{"jsonrpc":"2.0",');
 const started=Date.now();let status;const alive=setTimeout(()=>{},12000);
 try{
  await h(req,{setHeader(){}},new URL('https://uain.test/api/native/rpc'),(_,s)=>{status=s},'slow-caller');
  assert.ok(Date.now()-started<2000,`cut after ${Date.now()-started} ms`);assert.equal(status,503);assert.equal(req.destroyed,true);
  assert.equal((await invokeAs(h,frame,'slow-caller')).status,200,'its slot and its share are released');
 }finally{clearTimeout(alive)}
});
