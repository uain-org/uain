import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
const mod=await import('../dist/src/api/native-wallet-public-routes.js').catch(()=>({}));
test('native wallet proof GET independently verifies exact current binding and never serves substituted ownership',async()=>{
 assert.equal(typeof mod.handleNativeWalletPublicRoutes,'function','native wallet proof route required');
 const root=await mkdtemp(join(tmpdir(),'uain-wallet-route-'));
 try{const member='uain1'+'1'.repeat(40),id='00000000000000000042',binding={policy:'member-proved-external-wallet-v1',binding:id,member,network:'ethereum',address:'0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',sequence:'3',expires_height:'100',signature:'0x'+'3'.repeat(130),height:'42',active:true},records={['external_wallet/'+member+'/ethereum']:binding,['external_wallet_binding/'+id]:binding,['external_wallet_owner/ethereum/'+binding.address]:member};
  const fixture=join(root,'records.json'),binary=join(root,'reader'),genesis=join(root,'genesis');await writeFile(fixture,JSON.stringify(records));await writeFile(genesis,'{}');
  const script=`#!${process.execPath}\nconst fs=require('fs');let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{const a=process.argv.slice(2),s=JSON.parse(input),r=JSON.parse(fs.readFileSync(${JSON.stringify(fixture)},'utf8'));fs.writeFileSync(a[a.indexOf('--out')+1],JSON.stringify({chain_id:'fixture',height:'42',records:Object.fromEntries(s.keys.map(k=>[k,r[k]??null]))}),{mode:384,flag:'wx'})});\n`;
  await writeFile(binary,script,{mode:0o700});const env={UAIN_NATIVE_STATE_BINARY:binary,UAIN_NATIVE_STATE_SHA256:createHash('sha256').update(script).digest('hex'),UAIN_NATIVE_GENESIS:genesis,UAIN_NATIVE_GENESIS_SHA256:createHash('sha256').update('{}').digest('hex'),UAIN_NATIVE_RPC:'http://127.0.0.1:1'};
  let status,body;const invoke=method=>mod.handleNativeWalletPublicRoutes({method},{setHeader(){}},new URL('https://example.org/api/native/wallets/'+id),(_res,s,b)=>{status=s;body=b},()=>{},env);
  assert.equal(await invoke('GET'),true);assert.equal(status,200);assert.equal(body.address,binding.address);assert.equal(body.in_force,true);assert.equal(body.message,`UAIN external wallet binding v1\nchain_id: fixture\nmember: ${member}\nsequence: 3\nnetwork: ethereum\naddress: ${binding.address}\nexpires_height: 100\n`);
  records['external_wallet_owner/ethereum/'+binding.address]='attacker';await writeFile(fixture,JSON.stringify(records));await invoke('GET');assert.equal(status,503);await invoke('POST');assert.equal(status,405);
 }finally{await rm(root,{recursive:true,force:true})}
});
