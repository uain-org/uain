import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeConfig,nativeSubmit,handleNative} from '../dist/src/api/native-routes.js';
test('native namespace refuses incomplete/unconfigured authority without SQL fallback',async()=>{
 assert.equal(nativeConfig({}),null);
 assert.throws(()=>nativeConfig({UAIN_NATIVE_RPC:'https://rpc.example'}),/pins/);
 let reply;assert.equal(await handleNative({method:'POST'},null,new URL('https://uain.test/api/native/state'),(_,status,body)=>reply={status,body},()=>{},()=>{throw Error('must not read body or SQL when unconfigured')},{}),true);
 assert.equal(reply.status,503);assert.equal(reply.body.error,'native_authority_not_configured');
 assert.equal(await handleNative({method:'POST'},null,new URL('https://uain.test/api/native/receipt'),(_,status,body)=>reply={status,body},()=>{},()=>{throw Error('must not read body when unconfigured')},{}),true);
 assert.equal(reply.status,503);
});
test('native gateway forwards only bounded locally signed envelopes and never claims CheckTx finality',async()=>{
 const envelope={command:{version:1},public_key:'public',signature:'signed'};
 let forwarded;
 const transport=async(url,request)=>{forwarded=JSON.parse(request.body);return{ok:true,text:async()=>JSON.stringify({result:{code:0,hash:'a'.repeat(64)}})}};
 const result=await nativeSubmit(envelope,{rpc:'https://rpc.example'},transport);
 assert.equal(forwarded.method,'broadcast_tx_sync');assert.deepEqual(JSON.parse(Buffer.from(forwarded.params.tx,'base64')),envelope);
 assert.equal(result.accepted,true);assert.equal(result.finalized,false);
 await assert.rejects(()=>nativeSubmit({...envelope,private_key:'secret'},{rpc:'https://rpc.example'},transport),/locally signed/);
});
test('a refused native command returns the chain reason; a malformed request says what is wrong',async()=>{
 const envelope={command:{version:1},public_key:'public',signature:'signed'};
 const refuse=log=>async()=>({ok:true,text:async()=>JSON.stringify({result:{code:7,hash:'b'.repeat(64),log}})});
 const refused=await nativeSubmit(envelope,{rpc:'https://rpc.example'},refuse('original project membership required\u0000'));
 assert.equal(refused.accepted,false);assert.equal(refused.code,7);assert.equal(refused.reason,'original project membership required');assert.match(refused.next,/new step/);
 const silent=await nativeSubmit(envelope,{rpc:'https://rpc.example'},refuse(''));
 assert.match(silent.reason,/without a stated reason \(code 7\)/);
 assert.equal((await nativeSubmit(envelope,{rpc:'https://rpc.example'},refuse('x'.repeat(2000)))).reason.length,500);
 const ok=await nativeSubmit(envelope,{rpc:'https://rpc.example'},async()=>({ok:true,text:async()=>JSON.stringify({result:{code:0,hash:'a'.repeat(64),log:''}})}));
 assert.equal(ok.accepted,true);assert.equal('reason' in ok,false);
 const env={UAIN_NATIVE_STATE_BINARY:'/bin/false',UAIN_NATIVE_STATE_SHA256:'a'.repeat(64),UAIN_NATIVE_GENESIS:'/dev/null',UAIN_NATIVE_GENESIS_SHA256:'b'.repeat(64),UAIN_NATIVE_RPC:'https://rpc.example'};
 let reply;await handleNative({method:'POST'},null,new URL('https://uain.test/api/native/command'),(_,status,body)=>reply={status,body},()=>{},async()=>({...envelope,private_key:'secret'}),env);
 assert.equal(reply.status,400);assert.equal(reply.body.error,'native_request_invalid');assert.match(reply.body.message,/never a private key/);
});
test('native proof process capacity is bounded and rejects overload without exceeding two children',async()=>{
 const {mkdtemp,writeFile,chmod,readFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{createHash}=await import('node:crypto'),{nativeState}=await import('../dist/src/api/native-routes.js');
 const dir=await mkdtemp(join(tmpdir(),'uain-proof-capacity-'));try{
  const binary=join(dir,'reader'),genesis=join(dir,'genesis'),log=join(dir,'processes');const script=`#!${process.execPath}\nconst fs=require('fs'),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},'start '+process.pid+'\\n');process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{fs.writeFileSync(args[args.indexOf('--out')+1],'{}',{mode:384,flag:'wx'});fs.appendFileSync(${JSON.stringify(log)},'end '+process.pid+'\\n')},80));`;
  await writeFile(binary,script);await chmod(binary,0o700);await writeFile(genesis,'{}');const config={binary,binaryHash:createHash('sha256').update(script).digest('hex'),genesis,genesisHash:createHash('sha256').update('{}').digest('hex'),rpc:'http://127.0.0.1:1'};
  const results=await Promise.allSettled(Array.from({length:20},()=>nativeState({keys:[]},config)));assert.ok(results.some(r=>r.status==='rejected'&&/capacity/.test(String(r.reason))),'overload must refuse without creating another process');let active=0,max=0;for(const line of (await readFile(log,'utf8')).trim().split('\n')){active+=line.startsWith('start ')?1:-1;max=Math.max(max,active)}assert.equal(active,0);assert.ok(max<=2,`native proof children exceeded capacity: ${max}`);
 }finally{await rm(dir,{recursive:true,force:true})}
});
