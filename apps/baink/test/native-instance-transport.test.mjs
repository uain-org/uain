import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { createNativeAssetAdapter } from '../server/native-asset.mjs';
import { nativeInstanceSigningBytes } from '../server/native-instance.mjs';
const sha = b => createHash('sha256').update(b).digest('hex');

test('native adapter restricts instance broadcast to exact holder-signed instance_create and bounded matching CheckTx', async t => {
  let sends = 0, wrongHash = false;
  const rpc = createServer(async (req,res) => {
    let body = ''; for await (const b of req) body += b;
    const call = JSON.parse(body), bytes = Buffer.from(call.params.tx,'base64'); sends++;
    assert.equal(call.method,'broadcast_tx_sync'); assert.equal(JSON.parse(bytes).command.operation,'instance_create');
    res.end(JSON.stringify({result:{code:0,hash:wrongHash ? 'D'.repeat(64) : sha(bytes).toUpperCase()}}));
  });
  await new Promise(r => rpc.listen(0,'127.0.0.1',r));
  t.after(() => new Promise(r => rpc.close(r)));
  const native = createNativeAssetAdapter({config:{binary:'/fixture/reader',binaryHash:'a'.repeat(64),genesis:'/fixture/genesis.json',genesisHash:'b'.repeat(64),chainId:'instance-fixture',rpc:`http://127.0.0.1:${rpc.address().port}`,timeoutMs:1000,maxAgeSeconds:120}});
  const { publicKey,privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({type:'spki',format:'der'}).subarray(-32);
  const command = {version:1,chain_id:'instance-fixture',member:'uain1'+sha(raw).slice(0,40),sequence:'1',expires_height:'100',operation:'instance_create',payload:{id:'own-instance',name:'My instance',family:'Fixture'}};
  const envelope = {command,public_key:raw.toString('base64url'),signature:sign(null,nativeInstanceSigningBytes(command),privateKey).toString('base64url')};
  assert.equal(typeof native.broadcastInstance,'function');
  const result = await native.broadcastInstance(envelope,{timeoutMs:1000});
  assert.equal(result.accepted,true); assert.equal(result.finalized,false); assert.equal(sends,1);
  for (const bad of [{...envelope,command:{...command,operation:'coin_transfer'}},{...envelope,command:{...command,payload:{...command.payload,credits:'9'}}},{...envelope,signature:'A'.repeat(86)},{...envelope,command:{...command,chain_id:'other'}}]) await assert.rejects(native.broadcastInstance(bad));
  assert.equal(sends,1);
  wrongHash = true; await assert.rejects(native.broadcastInstance(envelope)); assert.equal(sends,2);
});
