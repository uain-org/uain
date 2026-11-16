import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {admitNativeSubmit,nativeSubmitPolicy,resetNativeSubmitWindows,handleNative,NativeSubmitRefused} from '../dist/src/api/native-routes.js';
import {registerNativeTools} from '../dist/src/api/native-tools.js';

const env={UAIN_NATIVE_STATE_BINARY:'/bin/false',UAIN_NATIVE_STATE_SHA256:'a'.repeat(64),UAIN_NATIVE_GENESIS:'/dev/null',UAIN_NATIVE_GENESIS_SHA256:'b'.repeat(64),UAIN_NATIVE_RPC:'https://rpc.example'};
const envelope=(operation,key='pk-1')=>({command:{version:1,operation,payload:{}},public_key:key,signature:'sig'});
const refusedWith=code=>e=>e instanceof NativeSubmitRefused&&e.code===code;
beforeEach(()=>resetNativeSubmitWindows());

// Any RPC contact during a refusal is a failure.
let rpcCalls=0;const realFetch=globalThis.fetch;
globalThis.fetch=async()=>{rpcCalls++;return{ok:true,text:async()=>JSON.stringify({result:{code:0,hash:'c'.repeat(64),log:''}})}};
const post=async(body,extra={})=>{let reply,headers={};const res={setHeader:(k,v)=>headers[k]=v};
 await handleNative({method:'POST'},res,new URL('https://uain.test/api/native/command'),(_,status,b)=>reply={status,body:b},()=>{},async()=>body,{...env,...extra});return{...reply,headers}};

