#!/usr/bin/env node
// Root-only execution of public custody output. Private attachments and vault
// access belong exclusively to the separate fixed-scope custody signer.
import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import {open,lstat,mkdir} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {submitMigrationBatch} from '../../chain/migration/submit.mjs';
import {writePublicArtifact,persistMigrationReceipt} from '../../chain/migration/public-artifact.mjs';
const ROOT='/var/lib/uain-custody/native-migration';
const GENESIS='54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff';
async function protectedPath(path,{privateFile=true,max=64*1024*1024}={}){
 assert.equal(resolve(path),path);let parent=dirname(path);
 while(true){const info=await lstat(parent);assert.ok(info.isDirectory()&&info.uid===0&&(info.mode&0o022)===0,'protected root parent required');if(parent==='/')break;parent=dirname(parent);}
 const info=await lstat(path);assert.ok(info.isFile()&&info.uid===0&&info.nlink===1&&info.size<=max&&(info.mode&(privateFile?0o077:0o022))===0,'protected public artifact required');
}
async function read(path,max){
 await protectedPath(path,{max});const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const info=await fd.stat();assert.ok(info.isFile()&&info.uid===0&&info.nlink===1&&(info.mode&0o077)===0&&info.size<=max);const data=await fd.readFile();assert.ok(data.length<=max);return data;}finally{await fd.close();}
}
async function main(){
 assert.equal(process.geteuid?.(),0,'fixed root operator required');assert.equal(process.argv.length,3);const epoch=process.argv[2];assert.match(epoch,/^[a-f0-9]{32}$/);process.umask(0o077);
 const directory=join(ROOT,epoch),approval=JSON.parse(await read(join(directory,'approval.json'),16384)),plan=await read(join(directory,'plan.json'),64*1024*1024),signed=JSON.parse(await read(join(directory,'signed.json'),128*1024*1024));
 assert.equal(approval.schema,'uain-native-migration-approval-v1');assert.equal(approval.epoch,epoch);assert.equal(approval.guardian,'uain158ac8d0debcf01d43164ef14736597da589d8b54');assert.equal(approval.genesis_sha256,GENESIS);assert.match(approval.state_binary_sha256,/^[a-f0-9]{64}$/);
 const executable='/opt/uain-chain/tools/state/'+approval.state_binary_sha256+'/uain-state';await protectedPath(executable,{privateFile:false,max:256*1024*1024});
 const reader={executable,executableSha256:approval.state_binary_sha256,genesis:'/var/lib/uain-chain/shadow-20261008-1/config/genesis.json',genesisSha256:GENESIS,rpc:'http://127.0.0.1:26667'};
 const receipts=join(directory,'receipts');await mkdir(receipts,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e});const info=await lstat(receipts);assert.ok(info.isDirectory()&&info.uid===0&&(info.mode&0o077)===0);
 const result=await submitMigrationBatch({plan,approval,signed,reader,persist:item=>persistMigrationReceipt(receipts,item)});
 await writePublicArtifact(join(directory,'submission.json'),result);console.log(JSON.stringify(result));
}
try{await main();}catch{console.error('Native migration submission refused or interrupted; retain public journals and reconcile finalized state before retry.');process.exitCode=1;}
