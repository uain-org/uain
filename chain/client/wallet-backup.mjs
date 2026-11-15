/** Passphrase-encrypted wallet backup and restore.
 *
 * This is the WALLET backup. It is separate from the identity backup (the
 * member signing key that proves who you are). The identity backup alone does
 * not recover private AI$: the notes belong to the Orchard spending key below.
 *
 * Format `baink-wallet-backup-v1`: a JSON envelope whose header names scrypt
 * (N=2^17, r=8, p=1, 16-byte salt) and AES-256-GCM (12-byte IV). The header is
 * the AEAD associated data, so it cannot be edited without detection. A short
 * HMAC key check tells a wrong passphrase apart from a damaged file.
 *
 * Inventory (paths inside the payload):
 *   wallet/orchard-key.json            the 32-byte spending key (required)
 *   wallet/wallet-identity.json        which owner and addresses the key is for
 *   wallet/owned-note-sources.json     known note sources (a hint; restore rescans)
 *   wallet/exchange/**                 courier proof journals
 *   wallet/submissions/**              submit-once journals (never re-sent)
 *   wallet/review-provenance/**        review provenance records
 *   receiving-wallets/**               optional ETH/SOL receiving keys and bindings
 * Excluded: temporary files (`.*`, `*.new`, `*.tmp`), locks, cached public health.
 *
 * Restore writes into a fresh wallet only: it refuses when a key, an identity
 * marker or any journal is already present. Every file is verified before the
 * first byte is written, and a partial restore is rolled back.
 */
import {createCipheriv,createDecipheriv,createHash,createHmac,randomBytes,scrypt as scryptCallback,timingSafeEqual} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,mkdir,open,readdir,rm,rename,link,mkdtemp} from 'node:fs/promises';
import {join,dirname,resolve,sep} from 'node:path';
import {promisify} from 'node:util';
import {createInterface} from 'node:readline';
import {Writable} from 'node:stream';
import {FINANCIAL_ENTRIES,IDENTITY_FILE,KEY_FILE,RESTORE_FILE,SETUP_FILE,financialStatePresent,validateIdentity} from './wallet-identity.mjs';

const scrypt=promisify(scryptCallback);
export const BACKUP_SCHEMA='baink-wallet-backup-v1';
const PAYLOAD_SCHEMA='baink-wallet-backup-payload-v1';
const DEFAULT_KDF=Object.freeze({name:'scrypt',N:2**17,r:8,p:1});
const MAX_FILES=200000,MAX_TOTAL=256*1024**2,MAX_FILE=16*1024**2,MAX_BACKUP=Math.ceil(MAX_TOTAL*1.4)+65536;
const MIN_PASSPHRASE=12;
const check=(ok,message)=>{if(!ok)throw Error(message);};
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const b64=b=>Buffer.from(b).toString('base64url');
const unb64=(s,length)=>{check(typeof s==='string'&&/^[A-Za-z0-9_-]*$/.test(s),'Wallet backup is corrupted');const b=Buffer.from(s,'base64url');check(b.toString('base64url')===s&&(length===undefined||b.length===length),'Wallet backup is corrupted');return b;};
const sha=b=>createHash('sha256').update(b).digest('hex');

export class WalletBackupError extends Error{constructor(code,message){super(message);this.code=code;}}
const fail=(code,message)=>{throw new WalletBackupError(code,message);};

function passphraseBytes(passphrase){
 check(typeof passphrase==='string'&&passphrase.isWellFormed(),'Backup passphrase required');
 const value=Buffer.from(passphrase.normalize('NFKC'),'utf8');
 if([...passphrase.normalize('NFKC')].length<MIN_PASSPHRASE)fail('WALLET_BACKUP_WEAK_PASSPHRASE',`Use a backup passphrase of at least ${MIN_PASSPHRASE} characters.`);
 return value;
}
async function deriveKeys(passphrase,kdf,salt){
 check(exact(kdf,['name','N','r','p','salt'])&&kdf.name==='scrypt'&&Number.isSafeInteger(kdf.N)&&kdf.N>=2**14&&kdf.N<=2**20&&(kdf.N&(kdf.N-1))===0&&kdf.r>=8&&kdf.r<=16&&kdf.p>=1&&kdf.p<=4,'Wallet backup is corrupted');
 const secret=passphraseBytes(passphrase);
 try{const material=await scrypt(secret,salt,64,{N:kdf.N,r:kdf.r,p:kdf.p,maxmem:256*kdf.N*kdf.r+64*1024**2});return{encryption:material.subarray(0,32),check:material.subarray(32,64)};}finally{secret.fill(0);}
}
const headerBytes=header=>Buffer.from(JSON.stringify({schema:header.schema,kdf:header.kdf,cipher:header.cipher,iv:header.iv,keyCheck:header.keyCheck,createdAt:header.createdAt}));
const keyCheckOf=key=>createHmac('sha256',key).update('baink-wallet-backup-key-check-v1').digest().subarray(0,16);

