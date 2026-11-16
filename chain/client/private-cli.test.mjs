import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {runPrivateAction} from './private-cli.mjs';
import {memberAddress} from './signing.mjs';
import {verifyPrivatePartyConsent} from './private-review.mjs';
test('private CLI keeps encryption keys in new private files and refuses overwrite',async()=>{
 const root=await mkdtemp(join(tmpdir(),'uain-private-cli-'));try{const file=join(root,'key');const result=await runPrivateAction('encryption-keygen',{file});assert.equal((await stat(file)).mode & 0o777,0o600);assert.equal(result.public_key.length,43);assert.ok(!JSON.stringify(result).includes('private'));assert.equal(JSON.parse(await readFile(file,'utf8')).algorithm,'X25519');await assert.rejects(runPrivateAction('encryption-keygen',{file}),{code:'EEXIST'});}finally{await rm(root,{recursive:true,force:true});}
});
test('private CLI signs only its local member consent and refuses exposed or symlinked keys',async()=>{
 const root=await mkdtemp(join(tmpdir(),'uain-private-cli-'));try{const key=generateKeyPairSync('ed25519');const jwk=key.privateKey.export({format:'jwk'});const file=join(root,'identity');await writeFile(file,JSON.stringify({algorithm:'Ed25519',public_key:jwk.x,private_key:jwk.d,address:memberAddress(Buffer.from(jwk.x,'base64url'))}),{mode:0o600});const context={version:1,chain:'uain-cli-fixture',expires:'100',licenceRevision:'0',effects:'61'.repeat(32),purpose:'62'.repeat(32),reviewer:'63'.repeat(32)},address='64'.repeat(43),out=join(root,'consent');assert.deepEqual(await runPrivateAction('consent',{context,address,signingKeyFile:file,out}),{saved:true});assert.ok(verifyPrivatePartyConsent(context,JSON.parse(await readFile(out,'utf8')),key.publicKey));const link=join(root,'linked');await symlink(file,link);await assert.rejects(runPrivateAction('consent',{context,address,signingKeyFile:link,out:join(root,'refused')}),/regular file/);const exposed=join(root,'exposed');await writeFile(exposed,await readFile(file),{mode:0o644});await assert.rejects(runPrivateAction('consent',{context,address,signingKeyFile:exposed,out:join(root,'refused')}),/regular file/);}finally{await rm(root,{recursive:true,force:true});}
});
test('private CLI refuses unknown commands and output-less operations',async()=>{
 await assert.rejects(runPrivateAction('auto-trade',{}),/unknown/);await assert.rejects(runPrivateAction('encryption-keygen',{}),/output/);
});

test('private status refuses a forged journal before making any RPC request', async()=>{
 const root=await mkdtemp(join(tmpdir(),'uain-private-cli-'));
 try {const file=join(root,'journal');await writeFile(file,JSON.stringify({tx_hash:'00'.repeat(32),envelope:{command:{member:'uain1'+'11'.repeat(20)},public_key:'22'.repeat(32),signature:'invalid'}}),{mode:0o600});await assert.rejects(runPrivateAction('status',{journalFile:file,reader:{rpc:'http://127.0.0.1:1'}}),/signed transaction journal/);}finally{await rm(root,{recursive:true,force:true});}
});

test('private outputs become visible only as complete JSON',async()=>{
 const root=await mkdtemp(join(tmpdir(),'uain-atomic-private-'));
 try {
  const executable=join(root,'reader-fixture'),out=join(root,'snapshot');
  const script=`#!/usr/bin/env node
const fs=require('node:fs');fs.writeFileSync(process.argv[process.argv.indexOf('--out')+1],JSON.stringify({header_time:new Date().toISOString(),relayer:{},reviewer:{},parties:[],payments:[],boundaries:[],commitments:[],padding:'x'.repeat(8*1024*1024)}),{mode:0o600});
`;
  await writeFile(executable,script,{mode:0o700});
  const action=runPrivateAction('state',{reader:{executable,executableSha256:createHash('sha256').update(script).digest('hex'),genesis:'unused',genesisSha256:'01'.repeat(32),rpc:'http://127.0.0.1:1',request:{}},out});action.catch(()=>{});
  let observed;const deadline=Date.now()+10000;
  try {
   while(!observed){try{observed=JSON.parse(await readFile(out,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}if(Date.now()>deadline)throw Error('publication deadline');if(!observed)await new Promise(resolve=>setTimeout(resolve,1));}
   assert.equal(observed.padding.length,8*1024*1024);await action;
  } catch(error){await action.catch(()=>{});throw error;}
  assert.equal((await stat(out)).mode&0o777,0o600);
 } finally {await rm(root,{recursive:true,force:true});}
});
