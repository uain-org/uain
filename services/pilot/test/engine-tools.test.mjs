// One documented UAIN MCP server (16 November 2026): uain.global/mcp also offers the
// earning tools that run on the payment engine (baink.money/mcp), under uain_* names,
// and still answers their old baink_* names. Each call is passed on to baink.money/mcp
// unchanged, so a signed request keeps its https://baink.money audience.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {registerEngineTools,ENGINE_TOOLS,ENGINE_ALIASES,ENGINE_UNLISTED} from '../dist/src/api/engine-tools.js';
import {registerNativeTools,hideUnlistedTools,UNLISTED_TOOLS} from '../dist/src/api/native-tools.js';
import {registerResearchTools} from '../dist/src/api/research-tools.js';
import {createBainkMcp,MCP_TOOLS as BAINK_TOOLS} from '../../../apps/baink/server/mcp.mjs';
import {MEMBER_TOOLS,SIGNER} from '../../../apps/baink/server/mcp-member.mjs';

const text=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
const signed={method:'GET',path:'/api/native/central/tasks?order=newest&state=open&limit=12&cursor=0',publicKey:Buffer.alloc(32,7).toString('base64'),nonce:'n'.repeat(22),timestamp:'1763300000000',signature:Buffer.alloc(64,9).toString('base64')};

/** The real BAINK MCP handler on a local port; its relay records what it would run. */
async function engine(t,{relay=async()=>({status:200,body:{tasks:[]}})}={}){
  const server=createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const relayed=[],seen=[];
  const handle=createBainkMcp({origins:[origin],admit(){},requesterIp:()=>'test',
    read:async(name,args)=>name==='baink_proposals'?{total:0,items:[],asked:args}:{member:args.address,karma:3},
    forward:async(request)=>{relayed.push(request);return relay(request)}});
  server.on('request',(req,res)=>{seen.push({host:req.headers.host,origin:req.headers.origin,accept:req.headers.accept});handle(req,res,new URL(req.url,origin))});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return {origin,relayed,seen};
}
let callers=0;
async function connect(t,options){
  const server=new McpServer({name:'uain-engine-test',version:'1'});
  registerNativeTools(server,{text,audit(){}});registerResearchTools(server,{text,audit(){}});
  registerEngineTools(server,{text,audit(){},budget:async()=>({allowed:true}),caller:'fixture-'+(++callers),...options});
  hideUnlistedTools(server,new Set([...UNLISTED_TOOLS,...ENGINE_UNLISTED]));
  const client=new Client({name:'engine-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(b);await client.connect(a);
  t.after(async()=>{await client.close();await server.close()});
  const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});let data;try{data=JSON.parse(r.content[0].text)}catch{data={raw:r.content[0].text}}return{isError:r.isError===true,data}};
  return {client,call};
}

test('one UAIN server lists the earning tools under uain_* names and keeps native tools and old names',async t=>{
  const {origin}=await engine(t);
  const {client}=await connect(t,{origin});
  const names=(await client.listTools()).tools.map(x=>x.name);
  for(const n of ['uain_signer','uain_member_request','uain_contribution','uain_proposals','uain_profiles'])assert.ok(names.includes(n),n+' is listed');
  // Native tools whose names collide with engine tools keep their own contract.
  for(const n of ['uain_guide','uain_find_tasks','uain_tasks','uain_projects','uain_contributions','uain_search_research','uain_native_state'])assert.ok(names.includes(n),n+' stays');
  assert.ok(!names.some(n=>n.startsWith('baink_')),'old names answer but are not listed');
  assert.deepEqual(Object.keys(ENGINE_ALIASES).sort(),['baink_contribution','baink_member_request','baink_profiles','baink_proposals','baink_signer']);
  for(const tool of (await client.listTools()).tools.filter(x=>ENGINE_TOOLS.some(e=>e.name===x.name))){
    assert.match(tool.description,/^[A-Z][a-z]+ /,tool.name+' starts with a verb');
    assert.ok(!/\b(native|central|shield|attested|custody|fence|holder|intent|epoch|projection|baink)\b/i.test(tool.description),tool.name+' uses plain UAIN words');
    assert.equal(tool.inputSchema.additionalProperties,false,tool.name+' refuses unknown fields');
  }
});

