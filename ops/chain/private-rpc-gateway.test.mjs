import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {generateKeyPairSync} from 'node:crypto';
import {startGateway,validateRPC} from './private-rpc-gateway.mjs';
import {signedEnvelope,memberAddress} from '../../chain/client/signing.mjs';
const frame=(method,params)=>({jsonrpc:'2.0',id:1,method,params});
const query=(key)=>frame('abci_query',{path:'/store/federation/key',data:Buffer.from(key).toString('hex'),height:'9',prove:true});
test('gateway confines queries to bounded wallet state and refuses admin or private extras',()=>{
 for(const key of ['private_activation','coin_supply','member/uain1'+'ab'.repeat(20),'private_root/'+'ac'.repeat(32)])assert.deepEqual(validateRPC(query(key)),query(key));
 assert.ok(validateRPC(frame('commit',{height:null})));
 assert.ok(validateRPC(frame('abci_query',{path:'/store/federation/subspace',data:Buffer.from('private_note/0000000').toString('hex'),height:'9',prove:false})));
 for(const body of [query('operator/private'),query('private_note/'),query('member/uain1x'),{...query('private_activation'),local_receipt:{}},frame('unsafe_flush_mempool',{}),frame('abci_query',{...query('coin_supply').params,prove:false}),frame('commit',{height:'9',secret:'terms'}),frame('abci_query',{...query('coin_supply').params,path:'/store/federation/subspace'})])assert.throws(()=>validateRPC(body));
});
test('gateway serves light-wallet prefix listings and proven nullifiers, never selected listings',()=>{
 const listing=key=>frame('abci_query',{path:'/store/federation/subspace',data:Buffer.from(key).toString('hex'),height:'9',prove:false});
 for(const key of ['member/','member/uain1a','member/uain1abc','private_reviewer/','coin_balance/uain1f','private_root/','private_payment/0','private_boundary/ab','private_nullifier/','private_nullifier/fff'])assert.ok(validateRPC(listing(key)),key);
 assert.ok(validateRPC(query('private_nullifier/'+'ad'.repeat(32))));
 for(const key of ['member/uain1abcd','member/uain1'+'ab'.repeat(20),'private_payment/abcd','private_nullifier/'+'ad'.repeat(32),'operator_claim/','member','member/x'])assert.throws(()=>validateRPC(listing(key)),key);
 assert.throws(()=>validateRPC({...listing('member/'),params:{...listing('member/').params,prove:true}}));
});
test('gateway accepts only signed OTC broadcasts after explicit enablement',()=>{
 const {privateKey,publicKey}=generateKeyPairSync('ed25519'),pub=Buffer.from(publicKey.export({format:'jwk'}).x,'base64url');
 const envelope=signedEnvelope({version:1,chain_id:'uain-fictional-relay',member:memberAddress(pub),sequence:'0',expires_height:'10',operation:'private_payment',payload:{bundle:'YQ',approval:{reviewer:memberAddress(pub),effects:'ab'.repeat(32),purpose_commitment:'ac'.repeat(32),class:'neutral',expires_height:'10',licence_revision:'0',signature:Buffer.alloc(64).toString('base64url')}}},pub,privateKey);
 const body=frame('broadcast_tx_sync',{tx:Buffer.from(JSON.stringify(envelope)).toString('base64')});
 assert.throws(()=>validateRPC(body));assert.ok(validateRPC(body,true));
 for(const change of [{...envelope,local_receipt:{terms:'private'}},{...envelope,signature:'invalid'},{...envelope,command:{...envelope.command,payload:{...envelope.command.payload,approval:{...envelope.command.payload.approval,private_receipt:{terms:'private'}}}}},{...envelope,command:{...envelope.command,operation:'mint'}}])assert.throws(()=>validateRPC(frame('broadcast_tx_sync',{tx:Buffer.from(JSON.stringify(change)).toString('base64')}),true));
});
test('Unix gateway forwards exact allowed requests, has no TCP listener and refuses occupied socket',async()=>{
 const root=await mkdtemp(join(tmpdir(),'uain-relay-fixture-'));let gateway;let requests=0;
 const upstream=http.createServer(async(req,res)=>{requests++;let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result:{ok:true}}));});
 await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 try {
  const socket=join(root,'gateway.sock');gateway=await startGateway({socket,upstream:`http://127.0.0.1:${upstream.address().port}`});
  assert.equal(gateway.address(),socket);assert.equal((await stat(socket)).mode & 0o777,0o660);
  await assert.rejects(startGateway({socket,upstream:`http://127.0.0.1:${upstream.address().port}`}));
  const call=body=>new Promise((resolve,reject)=>{const request=http.request({socketPath:socket,path:'/',method:'POST',headers:{'content-type':'application/json'}},response=>{let raw='';response.on('data',p=>raw+=p);response.on('end',()=>resolve({code:response.statusCode,body:JSON.parse(raw)}));});request.on('error',reject);request.end(JSON.stringify(body));});
  assert.equal((await call(query('private_activation'))).code,200);assert.equal(requests,1);
  assert.equal((await call(frame('unsafe_flush_mempool',{}))).code,400);assert.equal(requests,1);
  assert.equal((await call({...query('coin_supply'),secret:'x'.repeat(65536)})).code,400);assert.equal(requests,1);
 }finally{if(gateway)await new Promise(resolve=>gateway.close(resolve));await new Promise(resolve=>upstream.close(resolve));await rm(root,{recursive:true,force:true});}
});
