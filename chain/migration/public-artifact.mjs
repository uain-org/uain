// Root-only deterministic public migration journals. This module handles no
// key material and does not establish finality; the submitter must prove it.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,mkdir,open,link,unlink} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
const MAX=16*1024*1024;
async function parents(path){
 assert.equal(resolve(path),path,'absolute canonical public artifact path required');
 for(let p=dirname(path);;p=dirname(p)){
  const s=await lstat(p);assert.ok(s.isDirectory()&&s.uid===0&&(s.mode&0o022)===0,'protected root parent required');if(p==='/')break;
 }
}
async function links(path,s,pairedPath){
 if(s.nlink===1)return;
 assert.equal(s.nlink,2,'unrelated public artifact hardlink refused');assert.ok(pairedPath,'unrelated public artifact hardlink refused');
 const other=await lstat(pairedPath);assert.ok(other.isFile()&&other.uid===0&&(other.mode&0o077)===0&&other.nlink===2&&other.ino===s.ino&&other.dev===s.dev,'unrelated public artifact hardlink refused');
}
async function artifactBytes(path,pairedPath){
 let s;try{s=await lstat(path);}catch(e){if(e.code==='ENOENT')return null;throw e;}
 assert.ok(s.isFile()&&s.uid===0&&(s.mode&0o077)===0&&s.size<=MAX,'protected public artifact required');await links(path,s,pairedPath);
 const fd=await open(path,constants.O_RDWR|constants.O_NOFOLLOW);
 try{
  const f=await fd.stat();assert.ok(f.isFile()&&f.uid===0&&(f.mode&0o077)===0&&f.size<=MAX&&f.ino===s.ino&&f.dev===s.dev,'public artifact changed');await links(path,f,pairedPath);
  const raw=await fd.readFile();assert.ok(raw.length<=MAX,'bounded public artifact required');await fd.sync();return raw;
 }finally{await fd.close();}
}
async function existing(path,expected,pairedPath){const raw=await artifactBytes(path,pairedPath);if(raw===null)return false;assert.ok(raw.equals(expected),'public artifact bytes conflict');return true;}
async function syncDirectory(path){const fd=await open(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY);try{await fd.sync();}finally{await fd.close();}}
export async function writePublicArtifact(path,value){
 return writeArtifactBytes(path,Buffer.from(JSON.stringify(value)+'\n'));
}
async function writeArtifactBytes(path,raw){
 assert.equal(process.geteuid?.(),0,'fixed root operator required');await parents(path);
 assert.ok(raw.length<=MAX,'bounded public artifact required');
 const pending=path+'.pending',finalExists=await existing(path,raw,pending),pendingExists=await existing(pending,raw,path);
 const clean=async()=>{await syncDirectory(path);if(await existing(pending,raw,path))await unlink(pending).catch(e=>{if(e.code!=='ENOENT')throw e;});await syncDirectory(path);};
 if(finalExists){await clean();return;}
 if(!pendingExists){
  const fd=await open(pending,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await fd.writeFile(raw);await fd.sync();}finally{await fd.close();}
 }
 await syncDirectory(pending);
 // Link cannot overwrite a final artifact created by another operator process.
 // A crash after link is recognized only as this exact two-name inode pair.
 try{await link(pending,path);}catch(e){if(!['EEXIST','ENOENT'].includes(e.code))throw e;assert.ok(await existing(path,raw,pending),'public artifact publication raced');}
 await clean();
}
export function migrationReceiptArtifact(item){
 assert.ok(Number.isSafeInteger(item.index)&&item.index>=0&&item.index<1024&&item.receipt?.finalized===true,'bounded finalized migration receipt required');
 assert.ok(item.envelope&&item.receipt.event,'exact finalized envelope/event required');
 return {schema:'uain-native-migration-receipt-v2',index:item.index,envelope:structuredClone(item.envelope),receipt:{finalized:true,event:structuredClone(item.receipt.event)}};
}
export function migrationProofArtifact(item){
 const fixed=migrationReceiptArtifact(item);assert.ok(item.receipt.proof&&typeof item.receipt.proof==='object','finalized public proof capsule required');
 return {...fixed,schema:'uain-native-migration-proof-v1',receipt:structuredClone(item.receipt)};
}
export async function persistMigrationReceipt(directory,item){
 const expected=migrationReceiptArtifact(item),proof=migrationProofArtifact(item),proofs=join(directory,'proofs');
 await parents(join(directory,'check'));await mkdir(proofs,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
 const info=await lstat(proofs);assert.ok(info.isDirectory()&&info.uid===0&&(info.mode&0o077)===0,'private root proof directory required');
 await syncDirectory(proofs);
 const digest=createHash('sha256').update(JSON.stringify(proof)+'\n').digest('hex'),index=String(item.index).padStart(4,'0');
 // Historical proof durability precedes deterministic progress durability.
 await writePublicArtifact(join(proofs,index+'-'+digest+'.json'),proof);
 const path=join(directory,index+'.json'),pending=path+'.pending';await parents(path);const raw=await artifactBytes(path,pending)??await artifactBytes(pending,path);
 if(raw!==null){
  const prior=JSON.parse(raw);
  if(prior.schema!=='uain-native-migration-receipt-v2'){
   assert.equal(prior.index,item.index);assert.deepEqual(prior.envelope,item.envelope);assert.deepEqual(prior.receipt?.event,item.receipt.event);assert.equal(prior.receipt.finalized,true);
   // Retain old full-proof receipt bytes, reconciling only its identical pending.
   await writeArtifactBytes(path,raw);return;
  }
 }
 await writePublicArtifact(path,expected);
}
