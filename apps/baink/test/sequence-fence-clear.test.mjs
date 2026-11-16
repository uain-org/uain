// Self-clearing sequence fence: BAINK settles a member's broadcast but
// unreconciled central-earning intent from chain state itself (reads only).
// The central-earning fixture below is copied from central-earning-service.test.mjs.
import test from 'node:test';import assert from 'node:assert/strict';import{generateKeyPairSync,createHash,sign}from'node:crypto';
import{createCentralEarningService}from'../server/central-earning.mjs';import{centralEarningSigningBytes,CENTRAL_POLICY}from'../server/central-earning-command.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex'),OTHER='uain1'+'f'.repeat(40),E='e'.repeat(64);
function fixture({monotonicNow}={}){const pair=generateKeyPairSync('ed25519'),raw=pair.publicKey.export({format:'jwk'}).x,user={publicKey:Buffer.from(raw,'base64url').toString('base64'),address:'uain1'+sha(Buffer.from(raw,'base64url')).slice(0,40)},member={id:user.address,public_key:raw,sequence:'2',licence:'active'};let data={},queue=Promise.resolve(),sends=0,receipt=null,fail=false,proofPatch={};const store={read:()=>structuredClone(data),transact(fn){const p=queue.then(()=>{const next=structuredClone(data),result=fn(next);data=next;return structuredClone(result)});queue=p.catch(()=>{});return p;}};
 const records={['member/'+OTHER]:{id:OTHER,licence:'active'},coin_activation:{policy:'verified-bounties-108t-micro-v1',height:'5',evidence_digest:E},central_earning_activation:{policy:CENTRAL_POLICY,reviewer:OTHER,height:'5',evidence_digest:E},central_task_count:'1','central_task_index/00000000000000000001':{id:'CT-one',project:'P-one'},'central_task/CT-one':{id:'CT-one',project:'P-one',title:'Find a reproducible answer',criteria:'Answer is 42',acceptance_digest:sha('Answer is 42'),eligibility:'hard',eligibility_digest:E,evidence_digest:E,solver_amount:'1000000',reviewer_amount:'200000',state:'open',pending:'',winner:'',reserved:'1200000',paid:'0'},'project/P-one':{id:'P-one',lead:OTHER,state:'active',safety_halted:false},'central_project_budget/P-one':{project:'P-one',manager:OTHER,policy:CENTRAL_POLICY,allocation:'10000000000',lifetime_ceiling:'1000000000000000',round:1,height:'5',evidence_digest:E,reserved:'1200000',paid:'0'},['participation/P-one/'+user.address+'/']:{project:'P-one',member:user.address},coin_supply:{minted:'0',reserved:'1200000',transparent:'0',shielded:'0'}};
 const state={chain_id:'fictional-central',height:'20',app_hash:'c'.repeat(64),event_count:'1'},pins={chainId:state.chain_id,epoch:'a'.repeat(64),verifierSha256:'b'.repeat(64)};const native={configured:true,pins,timeoutMs:5000,async publicState(selection){assert.ok((selection.keys??[]).length<=32);const selected={};for(const k of selection.keys??[])selected[k]=records[k]??null;return{state:{...state,member:structuredClone(member),records:structuredClone(selected),...(selection.receipt?{receipt}:{} )},proof:{authority:'native',...pins,genesisSha256:pins.epoch,height:state.height,appHash:state.app_hash,headerTime:new Date().toISOString(),maxAgeSeconds:120,...proofPatch}};},async broadcastCentral(envelope){sends++;assert.ok(Object.values(store.read().centralEarningIntents).some(i=>i.sendAttemptedAt&&i.envelope));if(fail)throw Error('lost reply');return{accepted:true,code:0,transactionHash:sha(JSON.stringify(envelope)).toUpperCase()};}};const service=createCentralEarningService({store,native,enabled:true,monotonicNow});const body={operation:'central_submit',payload:{id:'CS-one',task:'CT-one',evidence:'42',evidence_digest:sha('42')}};return{service,store,user,member,native,records,state,body,get sends(){return sends},lose(){fail=true},patchProof(v){proofPatch=v},signed(i){return{envelope:{command:i.command,public_key:raw,signature:sign(null,centralEarningSigningBytes(i.command),pair.privateKey).toString('base64url')}}},finalize(i){member.sequence='3';state.height='22';state.event_count='2';records['central_submission/CS-one']={...body.payload,task:'CT-one',author:user.address,state:'under_review',height:'21'};receipt={authority:'native',finalized:true,chain_id:state.chain_id,state_height:'22',app_hash:state.app_hash,event:{id:'2',height:'21',member:user.address,operation:'central_submit',subject:'CS-one',command_digest:i.commandDigest}};records['event/00000000000000000002']=receipt.event;return receipt;}};}
