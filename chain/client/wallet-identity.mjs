/** Which spending key belongs to which owner, decided once and never guessed.
 *
 * A holder wallet directory is "bound" once it has a spending key, a
 * `wallet-identity.json` marker or any financial journal. A bound directory
 * whose key is missing is refused: making a new key there would silently move
 * the owner to an empty wallet while the old notes stay on the lost key. A key
 * is created only on an explicit first-time setup (the `wallet-setup.json`
 * permit that `bind` writes into an empty wallet directory); every other case
 * points the operator to `restore`.
 *
 * No secret is read here. Key bytes are opened only by the pinned wallet tools.
 */
import {lstat,readdir,open,rename,rm,link,mkdtemp} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,dirname} from 'node:path';

export const IDENTITY_FILE='wallet-identity.json';
export const SETUP_FILE='wallet-setup.json';
export const RESTORE_FILE='wallet-restore.json';
export const KEY_FILE='orchard-key.json';
/** Files and directories that record money. Any byte here means "bound". */
export const FINANCIAL_ENTRIES=Object.freeze(['exchange','submissions','review-provenance','owned-note-sources.json']);
const ADDRESS=/^[a-f0-9]{86}$/;

export class WalletRestoreRequired extends Error{
 constructor(message){super(message);this.code='WALLET_RESTORE_REQUIRED';}
}
const check=(ok,message)=>{if(!ok)throw Error(message);};
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const sameOwner=(a,b)=>exact(a,['member','publicKey'])&&exact(b,['member','publicKey'])&&a.member===b.member&&a.publicKey===b.publicKey;

async function exists(path){try{await lstat(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
export async function readPrivateJSON(path,limit=16384){
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const info=await file.stat();check(info.isFile()&&info.size<=limit&&!(info.mode&0o077)&&(!process.getuid||info.uid===process.getuid()),'Private wallet file refused: '+path);return JSON.parse(await file.readFile('utf8'));}finally{await file.close();}
}
/** Durable create-only write: never replaces an existing file unless asked. */
export async function writePrivateJSON(path,value,{replace=false}={}){
 const parent=dirname(path),temporary=await mkdtemp(join(parent,'.wallet-identity-'));
 try{
  const pending=join(temporary,'value'),file=await open(pending,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await file.writeFile(JSON.stringify(value)+'\n');await file.sync();}finally{await file.close();}
  if(replace)await rename(pending,path);else await link(pending,path);
  const folder=await open(parent,'r');try{await folder.sync();}finally{await folder.close();}
 }finally{await rm(temporary,{recursive:true,force:true});}
}

/** True when any journal byte exists. Empty directories do not count. */
export async function financialStatePresent(walletDirectory){
 async function any(path){
  let info;try{info=await lstat(path);}catch(error){if(error.code==='ENOENT')return false;throw error;}
  if(!info.isDirectory())return true;
  for(const name of await readdir(path))if(await any(join(path,name)))return true;
  return false;
 }
 for(const name of FINANCIAL_ENTRIES)if(await any(join(walletDirectory,name)))return true;
 return false;
}

export function validateIdentity(value,owner){
 check(exact(value,['schema','owner','addresses','createdAt','origin'])&&value.schema==='baink-wallet-identity-v1','Wallet identity marker refused');
 check(exact(value.addresses,['external','internal'])&&ADDRESS.test(value.addresses.external)&&ADDRESS.test(value.addresses.internal),'Wallet identity addresses refused');
 check(['first-setup','adopted','restored'].includes(value.origin)&&Number.isFinite(Date.parse(value.createdAt)),'Wallet identity marker refused');
 if(owner!==undefined&&!sameOwner(value.owner,owner))throw new WalletRestoreRequired('This wallet belongs to a different owner; it will not be reused or replaced.');
 return value;
}
export async function readWalletIdentity(walletDirectory,owner){
 try{return validateIdentity(await readPrivateJSON(join(walletDirectory,IDENTITY_FILE)),owner);}catch(error){if(error.code==='ENOENT')return null;throw error;}
}
export function setupPermit(owner){return{schema:'baink-wallet-first-setup-v1',owner:{member:owner.member,publicKey:owner.publicKey}};}

/**
 * Decide whether the spending key may be used, must be created, or must be
 * restored. `keygen({file})` and `readAddresses({spendingKeyFile})` are the
 * pinned tools; neither is called unless the decision allows it.
 */
export async function ensureWalletKey({walletDirectory,owner,keygen,readAddresses,now=()=>new Date().toISOString()}){
 const keyFile=join(walletDirectory,KEY_FILE),identity=await readWalletIdentity(walletDirectory,owner);
 const restoreHint='Restore it with: node cli.mjs restore ROOT TRUST.json STATE_DIRECTORY BACKUP.json';
 if(!await exists(keyFile)){
  if(identity)throw new WalletRestoreRequired('The spending key for this bound wallet is missing. A new key would not hold your funds. '+restoreHint);
  if(await financialStatePresent(walletDirectory))throw new WalletRestoreRequired('Payment journals exist but the spending key is missing. '+restoreHint);
  let permit=null;try{permit=await readPrivateJSON(join(walletDirectory,SETUP_FILE));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!permit)throw new WalletRestoreRequired('No spending key and no first-time setup was requested. Run bind for a new wallet, or restore an existing one. '+restoreHint);
  check(exact(permit,['schema','owner'])&&permit.schema==='baink-wallet-first-setup-v1','Wallet setup permit refused');
  if(!sameOwner(permit.owner,owner))throw new WalletRestoreRequired('The first-time setup was requested for a different owner.');
  await keygen({file:keyFile});
  const addresses=await readAddresses({spendingKeyFile:keyFile});
  await writePrivateJSON(join(walletDirectory,IDENTITY_FILE),{schema:'baink-wallet-identity-v1',owner:{member:owner.member,publicKey:owner.publicKey},addresses,createdAt:now(),origin:'first-setup'});
  await rm(join(walletDirectory,SETUP_FILE),{force:true});
  return{addresses,created:true,identity:'first-setup'};
 }
 const addresses=await readAddresses({spendingKeyFile:keyFile});
 if(identity){
  if(identity.addresses.external!==addresses.external||identity.addresses.internal!==addresses.internal)throw new WalletRestoreRequired('The spending key on disk is not the key this wallet was bound to. '+restoreHint);
  await rm(join(walletDirectory,SETUP_FILE),{force:true});
  return{addresses,created:false,identity:identity.origin};
 }
 // Wallets made before this marker existed: adopt the key that is there.
 await writePrivateJSON(join(walletDirectory,IDENTITY_FILE),{schema:'baink-wallet-identity-v1',owner:{member:owner.member,publicKey:owner.publicKey},addresses,createdAt:now(),origin:'adopted'});
 await rm(join(walletDirectory,SETUP_FILE),{force:true});
 return{addresses,created:false,identity:'adopted'};
}
