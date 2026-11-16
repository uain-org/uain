import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {generateKeyPairSync,createHash,sign} from 'node:crypto';
import {createNativeAssetAdapter} from '../server/native-asset.mjs';
import {nativeResearchSigningBytes} from '../integrations/native-research-codec.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
test('native research transport admits only exact holder-signed research operations and matching CheckTx hash',async t=>{
 let sends=0,wrong=false;
 const rpc=createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;const call=JSON.parse(body),bytes=Buffer.from(call.params.tx,'base64');sends++;assert.equal(call.method,'broadcast_tx_sync');assert.equal(JSON.parse(bytes).command.operation,'project_join');res.end(JSON.stringify({result:{code:0,hash:wrong?'A'.repeat(64):sha(bytes).toUpperCase()}}));});
 await new Promise(r=>rpc.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>rpc.close(r)));
 const native=createNativeAssetAdapter({config:{binary:'/fixture/reader',binaryHash:'a'.repeat(64),genesis:'/fixture/genesis.json',genesisHash:'b'.repeat(64),chainId:'isolated',rpc:`http://127.0.0.1:${rpc.address().port}`,timeoutMs:1000,maxAgeSeconds:120}});
 const{publicKey,privateKey}=generateKeyPairSync('ed25519'),raw=publicKey.export({type:'spki',format:'der'}).subarray(-32),command={version:1,chain_id:'isolated',member:'uain1'+sha(raw).slice(0,40),sequence:'1',expires_height:'100',operation:'project_join',payload:{project:'pilot'},instance:'owned'},envelope={command,public_key:raw.toString('base64url'),signature:sign(null,Buffer.from(nativeResearchSigningBytes(command)),privateKey).toString('base64url')};
 assert.equal((await native.broadcastResearch(envelope)).finalized,false);assert.equal(sends,1);
 for(const bad of [{...envelope,command:{...command,operation:'coin_claim'}},{...envelope,command:{...command,chain_id:'other'}},{...envelope,signature:'a'.repeat(86)},{...envelope,command:{...command,payload:{project:'other'}}}])await assert.rejects(()=>native.broadcastResearch(bad));assert.equal(sends,1);
 wrong=true;await assert.rejects(()=>native.broadcastResearch(envelope));assert.equal(sends,2);
});
