/** Holder-local bridge around the existing reviewed private workflow.
 * Ed25519 signing is an external capability; this module never accepts its
 * private key. Orchard keys remain files used only by the local native wallet.
 * No server, relay signer, broadcast or automatic ethical decision is included.
 */
import { createHash,createPublicKey,verify } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import { readPrivateState,assertPrivateStateContext } from '../../../chain/client/private-state.mjs';
import { producePrivateTrade,verifyPrivateTradeApproval,verifyPrivateTradeEnvelope } from '../../../chain/client/private-workflow.mjs';
import { privatePurposeCommitment,verifyPrivatePartyConsent } from '../../../chain/client/private-review.mjs';
import { coinBoundaryPurposeCommitment } from '../../../chain/client/coin-boundary.mjs';
import { canonicalJSON,memberAddress,signingBytes } from '../../../chain/client/signing.mjs';

const HEX=/^[a-f0-9]{64}$/,ADDRESS=/^uain1[a-f0-9]{40}$/;
const hash=value=>createHash('sha256').update(value).digest();
function requireCondition(ok,message='External holder request refused'){if(!ok)throw new Error(message);}
function exact(value,fields){return value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length===fields.length&&fields.every(k=>Object.hasOwn(value,k));}
function uint(value,max=0xffffffffffffffffn,zero=true){requireCondition(typeof value==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(value)&&BigInt(value)<=max&&(zero||BigInt(value)>0n));return BigInt(value);}
function publicBytes(value){requireCondition(typeof value==='string');const raw=Buffer.from(value,'base64url');requireCondition(raw.length===32&&raw.toString('base64url')===value);return raw;}
const publicObject=value=>createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:value},format:'jwk'});
function publicIdentity(value){requireCondition(exact(value,['member','publicKey'])&&ADDRESS.test(value.member)&&memberAddress(publicBytes(value.publicKey))===value.member);return structuredClone(value);}
function boundary(intent){return intent.operation==='private_payment'?null:{direction:intent.operation==='coin_shield'?'shield':'exit',member:intent.owner.member,amount:intent.amount};}
function effectiveAgreement(intent){
 // Keep the original random salt private while binding the exact new holder
 // request into the protocol's existing salted-purpose commitment. Legacy OTC
 // frames do not otherwise commit the typed amount or the selected parties.
 const metadata={id:intent.id,operation:intent.operation,amount:intent.amount,owner:intent.owner,recipient:intent.recipient,reviewer:intent.reviewer,salt:intent.agreement.salt};
 return {text:intent.agreement.text,salt:hash('BAINK/holder-intent-salt/v1\0'+canonicalJSON(metadata)).toString('hex')};
}
function purpose(intent){const agreement=effectiveAgreement(intent);return boundary(intent)?coinBoundaryPurposeCommitment(agreement,boundary(intent)):privatePurposeCommitment(agreement);}
export function holderPrivateAgreement(value){return effectiveAgreement(reviewedIntent(value));}
export function holderIntentPurpose(value){return purpose(reviewedIntent(value));}
function reviewedIntent(value){
 requireCondition(exact(value,['id','operation','amount','agreement','reviewer','owner','recipient']));
 requireCondition(typeof value.id==='string'&&/^[A-Za-z0-9_-]{8,100}$/.test(value.id)&&['coin_shield','coin_exit','private_payment'].includes(value.operation)&&ADDRESS.test(value.reviewer));
 uint(value.amount,0x7fffffffffffffffn,false);requireCondition(exact(value.agreement,['text','salt']));privatePurposeCommitment(value.agreement);publicIdentity(value.owner);
 requireCondition(value.reviewer!==value.owner.member);
 if(value.operation==='private_payment'){
  requireCondition(exact(value.recipient,['member','publicKey','address']));publicIdentity({member:value.recipient.member,publicKey:value.recipient.publicKey});
  requireCondition(value.recipient.member!==value.owner.member&&value.recipient.member!==value.reviewer&&typeof value.recipient.address==='string'&&/^[a-f0-9]{86}$/.test(value.recipient.address));
 }else requireCondition(value.recipient===null);
 return structuredClone(value);
}
function exactContext(value){
 requireCondition(exact(value,['version','chain','expires','licenceRevision','effects','purpose','reviewer'])&&value.version===1&&typeof value.chain==='string'&&value.chain.length>=1&&Buffer.byteLength(value.chain)<=128);
 uint(value.expires,0x7fffffffffffffffn,false);uint(value.licenceRevision);
 for(const key of ['effects','purpose','reviewer'])requireCondition(typeof value[key]==='string'&&HEX.test(value[key]));
}
/** Existing privatePartyConsent wire protocol, reproduced without needing an
 * Ed25519 private key. Compatibility is checked against the signed client. */
