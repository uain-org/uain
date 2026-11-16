import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
const mod=await import('./federation-workflow.mjs').catch(()=>({}));
test('receipt discovery requires an exact bounded persisted event cursor',async()=>{
 assert.equal(typeof mod.findFederationReceipt,'function');
 await assert.rejects(()=>mod.findFederationReceipt({afterEvent:-1}),/cursor/);
 await assert.rejects(()=>mod.findFederationReceipt({afterEvent:'0',maxEvents:257}),/cursor/);
});
test('serialized or fabricated indexer state cannot authorize a member command',()=>{
 assert.equal(typeof mod.composeFederationCommand,'function','verified member command composer required');
 const {privateKey}=generateKeyPairSync('ed25519');
 assert.throws(()=>mod.composeFederationCommand({state:{chain_id:'untrusted',height:'1',member:{sequence:'0',licence:'active'}},operation:'withdraw',payload:{},signingKey:privateKey}),/pinned finalized/);
});
test('public state reader requires independent executable and genesis pins before invoking a process',async()=>{
 assert.equal(typeof mod.readFederationState,'function');
 await assert.rejects(()=>mod.readFederationState({executable:'/bin/echo',genesis:'/tmp/untrusted',rpc:'http://127.0.0.1:1',request:{}}),/independent/);
});
test('pinned reader context composes a locally signed command with proven shared sequence and ownership',async()=>{
 const {mkdtemp,writeFile,chmod,rm}=await import('node:fs/promises');const{tmpdir}=await import('node:os');const{join}=await import('node:path');const{createHash,verify}=await import('node:crypto');const{memberAddress,signingBytes}=await import('./signing.mjs');
 const dir=await mkdtemp(join(tmpdir(),'uain-context-test-'));try{
  const{privateKey,publicKey}=generateKeyPairSync('ed25519'),raw=publicKey.export({type:'spki',format:'der'}).subarray(-32),member=memberAddress(raw),instance='fixture-instance';
  const state={chain_id:'isolated-signing-fixture',height:'100',header_time:new Date().toISOString(),member:{id:member,public_key:raw.toString('base64url'),sequence:'7',licence:'active'},instance:{id:instance,member,state:'active'},records:{legacy_import:null}};
  // This executable tests the binder's process boundary only. Actual signed
  // header/IAVL proof validation is exercised by the SDK gateway tests.
  const executable=join(dir,'reader'),genesis=join(dir,'genesis.json'),script=`#!${process.execPath}\nconst fs=require('fs');const args=process.argv.slice(2);let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{const r=JSON.parse(input);if(Object.keys(r).some(k=>!['member','instance'].includes(k)))process.exit(2);fs.writeFileSync(args[args.indexOf('--out')+1],${JSON.stringify(JSON.stringify(state))},{mode:384,flag:'wx'});});\n`;
  await writeFile(executable,script);await chmod(executable,0o700);await writeFile(genesis,'{}');const sha=s=>createHash('sha256').update(s).digest('hex');
  const proven=await mod.readFederationState({executable,executableSha256:sha(script),genesis,genesisSha256:sha('{}'),rpc:'http://127.0.0.1:1',request:{member,instance}});
  const envelope=mod.composeFederationCommand({state:proven,operation:'instance_update',payload:{name:'Locally signed fixture'},signingKey:privateKey});
  assert.equal(envelope.command.sequence,'7');assert.equal(envelope.command.instance,instance);assert.equal(envelope.command.expires_height,'200');assert.ok(verify(null,signingBytes(envelope.command),publicKey,Buffer.from(envelope.signature,'base64url')));
  assert.throws(()=>mod.composeFederationCommand({state:JSON.parse(JSON.stringify(proven)),operation:'withdraw',payload:{},signingKey:privateKey}),/pinned finalized/);
  assert.throws(()=>{proven.member.sequence='0'},TypeError);
  const other=generateKeyPairSync('ed25519');assert.throws(()=>mod.composeFederationCommand({state:proven,operation:'withdraw',payload:{},signingKey:other.privateKey}),/local key/);
 }finally{await rm(dir,{recursive:true,force:true})}
});