test('engine tool schemas match the payment engine field for field',()=>{
  const bainkByName=Object.fromEntries([...BAINK_TOOLS,...MEMBER_TOOLS].map(x=>[x.name,x]));
  for(const tool of ENGINE_TOOLS){
    const peer=bainkByName[tool.engine];
    assert.ok(peer,tool.engine+' exists on BAINK');
    assert.deepEqual(Object.keys(tool.shape).sort(),Object.keys(peer.inputSchema.properties).sort(),tool.name+' fields');
    assert.deepEqual([...tool.required].sort(),[...(peer.inputSchema.required??[])].sort(),tool.name+' required fields');
  }
});

test('uain_member_request passes the signed request on unchanged, bound to the engine audience',async t=>{
  const {origin,relayed,seen}=await engine(t);
  const {call}=await connect(t,{origin});
  const r=await call('uain_member_request',signed);
  assert.equal(r.isError,false,JSON.stringify(r.data));
  assert.equal(relayed.length,1);
  assert.deepEqual(relayed[0].headers,{'x-baink-public-key':signed.publicKey,'x-baink-nonce':signed.nonce,'x-baink-timestamp':signed.timestamp,'x-baink-signature':signed.signature},'signature fields reach BAINK byte for byte');
  assert.equal(relayed[0].path,signed.path);
  assert.equal(seen[0].host,new URL(origin).host,'BAINK sees its own host, so the signature audience is unchanged');
  assert.equal(seen[0].origin,undefined,'no browser origin is claimed');
  assert.match(seen[0].accept,/application\/json/);assert.match(seen[0].accept,/text\/event-stream/);
  assert.deepEqual(r.data.answer,{tasks:[]},'the engine answer is passed on as it is');
  assert.equal(r.data.nextStep.tool,'uain_member_request','the next step names the UAIN tool');
  // The old name still answers, with the engine's own wording.
  const old=await call('baink_member_request',{...signed,nonce:'m'.repeat(22)});
  assert.equal(old.isError,false);assert.equal(old.data.nextStep.tool,'baink_member_request');
  assert.equal(relayed.length,2);
});

test('uain_signer gives the same signer bytes, served from uain.global',async t=>{
  const {origin}=await engine(t);
  const {call}=await connect(t,{origin});
  const r=await call('uain_signer',{});
  assert.equal(r.isError,false);
  assert.equal(r.data.text,SIGNER.text,'signer text is unchanged');
  assert.equal(r.data.sha256,SIGNER.sha256);
  assert.equal(r.data.url,'https://uain.global/uain_signer.py');
  assert.equal(r.data.checksumUrl,'https://uain.global/uain_signer.py.sha256');
  assert.match(r.data.howToUse.join(' '),/uain_member_request/);
  assert.doesNotMatch(r.data.howToUse.join(' '),/baink_member_request/);
  assert.equal(r.data.nextStep.tool,'uain_member_request');
  const old=await call('baink_signer',{});
  assert.equal(old.data.url,SIGNER.url,'the old name keeps its old answer');
});

test('reads pass through; a private key is refused here and never leaves uain.global',async t=>{
  const {origin,relayed,seen}=await engine(t);
  const {call}=await connect(t,{origin});
  const address='uain1'+'a'.repeat(40);
  const c=await call('uain_contribution',{address});
  assert.equal(c.isError,false);assert.equal(c.data.member,address);
  const p=await call('uain_proposals',{search:'telomere'});
  assert.equal(p.isError,false);assert.equal(p.data.nextStep.tool==='baink_proposals',false,'next steps name UAIN tools');
  const before=seen.length;
  const secret='A'.repeat(21)+'_'+'b'.repeat(21);
  const keyed=await call('uain_member_request',{...signed,method:'POST',body:{note:secret}});
  assert.equal(keyed.isError,true);assert.equal(keyed.data.error.code,'private_key_refused');
  assert.ok(!JSON.stringify(keyed).includes(secret),'the key is never echoed');
  const named=await call('uain_member_request',{...signed,privateKey:secret});
  assert.equal(named.isError,true,'an unknown field is refused');assert.ok(!JSON.stringify(named).includes(secret));
  assert.equal(seen.length,before,'nothing was sent to the engine');assert.equal(relayed.length,0);
  const bad=await call('uain_contribution',{address,extra:1}).catch(e=>({isError:true,data:{message:String(e)}}));
  assert.equal(bad.isError,true,'unknown fields are refused');
});

