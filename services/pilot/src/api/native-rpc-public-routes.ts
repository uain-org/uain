import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {admitNativeSubmit,nativePublicRpcPolicy,NativeSubmitRefused} from './native-routes.js';

const MAX_REQUEST=96*1024,MAX_RESPONSE=8*1024*1024;
async function existingValidator(){
 const image=new URL('../../../native-rpc-transport.mjs',import.meta.url);
 const source=new URL('../../../../../ops/chain/native-rpc-transport.mjs',import.meta.url);
 return (await import((existsSync(fileURLToPath(image))?image:source).href)).validateFrame;
}
/** Public origin compatibility for the independently pinned member verifier.
 * The existing internal transport validates the same frame again. No node port,
 * arbitrary upstream or administrative RPC becomes reachable. A broadcast must also
 * pass the closed relay's policy (operation list, per-key and overall rates) before
 * anything is sent: without it, posting here skipped every off-chain limit (audit F-1). */
/** Each request holds one of `maxConcurrent` slots in this pod until its answer is sent. A caller
 * (the server's hashed client address) holds at most `maxPerCaller` of them, and must finish
 * sending its body within `bodyDeadlineMs`, so one slow uploader cannot keep the path full
 * (audit E-6). BAINK, the only steady caller, sends a few broadcasts a day, one at a time. */
export function createNativeRpcPublicHandler({env=process.env,validate=null,transport=fetch,maxConcurrent=2,maxPerCaller=1,deadlineMs=15000,bodyDeadlineMs=5000}:any={}){
 let active=0;const held=new Map<string,number>();
 return async(req:any,res:any,url:URL,send:any,caller:string=String(req.socket?.remoteAddress??''))=>{
  if(url.pathname!=='/api/native/rpc'||env.UAIN_AUTHORITY!=='native')return false;
  res.setHeader('cache-control','no-store');
  if(req.method!=='POST'){res.setHeader('allow','POST');send(res,405,{error:'method_not_allowed'});return true}
  if(!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type']??''))){send(res,415,{error:'application_json_required'});return true}
  if(url.search){send(res,400,{error:'bounded_native_rpc_required'});return true}
  let rpc:URL;
  try{rpc=new URL(env.UAIN_NATIVE_RPC);if(rpc.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(rpc.hostname)||rpc.username||rpc.password||rpc.pathname!=='/'||rpc.search||rpc.hash)throw Error('fixed loopback required')}
  catch{send(res,503,{error:'native_rpc_unavailable'});return true}
  const mine=held.get(caller)??0;
  if(mine>=maxPerCaller){res.setHeader('retry-after','1');send(res,429,{error:'native_rpc_caller_busy'});return true}
  if(active>=maxConcurrent){send(res,503,{error:'native_rpc_capacity_reached'});return true}
  active++;held.set(caller,mine+1);
  const abort=new AbortController();
  const cancel=()=>{abort.abort();if(!req.destroyed)req.destroy?.(Error('native RPC request ended'))};
  const disconnected=()=>{if(!res.writableEnded)cancel()};
  const timer=setTimeout(cancel,deadlineMs);timer.unref();
  const bodyTimer=setTimeout(cancel,Math.min(bodyDeadlineMs,deadlineMs));bodyTimer.unref();
  req.once?.('aborted',cancel);res.once?.('close',disconnected);
  try{
   const chunks=[];let bytes=0;
   for await(const chunk of req){bytes+=chunk.length;if(bytes>MAX_REQUEST){send(res,413,{error:'native_rpc_request_too_large'});return true}chunks.push(Buffer.from(chunk))}
   clearTimeout(bodyTimer);
   let frame;
   try{frame=JSON.parse(Buffer.concat(chunks).toString('utf8'));(validate??await existingValidator())(frame,env.UAIN_NATIVE_CHAIN_ID??'uain-shadow-20261008-1')}
   catch{send(res,400,{error:'bounded_native_rpc_required'});return true}
   if(frame.method==='broadcast_tx_sync'){
    try{admitNativeSubmit(JSON.parse(Buffer.from(frame.params.tx,'base64').toString('utf8')),nativePublicRpcPolicy(env))}
    catch(error){
     if(!(error instanceof NativeSubmitRefused)){send(res,400,{error:'bounded_native_rpc_required'});return true}
     if(error.retryAfter)res.setHeader('retry-after',String(error.retryAfter));
     send(res,error.status,{error:error.code,message:error.message,...(error.retryAfter?{retryAfter:error.retryAfter}:{})});return true;
    }
   }
   if(abort.signal.aborted)throw Error('native RPC deadline');
   const response=await transport(rpc.origin,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(frame),redirect:'error',signal:abort.signal});
   if(!response.ok||!response.body)throw Error('native upstream refused');
   const parts=[];let received=0;
   for await(const part of response.body){received+=part.length;if(received>MAX_RESPONSE)throw Error('native response exceeds bound');parts.push(Buffer.from(part))}
   const reply=JSON.parse(Buffer.concat(parts).toString('utf8'));
   if(reply.jsonrpc!=='2.0'||reply.id!==frame.id)throw Error('native RPC response differs');
   if(!res.destroyed&&!res.headersSent)send(res,200,reply);return true;
  }catch{if(!res.destroyed&&!res.headersSent)send(res,503,{error:'native_rpc_unavailable'});return true}
  finally{clearTimeout(timer);clearTimeout(bodyTimer);req.off?.('aborted',cancel);res.off?.('close',disconnected);active--;const left=(held.get(caller)??1)-1;if(left>0)held.set(caller,left);else held.delete(caller)}
 };
}
export const handleNativeRpcPublicRoutes=createNativeRpcPublicHandler();