export function privatePartyConsentSigningBytes(context,address){
 exactContext(context);requireCondition(typeof address==='string'&&/^[a-f0-9]{86}$/.test(address));
 const expiry=Buffer.alloc(8),revision=Buffer.alloc(8);expiry.writeBigUInt64BE(BigInt(context.expires));revision.writeBigUInt64BE(BigInt(context.licenceRevision));
 return Buffer.concat([Buffer.from('UAIN/private-review/party-consent/v1\0'),Buffer.from('UAIN/private-review/context/v1\0'),hash(context.chain),expiry,revision,Buffer.from(context.effects,'hex'),Buffer.from(context.purpose,'hex'),Buffer.from(context.reviewer,'hex'),Buffer.from(address,'hex')]);
}
function readProfile(reader,pins){
 requireCondition(reader&&typeof reader==='object'&&HEX.test(reader.executableSha256??'')&&HEX.test(reader.genesisSha256??'')&&reader.genesisSha256===pins.genesisSha256&&typeof reader.executable==='string'&&isAbsolute(reader.executable)&&typeof reader.genesis==='string'&&isAbsolute(reader.genesis));
 const url=new URL(reader.rpc),host=url.hostname.replace(/^\[|\]$/g,'');
 requireCondition(url.protocol==='http:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/'&&reader.socksProxy===undefined&&(isIP(host)===4&&host.split('.')[0]==='127'||host==='::1'),'A holder-owned loopback full node is required');
 requireCondition(reader.maxAgeSeconds===undefined||Number.isInteger(reader.maxAgeSeconds)&&reader.maxAgeSeconds>=1&&reader.maxAgeSeconds<=120);
 // Requests are always derived from the reviewed intent, never a profile's
 // saved selectors. The signed reader still verifies all semantic proofs.
 const copy=structuredClone(reader);delete copy.request;return copy;
}
function proofIdentity(actual,expected){requireCondition(actual?.member===expected.member&&actual.public_key===expected.publicKey&&memberAddress(publicBytes(actual.public_key))===actual.member);}
function requestFor(intent,{policyOnly=false,skipWitness=false,source}={}){
 const result=policyOnly?{policy_only:true,reviewer:intent.reviewer}:intent.operation==='private_payment'?{reviewer:intent.reviewer,parties:[intent.owner.member,intent.recipient.member]}:{reviewer:intent.reviewer,boundary_member:intent.owner.member,parties:[]};
 if(skipWitness)result.skip_witness=true;
 if(source)result[source.kind==='payment'?'source_payments':'source_boundaries']=[source.id];
 return result;
}
function payloadResult(intent,result){
 requireCondition(result&&typeof result==='object'&&['operation','payload','local_receipt'].every(k=>Object.hasOwn(result,k))&&Object.keys(result).length===3&&result.operation===intent.operation&&exact(result.payload,['bundle','approval']));
 const wire=typeof result.payload.bundle==='string'?Buffer.from(result.payload.bundle,'base64url'):Buffer.alloc(0);
 requireCondition(wire.length>=1&&wire.length<=16384&&wire.toString('base64url')===result.payload.bundle);
 requireCondition(result.local_receipt?.effects===result.payload.approval?.effects);
 return structuredClone(result);
}
export function createExternalHolder({identity,reader,tools,pins,sign,now=Date.now}){
 const holder=publicIdentity(identity);
 requireCondition(exact(pins,['chainId','genesisSha256'])&&typeof pins.chainId==='string'&&/^[A-Za-z0-9._-]{1,96}$/.test(pins.chainId)&&HEX.test(pins.genesisSha256)&&typeof sign==='function'&&typeof now==='function');
 pins=structuredClone(pins);reader=readProfile(reader,pins);
 requireCondition(exact(tools,['coinWallet','privateWallet']));
 for(const tool of Object.values(tools))requireCondition(exact(tool,['executable','executableSha256'])&&typeof tool.executable==='string'&&isAbsolute(tool.executable)&&HEX.test(tool.executableSha256));
 tools=structuredClone(tools);
 const owned=intent=>requireCondition(intent.owner.member===holder.member&&intent.owner.publicKey===holder.publicKey,'The reviewed owner must match this browser identity');
 function checkedState(intent,state,context){
  requireCondition(state.chain_id===pins.chainId&&state.reviewer?.member===intent.reviewer&&memberAddress(publicBytes(state.reviewer.public_key))===intent.reviewer);
  requireCondition(state.relayer?.member===memberAddress(publicBytes(state.relayer.public_key))&&state.relayer.member!==intent.owner.member&&(!intent.recipient||state.relayer.member!==intent.recipient.member));
  if(context){exactContext(context);requireCondition(context.chain===pins.chainId&&context.purpose===purpose(intent));assertPrivateStateContext(state,context);}
  if(state.coin?.owner)proofIdentity(state.coin.owner,intent.owner);
  if(!state.policy_only&&intent.operation==='private_payment'){
   requireCondition(state.parties.length===2);proofIdentity(state.parties[0],intent.owner);proofIdentity(state.parties[1],intent.recipient);
  }
  const age=now()-Date.parse(state.header_time),bound=(reader.maxAgeSeconds??120)*1000;
  requireCondition(Number.isFinite(age)&&age>=-60000&&age<=bound);
  return state;
 }
 async function stateFor(intent,context,options={}){
  return checkedState(intent,await readPrivateState({...reader,request:requestFor(intent,options)}),context);
 }
 function contextFor(intent,state,approval){
  const context={version:1,chain:state.chain_id,expires:approval.expires_height,licenceRevision:approval.licence_revision,effects:approval.effects,purpose:approval.purpose_commitment,reviewer:publicBytes(state.reviewer.public_key).toString('hex')};
  checkedState(intent,state,context);
  verifyPrivateTradeApproval({approval,context,boundary:boundary(intent),reviewerPublicKey:publicObject(state.reviewer.public_key)});
  return context;
 }
 async function external(intent,state,context,kind,bytes,extra){
  checkedState(intent,state,context);
  const expiresAt=Math.min(now()+60000,Date.parse(state.header_time)+(reader.maxAgeSeconds??120)*1000);requireCondition(Number.isFinite(expiresAt)&&expiresAt>now());
  const request={schema:'baink-holder-signature-v1',kind,chainId:pins.chainId,genesisSha256:pins.genesisSha256,member:holder.member,publicKey:holder.publicKey,intent:structuredClone(intent),context:structuredClone(context),expiresAt,signingBytesBase64:bytes.toString('base64'),signingDigest:hash(bytes).toString('hex'),...extra};
  const controller=new AbortController();let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('External signing window expired'));},Math.max(1,expiresAt-now()));});
  let reply;
  try{reply=await Promise.race([Promise.resolve().then(()=>sign(structuredClone(request),{signal:controller.signal})),timeout]);}
  finally{clearTimeout(timer);}
  requireCondition(now()<expiresAt&&exact(reply,['publicKey','signature'])&&reply.publicKey===holder.publicKey&&typeof reply.signature==='string');
  const signature=Buffer.from(reply.signature,'base64url');
  requireCondition(signature.length===64&&signature.toString('base64url')===reply.signature&&verify(null,bytes,publicObject(holder.publicKey),signature),'The browser signature does not match the reviewed request');
  checkedState(intent,state,context);return reply.signature;
 }
 const api={
  async signConsent(value,{context,address}){
   const intent=reviewedIntent(value);context=structuredClone(context);exactContext(context);
   const isOwner=holder.member===intent.owner.member&&holder.publicKey===intent.owner.publicKey;
   const isRecipient=intent.recipient&&holder.member===intent.recipient.member&&holder.publicKey===intent.recipient.publicKey;
   requireCondition(isOwner||isRecipient);
   requireCondition(typeof address==='string'&&/^[a-f0-9]{86}$/.test(address)&&(!isRecipient||address===intent.recipient.address)&&(!intent.recipient||!isOwner||address!==intent.recipient.address));
   const state=await stateFor(intent,context,{skipWitness:true});
   const signature=await external(intent,state,context,'party_consent',privatePartyConsentSigningBytes(context,address),{address});
   await stateFor(intent,context,{skipWitness:true});
   const consent={publicKey:publicBytes(holder.publicKey).toString('hex'),address,signature};verifyPrivatePartyConsent(context,consent,publicObject(holder.publicKey));return consent;
  },
  async produce(value,options){
   const intent=reviewedIntent(value);owned(intent);
   requireCondition(options&&typeof options==='object'&&Object.keys(options).every(k=>['spendingKeyFile','source','memo','recipientConsent','certificate','review','timeoutMs'].includes(k))&&typeof options.spendingKeyFile==='string'&&isAbsolute(options.spendingKeyFile)&&typeof options.certificate==='function'&&typeof options.review==='function');
   const info=await lstat(options.spendingKeyFile);requireCondition(info.isFile()&&!info.isSymbolicLink()&&!(info.mode&0o077)&&(!process.getuid||info.uid===process.getuid()));
   if(intent.operation==='coin_shield')requireCondition(options.source===undefined);
   else requireCondition(exact(options.source,['kind','id','position'])&&['payment','boundary'].includes(options.source.kind)&&HEX.test(options.source.id)&&Number.isSafeInteger(options.source.position)&&options.source.position>=0&&options.source.position<=0xffffffff);
   if(intent.operation==='private_payment')requireCondition(typeof options.recipientConsent==='function');
   let expectedEffects;
   const result=await producePrivateTrade({reader:{...reader,request:requestFor(intent,{source:options.source})},tools,operation:intent.operation,amount:intent.amount,agreement:effectiveAgreement(intent),recipientAddress:intent.recipient?.address,spendingKeyFile:options.spendingKeyFile,source:options.source,memo:options.memo??'',timeoutMs:options.timeoutMs??180000,
    consent:async({context,inspection,state,signal})=>{
     checkedState(intent,state,context);requireCondition(inspection.effects===context.effects&&Array.isArray(inspection.outputs)&&inspection.outputs.length===2);expectedEffects=context.effects;
     for(const output of inspection.outputs){requireCondition(typeof output.address==='string'&&/^[a-f0-9]{86}$/.test(output.address));uint(output.amount,0x7fffffffffffffffn);}
     if(boundary(intent)){
      requireCondition(inspection.value_balance===(intent.operation==='coin_shield'?'-':'')+intent.amount);
      if(intent.operation==='coin_shield')requireCondition(inspection.outputs.reduce((sum,o)=>sum+BigInt(o.amount),0n)===BigInt(intent.amount));
      const consents=[];for(const address of new Set(inspection.outputs.map(o=>o.address)))consents.push(await api.signConsent(intent,{context,address}));return consents;
     }
     requireCondition(inspection.outputs.filter(o=>o.address===intent.recipient.address&&o.amount===intent.amount).length===1);
     const change=inspection.outputs.find(o=>o.address!==intent.recipient.address);requireCondition(change);
     const ownConsent=await api.signConsent(intent,{context,address:change.address});
     const recipient=await options.recipientConsent({intent:structuredClone(intent),context:structuredClone(context),address:intent.recipient.address},{signal});
     verifyPrivatePartyConsent(context,recipient,publicObject(intent.recipient.publicKey));requireCondition(recipient.address===intent.recipient.address);return [ownConsent,recipient];
    },certificate:options.certificate,review:options.review});
   requireCondition(expectedEffects&&result.payload.approval.effects===expectedEffects);
   payloadResult(intent,result);return result;
  },
  async signBoundary(value,source){
   const intent=reviewedIntent(value);owned(intent);requireCondition(intent.operation!=='private_payment','A private OTC envelope must be signed by its licensed relay');
   const result=payloadResult(intent,source),state=await stateFor(intent,null,{skipWitness:true}),context=contextFor(intent,state,result.payload.approval);
   proofIdentity(state.coin?.owner,holder);uint(state.coin.owner.sequence);requireCondition(BigInt(state.coin.owner.sequence)<0xffffffffffffffffn);
   const command={version:1,chain_id:pins.chainId,member:holder.member,sequence:state.coin.owner.sequence,expires_height:context.expires,operation:intent.operation,payload:result.payload};
   const signature=await external(intent,state,context,'boundary_command',signingBytes(command),{command:structuredClone(command)});
   const envelope={command,public_key:holder.publicKey,signature};
   await verifyPrivateTradeEnvelope({reader,envelope});return structuredClone(envelope);
  },
  async relayRequest(value,source){
   const intent=reviewedIntent(value);owned(intent);requireCondition(intent.operation==='private_payment');
   const result=payloadResult(intent,source),state=await stateFor(intent,null,{policyOnly:true});contextFor(intent,state,result.payload.approval);
   uint(state.relayer.sequence);requireCondition(BigInt(state.relayer.sequence)<0xffffffffffffffffn);
   // Only the public proof/approval and required relay identity cross this
   // boundary. Parties, amount, terms, source and local receipt stay local.
   return {schema:'baink-holder-relay-request-v1',chainId:pins.chainId,genesisSha256:pins.genesisSha256,operation:'private_payment',payload:result.payload,signer:{member:state.relayer.member,publicKey:state.relayer.public_key,sequence:state.relayer.sequence},expiresHeight:result.payload.approval.expires_height};
  },
  async verifyRelayEnvelope(value,source,envelope){
   const intent=reviewedIntent(value);owned(intent);requireCondition(intent.operation==='private_payment');
   const result=payloadResult(intent,source);await api.relayRequest(intent,result);
   requireCondition(exact(envelope,['command','public_key','signature'])&&exact(envelope.command,['version','chain_id','member','sequence','expires_height','operation','payload'])&&envelope.command.operation==='private_payment'&&canonicalJSON(envelope.command.payload)===canonicalJSON(result.payload));
   await verifyPrivateTradeEnvelope({reader,envelope});requireCondition(envelope.command.member!==holder.member&&envelope.command.member!==intent.recipient.member);return structuredClone(envelope);
  },
 };
 return Object.freeze(api);
}