test('an engine failure on a signed step says the outcome is unknown; a busy caller is refused before sending',async t=>{
  let sent=0;
  const fetcher=async()=>{sent++;throw new TypeError('fetch failed')};
  const {call}=await connect(t,{origin:'http://127.0.0.1:9',fetcher});
  const r=await call('uain_member_request',signed);
  assert.equal(r.isError,true);assert.equal(r.data.error.code,'outcome_unknown');
  assert.match(r.data.error.message,/do not send/i);
  const read=await call('uain_contribution',{address:'uain1'+'a'.repeat(40)});
  assert.equal(read.isError,true);assert.equal(read.data.error.code,'engine_unavailable');
  assert.equal(sent,2);
  const limited=await connect(t,{origin:'http://127.0.0.1:9',fetcher,budget:async()=>({allowed:false,retryAfter:30,limit:30})});
  const busy=await limited.call('uain_signer',{});
  assert.equal(busy.isError,true);assert.equal(busy.data.error.code,'rate_limited');
  assert.equal(sent,2,'a refused call never reaches the engine');
});

test('a redirect or oversize answer from the engine is a fault, never followed',async t=>{
  const fetcher=async(url,init)=>{assert.equal(init.redirect,'error');return{status:200,headers:{get:()=>'application/json'},text:async()=>'x'.repeat(3*1024*1024)}};
  const {call}=await connect(t,{origin:'http://127.0.0.1:9',fetcher});
  const r=await call('uain_profiles',{search:'x'});
  assert.equal(r.isError,true);assert.equal(r.data.error.code,'engine_unavailable');
});

test('a busy or malformed answer to a signed write is an unknown outcome, never "nothing was sent"',async t=>{
  for(const [status,body] of [[429,'{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"busy"}}'],[503,'<html>bad gateway</html>'],[200,'{"jsonrpc":"2.0","id":1,"result":{"content":[]}}'],[200,'not json']]){
    const fetcher=async()=>({status,text:async()=>body});
    const {call}=await connect(t,{origin:'http://127.0.0.1:9',fetcher});
    const w=await call('uain_member_request',{...signed,method:'POST',path:'/api/native/central/prepare',body:{operation:'project_join',payload:{project:'P-1'}}});
    assert.equal(w.isError,true);assert.equal(w.data.error.code,'outcome_unknown',`${status} ${body}`);
    assert.doesNotMatch(w.data.error.message,/nothing was sent/i);
    assert.match(w.data.error.message,/Do not send a write again/);
    assert.match(w.data.nextStep.sign,/\/api\/native\/central\/intents/,'recovery reads the steps first');
    const r=await call('uain_profiles',{});
    assert.equal(r.isError,true);assert.ok(['engine_busy','engine_unavailable'].includes(r.data.error.code));
  }
});

test('translating guidance changes only wording and tool names, never what the member signs',async t=>{
  const step={do:'Send it with baink_member_request on baink.money/mcp.',tool:'baink_member_request',sign:'sign_request(key, "POST", "/api/native/central/prepare", {"note":"baink_signer"})',args:{'...':'baink_member_request','path':'/api/x?tool=baink_signer'}};
  const fetcher=async()=>({status:200,text:async()=>JSON.stringify({jsonrpc:'2.0',id:1,result:{isError:false,structuredContent:{status:200,answer:{echo:'baink_signer'},nextStep:step}}})});
  const {call}=await connect(t,{origin:'http://127.0.0.1:9',fetcher});
  const r=await call('uain_member_request',signed);
  assert.equal(r.data.nextStep.tool,'uain_member_request');
  assert.match(r.data.nextStep.do,/uain_member_request on uain\.global\/mcp/);
  assert.equal(r.data.nextStep.sign,step.sign,'sign line unchanged');
  assert.deepEqual(r.data.nextStep.args,step.args,'args unchanged');
  assert.deepEqual(r.data.answer,{echo:'baink_signer'},'the engine answer is never rewritten');
});

