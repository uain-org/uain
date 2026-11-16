// Audit F-1 (13 November 2026): the public JSON-RPC origin (`POST /` on uain.global, rewritten to
// /api/native/rpc) forwarded a member-signed broadcast for any operation, with no allow-list and no
// per-key or overall rate, past the closed relay's policy. These tests pin the fix: a broadcast passes
// the relay's own policy (admitNativeSubmit) before anything is sent upstream, and the proved reads
// the pinned member verifier needs are unchanged.
import assert from 'node:assert/strict';
import test,{beforeEach} from 'node:test';
import {existsSync,readFileSync} from 'node:fs';
import {Readable} from 'node:stream';
import {validateFrame} from '../../../ops/chain/native-rpc-transport.mjs';
import {createNativeRpcPublicHandler} from '../dist/src/api/native-rpc-public-routes.js';
import {NATIVE_PUBLIC_RPC_OPERATIONS,admitNativeSubmit,nativeSubmitPolicy,resetNativeSubmitWindows} from '../dist/src/api/native-routes.js';

const CHAIN='uain-shadow-20261008-1';
const env={UAIN_AUTHORITY:'native',UAIN_NATIVE_CHAIN_ID:CHAIN,UAIN_NATIVE_RPC:'http://127.0.0.1:26667'};
const key=i=>('key'+String(i).padStart(5,'0')).padEnd(43,'A');
const envelope=(operation,i=0)=>({command:{version:1,chain_id:CHAIN,member:'uain1'+'0'.repeat(40),sequence:'1',expires_height:'10',operation,payload:{}},public_key:key(i),signature:'S'.repeat(86)});
let ids=0;
const broadcast=(operation,i=0)=>({jsonrpc:'2.0',id:'b'+(++ids),method:'broadcast_tx_sync',params:{tx:Buffer.from(JSON.stringify(envelope(operation,i))).toString('base64')}});
const commit={jsonrpc:'2.0',id:'c',method:'commit',params:{}};
const query={jsonrpc:'2.0',id:'q',method:'abci_query',params:{path:'/store/federation/key',data:Buffer.from('member/uain1'+'0'.repeat(40)).toString('hex'),height:'5',prove:true}};

/** A fake loopback node that records every frame it is sent. */
function node(extra={}){
 const sent=[];
 const handler=createNativeRpcPublicHandler({env:{...env,...extra},validate:validateFrame,maxConcurrent:1000,transport:async(url,options)=>{
  assert.equal(url,'http://127.0.0.1:26667');const frame=JSON.parse(options.body);sent.push(frame);
  return new Response(JSON.stringify({jsonrpc:'2.0',id:frame.id,result:frame.method==='broadcast_tx_sync'?{code:0,hash:'A'.repeat(64),log:''}:{ok:true}}));
 }});
 return {sent,handler};
}
async function invoke(handler,body){
 const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method='POST';req.headers={'content-type':'application/json'};
 const headers={};let answer;
 await handler(req,{setHeader:(k,v)=>{headers[k.toLowerCase()]=v}},new URL('https://uain.test/api/native/rpc'),(_,status,b)=>{answer={status,body:b}});
 return {...answer,headers};
}
beforeEach(()=>resetNativeSubmitWindows());

test('an operation outside the public list is refused, and nothing is sent upstream',async()=>{
 const {sent,handler}=node();
 for(const op of ['licence','guardian_propose','guardian_execute','karma_policy_activate','activate_consensus_v2','central_review','central_project_start','open_task','verify','private_payment','Enrol',' enrol','enrol​','__proto__','constructor']){
  const r=await invoke(handler,broadcast(op));
  assert.equal(r.status,403,op);assert.equal(r.body.error,'native_operation_not_allowed',op);assert.match(r.body.message,/Nothing was sent/);
 }
 assert.equal(sent.length,0);
});

test('every listed operation passes and is forwarded once, byte for byte',async()=>{
 const {sent,handler}=node();const frames=NATIVE_PUBLIC_RPC_OPERATIONS.map((op,i)=>broadcast(op,i));
 for(const frame of frames){const r=await invoke(handler,frame);assert.equal(r.status,200,frame.id);assert.equal(r.body.result.code,0)}
 assert.deepEqual(sent,frames);
});

test('the operator setting replaces the list: blank closes public broadcasting, and the relay setting does not open it',async()=>{
 for(const value of ['',' , ,','*','ALL']){
  const {sent,handler}=node({UAIN_NATIVE_PUBLIC_RPC_OPERATIONS:value});
  const r=await invoke(handler,broadcast('enrol'));assert.equal(r.status,403,value);assert.equal(r.body.error,'native_submit_disabled',value);assert.equal(sent.length,0);
 }
 const narrowed=node({UAIN_NATIVE_PUBLIC_RPC_OPERATIONS:'enrol'});
 assert.equal((await invoke(narrowed.handler,broadcast('enrol',1))).status,200);
 assert.equal((await invoke(narrowed.handler,broadcast('coin_shield',2))).body.error,'native_operation_not_allowed');
 assert.equal(narrowed.sent.length,1);
 const relay=node({UAIN_NATIVE_SUBMIT_OPERATIONS:'licence,guardian_propose'});
 assert.equal((await invoke(relay.handler,broadcast('licence'))).body.error,'native_operation_not_allowed');
 assert.equal(relay.sent.length,0);
});

