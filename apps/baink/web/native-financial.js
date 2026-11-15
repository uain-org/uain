/** Holder-local WebCrypto signing. Private keys are never exported. Every
 * challenge is reconstructed from reviewed typed fields, never signed blindly. */
import { nativeProofFreshness } from './native-balance.js';
const enc=new TextEncoder(),HASH=/^[a-f0-9]{64}$/,ADDRESS=/^uain1[a-f0-9]{40}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/,CHAIN=/^[A-Za-z0-9._-]{1,96}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX64=18446744073709551615n,MAXHEIGHT=9223372036854775807n,CAP=108000000000000000000n;
const fields=['version','chain_id','member','sequence','expires_height','operation','payload'];
const insist=(ok,message='The financial signing request does not match your review.')=>{if(!ok)throw Error(message);};
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
function quoted(value){insist(typeof value==='string'&&value.isWellFormed());return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));}
function canonical(value,depth=0){insist(depth<=16);if(value===null)return'null';if(typeof value==='string')return quoted(value);if(typeof value==='boolean')return String(value);if(typeof value==='number'){insist(Number.isSafeInteger(value));return String(value);}if(Array.isArray(value))return'['+value.map(v=>canonical(v,depth+1)).join(',')+']';insist(value&&Object.getPrototypeOf(value)===Object.prototype);return'{'+Object.keys(value).sort((a,b)=>{const x=enc.encode(a),y=enc.encode(b);for(let i=0;i<Math.min(x.length,y.length);i++)if(x[i]!==y[i])return x[i]-y[i];return x.length-y.length;}).map(k=>quoted(k)+':'+canonical(value[k],depth+1)).join(',')+'}';}
const text=v=>enc.encode(v);
function join(...parts){const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;}
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
function unhex(value,length=32){insist(typeof value==='string'&&new RegExp(`^[a-f0-9]{${length*2}}$`).test(value));return Uint8Array.from(value.match(/../g),b=>parseInt(b,16));}
const digest=async bytes=>new Uint8Array(await crypto.subtle.digest('SHA-256',typeof bytes==='string'?text(bytes):bytes));
function b64(bytes,url=false){const s=btoa(String.fromCharCode(...bytes));return url?s.replaceAll('+','-').replaceAll('/','_').replaceAll('=',''):s;}
function unb64(value,length,url=false){insist(typeof value==='string'&&value.length<=90000);let raw;try{raw=Uint8Array.from(atob(url?value.replaceAll('-','+').replaceAll('_','/'):value),c=>c.charCodeAt(0));}catch{insist(false);}insist((length===undefined||raw.length===length)&&b64(raw,url)===value);return raw;}
function uint(value,max=MAX64,positive=false){insist(typeof value==='string'&&/^(0|[1-9][0-9]{0,20})$/.test(value)&&BigInt(value)<=max&&(!positive||BigInt(value)>0n));return BigInt(value);}
function u64(value,max=MAX64,positive=false){const bytes=new Uint8Array(8);new DataView(bytes.buffer).setBigUint64(0,uint(value,max,positive));return bytes;}
function clock(now){const started=Date.now();if(typeof now==='function')return now;insist(now===undefined||Number.isFinite(now));return()=>now===undefined?Date.now():now+(Date.now()-started);}
function pins(value){insist(value&&typeof value.chainId==='string'&&CHAIN.test(value.chainId)&&typeof value.genesisSha256==='string'&&HASH.test(value.genesisSha256),'Independent network pins are required.');}
function proof(p,expected,now){pins(expected);insist(p?.chainId===expected.chainId&&p.epoch===expected.genesisSha256&&p.genesisSha256===expected.genesisSha256&&HASH.test(p.verifierSha256??'')&&HASH.test(p.appHash??'')&&nativeProofFreshness(p,{now}).fresh,'The native signing proof is no longer current or trusted.');uint(p.height,MAXHEIGHT,true);}
async function owner(identity){const raw=new Uint8Array(await crypto.subtle.exportKey('raw',identity.publicKey)),address='uain1'+hex(await digest(raw)).slice(0,40);insist(raw.length===32&&identity.address===address&&b64(raw)===identity.publicKeyBase64);return{raw,address,publicKey:b64(raw,true)};}
async function signature(identity,who,bytes,guard=()=>{}){guard();const sig=new Uint8Array(await crypto.subtle.sign('Ed25519',identity.privateKey,bytes));const publicKey=await crypto.subtle.importKey('raw',who.raw,'Ed25519',false,['verify']);insist(await crypto.subtle.verify('Ed25519',publicKey,sig,bytes),'The local signing keys do not match.');guard();insist(identity.address===who.address&&identity.publicKeyBase64===b64(who.raw));return b64(sig,true);}
function commandBytes(command){insist(exact(command,fields)&&command.version===1&&CHAIN.test(command.chain_id)&&ADDRESS.test(command.member));insist(uint(command.sequence)<MAX64);uint(command.expires_height,MAXHEIGHT,true);return text('uain:chain-command:v1\n{'+fields.map(k=>quoted(k)+':'+canonical(command[k])).join(',')+'}');}
function earningPayload(operation,p){if(operation==='coin_quote')insist(exact(p,['task','open_event','amount','evidence_digest'])&&typeof p.task==='string'&&ID.test(p.task)&&typeof p.open_event==='string'&&/^[0-9]{20}$/.test(p.open_event)&&BigInt(p.open_event)>0n&&HASH.test(p.evidence_digest)&&uint(p.amount,CAP,true)>0n);else if(operation==='coin_reserve')insist(exact(p,['task','evidence_digest'])&&typeof p.task==='string'&&ID.test(p.task)&&HASH.test(p.evidence_digest));else if(operation==='coin_claim')insist(exact(p,['contribution'])&&typeof p.contribution==='string'&&ID.test(p.contribution));else insist(false,'Only the reviewed native earning operation can be signed.');}
export async function signNativeEarningIntent(identity,intent,options={}){
  const snapshot=structuredClone(intent),review=structuredClone(options.expectedPayload),getNow=clock(options.now),who=await owner(identity);
  const guard=()=>{insist(canonical(intent)===canonical(snapshot)&&snapshot.status==='prepared');proof(snapshot.proof,options,getNow());};guard();
  const c=snapshot.command;earningPayload(options.expectedOperation,review);earningPayload(c.operation,c.payload);
  insist(c.operation===options.expectedOperation&&canonical(c.payload)===canonical(review)&&c.chain_id===options.chainId&&c.member===who.address&&snapshot.publicKey===who.publicKey);
  const height=uint(snapshot.proof.height,MAXHEIGHT,true),expiry=uint(c.expires_height,MAXHEIGHT,true);insist(expiry>height&&expiry<=height+100n);
  const bytes=commandBytes(c);insist(b64(bytes)===snapshot.signingBytesBase64);
  return{command:c,public_key:who.publicKey,signature:await signature(identity,who,bytes,guard)};
}
function paymentBound(intent,expected){pins(expected);insist(typeof intent.id==='string'&&/^[A-Za-z0-9_-]{8,100}$/.test(intent.id)&&intent.chainId===expected.chainId&&intent.genesisSha256===expected.genesisSha256&&ADDRESS.test(intent.payer)&&ADDRESS.test(intent.payee)&&intent.payer!==intent.payee&&HASH.test(intent.requestDigest));uint(intent.amountUnits,CAP,true);return{id:intent.id,chainId:intent.chainId,genesisSha256:intent.genesisSha256,payer:intent.payer,payee:intent.payee,amountUnits:intent.amountUnits,requestDigest:intent.requestDigest};}
async function paymentOwner(identity,intent){const who=await owner(identity);insist([intent.payer,intent.payee].includes(who.address));insist((who.address===intent.payer?intent.payerPublicKey:intent.payeePublicKey)===identity.publicKeyBase64);return who;}
export async function signPaymentAgreement(identity,intent,options={}){
  const snapshot=structuredClone(intent),bound=paymentBound(snapshot,options),who=await paymentOwner(identity,snapshot),purpose=options.purposeCommitment;
  insist(options.expectedTo===snapshot.payee&&options.expectedAmountUnits===snapshot.amountUnits&&HASH.test(purpose)&&(!snapshot.purposeCommitment||snapshot.purposeCommitment===purpose)&&['awaiting-agreement','intent-ready'].includes(snapshot.status)&&!snapshot.envelope&&!snapshot.sendAttemptedAt);
  const guard=()=>insist(canonical(intent)===canonical(snapshot));
  return{purposeCommitment:purpose,signature:await signature(identity,who,text('BAINK/payment-agreement/v1\0'+canonical({...bound,purposeCommitment:purpose})),guard)};
}
export async function signPaymentConfirmation(identity,intent,options={}){
  const snapshot=structuredClone(intent),bound=paymentBound(snapshot,options),who=await paymentOwner(identity,snapshot),r=snapshot.receipt;
  insist(who.address===snapshot.payee&&options.expectedFrom===snapshot.payer&&options.expectedAmountUnits===snapshot.amountUnits&&options.expectedEffects===snapshot.effects&&options.expectedRequestDigest===snapshot.requestDigest&&options.locallyInspected===true&&HASH.test(snapshot.effects)&&['ledger-recorded','recipient-confirmed-paid'].includes(snapshot.status));
  // A durable exact historical receipt may outlive a current-state proof. This
  // never asserts that the hidden amount is publicly proved or spendable now.
  insist(r?.authority==='native'&&r.finalized===true&&r.chain_id===snapshot.chainId&&r.event?.operation==='private_payment'&&r.event.subject===snapshot.effects&&r.event.command_digest===snapshot.commandDigest&&HASH.test(snapshot.commandDigest)&&r.proof?.authority==='native'&&r.proof.chainId===snapshot.chainId&&r.proof.epoch===snapshot.genesisSha256&&r.proof.genesisSha256===snapshot.genesisSha256);
  const body={effects:snapshot.effects,chainId:snapshot.chainId,requestDigest:snapshot.requestDigest,locallyInspected:true};
  return{...body,signature:await signature(identity,who,text('BAINK/payment-recipient-confirmation/v1\0'+canonical({...bound,effects:snapshot.effects,locallyInspected:true})),()=>insist(canonical(intent)===canonical(snapshot)))};
}
export async function signHolderPairing(identity,challenge,options={}){
  const c=structuredClone(challenge),who=await owner(identity),getNow=clock(options.now);pins(options);
  const guard=()=>insist(canonical(challenge)===canonical(c)&&Number.isSafeInteger(c.issuedAt)&&Number.isSafeInteger(c.expiresAt)&&c.issuedAt<=getNow()&&c.expiresAt>getNow()&&c.expiresAt>c.issuedAt&&c.expiresAt-c.issuedAt<=60000,'The local holder pairing challenge has expired.');
  insist(exact(c,['schema','id','nonce','owner','origin','companionId','chainId','genesisSha256','issuedAt','expiresAt'])&&c.schema==='baink-holder-pair-v1'&&UUID.test(c.id)&&UUID.test(c.companionId)&&exact(c.owner,['member','publicKey'])&&c.owner.member===who.address&&c.owner.publicKey===who.publicKey&&c.origin===(options.origin??'https://baink.money')&&c.origin==='https://baink.money'&&c.chainId===options.chainId&&c.genesisSha256===options.genesisSha256);unb64(c.nonce,32,true);guard();
  return{challengeId:c.id,publicKey:who.publicKey,signature:await signature(identity,who,text('BAINK/holder-pair/v1\n'+canonical(c)),guard)};
}
async function publicIdentity(value){insist(exact(value,['member','publicKey'])&&ADDRESS.test(value.member));const raw=unb64(value.publicKey,32,true);insist('uain1'+hex(await digest(raw)).slice(0,40)===value.member);return raw;}
async function holderPurpose(intent){
  insist(exact(intent,['id','operation','amount','agreement','reviewer','owner','recipient'])&&typeof intent.id==='string'&&/^[A-Za-z0-9_-]{8,100}$/.test(intent.id)&&['coin_shield','coin_exit','private_payment'].includes(intent.operation)&&ADDRESS.test(intent.reviewer)&&exact(intent.agreement,['text','salt']));uint(intent.amount,MAXHEIGHT,true);await publicIdentity(intent.owner);insist(intent.reviewer!==intent.owner.member);
  if(intent.operation==='private_payment'){insist(exact(intent.recipient,['member','publicKey','address'])&&intent.recipient.member!==intent.owner.member&&intent.recipient.member!==intent.reviewer);await publicIdentity({member:intent.recipient.member,publicKey:intent.recipient.publicKey});unhex(intent.recipient.address,43);}else insist(intent.recipient===null);
  const agreement=text(intent.agreement.text);insist(typeof intent.agreement.text==='string'&&intent.agreement.text.length>0&&intent.agreement.text.isWellFormed()&&agreement.length<=65536);unhex(intent.agreement.salt);
  const meta={id:intent.id,operation:intent.operation,amount:intent.amount,owner:intent.owner,recipient:intent.recipient,reviewer:intent.reviewer,salt:intent.agreement.salt};
  const salt=await digest('BAINK/holder-intent-salt/v1\0'+canonical(meta)),length=new Uint8Array(4);new DataView(length.buffer).setUint32(0,agreement.length);
  const purpose=await digest(join(text('UAIN/private-exchange/purpose/v1\0'),salt,length,agreement));
  if(intent.operation==='private_payment')return hex(purpose);
  return hex(await digest(join(text('UAIN/coin-boundary/purpose/v1\0'),await digest('verified-bounties-108t-micro-v1'),new Uint8Array([intent.operation==='coin_shield'?1:2]),unhex(intent.owner.member.slice(5),20),u64(intent.amount,MAXHEIGHT,true),purpose)));
}
async function contextBytes(context){insist(exact(context,['version','chain','expires','licenceRevision','effects','purpose','reviewer'])&&context.version===1&&typeof context.chain==='string'&&CHAIN.test(context.chain));return join(text('UAIN/private-review/context/v1\0'),await digest(context.chain),u64(context.expires,MAXHEIGHT,true),u64(context.licenceRevision),unhex(context.effects),unhex(context.purpose),unhex(context.reviewer));}
async function verifyBoundary(intent,request){
  const c=request.command,a=c?.payload?.approval,x=request.context;
  insist(exact(c,fields)&&intent.operation!=='private_payment'&&c.operation===intent.operation&&c.chain_id===request.chainId&&c.member===intent.owner.member&&c.expires_height===x.expires&&exact(c.payload,['bundle','approval']));
  const bundle=unb64(c.payload.bundle,undefined,true);insist(bundle.length>0&&bundle.length<=16384);
  insist(exact(a,['reviewer','effects','purpose_commitment','class','expires_height','licence_revision','direction','member','amount','signature'])&&a.reviewer===intent.reviewer&&a.effects===x.effects&&a.purpose_commitment===x.purpose&&a.expires_height===x.expires&&a.licence_revision===x.licenceRevision&&a.direction===(intent.operation==='coin_shield'?'shield':'exit')&&a.member===intent.owner.member&&a.amount===intent.amount&&['benevolent','neutral'].includes(a.class));
  const reviewer=unhex(x.reviewer),policy=await digest('verified-bounties-108t-micro-v1');
  const bytes=join(text('UAIN/coin-boundary/approval/v1\0'),policy,await digest(x.chain),u64(x.expires,MAXHEIGHT,true),u64(x.licenceRevision),unhex(x.effects),unhex(x.purpose),new Uint8Array([a.class==='benevolent'?1:2,1]),reviewer,new Uint8Array([a.direction==='shield'?1:2]),unhex(a.member.slice(5),20),u64(a.amount,MAXHEIGHT,true));
  const key=await crypto.subtle.importKey('raw',reviewer,'Ed25519',false,['verify']);insist(await crypto.subtle.verify('Ed25519',key,unb64(a.signature,64,true),bytes),'The independent boundary review signature does not match.');return commandBytes(c);
}
export async function signHolderRequest(identity,request,options={}){
  const r=structuredClone(request),expected=structuredClone(options.expectedIntent),getNow=clock(options.now),who=await owner(identity);pins(options.pins);
  const extra=r.kind==='party_consent'?'address':r.kind==='boundary_command'?'command':null;
  insist(extra&&exact(r,['schema','kind','chainId','genesisSha256','member','publicKey','intent','context','expiresAt','signingBytesBase64','signingDigest',extra])&&r.schema==='baink-holder-signature-v1'&&canonical(r.intent)===canonical(expected)&&r.chainId===options.pins.chainId&&r.genesisSha256===options.pins.genesisSha256&&r.member===who.address&&r.publicKey===who.publicKey&&r.context?.chain===r.chainId);
  const guard=()=>insist(canonical(request)===canonical(r)&&canonical(options.expectedIntent)===canonical(expected)&&Number.isSafeInteger(r.expiresAt)&&r.expiresAt>getNow()&&r.expiresAt<=getNow()+60000,'The local holder signing request changed or expired.');guard();
  const purpose=await holderPurpose(expected),context=await contextBytes(r.context);insist(r.context.purpose===purpose&&'uain1'+hex(await digest(unhex(r.context.reviewer))).slice(0,40)===expected.reviewer);
  const isOwner=expected.owner.member===who.address&&expected.owner.publicKey===who.publicKey,isRecipient=expected.recipient?.member===who.address&&expected.recipient.publicKey===who.publicKey;insist(isOwner||isRecipient);
  let bytes;
  if(r.kind==='party_consent'){
    insist(typeof options.expectedAddress==='string'&&r.address===options.expectedAddress,'Review the exact owned Orchard output address before signing.');
    if(isRecipient)insist(r.address===expected.recipient.address);if(isOwner&&expected.recipient)insist(r.address!==expected.recipient.address);
    bytes=join(text('UAIN/private-review/party-consent/v1\0'),context,unhex(r.address,43));
  }else{insist(isOwner&&expected.operation!=='private_payment');bytes=await verifyBoundary(expected,r);}
  insist(b64(bytes)===r.signingBytesBase64&&hex(await digest(bytes))===r.signingDigest,'The local holder challenge bytes do not match the reviewed operation.');
  return{publicKey:who.publicKey,signature:await signature(identity,who,bytes,guard)};
}
// Derive independently before a participant agrees; companion JSON is not an
// authority for the immutable purpose of the browser's reviewed local invoice.
export { holderPurpose as holderIntentPurpose };

export { canonical as nativeCanonicalJSON };
