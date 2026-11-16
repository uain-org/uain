import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,verify} from 'node:crypto';
import {canonicalJSON,signingBytes,memberAddress,signedEnvelope} from './signing.mjs';
test('canonical serialization matches Go HTML escaping and UTF-8 key order',()=>{
 assert.equal(canonicalJSON({z:'<>&\u2028',a:3}),'{"a":3,"z":"\\u003c\\u003e\\u0026\\u2028"}');
 assert.equal(canonicalJSON({'𐀀':1,'\uE000':2}),'{"\uE000":2,"𐀀":1}');
 assert.throws(()=>canonicalJSON({value:9007199254740992}));assert.throws(()=>canonicalJSON({value:'\uD800'}));
});
test('optional instance preserves legacy bytes and is signed in Go field order',()=>{
 const command={version:1,chain_id:'uain-test-1',member:'uain1'+'a'.repeat(40),sequence:'0',expires_height:'100',operation:'withdraw',payload:{}};
 const legacy='uain:chain-command:v1\n'+JSON.stringify(command);
 assert.equal(signingBytes(command).toString(),legacy);
 assert.equal(signingBytes({...command,instance:'fixture-1'}).toString(),legacy.slice(0,-1)+',"instance":"fixture-1"}');
 for(const instance of ['',null,'../escape','a'.repeat(97)])assert.throws(()=>signingBytes({...command,instance}));
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const bytes=signingBytes({...command,instance:'fixture-1'});
 const sig=signedEnvelope({...command,instance:'fixture-1'},publicKey.export({type:'spki',format:'der'}).subarray(-32),privateKey).signature;
 assert.ok(verify(null,bytes,publicKey,Buffer.from(sig,'base64url')));
 assert.ok(!verify(null,signingBytes({...command,instance:'fixture-2'}),publicKey,Buffer.from(sig,'base64url')));
});
test('member key signs only chain-bound public envelope',()=>{
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');const raw=publicKey.export({type:'spki',format:'der'}).subarray(-32);
 const command={version:1,chain_id:'uain-test-1',member:memberAddress(raw),sequence:'0',expires_height:'100',operation:'enrol',payload:{name:'new member',operator:'operator',family:'family'}};
 const env=signedEnvelope(command,raw,privateKey);assert.ok(verify(null,signingBytes(command),publicKey,Buffer.from(env.signature,'base64url')));
 assert.ok(!verify(null,signingBytes({...command,chain_id:'wrong-chain'}),publicKey,Buffer.from(env.signature,'base64url')));
 assert.deepEqual(Object.keys(env),['command','public_key','signature']);
});