test('the per-key rate holds: the seventh broadcast from one key in a minute is refused with Retry-After',async()=>{
 const {sent,handler}=node();
 for(let n=0;n<6;n++)assert.equal((await invoke(handler,broadcast('coin_quote',7))).status,200);
 const refused=await invoke(handler,broadcast('coin_claim',7));
 assert.equal(refused.status,429);assert.equal(refused.body.error,'rate_limited');assert.ok(Number(refused.headers['retry-after'])>=1);assert.equal(refused.body.retryAfter,Number(refused.headers['retry-after']));
 assert.equal(sent.length,6);
 assert.equal((await invoke(handler,broadcast('coin_claim',8))).status,200,'another key is not held back');
 const tight=node({UAIN_NATIVE_SUBMIT_PER_KEY_PER_MINUTE:'2'});resetNativeSubmitWindows();
 for(let n=0;n<2;n++)assert.equal((await invoke(tight.handler,broadcast('enrol',9))).status,200);
 assert.equal((await invoke(tight.handler,broadcast('enrol',9))).status,429);assert.equal(tight.sent.length,2);
});

test('the overall rate holds against fresh keys, while commit and the proved query still answer',async()=>{
 const {sent,handler}=node();
 for(let i=0;i<60;i++)assert.equal((await invoke(handler,broadcast('enrol',100+i))).status,200);
 const refused=await invoke(handler,broadcast('enrol',999));
 assert.equal(refused.status,429);assert.equal(refused.body.error,'rate_limited');assert.match(refused.body.message,/capacity/);
 assert.equal(sent.length,60);
 assert.equal((await invoke(handler,commit)).status,200);assert.equal((await invoke(handler,query)).status,200);
 assert.deepEqual(sent.slice(60),[commit,query]);
});

test('one key has one budget across the relay and the public origin',async()=>{
 const relayPolicy=nativeSubmitPolicy({UAIN_NATIVE_SUBMIT_OPERATIONS:'coin_quote'});
 for(let n=0;n<6;n++)admitNativeSubmit(envelope('coin_quote',11),relayPolicy);
 const {sent,handler}=node();
 assert.equal((await invoke(handler,broadcast('coin_quote',11))).status,429);assert.equal(sent.length,0);
});

test('commit and the proved abci_query pass unchanged; an unproved query is still refused',async()=>{
 const {sent,handler}=node();
 const c=await invoke(handler,commit),q=await invoke(handler,query);
 assert.equal(c.status,200);assert.equal(c.body.id,'c');assert.equal(q.status,200);assert.equal(q.body.id,'q');
 assert.deepEqual(sent,[commit,query]);
 assert.equal((await invoke(handler,{...query,params:{...query.params,prove:false}})).status,400);
 assert.equal(sent.length,2);
});

// The default list must match what BAINK broadcasts through https://uain.global (BAINK_NATIVE_RPC)
// with the features it runs in production. If this fails, BAINK's transports changed: update
// NATIVE_PUBLIC_RPC_OPERATIONS in the same change, or BAINK's new operation is refused live.
test('the default list is exactly what BAINK broadcasts through the public origin',{skip:!existsSync(new URL('../../../apps/baink/server/native-asset.mjs',import.meta.url))},()=>{
 const read=file=>readFileSync(new URL('../../../apps/baink/server/'+file,import.meta.url),'utf8');
 const names=list=>[...list.matchAll(/'([a-z][a-z0-9_]*)'/g)].map(m=>m[1]);
 const asset=read('native-asset.mjs');
 const single=[...asset.matchAll(/config && envelope\?\.command\?\.operation === '([a-z_]+)'/g)].map(m=>m[1]);
 assert.deepEqual(single,['enrol','instance_create']);
 const research=names(asset.match(/config && (\[[^\]]+\])\.includes\(envelope\?\.command\?\.operation\)/)[1]);
 const earning=names(read('native-financial-transport.mjs').match(/broadcastEarning[\s\S]*?encode\(envelope,(\[[^\]]+\])\)/)[1]);
 const central=names(read('central-earning-transport.mjs').match(/MEMBER_OPERATIONS=Object\.freeze\((\[[^\]]+\])\)/)[1]);
 const shield=[...read('server-send-builder.mjs').matchAll(/envelope\?\.command\?\.operation === '([a-z_]+)'/g)].map(m=>m[1]);
 assert.deepEqual(shield,['coin_shield']);
 const production=new Set([...single,...earning,...central,...shield]);
 assert.deepEqual([...NATIVE_PUBLIC_RPC_OPERATIONS].sort(),[...production].sort());
 // BAINK's research pilot is off in production (BAINK_NATIVE_PROJECT_PILOT_ENABLED unset). Its
 // operations stay off the public list except project_join, which central earning also sends.
 assert.deepEqual(research.filter(op=>NATIVE_PUBLIC_RPC_OPERATIONS.includes(op)),['project_join']);
});
