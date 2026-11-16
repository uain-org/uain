/** Long, isolated HTTP/store qualification. Never calls production HTTP or config. */
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {monitorEventLoopDelay,performance} from 'node:perf_hooks';

export const percentile=(values,p=.95)=>{const a=[...values].sort((x,y)=>x-y);return Math.round(a[Math.min(a.length-1,Math.floor(a.length*p))]??0);};
export function checkRecords(actual,attempted,acknowledged){
 const seen=new Set();let uncertainCommitted=0;
 for(const row of actual){const key=row.clientRequestId;assert.ok(attempted.has(key),'unattempted record');assert.ok(!seen.has(key),'duplicate intent');seen.add(key);const expected=attempted.get(key);for(const[k,v]of Object.entries(expected))assert.deepEqual(row[k],v,`changed ${key}/${k}`);if(!acknowledged.has(key))uncertainCommitted++;}
 for(const key of acknowledged)assert.ok(seen.has(key),`lost acknowledged record ${key}`);
 return{records:actual.length,acknowledged:acknowledged.size,uncertainCommitted};
}
export async function withAttemptJournal(journal,key,expires,send){journal.set(key,{expires,preauth:false,status:null,ambiguous:true});return send();}
export async function drainedSnapshot(close,read){await close();return read();}
export async function runSoak({minutes=30,cycleSeconds=30,release='/opt/baink/releases/20261104T173604Z-3dd7516943',transport,transportSha,output,port=18997,allowShort=false,serverFactory=null,serverStats=null,dataRoot=null}={}){
 assert.ok(Number.isFinite(minutes)&&minutes>0&&minutes<=40&&(allowShort||minutes>=30));assert.ok(cycleSeconds>=5&&cycleSeconds<=60);assert.equal(resolve(release),'/opt/baink/releases/20261104T173604Z-3dd7516943');assert.ok(output&&transport&&/^[a-f0-9]{64}$/.test(transportSha));assert.ok(Number.isInteger(port)&&port>=18000&&port<=19000);
 const manifest=JSON.parse(await readFile(join(release,'release-manifest.json'),'utf8'));assert.equal(manifest.version,'0.3.23');for(const[p,h]of Object.entries(manifest.files)){assert.equal(createHash('sha256').update(await readFile(join(release,p))).digest('hex'),h,`immutable release ${p}`);}
 assert.equal(createHash('sha256').update(await readFile(transport)).digest('hex'),transportSha);const{api,createIdentity}=await import(pathToFileURL(transport));const createBainkServer=serverFactory?null:(await import(pathToFileURL(join(release,'server/app.mjs')))).createBainkServer;
 const originalFetch=globalThis.fetch,originalLocation=globalThis.location,origin=`http://127.0.0.1:${port}`,dir=await mkdtemp(join(dataRoot??tmpdir(),'baink-soak-')),start=performance.now(),duration=minutes*60000,deadline=start+duration+300000;
 const people=[];for(let i=0;i<200;i++)people.push(await createIdentity());const index=new Map(people.map((p,i)=>[p.publicKeyBase64,i]));
 const attemptedRequests=new Map(),ackedRequests=new Set(),attemptedMessages=new Map(),ackedMessages=new Set(),conversations=[],wire=new Map(),cycles=[],checkpoints=[];let app,current=null,cycle=0,lastReplay=null,acceptedWire=0,wireCount=0,completed=false;
 const eventLoop=monitorEventLoopDelay({resolution:20});eventLoop.enable();globalThis.location={origin};
 const counts={success:0,refused:0,ambiguous:0};const allowedRefusals=new Set(['busy','client_busy','storage_busy','member_nonce_limit','rate_limited']);
 globalThis.fetch=async(path,options)=>{
  assert.ok(performance.now()<deadline,'global fixture deadline');assert.ok(typeof path==='string'&&path.startsWith('/api/'),'loopback-only fixture');const actor=index.get(options.headers['X-BAINK-Public-Key']);assert.notEqual(actor,undefined);
  const nonce=options.headers['X-BAINK-Nonce'],key=people[actor].address+':'+nonce,begin=performance.now();wireCount++;
  try{const headers={...options.headers,Origin:origin,'X-Real-IP':`192.0.2.${actor+1}`};const r=await withAttemptJournal(wire,key,Number(headers['X-BAINK-Timestamp'])+300000,()=>originalFetch(origin+path,{...options,headers}));const body=await r.clone().json().catch(()=>({}));const preauth=(r.status===503&&body.error?.code==='busy')||(r.status===429&&body.error?.code==='client_busy');wire.set(key,{expires:Number(headers['X-BAINK-Timestamp'])+300000,preauth,status:r.status,ambiguous:false});if(!preauth&&r.status!==401)acceptedWire++;if(current){current.wireAttempts++;current.statuses[r.status]=(current.statuses[r.status]??0)+1;current.wireMs.push(performance.now()-begin);}if(r.ok&&options.method==='GET')lastReplay={path,headers};return r;
  }catch(e){if(current)current.network[e.name]=(current.network[e.name]??0)+1;throw e;}
 };
 const disk=async()=>JSON.parse(await readFile(join(dir,'state.json'),'utf8'));
 async function startServer(){const config={dataDir:dir,publicOrigin:origin,projectsSource:null,catalogueDir:null,trustProxy:true};if(serverFactory)app=await serverFactory({...config,port});else{app=await createBainkServer(config);await new Promise(r=>app.server.listen(port,'127.0.0.1',r));}}
 async function op(identity,path,{method='GET',body,required=false,expectedError}={}){
  const begin=performance.now();try{const value=await api(path,{identity,method,...(body?{body}:{})});assert.equal(expectedError,undefined,'expected authorization refusal');counts.success++;if(current)current.success++;return value;
  }catch(e){if(expectedError){assert.equal(e.status,expectedError);counts.success++;if(current)current.success++;return null;}if(allowedRefusals.has(e.code)&&[429,503].includes(e.status)){counts.refused++;if(current){current.refused++;current.errors[e.code]=(current.errors[e.code]??0)+1;}if(required)throw e;return null;}if(['TimeoutError','AbortError','TypeError'].includes(e.name)){counts.ambiguous++;if(current){current.ambiguous++;current.errors[e.name]=(current.errors[e.name]??0)+1;}if(required)throw e;return null;}throw e;
  }finally{if(current)current.opMs.push(performance.now()-begin);}
 }
 async function parallel(items,n,fn){let cursor=0;await Promise.all(Array.from({length:Math.min(n,items.length)},async()=>{while(cursor<items.length){const i=cursor++;await fn(items[i],i);}}));}
 async function checkpoint(label){
  const before=await drainedSnapshot(async()=>{await app.close();app=null;},disk);const requestResult=checkRecords(Object.values(before.requests),attemptedRequests,ackedRequests);const allMessages=Object.values(before.peerMessages.conversations).flatMap(c=>c.messages);const messageResult=checkRecords(allMessages,attemptedMessages,ackedMessages);assert.equal(Object.keys(before.accounts).length,200);assert.equal(Object.keys(before.peerMessages.conversations).length,200);
  let preauthRefusalsChecked=0;for(const[k,v]of wire){if(v.preauth){assert.equal(Object.hasOwn(before.nonces,k),false,'preauth refusal reserved nonce');preauthRefusalsChecked++;}if(v.expires<Date.now()-60000)wire.delete(k);}for(const key of Object.keys(before.nonces))assert.ok(wire.has(key),'unknown durable nonce');
  await startServer();const after=await disk();assert.deepEqual(after,before,'restart changed persisted store');
  if(lastReplay&&Number(lastReplay.headers['X-BAINK-Timestamp'])+300000>Date.now()){const r=await originalFetch(origin+lastReplay.path,{headers:lastReplay.headers});assert.equal(r.status,409);assert.equal((await r.json()).error.code,'replay_detected');}
  await parallel(people.slice(0,12),4,async(p,i)=>{assert.equal((await op(p,'/api/account',{required:true})).account.address,p.address);await op(people[(i+3)%200],`/api/messages/conversations/${conversations[i].id}`,{expectedError:404,required:true});});
  const stateBytes=Buffer.byteLength(JSON.stringify(after)),result={label,elapsedSeconds:Math.round((performance.now()-start)/1000),requests:requestResult,messages:messageResult,stateBytes,preauthRefusalsChecked,rss:process.memoryUsage().rss,eventLoopP95ms:Math.round(eventLoop.percentile(95)/1e6),eventLoopMaxMs:Math.round(eventLoop.max/1e6)};checkpoints.push(result);console.log(JSON.stringify({checkpoint:result}));await writeFile(output,JSON.stringify({status:'running',fixtureOnly:true,productionRequests:0,productionWrites:false,minutes,release:manifest.release,counts,cycles,checkpoints},null,2)+'\n');
 }
 try{
  await startServer();await parallel(people,16,async(p,i)=>{const a=(await op(p,'/api/account',{method:'POST',body:{displayName:`Fictional soak ${i}`},required:true})).account;assert.equal(a.address,p.address);assert.equal(a.balance,null);});
  await parallel(people,16,async(p,i)=>{conversations[i]=(await op(p,'/api/messages/conversations',{method:'POST',body:{to:people[(i+1)%200].address,clientRequestId:`soak-conversation-${i}`},required:true})).conversation;});
  const soakStart=performance.now();
  for(let phase=0;phase<3;phase++){
   const concurrency=[32,64,100][phase],phaseEnd=soakStart+duration*(phase+1)/3;
   while(performance.now()<phaseEnd){
    const began=performance.now(),id=cycle++;current={cycle:id,concurrency,elapsedSeconds:Math.round((began-start)/1000),wireAttempts:0,statuses:{},network:{},success:0,refused:0,ambiguous:0,errors:{},wireMs:[],opMs:[]};
    await parallel(people,concurrency,async p=>{const a=await op(p,'/api/account');if(a)assert.equal(a.account.address,p.address);});
    await parallel(Array.from({length:96},(_,i)=>people[(i+id*96)%200]),concurrency,async(p,i)=>{const clientRequestId=`soak-request-${id}-${i}`,body={to:people[(index.get(p.publicKeyBase64)+1)%200].address,amount:'0.000001',memo:`Fictional metadata request ${id}/${i}`,clientRequestId};attemptedRequests.set(clientRequestId,{...body,from:p.address,currency:'AI$'});const r=await op(p,'/api/requests',{method:'POST',body});if(r){ackedRequests.add(clientRequestId);assert.equal(r.request.clientRequestId,clientRequestId);if(i<8){const again=await op(p,'/api/requests',{method:'POST',body});if(again)assert.equal(again.request.id,r.request.id);}}});
    await parallel(Array.from({length:48},(_,i)=>(i+id*48)%200),concurrency,async actor=>{const p=people[actor],clientRequestId=`soak-message-${id}-${actor}`,body={body:`Fictional private metadata ${id}/${actor}`,clientRequestId};attemptedMessages.set(clientRequestId,{clientRequestId,body:body.body,from:p.address,conversationId:conversations[actor].id});const r=await op(p,`/api/messages/conversations/${conversations[actor].id}/messages`,{method:'POST',body});if(r)ackedMessages.add(clientRequestId);});
    const{wireMs,opMs,...rest}=current;cycles.push({...rest,durationMs:Math.round(performance.now()-began),wireP95ms:percentile(wireMs),opP95ms:percentile(opMs),rss:process.memoryUsage().rss,...(serverStats?{server:await serverStats()}:{} )});console.log(JSON.stringify({cycle:cycles.at(-1)}));current=null;
    if(cycle%5===0)await checkpoint(`cycle-${cycle}`);
    const wait=Math.min(phaseEnd-performance.now(),cycleSeconds*1000-(performance.now()-began));if(wait>0)await new Promise(r=>setTimeout(r,wait));
   }
   await checkpoint(`phase-${concurrency}`);
  }
  assert.ok(performance.now()-soakStart>=duration,'short soak');await checkpoint('final');
  const result={status:'PASS',fixtureOnly:true,productionRequests:0,productionWrites:false,actualBrowserTransport:true,serverProcessSeparate:Boolean(serverFactory),GUIBrowsers:false,identities:200,simulatedDistinctProxyIPs:true,nativeProofCapacityTested:false,paymentCapacityTested:false,release:manifest.release,transportSha,requestedMinutes:minutes,soakSeconds:Math.round((performance.now()-soakStart)/1000),totalSeconds:Math.round((performance.now()-start)/1000),wireCount,acceptedWire,counts,cycles,checkpoints,maxRSSKiB:process.resourceUsage().maxRSS,eventLoopP95ms:Math.round(eventLoop.percentile(95)/1e6),eventLoopMaxMs:Math.round(eventLoop.max/1e6),externalWriteRetries:false};await writeFile(output,JSON.stringify(result,null,2)+'\n');completed=true;console.log(JSON.stringify({result:'PASS',soakSeconds:result.soakSeconds,counts,checkpoints:checkpoints.length,maxRSSKiB:result.maxRSSKiB}));return result;
 }catch(error){await writeFile(output,JSON.stringify({status:'FAIL',fixtureOnly:true,productionRequests:0,productionWrites:false,error:String(error.stack??error),retainedFixtureDataDir:dir,acknowledgedRequestIds:[...ackedRequests],acknowledgedMessageIds:[...ackedMessages],attemptedRequests:[...attemptedRequests],attemptedMessages:[...attemptedMessages],counts,cycles,checkpoints,totalSeconds:Math.round((performance.now()-start)/1000)},null,2)+'\n');throw error;
 }finally{current=null;await app?.close();eventLoop.disable();globalThis.fetch=originalFetch;globalThis.location=originalLocation;if(completed)await rm(dir,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const a=Object.fromEntries(process.argv.slice(2).map(x=>{const i=x.indexOf('=');assert.ok(x.startsWith('--')&&i>2);return[x.slice(2,i),x.slice(i+1)];}));await runSoak({minutes:Number(a.minutes??30),cycleSeconds:Number(a['cycle-seconds']??30),transport:a.transport,transportSha:a['transport-sha'],output:a.output,allowShort:a['allow-short']==='1',port:Number(a.port??18997)});}
