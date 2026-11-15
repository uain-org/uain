import{open,lstat,realpath,readdir,unlink}from'node:fs/promises';import{constants}from'node:fs';import{join,dirname,resolve}from'node:path';import{canonical,sha256,HASH,need}from'../../project-organizations/src/common.mjs';
const keyOf=v=>sha256('UAIN/fund-inspection-report/v1\n'+canonical(v));
export async function openInspectionStore({directory,uid=process.getuid(),limit=65536,maxEntries=4096}){
 need(Number.isInteger(uid)&&limit>0&&limit<=65536&&Number.isInteger(maxEntries)&&maxEntries>0&&maxEntries<=4096,'inspection_store_configuration');need(resolve(directory)===await realpath(directory),'inspection_store_link');
 async function parents(){for(let p=directory;;p=dirname(p)){const s=await lstat(p);need(s.isDirectory()&&!s.isSymbolicLink()&&[0,uid].includes(s.uid)&&!(s.mode&0o022),'inspection_store_parent');if(p===dirname(p))break;}const s=await lstat(directory);need(s.uid===uid&&!(s.mode&0o077),'inspection_store_private');}await parents();
 async function get(key){need(typeof key==='string'&&HASH.test(key),'inspection_report_key');await parents();let fd;try{fd=await open(join(directory,key+'.json'),constants.O_RDONLY|constants.O_NOFOLLOW);}catch(e){if(e.code==='ENOENT')return null;throw e;}try{const s=await fd.stat();need(s.isFile()&&s.uid===uid&&(s.mode&0o777)===0o600&&s.nlink===1&&s.size<=limit,'inspection_report_private');const b=Buffer.alloc(limit+1);let n=0;for(;;){const r=await fd.read(b,n,b.length-n,null);if(!r.bytesRead)break;n+=r.bytesRead;need(n<=limit,'inspection_report_size');}const end=await fd.stat();need(s.size===n&&s.mtimeMs===end.mtimeMs&&s.ctimeMs===end.ctimeMs,'inspection_report_changed');const value=JSON.parse(b.subarray(0,n).toString());need(keyOf(value)===key,'inspection_report_digest');return value;}finally{await fd.close();}}
 return {get,async put(value){
  const raw=canonical(value),key=keyOf(value);
  need(Buffer.byteLength(raw)<=limit,'inspection_report_size');await parents();
  const lockPath=join(directory,'.inspection.lock');
  const lock=await open(lockPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{
   await lock.writeFile('fund-inspection-append-v1\n');await lock.sync();
   const old=await get(key);if(old!==null){need(canonical(old)===raw,'inspection_report_conflict');return key;}
   need((await readdir(directory)).filter(n=>n.endsWith('.json')).length<maxEntries,'inspection_store_full');
   const fd=await open(join(directory,key+'.json'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try{await fd.writeFile(raw);await fd.sync();}finally{await fd.close();}
   const d=await open(directory,'r');try{await d.sync();}finally{await d.close();}return key;
  }finally{await lock.close();await unlink(lockPath);const d=await open(directory,'r');try{await d.sync();}finally{await d.close();}}
 }};
}
