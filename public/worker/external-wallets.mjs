// Receiving keys are created, retained and used exclusively on the member's
// machine. Return public addresses only. Research tools cannot call this module.
import {createPrivateKey,createPublicKey,generateKeyPairSync,randomBytes,sign,webcrypto} from 'node:crypto';
import {constants} from 'node:fs';
import {open,mkdir,mkdtemp,link,rm,lstat,readFile,rename} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {secp256k1,keccak_256,base58Encode} from './wallet-crypto.mjs';
const POLICY='member-proved-external-wallet-v1';
const networks=['ethereum','solana'];
const memberID=value=>typeof value==='string'&&/^uain1[0-9a-f]{40}$/.test(value);
const hex=bytes=>Buffer.from(bytes).toString('hex');
// Noble also uses secure randomness for scalar blinding. Node 18 exposes its
// standard provider through node:crypto but may omit the browser-style global.
function cryptoReady(){if(typeof globalThis.crypto?.getRandomValues!=='function')Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true,writable:true})}
async function directory(path){await mkdir(path,{mode:0o700,recursive:true});const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0||process.getuid&&info.uid!==process.getuid())throw Error('private owned wallet directory required');return resolve(path)}
async function json(path){const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const info=await file.stat();if(!info.isFile()||info.size>128*1024||(info.mode&0o077)!==0||process.getuid&&info.uid!==process.getuid())throw Error('private owned wallet file required');return JSON.parse(await file.readFile('utf8'))}finally{await file.close()}}
async function durable(path,value,replace=false){const parent=dirname(path),temporary=await mkdtemp(join(parent,'.wallet-'));try{const pending=join(temporary,'value'),file=await open(pending,'wx',0o600);try{await file.writeFile(JSON.stringify(value)+'\n');await file.sync()}finally{await file.close()}if(replace)await rename(pending,path);else await link(pending,path);const folder=await open(parent,'r');try{await folder.sync()}finally{await folder.close()}}finally{await rm(temporary,{force:true,recursive:true})}}
function keyAddress(key,network,member){
 if(key.format!=='uain-receiving-wallet-v1'||key.member!==member||key.network!==network)throw Error('existing local wallet identity differs');
 let address,secret;
 if(network==='ethereum'){if(typeof key.private_key!=='string'||!/^[0-9a-f]{64}$/.test(key.private_key))throw Error('existing Ethereum key invalid');secret=Buffer.from(key.private_key,'hex');address='0x'+hex(keccak_256(secp256k1.getPublicKey(secret,false).subarray(1)).subarray(12))}
 else{secret=createPrivateKey({key:{kty:'OKP',crv:'Ed25519',d:key.private_key,x:key.public_key},format:'jwk'});const pub=createPublicKey(secret).export({format:'jwk'}).x;if(pub!==key.public_key)throw Error('existing Solana key differs');address=base58Encode(Buffer.from(pub,'base64url'))}
 if(address!==key.address)throw Error('existing local wallet address differs');return{address,secret};
}
export async function ensureLocalWallet({directory:root,member,network}){
 cryptoReady();
 if(!memberID(member)||!networks.includes(network))throw Error('receiving wallet member/network required');
 const parent=await directory(root),file=join(parent,network+'.json');let key;
 try{key=await json(file)}catch(error){if(error.code!=='ENOENT')throw error;
  if(network==='ethereum'){const secret=secp256k1.utils.randomSecretKey(randomBytes(secp256k1.lengths.seed));key={format:'uain-receiving-wallet-v1',member,network,private_key:hex(secret),address:'0x'+hex(keccak_256(secp256k1.getPublicKey(secret,false).subarray(1)).subarray(12))}}
  else{const pair=generateKeyPairSync('ed25519'),pub=pair.publicKey.export({format:'jwk'}).x;key={format:'uain-receiving-wallet-v1',member,network,public_key:pub,private_key:pair.privateKey.export({format:'jwk'}).d,address:base58Encode(Buffer.from(pub,'base64url'))}}
  try{await durable(file,key)}catch(error){if(error.code!=='EEXIST')throw error}key=await json(file);
 }
 const{address}=keyAddress(key,network,member);return{network,address,file};
}
export async function walletBindingPayload({file,member,network,state,expiresInBlocks=100}){
 cryptoReady();
 if(!memberID(member)||!networks.includes(network)||!Number.isInteger(expiresInBlocks)||expiresInBlocks<1||expiresInBlocks>720||typeof state.chain_id!=='string'||/[\r\n]/.test(state.chain_id)||!/^\d+$/.test(state.member?.sequence)||!/^\d+$/.test(state.height))throw Error('bounded proved wallet context required');
 const{address,secret}=keyAddress(await json(file),network,member),expires_height=String(BigInt(state.height)+BigInt(expiresInBlocks)),message=Buffer.from(`UAIN external wallet binding v1\nchain_id: ${state.chain_id}\nmember: ${member}\nsequence: ${state.member.sequence}\nnetwork: ${network}\naddress: ${address}\nexpires_height: ${expires_height}\n`);
 let signature;if(network==='solana')signature=base58Encode(sign(null,message,secret));else{const digest=keccak_256(Buffer.concat([Buffer.from('\x19Ethereum Signed Message:\n'+message.length),message])),signed=secp256k1.sign(digest,secret,{prehash:false,format:'recovered',lowS:true});if(signed[0]>1)throw Error('unsupported Ethereum recovery byte');signature='0x'+hex(Buffer.concat([signed.subarray(1),Buffer.from([signed[0]+27])]))}
 return{network,address,expires_height,signature};
}
async function binding(action,reader,member,network){
 const key='external_wallet/'+member+'/'+network,state=await action('state',{reader,selection:{member,keys:[key]}}),current=state.records?.[key];
 if(state.member?.id!==member||state.member.licence!=='active')throw Error('proved active member required for receiving wallets');
 if(current==null)return null;if(current.active===false){if(current.policy!==POLICY||current.member!==member||current.network!==network)throw Error('external wallet unbinding identity differs');return{network,address:null,unbound:true}}
 if(current.policy!==POLICY||current.member!==member||current.network!==network||current.active!==true||!/^\d{20}$/.test(current.binding)||typeof current.address!=='string')throw Error('external wallet binding identity differs');
 const immutable='external_wallet_binding/'+current.binding,end='external_wallet_end/'+current.binding,owner='external_wallet_owner/'+network+'/'+current.address,proof=await action('state',{reader,selection:{keys:[key,immutable,end,owner]}});
 if(JSON.stringify(proof.records?.[key])!==JSON.stringify(current)||JSON.stringify(proof.records?.[immutable])!==JSON.stringify(current)||proof.records?.[end]!==null||proof.records?.[owner]!==member)throw Error('external wallet binding proof differs');
 return{network,address:current.address,binding:current.binding};
}
export async function provisionReceivingWallets(input,deps){
 const{action}=deps,member=input.member;if(!memberID(member))throw Error('local wallet member required');
 const root=await directory(input.directory),journals=await directory(join(root,'bindings-'+input.reader.genesisSha256));
 const lock=join(root,'provision.lock');let held=false;
 for(let attempt=0;attempt<2&&!held;attempt++){
  // Publish the complete, synced owner record with one exclusive hardlink.
  // No observable lock can exist without its owner after a crash.
  try{await durable(lock,{pid:process.pid});held=true}catch(error){
   if(held){await rm(lock,{recursive:true,force:true});throw error}if(error.code!=='EEXIST')throw error;
   const recovery=lock+'.recovery';try{await durable(recovery,{pid:process.pid})}catch(error){if(error.code==='EEXIST')throw Error('wallet provisioning recovery busy; if interrupted, verify its recorded process has ended before removing the recovery file');throw error}
   try{
    let owner;try{owner=await json(lock)}catch(error){if(error.code==='ENOENT')continue;throw error}if(!Number.isInteger(owner.pid)||owner.pid<1)throw Error('wallet provisioning lock requires recovery');
    try{process.kill(owner.pid,0);throw Error('wallet provisioning already running')}catch(error){if(error.code!=='ESRCH')throw error;await rm(lock,{force:true})}
    // Keep recovery exclusive until the dead owner's replacement is published.
    // Another initializer can win an empty slot, but cannot have its live lock
    // removed by a second stale-owner recovery process.
    try{await durable(lock,{pid:process.pid});held=true}catch(error){if(error.code!=='EEXIST')throw error}
   }finally{await rm(recovery,{force:true})}
  }
 }
 if(!held)throw Error('wallet provisioning busy');
 try{const wallets={},memberState=await action('state',{reader:input.reader,selection:{member,keys:[]}});
  if(memberState.member?.id!==member)throw Error('proved receiving wallet member required');
  if(memberState.member.licence==='pending'){
   for(const network of networks){const local=await ensureLocalWallet({directory:root,member,network});wallets[network]={network,address:local.address,ownership_binding_pending:true}}
   return{finalized:false,licence_required:true,wallets};
  }
  if(memberState.member.licence!=='active')throw Error('active member licence required for receiving wallet binding');
  for(const network of networks){
  const current=await binding(action,input.reader,member,network);if(current){wallets[network]=current;continue}
  const wallet=await ensureLocalWallet({directory:root,member,network});let journalFile=join(journals,network+'.command.json');
  for(let attempt=0;;attempt++){
   let exists=true;try{await lstat(journalFile)}catch(error){if(error.code!=='ENOENT')throw error;exists=false}
   if(!exists){await action('prepare-wallet',{reader:input.reader,signingKeyFile:input.signingKeyFile,network,walletFile:wallet.file,out:journalFile});break}
   const status=await action('wallet-status',{reader:input.reader,signingKeyFile:input.signingKeyFile,network,journalFile});if(!status.expired)break;
   if(attempt>=7||!/^[A-F0-9]{64}$/.test(status.transaction_hash))throw Error('receiving wallet expired recovery exceeds bound');journalFile=join(journals,network+'.after-'+status.transaction_hash+'.command.json');
  }
  const progress=journalFile+'.progress.json';
  await action('submit',{reader:input.reader,journalFile});
  let afterEvent;try{afterEvent=(await json(progress)).after_event;if(typeof afterEvent!=='string'||!/^(0|[1-9][0-9]*)$/.test(afterEvent))throw Error('invalid wallet receipt cursor')}catch(error){if(error.code!=='ENOENT')throw error}
  let receipt;for(let attempt=0;attempt<(deps.receiptAttempts??12);attempt++){
   receipt=await action('receipt',{reader:input.reader,journalFile,...(afterEvent===undefined?{}:{afterEvent})});if(receipt.finalized)break;
   if(typeof receipt.scanned_through!=='string'||!/^(0|[1-9][0-9]*)$/.test(receipt.scanned_through)||afterEvent!==undefined&&BigInt(receipt.scanned_through)<BigInt(afterEvent))throw Error('wallet receipt cursor differs');afterEvent=receipt.scanned_through;await durable(progress,{after_event:afterEvent},true);if(attempt+1<(deps.receiptAttempts??12))await delay(deps.receiptDelay??500);
  }
  if(!receipt?.finalized)return{finalized:false,receipt_required:true,wallets,pending:{network,address:wallet.address}};
  const proved=await binding(action,input.reader,member,network);if(!proved||proved.address!==wallet.address)throw Error('finalized receiving wallet binding differs');wallets[network]=proved;
 }return{finalized:true,wallets}}finally{await rm(lock,{recursive:true,force:true})}
}
