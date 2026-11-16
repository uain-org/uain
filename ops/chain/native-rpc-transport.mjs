// Keyless local transport: a host Unix capability connects pod loopback readers
// to the original node. It exposes only public proved reads and bounded signed
// envelopes. Native CheckTx/DeliverTx retain all signing and policy authority.
import http from 'node:http';
import {chmod,lstat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const SOCKET='/run/uain-native-rpc/gateway.sock';
const REQUEST=96*1024, RESPONSE=8*1024*1024;
const ORIGINAL_CHAIN='uain-shadow-20261008-1';
const validChain=v=>typeof v==='string'&&/^uain-[a-z0-9][a-z0-9_-]{1,63}$/.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
const height=v=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
export function validateFrame(v,chainId=ORIGINAL_CHAIN){
 if(!validChain(chainId))throw Error('fixed public chain required');
 if(!exact(v,['jsonrpc','id','method','params'])||v.jsonrpc!=='2.0'||!['string','number'].includes(typeof v.id)||!Number.isFinite(typeof v.id==='number'?v.id:0)||String(v.id).length>64)throw Error('RPC frame refused');
 const p=v.params;
 if(v.method==='commit'){
  if(!exact(p,['height'])||p.height!=null&&!height(p.height))throw Error('commit refused');
 }else if(v.method==='abci_query'){
  if(!exact(p,['path','data','height','prove'])||p.path!=='/store/federation/key'||p.prove!==true||!height(p.height)||typeof p.data!=='string'||!/^(?:0x)?(?:[a-fA-F0-9]{2}){1,1024}$/.test(p.data))throw Error('proved query refused');
  const raw=Buffer.from(p.data.replace(/^0x/,''),'hex'),key=raw.toString('utf8');
  if(!raw.equals(Buffer.from(key))||!key.length||/[\x00-\x1f\x7f]/.test(key))throw Error('public key refused');
 }else if(v.method==='broadcast_tx_sync'){
  if(!exact(p,['tx'])||typeof p.tx!=='string')throw Error('envelope refused');
  const wire=Buffer.from(p.tx,'base64');
  if(wire.length<1||wire.length>65536||wire.toString('base64')!==p.tx)throw Error('bounded envelope refused');
  const envelope=JSON.parse(wire.toString('utf8'));
  if(!exact(envelope,['command','public_key','signature'])||Object.keys(envelope).length!==3||!exact(envelope.command,['version','chain_id','member','sequence','expires_height','operation','payload','instance'])||envelope.command.chain_id!==chainId||typeof envelope.command.operation!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(envelope.public_key)||!/^[A-Za-z0-9_-]{86}$/.test(envelope.signature))throw Error('pinned chain signed envelope required');
 }else throw Error('RPC method refused');
 return v;
}
async function bounded(stream,max){const parts=[];let n=0;for await(const part of stream){n+=part.length;if(n>max)throw Error('transport bound exceeded');parts.push(part)}return Buffer.concat(parts)}
function relay({socketPath,port},raw,signal){return new Promise((yes,no)=>{
 const request=http.request({...(socketPath?{socketPath}:{hostname:'127.0.0.1',port}),path:'/',method:'POST',headers:{'content-type':'application/json','content-length':raw.length},timeout:15000,signal},async response=>{
  try{if(response.statusCode!==200)throw Error('upstream refused');yes(await bounded(response,RESPONSE))}catch(e){response.destroy();no(e)}
 });request.on('timeout',()=>request.destroy(Error('upstream timeout')));request.on('error',no);request.end(raw);
})}
export async function startTransport({mode,socket=SOCKET,port=26667,upstreamPort=26667,maxConcurrent=16,chainId=ORIGINAL_CHAIN}={}){
 if(!validChain(chainId))throw Error('fixed public chain required');
 if(!['host','bridge'].includes(mode)||!Number.isInteger(port)||port<1024||port>65535||!Number.isInteger(upstreamPort)||upstreamPort<1024||upstreamPort>65535||!Number.isInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>32||!socket.startsWith('/'))throw Error('fixed local transport required');
 if(mode==='host'){try{await lstat(socket);throw Error('new socket required')}catch(e){if(e.code!=='ENOENT')throw e}}
 let active=0;
 const server=http.createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');
  if(req.method!=='POST'||req.url!=='/'||req.headers['content-type']?.split(';')[0]!=='application/json'){res.writeHead(404);res.end('{}');return}
  if(active>=maxConcurrent){res.writeHead(503);res.end('{}');return}active++;
  const abort=new AbortController();res.once('close',()=>abort.abort());
  const timer=setTimeout(()=>{abort.abort();req.destroy();res.destroy()},20000);timer.unref();
  try{
   const raw=await bounded(req,REQUEST),frame=validateFrame(JSON.parse(raw),chainId);
   const output=await relay(mode==='host'?{port:upstreamPort}:{socketPath:socket},raw,AbortSignal.any([abort.signal,AbortSignal.timeout(15000)])),reply=JSON.parse(output);
   if(reply.jsonrpc!=='2.0'||reply.id!==frame.id)throw Error('RPC reply differs');
   res.writeHead(200);res.end(output);
  }catch{if(!res.destroyed){res.writeHead(400);res.end('{}')}}finally{clearTimeout(timer);active--}
 });
 server.requestTimeout=20000;server.headersTimeout=10000;server.keepAliveTimeout=1000;server.maxRequestsPerSocket=100;
 server.on('clientError',(_e,s)=>s.destroy());
 await new Promise((yes,no)=>{server.once('error',no);mode==='host'?server.listen(socket,yes):server.listen(port,'127.0.0.1',yes)});
 if(mode==='host')await chmod(socket,0o660);
 return server;
}
export async function runProjection(options={}){
 const server=await startTransport({...options,mode:'bridge'});
 const child=spawn(process.execPath,['dist/src/native/worker.js'],{stdio:'inherit'});
 const term=()=>child.kill('SIGTERM'),interrupt=()=>child.kill('SIGINT');
 process.once('SIGTERM',term);process.once('SIGINT',interrupt);
 try{return await new Promise((yes,no)=>{child.once('error',no);child.once('close',code=>yes(code??1))})}
 finally{process.removeListener('SIGTERM',term);process.removeListener('SIGINT',interrupt);server.closeAllConnections();await new Promise(r=>server.close(r))}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  if(process.argv.length!==3)throw Error('host, bridge or projection required');
  const projection=process.argv[2]==='projection';
  if(projection){
   // The bridge is listening before the worker starts. It exits with the
   // bounded worker instead of leaving a sidecar that prevents Job completion.
   process.exitCode=await runProjection({chainId:process.env.UAIN_NATIVE_CHAIN_ID??ORIGINAL_CHAIN});
  }else{
   const server=await startTransport({mode:process.argv[2],chainId:process.env.UAIN_NATIVE_CHAIN_ID??ORIGINAL_CHAIN});
   for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{server.closeAllConnections();server.close(()=>process.exit(0))});
  }
 }catch{console.error('Local native RPC transport refused startup.');process.exitCode=1}
}