import{createSequenceFenceClearer,pendingCentralIntents}from'../server/sequence-fence-clear.mjs';
import{hasPendingNativeSend}from'../server/native-sequence-fence.mjs';

async function held(){const f=fixture(),{intent}=await f.service.prepare(f.user,f.body);await f.service.submit(f.user,intent.id,f.signed(intent));assert.equal(hasPendingNativeSend(f.store.read(),f.user.address),true,'a sent step holds the sequence');return{f,intent};}
const clearer=(f,o={})=>{let reads=0;const c=createSequenceFenceClearer({store:f.store,reconcile:async(u,id,b)=>{reads++;return f.service.reconcile(u,id,b);},...o});return{c,get reads(){return reads}};};

test('BAINK finalizes an included central intent itself and releases the fence, with no new broadcast',async()=>{
 const{f,intent}=await held();const{c}=clearer(f);
 assert.equal(await c.clear(f.user.address),false,'not yet on chain: still held');
 assert.equal(hasPendingNativeSend(f.store.read(),f.user.address),true);
 f.finalize(intent);
 assert.equal(await c.clear(f.user.address,{force:true}),true);
 const row=f.store.read().centralEarningIntents[intent.id];assert.equal(row.status,'finalized');assert.equal(row.result.paid,false);
 assert.equal(hasPendingNativeSend(f.store.read(),f.user.address),false);assert.equal(f.sends,1,'reconcile never re-broadcasts');
});

test('a definite CheckTx refusal still waits for proved expiry; then BAINK releases it as expired-unused',async()=>{
 const f=fixture(),{intent}=await f.service.prepare(f.user,f.body);let sends=0;f.native.broadcastCentral=async envelope=>{sends++;return{accepted:false,code:5,transactionHash:sha(JSON.stringify(envelope)).toUpperCase()};};
 await f.service.submit(f.user,intent.id,f.signed(intent));const{c}=clearer(f,{minIntervalMs:0});
 assert.equal(await c.clear(f.user.address),false,'refused names the hash, but inclusion is still possible before expiry');
 f.state.height=String(BigInt(intent.command.expires_height)+1n);f.member.sequence='3';
 assert.equal(await c.clear(f.user.address),false,'a moved sequence is not proof of non-inclusion');
 f.member.sequence='2';assert.equal(await c.clear(f.user.address),true);
 assert.equal(f.store.read().centralEarningIntents[intent.id].status,'expired-unused');assert.equal(sends,1,'never re-sent or re-signed');
});

test('reader outage or a wrong receipt never releases the fence',async()=>{
 const{f,intent}=await held();const{c}=clearer(f,{minIntervalMs:0});const read=f.native.publicState;
 f.native.publicState=async()=>{throw Error('outage');};assert.equal(await c.clear(f.user.address),false);
 f.native.publicState=read;const r=f.finalize(intent);r.event.command_digest='f'.repeat(64);f.records['event/00000000000000000002'].command_digest='f'.repeat(64);
 assert.equal(await c.clear(f.user.address),false);assert.equal(hasPendingNativeSend(f.store.read(),f.user.address),true);
});

test('reads are paced per intent, shared per member, and bounded per sweep',async()=>{
 const{f,intent}=await held();let clock=0;const t=clearer(f,{now:()=>clock,minIntervalMs:15000});
 await Promise.all([t.c.clear(f.user.address),t.c.clear(f.user.address),t.c.clear(f.user.address)]);assert.equal(t.reads,1,'concurrent callers share one read');
 await t.c.clear(f.user.address);assert.equal(t.reads,1,'paced: no second read inside the interval');
 clock=15000;await t.c.sweep();assert.equal(t.reads,2);
 f.finalize(intent);clock=30000;const out=await t.c.sweep();assert.deepEqual(out.map(x=>x.status),['finalized']);
 assert.deepEqual(pendingCentralIntents(f.store.read(),f.user.address),[]);
 await t.c.sweep();assert.equal(t.reads,3,'nothing left to read');
});

test('only sent intents with a journaled envelope are read; unsent and foreign rows are ignored',async()=>{
 const owner='uain1'+'a'.repeat(40),other='uain1'+'b'.repeat(40);let reads=0;
 const state={centralEarningIntents:{a:{id:'a',member:owner,status:'prepared',sendAttemptedAt:null,envelope:null},b:{id:'b',member:other,command:{member:other},status:'unknown',sendAttemptedAt:'x',envelope:{},publicKey:'A'.repeat(43)},c:{id:'c',member:owner,status:'finalized',sendAttemptedAt:'x',envelope:{}}}};
 const c=createSequenceFenceClearer({store:{read:()=>structuredClone(state)},reconcile:async()=>{reads++;return{intent:{status:'unknown'}};}});
 assert.equal(await c.clear(owner),true);assert.equal(reads,0);assert.equal(await c.clear('not-an-address'),false);
});
