import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('public read frames reject administration, unproved ranges and alternate chains',async()=>{
 const {validateFrame}=await import('./native-rpc-transport.mjs');
 const frame={jsonrpc:'2.0',id:1,method:'abci_query',params:{path:'/store/federation/key',data:Buffer.from('legacy/task/actual').toString('hex'),height:'9',prove:true}};
 assert.deepEqual(validateFrame(frame),frame);
 for(const v of [{...frame,method:'unsafe_flush_mempool'},{...frame,params:{...frame.params,path:'/store/federation/subspace'}},{...frame,params:{...frame.params,prove:false}},{...frame,params:{...frame.params,data:'00'}},{...frame,params:{...frame.params,height:'0'}},{...frame,extra:true}])assert.throws(()=>validateFrame(v));
 const envelope={command:{version:1,chain_id:'uain-shadow-20261008-1',member:'uain1'+'a'.repeat(40),sequence:'1',expires_height:'100',operation:'submit',payload:{}},public_key:'a'.repeat(43),signature:'a'.repeat(86)};
 const tx=v=>({jsonrpc:'2.0',id:'signed',method:'broadcast_tx_sync',params:{tx:Buffer.from(JSON.stringify(v)).toString('base64')}});
 assert.equal(validateFrame(tx(envelope)).method,'broadcast_tx_sync');
 assert.throws(()=>validateFrame(tx({...envelope,command:{...envelope.command,chain_id:'other'}})));
 assert.equal(validateFrame(tx({...envelope,command:{...envelope.command,chain_id:'uain-reset-reviewed-1'}}),'uain-reset-reviewed-1').method,'broadcast_tx_sync');
 assert.throws(()=>validateFrame(tx(envelope),'uain-reset-reviewed-1'));
 assert.throws(()=>validateFrame(tx({...envelope,private_key:'never'})));
 assert.throws(()=>validateFrame({...tx(envelope),params:{tx:'a'.repeat(90000)}}));
});
test('projection waits for its bridge and exits with its fixed worker',async()=>{
 const {startTransport,runProjection}=await import('./native-rpc-transport.mjs');
 const dir=await mkdtemp(join(tmpdir(),'uain-projection-')),socket=join(dir,'rpc.sock'),cwd=process.cwd();let requests=0,host;
 const upstream=http.createServer(async(req,res)=>{let raw='';for await(const p of req)raw+=p;requests++;const v=JSON.parse(raw);res.end(JSON.stringify({jsonrpc:'2.0',id:v.id,result:{ready:true}}))});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 try{
  host=await startTransport({mode:'host',socket,upstreamPort:upstream.address().port});
  await mkdir(join(dir,'dist/src/native'),{recursive:true});
  await writeFile(join(dir,'dist/src/native/worker.js'),`(async()=>{const r=await fetch('http://127.0.0.1:${port}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'worker',method:'commit',params:{}})});process.exitCode=(await r.json()).result.ready?7:9})().catch(()=>{process.exitCode=11});`);
  process.chdir(dir);assert.equal(await runProjection({socket,port}),7);assert.equal(requests,1);
  await assert.rejects(()=>fetch(`http://127.0.0.1:${port}`));
 }finally{process.chdir(cwd);for(const s of [host,upstream])if(s){s.closeAllConnections();await new Promise(r=>s.close(r))}await rm(dir,{recursive:true,force:true})}
});
test('pod loopback → Unix capability → host loopback preserves exact frames and bounds',async()=>{
 const {startTransport}=await import('./native-rpc-transport.mjs');
 const dir=await mkdtemp(join(tmpdir(),'uain-native-transport-')),socket=join(dir,'rpc.sock');let requests=0,badReply=false;
 const upstream=http.createServer(async(req,res)=>{let raw='';for await(const p of req)raw+=p;requests++;const v=JSON.parse(raw);res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:badReply?'wrong':v.id,result:{echo:v}}))});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 let host,bridge;
 try{
  host=await startTransport({mode:'host',socket,upstreamPort:upstream.address().port});bridge=await startTransport({mode:'bridge',socket,port});
  assert.equal((await stat(socket)).mode&0o777,0o660);assert.equal(bridge.address().address,'127.0.0.1');
  const frame={jsonrpc:'2.0',id:'actual',method:'commit',params:{}};
  const post=v=>fetch(`http://127.0.0.1:${port}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(v)});
  assert.deepEqual((await(await post(frame)).json()).result.echo,frame);assert.equal(requests,1);
  assert.equal((await post({...frame,method:'dial_peers'})).status,400);assert.equal(requests,1);
  badReply=true;assert.equal((await post(frame)).status,400);
  assert.equal((await fetch(`http://127.0.0.1:${port}/admin`)).status,404);
  await assert.rejects(()=>startTransport({mode:'host',socket}));
  await assert.rejects(()=>startTransport({mode:'bridge',socket,port:80}));
 }finally{for(const s of [bridge,host,upstream])if(s)await new Promise(r=>s.close(r));await rm(dir,{recursive:true,force:true})}
});
