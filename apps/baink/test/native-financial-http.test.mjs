import test from 'node:test';
import { readPersistedState } from '../server/store-sqlite.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID,sign} from 'node:crypto';
import {fixture,member} from './http-fixture.mjs';
import {nativeEarningSigningBytes} from '../server/native-earning.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const localState=people=>({version:1,accounts:Object.fromEntries(people.map(p=>[p.address,{address:p.address,publicKey:p.publicKey,displayName:'Holder',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'}])),requests:{},nonces:{},history:[],nativeIntents:{}});
const disk=f=>Promise.resolve(readPersistedState(f.dataDir));
// 13 November 2026 (FE-3, LV-2): the retired loopback holder is no longer
// reachable from the page, images come only from the site or data:, and HSTS is sent.
test('browser policy permits only same-origin requests and images, and the site sends HSTS',async t=>{
 const f=await fixture(t);const response=await f.request(null,'GET','/api/config');
 const policy=response.headers.get('content-security-policy');
 assert.match(policy,/connect-src 'self';/);
 assert.match(policy,/img-src 'self' data:;/);
 assert.ok(!policy.includes('127.0.0.1')&&!policy.includes('localhost')&&!policy.includes('https:;'));
 assert.equal(response.headers.get('strict-transport-security'),'max-age=31536000; includeSubDomains');
});
async function qualifiedFixture(t,{recovery=false}={}) {
  const payer=member(),payee=member(),stranger=member(),directory=await mkdtemp(join(tmpdir(),'financial-http-reader-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const genesis=JSON.stringify({chain_id:'financial-http'}),genesisFile=join(directory,'genesis.json'),binary=join(directory,'reader');
  await writeFile(genesisFile,genesis);
  const members=Object.fromEntries([payer,payee,stranger].map(p=>[p.address,{id:p.address,public_key:Buffer.from(p.publicKey,'base64').toString('base64url'),sequence:'0',licence:'active',karma:0,creator:false,default_verifier:false,active_projects:0}]));
  // Process-boundary fixture only: cryptographic state verification belongs to
  // the qualified native reader, not this local executable test double.
  const globals={coin_activation:{policy:'verified-bounties-108t-micro-v1',height:'2',evidence_digest:'d'.repeat(64)},private_activation:{policy:'orchard-v2-reviewed-otc-v1',height:'2',evidence_digest:'d'.repeat(64)},coin_supply:{minted:'0',reserved:'0',transparent:'0',shielded:'0'}};
  const script=`#!${process.execPath}\nconst fs=require('fs');let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{const r=JSON.parse(input),members=${JSON.stringify(members)},globals=${JSON.stringify(globals)},records={};for(const k of r.keys||[])records[k]=k.startsWith('member/')?(members[k.slice(7)]??null):(globals[k]??null);const out={chain_id:'financial-http',height:'100',header_time:new Date().toISOString(),app_hash:'c'.repeat(64),event_count:'0',records};if(r.member)out.member=members[r.member]??null;fs.writeFileSync(process.argv[process.argv.indexOf('--out')+1],JSON.stringify(out),{mode:384,flag:'wx'});});\n`;
  await writeFile(binary,script,{mode:0o700});await chmod(binary,0o700);
  const initialState=localState([payer,payee,stranger]);let recoveryId=null;
  if(recovery){
    recoveryId=randomUUID();const command={version:1,chain_id:'financial-http',member:payer.address,sequence:'0',expires_height:'90',operation:'coin_quote',payload:{task:'T-http-recovery',open_event:'00000000000000000001',amount:'1',evidence_digest:'d'.repeat(64)}},bytes=nativeEarningSigningBytes(command),publicKey=Buffer.from(payer.publicKey,'base64').toString('base64url'),envelope={command,public_key:publicKey,signature:sign(null,bytes,payer.privateKey).toString('base64url')},at=new Date().toISOString();
    initialState.nativeEarningIntents={[recoveryId]:{id:recoveryId,member:payer.address,publicKey,clientRequestId:'http-original-earning',identity:JSON.stringify({operation:command.operation,payload:command.payload}),status:'unknown',command,signingBytesBase64:bytes.toString('base64'),commandDigest:hash(bytes),expectedAmount:'1',proof:{authority:'native',chainId:'financial-http',epoch:hash(genesis),genesisSha256:hash(genesis),verifierSha256:hash(script),height:'80',appHash:'c'.repeat(64),headerTime:at,maxAgeSeconds:120},afterEvent:'0',scanCursor:'0',envelope,sendAttemptedAt:at,transactionHash:hash(JSON.stringify(envelope)).toUpperCase(),result:{verified:false,status:'pending'},createdAt:at,updatedAt:at}};
  }
  const f=await fixture(t,{initialState,nativeConfig:{binary,binaryHash:hash(script),genesis:genesisFile,genesisHash:hash(genesis),chainId:'financial-http',rpc:'http://127.0.0.1:1',timeoutMs:1000,maxAgeSeconds:120},nativeEarningEnabled:true,nativePaymentEnabled:true});
  return{f,payer,payee,stranger,recoveryId,removeReader:()=>rm(binary)};
}
test('financial routes require exact signed account ownership and read journals without initializing optional stores',async t=>{
  const owner=member(),unknown=member(),f=await fixture(t,{initialState:localState([owner])});
  for(const path of ['/api/native/earning','/api/native/payments']){
    assert.equal((await f.request(null,'GET',path)).status,401);
    const before=await disk(f);assert.equal((await f.request(unknown,'GET',path)).status,404);assert.deepEqual(await disk(f),before);
    const r=await f.request(owner,'GET',path);assert.equal(r.status,200);assert.deepEqual(r.body,{intents:[]});
    assert.equal((await f.request(owner,'GET',path+'?owner=other')).status,400);
  }
  const state=await disk(f);for(const key of ['nativeEarningIntents','nativePaymentIntents','nativePaymentEffects','nativePaymentRequestLocks'])assert.equal(Object.hasOwn(state,key),false);
  assert.equal((await f.request(owner,'POST','/api/native/earning/readiness',{owner:'other'})).status,400);
  assert.equal((await f.request(owner,'POST','/api/native/earning/discover',{afterEvent:'0',owner:'other'})).status,400);
});
test('public config separates journal availability from qualified holder settlement and public transfer remains fail closed',async t=>{
  const owner=member(),f=await fixture(t,{initialState:localState([owner]),nativeEarningEnabled:true,nativePaymentEnabled:true});
  const config=(await f.request(null,'GET','/api/config')).body;
  assert.equal(config.nativeEarning.enabled,false);assert.deepEqual(config.nativeEarning.narrowOperations,['coin_quote','coin_reserve','coin_claim']);
  assert.equal(config.nativePayments.intentsAvailable,true);assert.equal(config.nativePayments.serverSubmissionEnabled,false);assert.equal(config.nativePayments.holderSubmissionRequired,true);assert.equal(config.nativePayments.recipientConfirmationRequired,true);assert.equal(config.settlement.available,false);
  assert.equal((await f.request(owner,'POST','/api/transfers',{to:member().address,amount:'1',memo:'invoice',clientRequestId:'transfer-http-1'})).status,503);
});
test('payment intent HTTP rejects forged owner/body/query, creates exact amount and keeps unrelated journals private',async t=>{
  const {f,payer,payee,stranger}=await qualifiedFixture(t),body={clientRequestId:'payment-http-01',to:payee.address,amountUnits:'1000001',memo:'Invoice'};
  assert.equal((await f.request(payer,'POST','/api/native/payments/prepare?owner=other',body)).status,400);
  assert.equal((await f.request(payer,'POST','/api/native/payments/prepare',{...body,privateKey:'never'})).status,400);
  const r=await f.request(payer,'POST','/api/native/payments/prepare',body);assert.equal(r.status,201);assert.equal(r.body.intent.amountUnits,'1000001');assert.equal(r.body.intent.memo,'Invoice');
  const path='/api/native/payments/'+r.body.intent.id;
  assert.equal((await f.request(payer,'GET',path)).status,200);assert.equal((await f.request(payee,'GET',path)).status,200);assert.equal((await f.request(stranger,'GET',path)).status,404);
  assert.equal((await f.request(stranger,'GET','/api/native/payments')).body.intents.length,0);
  assert.equal((await f.request(payer,'POST',path+'/confirm',{effects:'a'.repeat(64),chainId:'financial-http',requestDigest:r.body.intent.requestDigest,locallyInspected:true,signature:'bad'})).status,403);
  const after=await disk(f);assert.equal(after.accounts[payer.address].balance,undefined);assert.equal(after.history.length,0);
});
test('only payment-envelope routes admit bounded 32KiB bodies; other routes retain16KiB',async t=>{
  const {f,payer}=await qualifiedFixture(t),id='00000000-0000-4000-8000-000000000000',body={padding:'x'.repeat(17000)};
  assert.equal((await f.request(payer,'POST','/api/native/payments/'+id+'/recover',body)).status,400);
  assert.equal((await f.request(payer,'POST','/api/native/payments/'+id+'/submit',body)).status,400);
  assert.equal((await f.request(payer,'POST','/api/native/payments/'+id+'/agree',body)).status,413);
  assert.equal((await f.request(payer,'POST','/api/native/earning/prepare',body)).status,413);
  assert.equal((await f.request(payer,'POST','/api/native/payments/'+id+'/recover',{padding:'x'.repeat(33000)})).status,413);
});
test('payment-request lock is released only by safe participant abandon, then normal cancel works',async t=>{
  const {f,payer,payee}=await qualifiedFixture(t);
  const request=(await f.request(payee,'POST','/api/requests',{to:payer.address,amount:'1.000001',memo:'Invoice',clientRequestId:'invoice-request-http'})).body.request;
  const prepared=await f.request(payer,'POST','/api/native/payments/prepare',{clientRequestId:'locked-payment-http',to:payee.address,amountUnits:'1000001',requestId:request.id,requestVersion:request.updatedAt});assert.equal(prepared.status,201);
  assert.equal((await f.request(payee,'POST','/api/requests/'+request.id+'/cancel')).status,409);
  assert.equal((await f.request(payer,'POST','/api/requests/'+request.id+'/decline')).status,409);
  assert.equal((await f.request(payee,'POST','/api/native/payments/'+prepared.body.intent.id+'/abandon')).status,200);
  assert.equal((await f.request(payee,'POST','/api/requests/'+request.id+'/cancel')).status,200);
  assert.equal((await disk(f)).requests[request.id].status,'cancelled');
});
test('malformed optional financial stores fail startup rather than being silently replaced',async t=>{
  for(const key of ['nativeEarningIntents','nativePaymentIntents','nativePaymentEffects','nativePaymentRequestLocks'])await assert.rejects(fixture(t,{initialState:{...localState([]),[key]:[]}}),/native|financial|payment|earning/i);
});
test('active native transfers create a memo-bound holder intent, never a fake transfer or balance debit',async t=>{
  const {f,payer,payee}=await qualifiedFixture(t),body={to:payee.address,amount:'1.000001',memo:'Actual private invoice',clientRequestId:'direct-transfer-http'};
  const first=await f.request(payer,'POST','/api/transfers',body);assert.equal(first.status,202);assert.equal(first.body.settled,false);assert.equal(first.body.workflow,'holder-private-payment');assert.equal(first.body.intent.amountUnits,'1000001');assert.equal(first.body.intent.memo,body.memo);
  const again=await f.request(payer,'POST','/api/transfers',body);assert.equal(again.status,202);assert.equal(again.body.intent.id,first.body.intent.id);
  assert.equal((await f.request(payer,'POST','/api/transfers',{...body,memo:'Changed terms'})).status,409);
  const state=await disk(f);assert.equal(state.history.length,0);assert.equal(state.accounts[payer.address].balance,undefined);assert.equal(Object.values(state.nativePaymentIntents).length,1);
  await f.restart();assert.equal((await f.request(payee,'GET','/api/native/payments/'+first.body.intent.id)).status,200);
});
test('request pay starts a version-bound workflow; abandoning permits a new deliberate attempt without closing request',async t=>{
  const {f,payer,payee}=await qualifiedFixture(t),invoice=(await f.request(payee,'POST','/api/requests',{to:payer.address,amount:'2',memo:'Private invoice terms',clientRequestId:'request-pay-http'})).body.request,path='/api/requests/'+invoice.id+'/pay';
  const started=await f.request(payer,'POST',path);assert.equal(started.status,202);assert.equal(started.body.intent.requestId,invoice.id);assert.equal(started.body.intent.requestVersion,invoice.updatedAt);assert.equal(started.body.intent.memo,invoice.memo);assert.equal(started.body.settled,false);
  assert.equal((await f.request(payer,'POST',path)).body.intent.id,started.body.intent.id);assert.equal((await disk(f)).requests[invoice.id].status,'open');
  await f.request(payee,'POST','/api/native/payments/'+started.body.intent.id+'/abandon');
  const next=await f.request(payer,'POST',path);assert.equal(next.status,202);assert.notEqual(next.body.intent.id,started.body.intent.id);assert.equal((await disk(f)).requests[invoice.id].status,'open');
});

test('earning recovery HTTP requires exact signed owner and an empty body with no proof selectors',async t=>{
  const {f,payer,stranger,recoveryId}=await qualifiedFixture(t,{recovery:true}),path='/api/native/earning/'+recoveryId+'/reconcile';
  assert.equal((await f.request(null,'POST',path,{})).status,401);
  assert.equal((await f.request(member(),'POST',path,{})).status,404);
  assert.equal((await f.request(stranger,'POST',path,{})).status,404);
  assert.equal((await f.request(payer,'POST',path+'?height=100',{})).status,400);
  for(const body of [{height:'100'},{sequence:'0'},{recordKey:'coin_quote/T-other'},{envelope:{}}])assert.equal((await f.request(payer,'POST',path,body)).status,400);
  assert.equal((await disk(f)).nativeEarningIntents[recoveryId].status,'unknown');
});
test('earning recovery HTTP persists exact proved expiry without sending and returns its first proof after restart',async t=>{
  const {f,payer,recoveryId,removeReader}=await qualifiedFixture(t,{recovery:true}),path='/api/native/earning/'+recoveryId+'/reconcile',before=(await disk(f)).nativeEarningIntents[recoveryId];
  const response=await f.request(payer,'POST',path,{});assert.equal(response.status,200,JSON.stringify(response.body));const intent=response.body.intent;
  assert.equal(intent.status,'expired-unused');assert.equal(intent.receiptRequired,false);assert.equal(intent.finalized,false);assert.equal(intent.recovery.recordPresent,false);assert.equal(intent.recovery.recordKey,'coin_quote/T-http-recovery');assert.equal(intent.recovery.proof.height,'100');assert.equal(intent.recovery.paid,false);
  assert.deepEqual(intent.envelope,before.envelope);assert.equal(intent.transactionHash,before.transactionHash);assert.equal(intent.sendAttemptedAt,before.sendAttemptedAt);
  await f.restart();await removeReader();const again=await f.request(payer,'POST',path,{});assert.equal(again.status,200);assert.deepEqual(again.body.intent.recovery,intent.recovery);
  const state=await disk(f);assert.equal(state.history.length,0);assert.equal(state.accounts[payer.address].balance,undefined);
});
