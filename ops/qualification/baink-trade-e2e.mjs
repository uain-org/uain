// Isolated qualification of the deployed immutable release. Never points at production HTTP/data.
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash,randomBytes,sign} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBainkServer} from '/opt/baink/releases/20261104T143644Z-6f1439aefe/server/app.mjs';
const origin='http://127.0.0.1:18997',started=performance.now(),dir=await mkdtemp(join(tmpdir(),'baink-trade-e2e-'));
const people=Array.from({length:200},(_,i)=>{const pair=generateKeyPairSync('ed25519'),raw=pair.publicKey.export({format:'der',type:'spki'}).subarray(-32);return {privateKey:pair.privateKey,publicKey:raw.toString('base64'),address:'uain1'+createHash('sha256').update(raw).digest('hex').slice(0,40),ip:`192.0.2.${i+1}`};});
function canonical(v){if(Array.isArray(v))return`[${v.map(canonical).join(',')}]`;if(v&&typeof v==='object')return`{${Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')}}`;return JSON.stringify(v);}
function headers(who,method,path,body){const nonce=randomBytes(24).toString('base64url'),timestamp=Date.now().toString();return {'X-BAINK-Public-Key':who.publicKey,'X-BAINK-Nonce':nonce,'X-BAINK-Timestamp':timestamp,'X-BAINK-Signature':sign(null,Buffer.from(canonical({audience:origin,method,path,body,nonce,timestamp})),who.privateKey).toString('base64')};}
let app,active;
const phases=[],checks={};
async function start(){app=await createBainkServer({dataDir:dir,publicOrigin:origin,projectsSource:null,catalogueDir:null,trustProxy:true,tradeMode:'open'});await new Promise(r=>app.server.listen(18997,'127.0.0.1',r));}
async function call(who,method,path,body={},signedHeaders){assert.ok(performance.now()-started<150000,'qualification deadline');const begin=performance.now();const r=await fetch(origin+path,{method,headers:{Origin:origin,'Content-Type':'application/json','X-Real-IP':who?.ip??'198.51.100.1',...(who?(signedHeaders??headers(who,method,path,body)): {})},...(method==='GET'?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(25000)});const result={status:r.status,body:await r.json()};if(active){active.attempts++;active.statuses[r.status]=(active.statuses[r.status]??0)+1;active.times.push(performance.now()-begin);}return result;}
let retryActive=0;const retryQueue=[];
async function retrySlot(work){if(retryActive>=16)await new Promise(r=>retryQueue.push(r));else retryActive++;try{return await work();}finally{const next=retryQueue.shift();if(next)next();else retryActive--;}}
async function ok(who,method,path,body={},expected=[200,201]){const accepted=r=>expected.includes(r.status),busy=r=>[429,503].includes(r.status)&&['busy','client_busy'].includes(r.body.error?.code);let result=await call(who,method,path,body);if(accepted(result))return result.body;if(!busy(result))assert.fail(JSON.stringify({method,path,status:result.status,error:result.body.error}));return retrySlot(async()=>{for(let n=0;n<8;n++){await new Promise(r=>setTimeout(r,80+Math.floor(Math.random()*80)+80*n));result=await call(who,method,path,body);if(accepted(result))return result.body;if(!busy(result))assert.fail(JSON.stringify({method,path,status:result.status,error:result.body.error}));}assert.fail('bounded admission retries exhausted');});}
async function phase(name,concurrency,items,work){active={name,concurrency,operations:items.length,attempts:0,statuses:{},times:[]};const begin=performance.now();let index=0;await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{while(index<items.length){const i=index++;await work(items[i],i);}}));const p=active;active=null;p.times.sort((a,b)=>a-b);const {times,...rest}=p;phases.push({...rest,p95ms:Math.round(times[Math.min(times.length-1,Math.floor(times.length*.95))]??0),durationMs:Math.round(performance.now()-begin),rss:process.memoryUsage().rss});console.log(JSON.stringify({phase:phases.at(-1)}));}
const flows=Array.from({length:100},(_,i)=>({i,seller:people[i*2],buyer:people[i*2+1]}));
const terms={scope:'Fictional CSV inspection only',deliverables:'Fictional report',price:'0.000001',timeline:'Discussion only',acceptanceCriteria:'No actual service or payment'};
const flags=x=>{assert.equal(x.binding,false);assert.equal(x.settlementAvailable,false);};
try {
await start();
await phase('register-fictional-200',16,people,async(w,i)=>{const x=(await ok(w,'POST','/api/account',{displayName:`Fictional Trade ${i}`})).account;assert.equal(x.balance,null);});
await phase('publish-offers-100',10,flows,async f=>{f.body={clientRequestId:`trade-offer-${f.i}`,title:`Fictional offer ${f.i}`,description:'Disposable qualification; no genuine service',price:'0.000001',publish:true};f.offer=(await ok(f.seller,'POST','/api/trade/offers',f.body)).offer;assert.equal(f.offer.priceUnits,'1');});
await phase('enquiries-100',10,flows,async f=>{f.enquiryBody={clientRequestId:`trade-enquiry-${f.i}`,message:'Fictional interest; not acceptance',expectedRevision:f.offer.revision};f.enquiry=(await ok(f.buyer,'POST',`/api/trade/offers/${f.offer.id}/enquiries`,f.enquiryBody)).enquiry;flags(f.enquiry);assert.equal(f.enquiry.offer.revision,1);});
await phase('recipient-replies-100',10,flows,async f=>{f.conversation=(await ok(f.seller,'POST','/api/messages/conversations',{to:f.buyer.address,clientRequestId:`trade-conversation-${f.i}`})).conversation;await ok(f.seller,'POST',`/api/messages/conversations/${f.conversation.id}/messages`,{body:`Fictional enquiry reply ${f.i}`,clientRequestId:`trade-reply-${f.i}`});const thread=await ok(f.buyer,'GET',`/api/messages/conversations/${f.conversation.id}`);assert.equal(thread.messages[0].body,`Fictional enquiry reply ${f.i}`);});
await phase('author-private-terms-100',10,flows,async f=>{f.list=`/api/trade/enquiries/${f.enquiry.id}/terms`;f.draft=(await ok(f.buyer,'POST',f.list,{clientRequestId:`trade-terms-${f.i}`,terms})).draft;flags(f.draft);assert.equal((await ok(f.seller,'GET',f.list)).draftCount,0);await ok(f.seller,'GET',`/api/trade/terms/${f.draft.id}`,{},[404]);});
await phase('explicit-reviewed-send-100',10,flows,async f=>{f.send={clientRequestId:`trade-send-${f.i}`,expectedRevision:f.draft.revision,confirmNonbinding:true};f.proposal=(await ok(f.buyer,'POST',`/api/trade/terms/${f.draft.id}/send`,f.send)).proposal;flags(f.proposal);assert.equal(f.proposal.nonbinding,true);assert.equal(f.proposal.acceptanceAvailable,false);assert.equal((await ok(f.seller,'GET',f.list)).proposals[0].id,f.proposal.id);});
const f=flows[0],outsider=people[4],offerPath=`/api/trade/offers/${f.offer.id}`,draftPath=`/api/trade/terms/${f.draft.id}`;
assert.equal((await call(null,'GET',f.list)).status,401);
await ok(outsider,'GET',f.list,{},[404]);await ok(outsider,'GET',`/api/messages/conversations/${f.conversation.id}`,{},[404]);await ok(outsider,'PATCH',offerPath,{price:'2',publish:true},[403]);
await ok(f.buyer,'POST','/api/trade/offers',{...f.body,title:'Changed reused intent'},[201]); // buyer owns a separate namespace
await ok(f.seller,'POST','/api/trade/offers',{...f.body,title:'Conflicting owner intent'},[409]);
const revised=(await ok(f.seller,'PATCH',offerPath,{price:'0.000002',publish:true})).offer;assert.equal(revised.revision,2);
await ok(people[5],'POST',offerPath+'/enquiries',{clientRequestId:'trade-stale-review',message:'Stale quote',expectedRevision:1},[409]);
const changed=(await ok(f.buyer,'PATCH',draftPath,{clientRequestId:'trade-draft-update',expectedRevision:1,terms:{...terms,price:'0.000002'}})).draft;assert.equal(changed.revision,2);
await ok(f.buyer,'POST',draftPath+'/send',{clientRequestId:'trade-stale-terms',expectedRevision:1,confirmNonbinding:true},[409]);
await ok(f.buyer,'POST',draftPath+'/send',{clientRequestId:'trade-no-confirm',expectedRevision:2,confirmNonbinding:false},[400]);
await ok(f.buyer,'POST',draftPath+'/send',{...f.send,expectedRevision:2},[409]);
assert.deepEqual((await ok(f.buyer,'POST',draftPath+'/send',f.send)).proposal,f.proposal);
await ok(f.seller,'POST',offerPath+'/withdraw');assert.deepEqual((await ok(f.buyer,'POST',offerPath+'/enquiries',f.enquiryBody)).enquiry,f.enquiry);
await ok(f.buyer,'POST',draftPath+'/send',{clientRequestId:'trade-withdraw-refuse',expectedRevision:2,confirmNonbinding:true},[409]);
await ok(f.buyer,'POST',draftPath+'/accept',{},[404]);
const pair=flows[1];await ok(pair.seller,'POST','/api/messages/blocks',{address:pair.buyer.address,blocked:true});await ok(pair.buyer,'POST',`/api/messages/conversations/${pair.conversation.id}/messages`,{body:'Blocked reply',clientRequestId:'trade-blocked-reply'},[403]);
const disk=()=>readFile(join(dir,'state.json'),'utf8').then(JSON.parse);const before=await disk();
assert.equal(Object.keys(before.trade.enquiries).length,100);assert.equal(Object.keys(before.tradeTerms.proposals).length,100);assert.equal(Object.keys(before.nativeIntents).length,0);assert.equal(Object.keys(before.nativePaymentIntents??{}).length,0);
await app.close();app=null;await start();
await phase('restart-history-100',10,flows,async f=>{const r=await ok(f.seller,'GET',f.list);assert.deepEqual(r.proposals[0],f.proposal);assert.equal((await ok(f.buyer,'GET',`/api/messages/conversations/${f.conversation.id}`)).messages[0].body,`Fictional enquiry reply ${f.i}`);});
const after=await disk();for(const key of ['trade','tradeTerms','peerMessages'])assert.deepEqual(after[key],before[key]);
assert.deepEqual((await ok(f.buyer,'POST',draftPath+'/send',f.send)).proposal,f.proposal);
console.log(JSON.stringify({result:'PASS',fixtureOnly:true,release:'0.3.22/20261104T143644Z-6f1439aefe',identities:200,tradeFlows:100,checks:{offerEnquiryReplyTerms:true,privateDrafts:true,strictRevisionAndReplay:true,crossOwnerIsolation:true,withdrawAndBlockGuards:true,nonbindingNoSettlement:true,restartPersistence:true},productionWrites:0,realFundsUsed:false,nativeMintTested:false,paymentTested:false,durationMs:Math.round(performance.now()-started),maxRSS:process.resourceUsage().maxRSS,phases},null,2));
}finally{await app?.close();await rm(dir,{recursive:true,force:true});}