async function safeFile(path){
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const info=await handle.stat();check(info.isFile()&&info.size<=MAX_FILE&&!(info.mode&0o077)&&(!process.getuid||info.uid===process.getuid()),'Wallet file refused for backup: '+path);return{data:await handle.readFile(),mode:info.mode&0o777};}finally{await handle.close();}
}
const skipped=name=>name.startsWith('.')||name.endsWith('.new')||name.endsWith('.tmp')||name.endsWith('.lock')||name==='provision.lock'||name==='service-broker-health.json'||name===RESTORE_FILE||name===SETUP_FILE;
async function collect(root,prefix,entries,out){
 for(const entry of entries){
  const path=join(root,entry);let info;try{info=await lstat(path);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  check(!info.isSymbolicLink(),'Symbolic links are refused in a wallet backup: '+path);
  if(info.isDirectory()){check(!(info.mode&0o077),'Wallet directory must be private: '+path);await collect(path,prefix+entry+'/',(await readdir(path)).filter(n=>!skipped(n)).sort(),out);continue;}
  check(info.isFile(),'Only regular files can be backed up: '+path);
  const {data,mode}=await safeFile(path);out.push({path:prefix+entry,mode,sha256:sha(data),data:b64(data)});
  check(out.length<=MAX_FILES,'Wallet backup has too many files');
 }
}

/** Read the wallet inventory and return the encrypted envelope (an object). */
export async function createWalletBackup({walletDirectory,receivingWalletsDirectory=null,owner=null,passphrase,keyFile=KEY_FILE,kdf=DEFAULT_KDF,now=()=>new Date().toISOString()}){
 walletDirectory=resolve(walletDirectory);const secret=passphraseBytes(passphrase);secret.fill(0);
 const files=[];
 const key=await safeFile(join(walletDirectory,keyFile)).catch(error=>{if(error.code==='ENOENT')fail('WALLET_BACKUP_NO_KEY','This wallet has no spending key to back up.');throw error;});
 check(key.data.length===32,'Spending key file refused');
 files.push({path:'wallet/'+KEY_FILE,mode:0o600,sha256:sha(key.data),data:b64(key.data)});key.data.fill(0);
 await collect(walletDirectory,'wallet/',[IDENTITY_FILE,...FINANCIAL_ENTRIES],files);
 let identity=null;const marker=files.find(f=>f.path==='wallet/'+IDENTITY_FILE);
 if(marker){identity=validateIdentity(JSON.parse(Buffer.from(marker.data,'base64url').toString('utf8')),owner??undefined);}
 if(receivingWalletsDirectory)await collect(resolve(receivingWalletsDirectory),'receiving-wallets/',(await readdir(resolve(receivingWalletsDirectory))).filter(n=>!skipped(n)).sort(),files);
 const total=files.reduce((n,f)=>n+f.data.length,0);check(total<=MAX_TOTAL*1.4,'Wallet backup is too large');
 const createdAt=now(),payload={schema:PAYLOAD_SCHEMA,createdAt,owner:owner?{member:owner.member,publicKey:owner.publicKey}:identity?.owner??null,addresses:identity?.addresses??null,keyFile,inventory:files.map(f=>({path:f.path,sha256:f.sha256})),files};
 const salt=randomBytes(16),iv=randomBytes(12),keys=await deriveKeys(passphrase,{...kdf,salt:b64(salt)},salt);
 const header={schema:BACKUP_SCHEMA,kdf:{...kdf,salt:b64(salt)},cipher:'aes-256-gcm',iv:b64(iv),keyCheck:b64(keyCheckOf(keys.check)),createdAt};
 const plain=Buffer.from(JSON.stringify(payload),'utf8');
 try{
  const cipher=createCipheriv('aes-256-gcm',keys.encryption,iv);cipher.setAAD(headerBytes(header));
  const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);
  return{envelope:{...header,ciphertext:b64(ciphertext),tag:b64(cipher.getAuthTag())},summary:{createdAt,owner:payload.owner?.member??null,files:files.length,inventory:summarize(files)}};
 }finally{plain.fill(0);keys.encryption.fill(0);keys.check.fill(0);}
}
function summarize(files){const counts={};for(const f of files){const top=f.path.split('/').slice(0,2).join('/');counts[top]=(counts[top]??0)+1;}return counts;}