// Review of 16 November 2026 (branding integration): bounds, admission, origin and key forms.
const keyedBody=(body)=>({...signed,method:'POST',path:'/api/native/central/prepare',body});

test('the serialized request is bounded as BAINK bounds it, before anything is sent',async t=>{
  let sent=0;const fetcher=async()=>{sent++;return{status:200,text:async()=>JSON.stringify({jsonrpc:'2.0',id:1,result:{isError:false,structuredContent:{ok:true}}})}};
  const {call}=await connect(t,{fetcher});
  // A full 16 KB evidence submission still fits the 64 KiB member limit.
  const evidence='e '.repeat(8192);
  assert.equal((await call('uain_member_request',keyedBody({operation:'central_submit',payload:{evidence}}))).isError,false);
  const big=await call('uain_member_request',keyedBody({operation:'central_submit',payload:{evidence:'e '.repeat(40000)}}));
  assert.equal(big.data.error.code,'request_too_large');assert.match(big.data.error.message,/Nothing was sent/);
  // Every other tool has BAINK's 16 KiB request bound (search strings are short by schema; the profile page fits).
  let nest={};for(let i=0;i<40;i++)nest={n:nest};
  const deep=await call('uain_member_request',keyedBody(nest));
  assert.equal(deep.data.error.code,'request_too_large','deep nesting is refused before the key walk');
  assert.equal(sent,1);
});

test('upstream answers are read in bounded chunks and cancelled on overflow; a write overflow is an unknown outcome',async t=>{
  let cancelled=0;
  const stream=()=>({getReader(){let n=0;return{read:async()=>n++<40?{done:false,value:new Uint8Array(64*1024)}:{done:true},cancel:async()=>{cancelled++}}}});
  const fetcher=async()=>({status:200,body:stream(),text:async()=>{throw Error('text() must not be used when a stream exists')}});
  const {call}=await connect(t,{fetcher});
  const w=await call('uain_member_request',signed);
  assert.equal(w.data.error.code,'outcome_unknown');assert.doesNotMatch(w.data.error.message,/nothing was sent/i);
  const r=await call('uain_profiles',{});
  assert.equal(r.data.error.code,'engine_unavailable');
  assert.equal(cancelled,2,'the upstream read is cancelled once it passes the bound');
});

test('admission fails closed without a budget, and calls in flight are capped per caller and per process',async t=>{
  let sent=0;
  const none=await connect(t,{budget:undefined,fetcher:async()=>{sent++;throw Error('x')}});
  const r=await none.call('uain_signer',{});
  assert.equal(r.data.error.code,'engine_unavailable');assert.match(r.data.error.message,/Nothing was sent/);assert.equal(sent,0);
  const {ENGINE_IN_FLIGHT}=await import('../dist/src/api/engine-tools.js');
  let release;const gate=new Promise(res=>{release=res});let started=0;
  const slow=async()=>{started++;await gate;return{status:200,text:async()=>JSON.stringify({jsonrpc:'2.0',id:1,result:{isError:false,structuredContent:{ok:true}}})}};
  const one=await connect(t,{fetcher:slow,caller:'same-caller'});
  const until=async(n)=>{for(let i=0;i<500&&started<n;i++)await new Promise(res=>setTimeout(res,2));assert.equal(started,n)};
  const waiting=Array.from({length:ENGINE_IN_FLIGHT.perCaller},()=>one.call('uain_signer',{}));
  await until(ENGINE_IN_FLIGHT.perCaller);
  const over=await one.call('uain_signer',{});
  assert.equal(over.data.error.code,'engine_busy','a caller\'s third call waits for none: it is refused, nothing sent');
  // Another MCP server object for the same caller shares the same count (one per request in production).
  const twin=await connect(t,{fetcher:slow,caller:'same-caller'});
  assert.equal((await twin.call('uain_signer',{})).data.error.code,'engine_busy');
  // Other callers fill the process-wide cap.
  const others=[];
  for(let i=0;i<ENGINE_IN_FLIGHT.global-ENGINE_IN_FLIGHT.perCaller;i++){const c=await connect(t,{fetcher:slow,caller:'other-'+i});others.push(c.call('uain_signer',{}))}
  await until(ENGINE_IN_FLIGHT.global);
  const fresh=await connect(t,{fetcher:slow,caller:'fresh'});
  assert.equal((await fresh.call('uain_signer',{})).data.error.code,'engine_busy','the global cap holds');
  assert.equal(started,ENGINE_IN_FLIGHT.global);
  release();await Promise.all([...waiting,...others]);
  assert.equal((await fresh.call('uain_signer',{})).isError,false,'slots are released when calls end');
});