test('H1: closed by default: no operations configured refuses every envelope over HTTP without contacting the chain',async()=>{
 rpcCalls=0;
 for(const op of ['instance_create','central_award','transfer','guardian_handover',undefined]){const r=await post(envelope(op));assert.equal(r.status,403);assert.equal(r.body.error,'native_submit_disabled')}
 const r=await post(envelope('transfer'),{UAIN_NATIVE_SUBMIT_OPERATIONS:'   , ,'});assert.equal(r.body.error,'native_submit_disabled','blank list stays closed');
 assert.equal(rpcCalls,0);
});
test('H2: an allow-list cannot be dodged by case, spacing, type, prototype names or nesting',async()=>{
 rpcCalls=0;const extra={UAIN_NATIVE_SUBMIT_OPERATIONS:'instance_create'};
 const bad=[envelope('Instance_create'),envelope(' instance_create'),envelope('instance_create​'),envelope(['instance_create']),envelope({toString:()=>'instance_create'}),envelope('__proto__'),envelope('constructor'),envelope('hasOwnProperty'),
  {command:{version:1,payload:{operation:'instance_create'}},public_key:'k',signature:'s'}];
 for(const e of bad){const r=await post(e,extra);assert.equal(r.status,403,JSON.stringify(e.command));assert.equal(r.body.error,'native_operation_not_allowed')}
 assert.equal(rpcCalls,0);
});
test('H3: an operator-listed operation is relayed to the chain once',async()=>{
 rpcCalls=0;const r=await post(envelope('instance_create'),{UAIN_NATIVE_SUBMIT_OPERATIONS:'instance_create, research_publish'});
 assert.equal(r.status,200);assert.equal(r.body.accepted,true);assert.equal(r.body.finalized,false);assert.equal(rpcCalls,1);
});
test('H4: invalid operation names in the setting are ignored, never widen the list',()=>{
 const p=nativeSubmitPolicy({UAIN_NATIVE_SUBMIT_OPERATIONS:'*,ALL,instance_create,../x,a b'});
 assert.deepEqual([...p.operations],['instance_create']);
 assert.throws(()=>admitNativeSubmit(envelope('anything'),p),refusedWith('native_operation_not_allowed'));
});
test('H5: per-key rate limit; a fresh key per step is still capped by the global limit; windows expire',()=>{
 const p=nativeSubmitPolicy({UAIN_NATIVE_SUBMIT_OPERATIONS:'x',UAIN_NATIVE_SUBMIT_PER_KEY_PER_MINUTE:'2',UAIN_NATIVE_SUBMIT_PER_MINUTE:'5'});const t=1_000_000;
 admitNativeSubmit(envelope('x','a'),p,t);admitNativeSubmit(envelope('x','a'),p,t+1);
 assert.throws(()=>admitNativeSubmit(envelope('x','a'),p,t+2),e=>refusedWith('rate_limited')(e)&&e.status===429&&e.retryAfter>=1&&e.retryAfter<=60);
 admitNativeSubmit(envelope('x','b'),p,t+3);admitNativeSubmit(envelope('x','c'),p,t+4);admitNativeSubmit(envelope('x','d'),p,t+5);
 assert.throws(()=>admitNativeSubmit(envelope('x','e'),p,t+6),refusedWith('rate_limited'),'key rotation hits the global cap');
 admitNativeSubmit(envelope('x','a'),p,t+60_002);
});
test('H6: junk rate settings fall back to safe defaults rather than disabling the limit',()=>{
 for(const v of ['0','-1','abc','1e9','Infinity','2.5']){const p=nativeSubmitPolicy({UAIN_NATIVE_SUBMIT_OPERATIONS:'x',UAIN_NATIVE_SUBMIT_PER_KEY_PER_MINUTE:v,UAIN_NATIVE_SUBMIT_PER_MINUTE:v});assert.equal(p.perKeyPerMinute,6,v);assert.equal(p.perMinute,60,v)}
});
test('H7: the 429 reply carries Retry-After over HTTP',async()=>{
 const extra={UAIN_NATIVE_SUBMIT_OPERATIONS:'x',UAIN_NATIVE_SUBMIT_PER_KEY_PER_MINUTE:'1'};
 assert.equal((await post(envelope('x','z'),extra)).status,200);
 const r=await post(envelope('x','z'),extra);assert.equal(r.status,429);assert.equal(r.body.error,'rate_limited');assert.ok(Number(r.headers['retry-after'])>=1);
});
test('H8: no regression: a private key or wrong shape is still a 400 that never echoes the secret, checked before the policy',async()=>{
 rpcCalls=0;
 for(const body of [{...envelope('x'),private_key:'DO_NOT_ECHO'},{command:'str',public_key:'k',signature:'s'},[]]){const r=await post(body,{UAIN_NATIVE_SUBMIT_OPERATIONS:'x'});assert.equal(r.status,400);assert.equal(r.body.error,'native_request_invalid');assert.ok(!JSON.stringify(r.body).includes('DO_NOT_ECHO'))}
 assert.equal(rpcCalls,0);
});
test('H9: state and receipt reads are not affected by the closed relay',async()=>{
 let reply;await handleNative({method:'POST'},null,new URL('https://uain.test/api/native/state'),(_,status,b)=>reply={status,body:b},()=>{},async()=>({keys:[]}),env);
 assert.notEqual(reply.body?.error,'native_submit_disabled');
});
test('H10: the MCP tool refuses the same way, through the same policy, without contacting the chain',async()=>{
 const tools={};const server={registerTool:(name,_m,fn)=>tools[name]=fn};
 registerNativeTools(server,{text:v=>v,audit:()=>{}});
 const saved={...process.env};Object.assign(process.env,env);delete process.env.UAIN_NATIVE_SUBMIT_OPERATIONS;rpcCalls=0;
 try{
  const closed=await tools.uain_native_submit({envelope:envelope('instance_create')});assert.equal(closed.error,'native_submit_disabled');assert.equal(closed.nextStep.tool,'uain_guide');
  process.env.UAIN_NATIVE_SUBMIT_OPERATIONS='instance_create';
  assert.equal((await tools.uain_native_submit({envelope:envelope('transfer')})).error,'native_operation_not_allowed');
  assert.equal(rpcCalls,0);
  const ok=await tools.uain_native_submit({envelope:envelope('instance_create')});assert.equal(ok.accepted,true);assert.equal(rpcCalls,1);
  const bad=await tools.uain_native_submit({envelope:{...envelope('instance_create'),private_key:'DO_NOT_ECHO'}});assert.equal(bad.error,'request_invalid');assert.ok(!JSON.stringify(bad).includes('DO_NOT_ECHO'));
 }finally{process.env=saved}
});
test.after(()=>{globalThis.fetch=realFetch});
