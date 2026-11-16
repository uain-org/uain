/** Public pins only. The production caller uses PROFILE_PATH, never argv/env. */
import {open,lstat,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {HASH,exactKeys,need,sha256} from '../../project-organizations/src/common.mjs';
export const PROFILE_PATH='/etc/uain-fund-inspection/profile.json';
const pathOK=p=>typeof p==='string'&&p.startsWith('/')&&resolve(p)===p&&!p.includes('\0');
export async function protectedPath(path,{uid=process.getuid(),directory=false}={}){
 need(pathOK(path)&&Number.isInteger(uid),'inspection_profile_path');
 for(let p=path;;p=dirname(p)){
  const s=await lstat(p);need(!s.isSymbolicLink()&&[0,uid].includes(s.uid)&&!(s.mode&0o022),'inspection_profile_permissions');
  need(p===path&&!directory?s.isFile()&&s.nlink===1:s.isDirectory(),'inspection_profile_type');
  if(p===dirname(p))break;
 }
 need(await realpath(path)===path,'inspection_profile_link');
}
export async function readPinnedFile(path,{uid=process.getuid(),sha256:pin=null,limit=65536,executable=false}={}){
 need(Number.isSafeInteger(limit)&&limit>0&&limit<=256*1024*1024&&(pin===null||HASH.test(pin)),'inspection_profile_pin');
 await protectedPath(path,{uid});const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const s=await fd.stat();need(s.isFile()&&[0,uid].includes(s.uid)&&s.nlink===1&&!(s.mode&0o022)&&s.size<=limit&&(!executable||s.mode&0o111),'inspection_profile_file');
  const b=Buffer.alloc(s.size+1);let n=0;for(;;){const r=await fd.read(b,n,b.length-n,null);if(!r.bytesRead)break;n+=r.bytesRead;need(n<=s.size,'inspection_profile_changed');}
  const end=await fd.stat(),current=await lstat(path);need(n===s.size&&s.dev===current.dev&&s.ino===current.ino&&s.mtimeMs===end.mtimeMs&&s.ctimeMs===end.ctimeMs,'inspection_profile_changed');
  const bytes=b.subarray(0,n);need(pin===null||sha256(bytes)===pin,'inspection_profile_digest');await protectedPath(path,{uid});return bytes;
 }finally{await fd.close();}
}
export function parseInspectionProfile(p){
 need(exactKeys(p,['schema','native','selection','amendments','registry','projectIds','reportDirectory'])&&p.schema==='uain-fund-inspection-profile-v1','inspection_profile_schema');
 const n=p.native;need(exactKeys(n,['binary','binaryHash','genesis','genesisHash','rpc','chainId','timeoutMs','maxAgeSeconds']),'inspection_profile_native');
 need(pathOK(n.binary)&&pathOK(n.genesis)&&HASH.test(n.binaryHash)&&HASH.test(n.genesisHash)&&/^[A-Za-z0-9._-]{1,96}$/.test(n.chainId??'')&&Number.isInteger(n.timeoutMs)&&n.timeoutMs>=100&&n.timeoutMs<=10000&&Number.isInteger(n.maxAgeSeconds)&&n.maxAgeSeconds>=1&&n.maxAgeSeconds<=120,'inspection_profile_native');
 let rpc;try{rpc=new URL(n.rpc);}catch{need(false,'inspection_profile_rpc');}
 need(!rpc.username&&!rpc.password&&!rpc.search&&!rpc.hash&&rpc.pathname==='/'&&(rpc.protocol==='https:'||rpc.protocol==='http:'&&['127.0.0.1','[::1]'].includes(rpc.hostname)),'inspection_profile_rpc');
 for(const k of ['selection','amendments','registry'])need(exactKeys(p[k],['path','sha256'])&&pathOK(p[k].path)&&HASH.test(p[k].sha256),'inspection_profile_pin');
 need(Array.isArray(p.projectIds)&&p.projectIds.length>0&&p.projectIds.length<=120&&new Set(p.projectIds).size===p.projectIds.length&&p.projectIds.every(id=>/^OPP-[0-9]{5}$/.test(id))&&pathOK(p.reportDirectory),'inspection_profile_scope');
 const copy=structuredClone(p);for(const k of ['native','selection','amendments','registry','projectIds'])Object.freeze(copy[k]);return Object.freeze(copy);
}
