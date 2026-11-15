/** Operator-reviewed source packages, read only after fresh native ownership.
 * Never put these files under the public/static root. This grants no role,
 * balance, task admission, funding or scientific acceptance. */
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,lstat,realpath} from 'node:fs/promises';
import {isAbsolute,dirname} from 'node:path';
const HASH=/^[a-f0-9]{64}$/,ADDRESS=/^uain1[a-f0-9]{40}$/,ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/,CHAIN=/^[A-Za-z0-9._-]{1,96}$/;
const MAX_PACKAGE=2*1024*1024,MAX_TOTAL=8*1024*1024,MAX_MANIFEST=128*1024;
const sha=value=>createHash('sha256').update(value).digest('hex');
const object=value=>value&&Object.getPrototypeOf(value)===Object.prototype;
const exact=(value,fields)=>object(value)&&Object.keys(value).length===fields.length&&fields.every(k=>Object.hasOwn(value,k));
const configured=ok=>{if(!ok)throw Error('Invalid native bounty materials configuration.');};
export class NativeBountyMaterialsError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const check=(ok,status,code)=>{if(!ok)throw new NativeBountyMaterialsError(status,code);};
export const BOUNTY_REVIEW_SOURCE_FILES=Object.freeze([
 'apps/baink/server/native-financial-command.mjs','apps/baink/server/native-financial-transport.mjs','apps/baink/server/native-asset.mjs','apps/baink/server/native-earning.mjs','apps/baink/server/native-payments.mjs',
 'apps/baink/holder/external-signing.mjs','apps/baink/holder/companion.mjs','apps/baink/holder/courier-executor.mjs','apps/baink/holder/produce-worker.mjs','apps/baink/holder/public-action-worker.mjs','apps/baink/holder/submitter.mjs','apps/baink/holder/incoming-inspection.mjs','apps/baink/holder/owned-addresses.mjs','apps/baink/holder/reviewer-worker.mjs','apps/baink/holder/service-broker.mjs','apps/baink/holder/runtime/wallet.mjs',
 'apps/baink/holder/owned-notes.mjs','apps/baink/holder/service-health.mjs','apps/baink/holder/runtime/broker.mjs','apps/baink/holder/runtime/start.mjs',
 'ops/custody/private_payment_service.py',
 'apps/baink/web/native-financial.js','apps/baink/web/native-wallet-state.js',
 'chain/client/signing.mjs','chain/client/private-state.mjs','chain/client/private-review.mjs','chain/client/private-workflow.mjs','chain/client/private-cli.mjs','chain/client/coin-boundary.mjs',
 'chain/client/federation-workflow.mjs','chain/privatewallet/state.go',
 'chain/private-exchange/src/bin/uain-note-source.rs','chain/private-exchange/tests/note_source.rs','chain/private-exchange/src/wallet_files.rs','chain/private-exchange/src/lib.rs','chain/private-exchange/Cargo.toml','chain/private-exchange/Cargo.lock',
 'chain/federation/coin.go','chain/federation/coin_boundary.go','chain/federation/private_exchange.go','chain/federation/settlement.go','chain/federation/budgets.go','chain/federation/operator_rewards.go','chain/federation/operators.go',
 'apps/baink/test/native-earning.test.mjs','apps/baink/test/native-payments.test.mjs','apps/baink/test/native-financial-http.test.mjs','apps/baink/holder/submitter.test.mjs','apps/baink/holder/companion.test.mjs','apps/baink/holder/courier-executor.test.mjs',
 'docs/baink/first-native-bounty-2026-11-04.md','docs/baink/earned-private-payments-2026-11-04.md','docs/superpowers/specs/2026-11-04-earned-private-payments.md',
]);
const allowedFiles=new Set(BOUNTY_REVIEW_SOURCE_FILES);
async function protectedFile(path,limit){
 configured(typeof path==='string'&&isAbsolute(path)&&await realpath(path)===path);
 const parent=await lstat(dirname(path));configured(parent.isDirectory()&&!parent.isSymbolicLink()&&[0,process.getuid()].includes(parent.uid)&&!(parent.mode&0o077));
 const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const info=await fd.stat();configured(info.isFile()&&info.nlink===1&&[0,process.getuid()].includes(info.uid)&&!(info.mode&0o077)&&info.size>=1&&info.size<=limit);const bytes=Buffer.alloc(info.size+1);let length=0;while(length<bytes.length){const read=await fd.read(bytes,length,bytes.length-length,null);if(!read.bytesRead)break;length+=read.bytesRead;}configured(length===info.size);return bytes.subarray(0,length);}finally{await fd.close();}
}
function crc32(bytes){let n=0xffffffff;for(const byte of bytes){n^=byte;for(let i=0;i<8;i++)n=n&1?(n>>>1)^0xedb88320:n>>>1;}return(n^0xffffffff)>>>0;}
/** Canonical small ZIP_STORED only: no ZIP64, encryption, extra fields,
 * comments, directories, executable/symlink entries or unlisted byte streams. */