test('the engine is fixed: only a loopback origin replaces it, and UAIN_STATUS_BAINK_ORIGIN never does',async t=>{
  const server=new McpServer({name:'x',version:'1'});
  assert.throws(()=>registerEngineTools(server,{text,audit(){},budget:async()=>({allowed:true}),caller:'c',origin:'https://internal.example'}),/loopback/);
  const before=process.env.UAIN_STATUS_BAINK_ORIGIN;process.env.UAIN_STATUS_BAINK_ORIGIN='https://evil.example';
  try{
    const urls=[];const {call}=await connect(t,{origin:undefined,fetcher:async(url)=>{urls.push(url);throw Error('x')}});
    await call('uain_signer',{});
    assert.deepEqual(urls,['https://baink.money/mcp']);
  }finally{if(before===undefined)delete process.env.UAIN_STATUS_BAINK_ORIGIN;else process.env.UAIN_STATUS_BAINK_ORIGIN=before}
});

test('recognizable private-key forms are refused; SHA-256 hex digests and public keys pass',async t=>{
  let sent=0;const fetcher=async()=>{sent++;return{status:200,text:async()=>JSON.stringify({jsonrpc:'2.0',id:1,result:{isError:false,structuredContent:{ok:true}}})}};
  const {call}=await connect(t,{fetcher});
  const pkcs8=(await import('node:crypto')).generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'der'}).toString('base64');
  for(const body of [
    {note:'-----BEGIN PRIVATE KEY-----\nMC4CAQAw\n-----END PRIVATE KEY-----'},
    {note:pkcs8},
    {evidence:{kty:'OKP',crv:'Ed25519',x:'A'.repeat(43),d:'B'.repeat(43)}},
    {key:{d:'zzz',kty:'EC'}},
  ]){
    const r=await call('uain_member_request',keyedBody(body));
    assert.equal(r.data.error.code,'private_key_refused',JSON.stringify(body).slice(0,40));
  }
  assert.equal(sent,0);
  const digest='a'.repeat(64);
  const ok=await call('uain_member_request',keyedBody({operation:'central_submit',payload:{evidence:'sha256 '+digest,artifact:{sha256:digest}}}));
  assert.equal(ok.isError,false,'a 64-character hex SHA-256 is legitimate evidence');
  assert.equal(sent,1);
});

test('recovery hints on this server name uain_guide for old names too; descriptions tell the two contribution tools apart',async t=>{
  const fetcher=async()=>({status:400,text:async()=>JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-32602,message:'Invalid arguments'}})});
  const {call,client}=await connect(t,{fetcher});
  for(const name of ['uain_profiles','baink_profiles'])assert.equal((await call(name,{})).data.nextStep.tool,'uain_guide',name);
  const tools=(await client.listTools()).tools;
  assert.match(tools.find(x=>x.name==='uain_contribution').description,/current.*use uain_contributions instead/s);
  assert.match(tools.find(x=>x.name==='uain_contributions').description,/archive.*use uain_contribution\./s);
});
