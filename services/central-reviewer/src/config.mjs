/** Operator-owned, public-only runtime settings. No authority comes from environment. */
import{lstat,open}from'node:fs/promises';import{constants}from'node:fs';import{dirname,isAbsolute}from'node:path';
const check=(ok)=>{if(!ok)throw Error('central runtime configuration refused');};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.sort().join();
const HASH=/^[a-f0-9]{64}$/;
export function validateConfig(p){
 check(exact(p,['schema','reviewer','directory','custodySocket','fenceScript','intervalMs','timeoutMs','hourlyAttempts','dailyAttempts','native']));
 check(p.schema==='uain-central-review-runtime-v1'&&/^uain1[a-f0-9]{40}$/.test(p.reviewer)&&p.directory==='/var/lib/uain-central-reviewer'&&p.custodySocket==='/run/uain-central-reviewer/custody.sock');
 check(/^\/opt\/uain-central-reviewer\/releases\/[a-f0-9]{64}\/services\/central-reviewer\/src\/provider-fence.py$/.test(p.fenceScript));
 check(Number.isInteger(p.intervalMs)&&p.intervalMs>=1000&&p.intervalMs<=3600000&&Number.isInteger(p.timeoutMs)&&p.timeoutMs>=1000&&p.timeoutMs<=120000&&Number.isInteger(p.hourlyAttempts)&&p.hourlyAttempts>0&&p.hourlyAttempts<=128&&Number.isInteger(p.dailyAttempts)&&p.dailyAttempts>=p.hourlyAttempts&&p.dailyAttempts<=1024);
 const n=p.native;check(exact(n,['binary','binaryHash','genesis','genesisHash','chainId','rpc','timeoutMs','maxAgeSeconds']));check(isAbsolute(n.binary??'')&&isAbsolute(n.genesis??'')&&n.binaryHash==='136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860'&&n.genesisHash==='54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff'&&n.chainId==='uain-shadow-20261008-1'&&n.rpc==='http://127.0.0.1:26667'&&n.maxAgeSeconds===120&&Number.isInteger(n.timeoutMs)&&n.timeoutMs>=100&&n.timeoutMs<=10000);return structuredClone(p);
}
export async function trustedPath(path,{directory=false}={}){
 check(isAbsolute(path));let current=path,first=true;while(true){const s=await lstat(current);check(s.uid===0&&!s.isSymbolicLink()&&!(s.mode&0o022)&&(first&&!directory?s.isFile()&&s.nlink===1:s.isDirectory()));const next=dirname(current);if(next===current)break;current=next;first=false;}
}
export async function loadConfig(path='/etc/uain-central-reviewer/runtime.json'){
 check(path==='/etc/uain-central-reviewer/runtime.json');await trustedPath(path);const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=await f.stat();check(s.uid===0&&s.isFile()&&s.nlink===1&&!(s.mode&0o022)&&s.size<=16384);return validateConfig(JSON.parse(await f.readFile('utf8')));}finally{await f.close();}
}