/** Write the envelope to a new file (never overwrites). */
export async function exportWalletBackup({out,...options}){
 const {envelope,summary}=await createWalletBackup(options),path=resolve(out);
 const handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600).catch(error=>{if(error.code==='EEXIST')fail('WALLET_BACKUP_EXISTS','The backup file already exists; choose a new name.');throw error;});
 try{await handle.writeFile(JSON.stringify(envelope)+'\n');await handle.sync();}finally{await handle.close();}
 return{file:path,...summary,encrypted:'scrypt+aes-256-gcm'};
}

/** Decrypt and fully verify a backup without writing anything. */
export async function openWalletBackup({file,envelope,passphrase}){
 if(!envelope){
  const handle=await open(resolve(file),constants.O_RDONLY|constants.O_NOFOLLOW);let text;
  try{const info=await handle.stat();check(info.isFile()&&info.size<=MAX_BACKUP,'Wallet backup file refused');text=await handle.readFile('utf8');}finally{await handle.close();}
  try{envelope=JSON.parse(text);}catch{fail('WALLET_BACKUP_CORRUPT','The wallet backup is corrupted (not a readable backup file).');}
 }
 if(!exact(envelope,['schema','kdf','cipher','iv','keyCheck','createdAt','ciphertext','tag'])||envelope.schema!==BACKUP_SCHEMA||envelope.cipher!=='aes-256-gcm')fail('WALLET_BACKUP_CORRUPT','The wallet backup is corrupted or not a wallet backup.');
 let salt,iv,tag,keyCheck,ciphertext;
 try{salt=unb64(envelope.kdf?.salt,16);iv=unb64(envelope.iv,12);tag=unb64(envelope.tag,16);keyCheck=unb64(envelope.keyCheck,16);ciphertext=unb64(envelope.ciphertext);}catch{fail('WALLET_BACKUP_CORRUPT','The wallet backup is corrupted.');}
 let keys;try{keys=await deriveKeys(passphrase,envelope.kdf,salt);}catch(error){if(error instanceof WalletBackupError&&error.code==='WALLET_BACKUP_WEAK_PASSPHRASE')fail('WALLET_BACKUP_WRONG_PASSPHRASE','Wrong backup passphrase.');if(error instanceof WalletBackupError)throw error;fail('WALLET_BACKUP_CORRUPT','The wallet backup is corrupted.');}
 let plain;
 try{
  if(!timingSafeEqual(keyCheckOf(keys.check),keyCheck))fail('WALLET_BACKUP_WRONG_PASSPHRASE','Wrong backup passphrase.');
  try{const decipher=createDecipheriv('aes-256-gcm',keys.encryption,iv);decipher.setAAD(headerBytes(envelope));decipher.setAuthTag(tag);plain=Buffer.concat([decipher.update(ciphertext),decipher.final()]);}
  catch{fail('WALLET_BACKUP_CORRUPT','The wallet backup is corrupted: the passphrase is right but the contents fail their integrity check.');}
 }finally{keys.encryption.fill(0);keys.check.fill(0);}
 let payload;try{payload=JSON.parse(plain.toString('utf8'));}catch{fail('WALLET_BACKUP_CORRUPT','The wallet backup is corrupted.');}finally{plain.fill(0);}
 try{validatePayload(payload);}catch(error){if(error instanceof WalletBackupError)throw error;fail('WALLET_BACKUP_CORRUPT','The wallet backup is corrupted: '+error.message);}
 return payload;
}
function validatePayload(p){
 check(exact(p,['schema','createdAt','owner','addresses','keyFile','inventory','files'])&&p.schema===PAYLOAD_SCHEMA&&Array.isArray(p.files)&&Array.isArray(p.inventory)&&p.files.length===p.inventory.length&&p.files.length<=MAX_FILES,'payload shape');
 check(p.owner===null||exact(p.owner,['member','publicKey'])&&/^uain1[a-f0-9]{40}$/.test(p.owner.member),'owner');
 const seen=new Set();
 p.files.forEach((f,i)=>{
  check(exact(f,['path','mode','sha256','data'])&&typeof f.path==='string'&&/^(wallet|receiving-wallets)\/[A-Za-z0-9._\/-]+$/.test(f.path)&&!f.path.split('/').some(x=>x===''||x==='.'||x==='..')&&!seen.has(f.path),'file path');seen.add(f.path);
  check(Number.isInteger(f.mode)&&!(f.mode&0o077),'file mode');
  const data=unb64(f.data);check(data.length<=MAX_FILE&&sha(data)===f.sha256&&p.inventory[i].path===f.path&&p.inventory[i].sha256===f.sha256,'file digest');
 });
 const key=p.files.find(f=>f.path==='wallet/'+KEY_FILE);check(key&&unb64(key.data).length===32,'spending key');
}

