// Real native absence/expiry qualification on the caller's disposable network.
// The proxy forwards every proof query unchanged and withholds one exact
// fictional broadcast before it can reach either native node.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {fixture} from './http-fixture.mjs';
import {signedEnvelope} from '../../../chain/client/signing.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function exerciseNativeEarningRecovery({t,network}) {
  assert.equal(process.env.UAIN_FINANCIAL_E2E,'1');
  assert.equal(process.env.UAIN_FINANCIAL_EARNING_RECOVERY_E2E,'1');
  assert.match(network.config.chainId,/^baink-fictional-e2e-[a-f0-9]{12}$/);
  assert.match(network.config.rpc,/^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(network.people.sender.member.name,/^Fictional /);
  const {sender}=network.people,task='T-fictional-unused-quote';
  const evidence=sha('Fictional withheld earning recovery only; no work or monetary claim');
  const priorArt={basis:'Fictional disposable recovery qualification, never a production novelty assertion or a paid result.',searches:['fictional recovery first query','fictional recovery second query']};
  await network.submit('open_task',{id:task,project:'P-fictional-baink',title:'Fictional unused quote recovery',class:'benevolent',prior_art:priorArt,criteria:'Disposable command expiry and exact absence only; no accepted research.',kind:'instant',karma_reward:1,credit_reward:'1',verifiers_required:2},sender);
  const opening=(await network.read({})).state.event_count.padStart(20,'0');
  let broadcasts=0,captured=null;
  const proxy=createServer(async(req,res)=>{
    try {
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;assert.ok(size<=131072);chunks.push(chunk)}
      const bytes=Buffer.concat(chunks),call=req.method==='POST'&&bytes.length?JSON.parse(bytes):null;
      if(call?.method?.startsWith('broadcast')) {
        const tx=Buffer.from(call.params.tx,'base64'),envelope=JSON.parse(tx);
        assert.equal(envelope.command.operation,'coin_quote');
        assert.equal(envelope.command.member,sender.address);
        assert.equal(envelope.command.payload.task,task);
        broadcasts++;captured={envelope,transactionHash:sha(tx).toUpperCase()};
        res.setHeader('content-type','application/json');
        res.end(JSON.stringify({jsonrpc:'2.0',id:call.id,error:{code:-32000,message:'Explicit fictional transport withheld before any broadcast'}}));
        return;
      }
      const target=new URL(req.url,network.config.rpc);
      assert.equal(target.origin,new URL(network.config.rpc).origin);
      const answer=await fetch(target,{method:req.method,headers:{'content-type':'application/json'},...(req.method==='POST'?{body:bytes}:{}),signal:AbortSignal.timeout(12000)});
      res.writeHead(answer.status,{'content-type':'application/json'});
      res.end(Buffer.from(await answer.arrayBuffer()));
    } catch {
      res.writeHead(502,{'content-type':'application/json'});
      res.end(JSON.stringify({error:{code:-32001,message:'Fictional proxy failed; no absence inferred'}}));
    }
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve))});
  const f=await fixture(t,{nativeConfig:{...network.config,rpc:`http://127.0.0.1:${proxy.address().port}`},nativeEarningEnabled:true});
  async function request(path,body={},status=200){const r=await f.request(sender,'POST',path,body);assert.equal(r.status,status,`${path}: ${JSON.stringify(r.body)}`);return r.body}
  await request('/api/account',{displayName:'Fictional withheld earning holder'},201);
  const prepareBody={operation:'coin_quote',payload:{task,open_event:opening,amount:'1000000',evidence_digest:evidence}};
  const prepared=(await request('/api/native/earning/prepare',{...prepareBody,clientRequestId:'fictional-withheld-quote'},201)).intent;
  const envelope=signedEnvelope(prepared.command,Buffer.from(sender.member.public_key,'base64url'),sender.privateKey);
  const old=(await request(`/api/native/earning/${prepared.id}/submit`,{envelope},202)).intent;
  assert.equal(old.status,'unknown');assert.equal(broadcasts,1);
  assert.equal(old.transactionHash,captured.transactionHash);
  assert.deepEqual(captured.envelope,envelope);
  const frozen=JSON.stringify({envelope:old.envelope,commandDigest:old.commandDigest,transactionHash:old.transactionHash,sendAttemptedAt:old.sendAttemptedAt});
  const key=`coin_quote/${task}`,selection={member:sender.address,keys:[key,'coin_supply']};
  const before=await network.read(selection);
  assert.equal(before.state.records[key],null);
  assert.equal(before.state.member.sequence,old.command.sequence);
  assert.ok(BigInt(before.state.height)<=BigInt(old.command.expires_height));
  await request(`/api/native/earning/${old.id}/reconcile`,{},409);
  await request('/api/native/earning/prepare',{...prepareBody,clientRequestId:'fictional-too-early-replacement'},409);
  // RPC height is only a progress hint. Reconciliation itself uses the actual
  // pinned reader's authenticated member and immutable-result nonmembership.
  // The pinned daemon produces blocks about every two seconds: allow the
  // unchanged production100-block expiry plus scheduling/finality margin.
  const deadline=Date.now()+300000;
  while(BigInt((await network.rpc(0,'status')).sync_info.latest_block_height)<=BigInt(old.command.expires_height)+1n) {
    assert.ok(Date.now()<deadline,'Disposable native command did not expire within 300 seconds');
    await new Promise(resolve=>setTimeout(resolve,700));
  }
  const absence=await network.read(selection);
  assert.ok(BigInt(absence.state.height)>BigInt(old.command.expires_height));
  assert.equal(absence.state.member.sequence,old.command.sequence);
  assert.equal(absence.state.records[key],null);
  assert.deepEqual(absence.state.records.coin_supply,before.state.records.coin_supply);
  const recovered=(await request(`/api/native/earning/${old.id}/reconcile`)).intent;
  assert.equal(recovered.status,'expired-unused');assert.equal(recovered.finalized,false);
  assert.equal(recovered.recovery.recordKey,key);assert.equal(recovered.recovery.recordPresent,false);
  assert.equal(recovered.recovery.proof.verifierSha256,network.config.binaryHash);
  assert.equal(recovered.recovery.proof.genesisSha256,network.config.genesisHash);
  assert.ok(BigInt(recovered.recovery.proof.height)>BigInt(old.command.expires_height));
  assert.equal(JSON.stringify({envelope:recovered.envelope,commandDigest:recovered.commandDigest,transactionHash:recovered.transactionHash,sendAttemptedAt:recovered.sendAttemptedAt}),frozen);
  assert.equal(broadcasts,1);
  await f.restart();
  assert.deepEqual((await request(`/api/native/earning/${old.id}/reconcile`)).intent.recovery,recovered.recovery);
  assert.equal((await request(`/api/native/earning/${old.id}/submit`,{envelope})).attempted,false);
  assert.equal((await request('/api/native/earning/prepare',{...prepareBody,clientRequestId:'fictional-withheld-quote'})).intent.id,old.id);
  const next=(await request('/api/native/earning/prepare',{...prepareBody,clientRequestId:'fictional-explicit-new-quote'},201)).intent;
  assert.notEqual(next.id,old.id);assert.equal(next.command.sequence,old.command.sequence);
  assert.ok(BigInt(next.command.expires_height)>BigInt(old.command.expires_height));
  assert.equal(broadcasts,1,'Only the original deliberately withheld transport attempt occurred');
  const final=await network.read(selection);
  assert.equal(final.state.records[key],null);assert.equal(final.state.member.sequence,old.command.sequence);
  assert.deepEqual(final.state.records.coin_supply,before.state.records.coin_supply);
  t.diagnostic(JSON.stringify({fixtureOnly:true,chainId:network.config.chainId,genesisSha256:network.config.genesisHash,productionWrites:false,realPinnedNativeAbsenceProof:true,strictPostExpiryHeight:true,unchangedHolderSequence:true,originalEnvelopeRetained:true,restartHistoricalRecovery:true,explicitNewReviewPrepared:true,originalBroadcastToNativeNodes:false,transportAttempts:1,reconciliationBroadcasts:0,coinSupplyUnchanged:true,earned:false,minted:false}));
}