function reviewedZIP(bytes,files){
 configured(object(files)&&Object.keys(files).length>=1&&Object.keys(files).length<=64&&Object.entries(files).every(([name,pin])=>allowedFiles.has(name)&&typeof pin==='string'&&HASH.test(pin)));
 const end=bytes.length-22;configured(end>=0&&bytes.readUInt32LE(end)===0x06054b50&&bytes.readUInt16LE(end+4)===0&&bytes.readUInt16LE(end+6)===0&&bytes.readUInt16LE(end+20)===0);
 const count=bytes.readUInt16LE(end+10),size=bytes.readUInt32LE(end+12),start=bytes.readUInt32LE(end+16);configured(count===Object.keys(files).length&&bytes.readUInt16LE(end+8)===count&&start+size===end);
 const locals=new Map();let at=0;
 while(at<start){
  configured(at+30<=start&&bytes.readUInt32LE(at)===0x04034b50&&bytes.readUInt16LE(at+4)===20&&[0,0x800].includes(bytes.readUInt16LE(at+6))&&bytes.readUInt16LE(at+8)===0&&bytes.readUInt16LE(at+28)===0);
  const checksum=bytes.readUInt32LE(at+14),length=bytes.readUInt32LE(at+18),plain=bytes.readUInt32LE(at+22),namesize=bytes.readUInt16LE(at+26),body=at+30+namesize;
  configured(namesize>=1&&namesize<=200&&length===plain&&body+length<=start&&length<=MAX_PACKAGE);
  const namebytes=bytes.subarray(at+30,body),name=namebytes.toString('utf8');configured(Buffer.from(name).equals(namebytes)&&allowedFiles.has(name)&&Object.hasOwn(files,name)&&!locals.has(name));
  const content=bytes.subarray(body,body+length);configured(Buffer.from(content.toString('utf8')).equals(content)&&sha(content)===files[name]&&crc32(content)===checksum);
  locals.set(name,{at,checksum,length,flags:bytes.readUInt16LE(at+6)});at=body+length;
 }
 configured(at===start&&locals.size===count);const seen=new Set();
 for(let i=0;i<count;i++){
  configured(at+46<=end&&bytes.readUInt32LE(at)===0x02014b50&&bytes.readUInt16LE(at+6)===20&&bytes.readUInt16LE(at+10)===0&&bytes.readUInt16LE(at+30)===0&&bytes.readUInt16LE(at+32)===0&&bytes.readUInt16LE(at+34)===0);
  const namesize=bytes.readUInt16LE(at+28),next=at+46+namesize;configured(next<=end);const namebytes=bytes.subarray(at+46,next),name=namebytes.toString('utf8'),local=locals.get(name),attributes=bytes.readUInt32LE(at+38),mode=attributes>>>16,type=mode&0o170000;
  configured(Buffer.from(name).equals(namebytes)&&local&&!seen.has(name)&&bytes.readUInt16LE(at+8)===local.flags&&bytes.readUInt32LE(at+16)===local.checksum&&bytes.readUInt32LE(at+20)===local.length&&bytes.readUInt32LE(at+24)===local.length&&bytes.readUInt32LE(at+42)===local.at&&[0,0o100000].includes(type)&&!(mode&0o133)&&!(attributes&0x10));
  seen.add(name);at=next;
 }
 configured(at===end);return count;
}
async function readMaterials(manifestFile,pins){
 if(manifestFile===null||manifestFile===undefined)return new Map();
 const raw=await protectedFile(manifestFile,MAX_MANIFEST);let manifest;try{manifest=JSON.parse(raw.toString('utf8'));}catch{configured(false);}
 configured(exact(manifest,['schema','chainId','genesisSha256','materials'])&&manifest.schema==='baink-native-bounty-materials-v1'&&CHAIN.test(manifest.chainId)&&manifest.chainId===pins?.chainId&&manifest.genesisSha256===pins?.epoch&&HASH.test(manifest.genesisSha256)&&Array.isArray(manifest.materials)&&manifest.materials.length<=8);
 const result=new Map();let total=0;
 for(const row of manifest.materials){
  configured(exact(row,['taskId','projectId','filename','path','sha256','bytes','files'])&&typeof row.taskId==='string'&&ID.test(row.taskId)&&typeof row.projectId==='string'&&ID.test(row.projectId)&&!result.has(row.taskId)&&typeof row.filename==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,115}\.zip$/.test(row.filename)&&HASH.test(row.sha256)&&Number.isSafeInteger(row.bytes)&&row.bytes>=1&&row.bytes<=MAX_PACKAGE);
  const bytes=await protectedFile(row.path,MAX_PACKAGE);configured(bytes.length===row.bytes&&sha(bytes)===row.sha256);total+=bytes.length;configured(total<=MAX_TOTAL);const fileCount=reviewedZIP(bytes,row.files);
  result.set(row.taskId,{filename:row.filename,bytes,metadata:Object.freeze({taskId:row.taskId,projectId:row.projectId,sourceSha256:row.sha256,bytes:bytes.length,fileCount,downloadPath:'/api/native/earning/materials/'+row.taskId})});
 }
 return result;
}
export async function createNativeBountyMaterials({native,manifestFile=null,now=Date.now}={}){
 configured(native&&typeof native.publicState==='function'&&typeof now==='function');const materials=await readMaterials(manifestFile,native.pins),notice='Reviewed source access does not establish an admitted or funded task, scientific acceptance or an AI$ reward.';
 async function qualified(user){
  check(ADDRESS.test(user?.address??'')&&typeof user.publicKey==='string',401,'invalid_native_holder');const key=Buffer.from(user.publicKey,'base64');check(key.length===32&&key.toString('base64')===user.publicKey&&'uain1'+sha(key).slice(0,40)===user.address,401,'invalid_native_holder');
  check(native.configured===true&&typeof native.pins?.chainId==='string'&&CHAIN.test(native.pins.chainId)&&HASH.test(native.pins?.epoch??'')&&HASH.test(native.pins?.verifierSha256??''),503,'native_proof_unavailable');let context;
  try{context=await native.publicState({member:user.address,keys:['member/'+user.address]},{timeoutMs:Math.min(30000,native.timeoutMs??15000)});}catch{check(false,503,'native_proof_unavailable');}
  const s=context?.state,p=context?.proof,pins=native.pins,age=now()-Date.parse(p?.headerTime),member=s?.member,selected=s?.records?.['member/'+user.address];
  check(p?.authority==='native'&&p.chainId===pins.chainId&&p.epoch===pins.epoch&&p.genesisSha256===pins.epoch&&p.verifierSha256===pins.verifierSha256&&Number.isInteger(p.maxAgeSeconds)&&p.maxAgeSeconds>=1&&p.maxAgeSeconds<=120&&Number.isFinite(age)&&age>=-60000&&age<p.maxAgeSeconds*1000&&/^[1-9][0-9]{0,18}$/.test(p.height??'')&&HASH.test(p.appHash??'')&&s?.chain_id===p.chainId&&s.height===p.height&&s.app_hash===p.appHash&&s.header_time===p.headerTime&&member?.id===user.address&&member.public_key===key.toString('base64url')&&selected?.id===member.id&&selected.public_key===member.public_key&&selected.licence===member.licence&&typeof member.sequence==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(member.sequence)&&BigInt(member.sequence)<=18446744073709551615n&&selected.sequence===member.sequence,503,'native_proof_unavailable');
  check(member.licence==='active',403,'native_licence_inactive');return Object.fromEntries(['authority','chainId','epoch','genesisSha256','verifierSha256','height','appHash','headerTime','maxAgeSeconds'].map(key=>[key,p[key]]));
 }
 return Object.freeze({
  async list(user){const proof=await qualified(user);return{materials:[...materials.values()].map(item=>({...item.metadata})),proof,notice};},
  async get(user,taskId){check(typeof taskId==='string'&&ID.test(taskId),400,'invalid_material_task');await qualified(user);const item=materials.get(taskId);check(item,404,'native_materials_missing');return{filename:item.filename,sourceSha256:item.metadata.sourceSha256,bytes:Buffer.from(item.bytes)};},
 });
}