async function exists(path){try{await lstat(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function privateDirectory(path){await mkdir(path,{recursive:true,mode:0o700});const info=await lstat(path);check(info.isDirectory()&&!info.isSymbolicLink()&&!(info.mode&0o077)&&(!process.getuid||info.uid===process.getuid()),'Private directory refused: '+path);}
async function syncDirectory(path){const h=await open(path,'r');try{await h.sync();}finally{await h.close();}}

/** Operations whose send state the backup cannot prove: a recovery record
 * without a submit-once marker. They are fenced so restore never re-sends. */
function uncertainOperations(files){
 const recovery=new Set(),marked=new Set();
 for(const f of files){const m=f.path.match(/^wallet\/submissions\/([a-f0-9-]{36})\/(recovery|submission)\.json$/);if(m)(m[2]==='recovery'?recovery:marked).add(m[1]);}
 const sent=[...marked],unknown=[...recovery].filter(id=>!marked.has(id));return{sendAttempted:sent.sort(),uncertain:unknown.sort()};
}

/**
 * Restore into a fresh wallet directory. Refuses to overwrite, refuses an
 * owner mismatch, and leaves a `wallet-restore.json` marker that (a) fences
 * every restored submission so nothing is re-sent and (b) asks the runtime to
 * rescan the chain for owned notes.
 */
export async function restoreWalletBackup({file,envelope,passphrase,walletDirectory,receivingWalletsDirectory=null,owner=null,keyFile=KEY_FILE,now=()=>new Date().toISOString()}){
 walletDirectory=resolve(walletDirectory);
 const payload=await openWalletBackup({file,envelope,passphrase});
 if(owner&&payload.owner&&(payload.owner.member!==owner.member||payload.owner.publicKey!==owner.publicKey))fail('WALLET_RESTORE_OWNER_MISMATCH','This backup belongs to a different owner ('+payload.owner.member+').');
 const target=payload.files.map(f=>({...f,dest:f.path.startsWith('wallet/')?join(walletDirectory,f.path==='wallet/'+KEY_FILE?keyFile:f.path.slice(7)):receivingWalletsDirectory?join(resolve(receivingWalletsDirectory),f.path.slice('receiving-wallets/'.length)):null}));
 if(target.some(f=>f.dest===null))fail('WALLET_RESTORE_NEEDS_RECEIVING_DIRECTORY','This backup contains receiving wallets; pass the receiving-wallets directory to restore them.');
 for(const f of target){const root=f.path.startsWith('wallet/')?walletDirectory:resolve(receivingWalletsDirectory);check(f.dest.startsWith(root+sep),'Restore path escapes its directory');}
 await privateDirectory(walletDirectory);
 if(await exists(join(walletDirectory,keyFile))||await exists(join(walletDirectory,IDENTITY_FILE))||await financialStatePresent(walletDirectory))fail('WALLET_RESTORE_WOULD_OVERWRITE','This wallet directory already has a key or payment journals. Restore only into a fresh profile; nothing was changed.');
 for(const f of target)if(await exists(f.dest))fail('WALLET_RESTORE_WOULD_OVERWRITE','Restore would overwrite '+f.dest+'; nothing was changed.');
 const written=[];
 try{
  for(const f of target){
   await privateDirectory(dirname(f.dest));const data=unb64(f.data);
   const handle=await open(f.dest,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);written.push(f.dest);
   try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();data.fill(0);}
  }
  const fence=uncertainOperations(payload.files);
  if(!target.some(f=>f.path==='wallet/'+IDENTITY_FILE)&&payload.owner&&payload.addresses){
   const path=join(walletDirectory,IDENTITY_FILE);const handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);written.push(path);
   try{await handle.writeFile(JSON.stringify({schema:'baink-wallet-identity-v1',owner:payload.owner,addresses:payload.addresses,createdAt:now(),origin:'restored'})+'\n');await handle.sync();}finally{await handle.close();}
  }
  const marker={schema:'baink-wallet-restore-v1',restoredAt:now(),backupCreatedAt:payload.createdAt,owner:payload.owner,addresses:payload.addresses,fencedOperations:[...fence.sendAttempted,...fence.uncertain].sort(),uncertainOperations:fence.uncertain,rescan:{state:'pending',height:null,sources:null,completedAt:null}};
  const path=join(walletDirectory,RESTORE_FILE),temporary=await mkdtemp(join(walletDirectory,'.restore-'));
  try{const pending=join(temporary,'v'),h=await open(pending,'wx',0o600);try{await h.writeFile(JSON.stringify(marker)+'\n');await h.sync();}finally{await h.close();}await link(pending,path);written.push(path);}finally{await rm(temporary,{recursive:true,force:true});}
  await rm(join(walletDirectory,SETUP_FILE),{force:true});
  await syncDirectory(walletDirectory);
  return{restored:true,owner:payload.owner?.member??null,addresses:payload.addresses,files:target.length,inventory:summarize(payload.files),uncertainOperations:fence.uncertain,rescan:'pending: the holder rescans the chain for owned notes once its node has caught up',backupCreatedAt:payload.createdAt};
 }catch(error){
  for(const path of written.reverse())await rm(path,{force:true}).catch(()=>{});
  throw error;
 }
}

/** Read the restore marker, or null. */
export async function readRestoreMarker(walletDirectory){
 try{const h=await open(join(walletDirectory,RESTORE_FILE),constants.O_RDONLY|constants.O_NOFOLLOW);try{return JSON.parse(await h.readFile('utf8'));}finally{await h.close();}}catch(error){if(error.code==='ENOENT')return null;throw error;}
}
export async function updateRestoreMarker(walletDirectory,update){
 const current=await readRestoreMarker(walletDirectory);if(!current)return null;const next={...current,...update(current)};
 const path=join(walletDirectory,RESTORE_FILE),temporary=path+'.'+process.pid+'.new';
 const h=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o600);try{await h.writeFile(JSON.stringify(next)+'\n');await h.sync();}finally{await h.close();}
 await rename(temporary,path);await syncDirectory(walletDirectory);return next;
}
/** True when a restored submission must never be broadcast again. */
export async function restoreFenced(walletDirectory,operationId){
 const marker=await readRestoreMarker(walletDirectory);return Boolean(marker&&Array.isArray(marker.fencedOperations)&&marker.fencedOperations.includes(operationId));
}

/** Read a passphrase from an environment variable or the terminal. */
export async function readPassphrase({env=process.env,variable='BAINK_WALLET_PASSPHRASE',prompt='Wallet backup passphrase: ',confirm=false,input=process.stdin,output=process.stderr}={}){
 if(typeof env[variable]==='string'&&env[variable].length)return env[variable];
 check(input.isTTY,`Set ${variable} or run in a terminal to enter the backup passphrase.`);
 const ask=label=>new Promise((resolve,reject)=>{output.write(label);const muted=new Writable({write(_c,_e,cb){cb();}});const rl=createInterface({input,output:muted,terminal:true});rl.once('line',line=>{rl.close();output.write('\n');resolve(line);});rl.once('SIGINT',()=>{rl.close();reject(Error('Cancelled'));});});
 const first=await ask(prompt);if(confirm){const second=await ask('Repeat passphrase: ');check(first===second,'The passphrases differ.');}return first;
}
