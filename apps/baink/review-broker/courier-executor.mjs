/** Concrete holder-local private file courier. No native broadcast occurs here.
 * Only actual participant, checker and relay signatures can advance its files.
 */
import { constants } from 'node:fs';
import { open,lstat,mkdir,mkdtemp,link,rm,realpath,readdir,unlink } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createPublicKey,verify,randomUUID,createHash } from 'node:crypto';
import { canonicalJSON,memberAddress,signingBytes } from '../../../chain/client/signing.mjs';
import { readPrivateState } from '../../../chain/client/private-state.mjs';
import { holderIntentPurpose,privatePartyConsentSigningBytes } from './external-signing.mjs';
import {verifyPrivateTradeApproval} from '../../../chain/client/private-workflow.mjs';
import { verifyPrivatePartyConsent,verifyReviewCertificate } from '../../../chain/client/private-review.mjs';
import { paymentAgreementBytes,paymentReviewerBindingBytes } from '../server/native-payments.mjs';
import {validatePurposeEvidence} from './reviewer-worker.mjs';
const HASH=/^[a-f0-9]{64}$/,ADDRESS=/^uain1[a-f0-9]{40}$/;
const check=(ok,message='Private holder courier refused')=>{if(!ok)throw new Error(message);};
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
const publicKey=value=>createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:value},format:'jwk'});
function key(value){check(typeof value==='string');const raw=Buffer.from(value,'base64url');check(raw.length===32&&raw.toString('base64url')===value);return raw;}
function signature(publicValue,value,bytes){check(typeof value==='string');const raw=Buffer.from(value,'base64url');check(raw.length===64&&raw.toString('base64url')===value&&verify(null,bytes,publicKey(publicValue),raw));}
function aborted(signal){if(signal?.aborted)throw new Error('Private holder operation cancelled');}
async function privateDirectory(path){const info=await lstat(path);check(info.isDirectory()&&!info.isSymbolicLink()&&!(info.mode&0o077)&&(!process.getuid||info.uid===process.getuid()));return realpath(path);}
export function parseCanonicalInvoice(intent,reader){
 check(intent.operation==='private_payment');const invoice=JSON.parse(intent.agreement.text);
 check(exact(invoice,['schema','id','chainId','genesisSha256','payer','payee','amountUnits','requestDigest'])&&invoice.schema==='baink-private-invoice-v1'&&canonicalJSON(invoice)===intent.agreement.text);
 check(invoice.id===intent.id&&invoice.payer===intent.owner.member&&invoice.payee===intent.recipient.member&&invoice.amountUnits===intent.amount&&invoice.genesisSha256===reader.genesisSha256&&HASH.test(invoice.genesisSha256)&&HASH.test(invoice.requestDigest)&&typeof invoice.chainId==='string'&&/^[A-Za-z0-9._-]{1,96}$/.test(invoice.chainId)&&ADDRESS.test(invoice.payer)&&ADDRESS.test(invoice.payee));return invoice;
}
export function verifyAgreedInvoice(intent,invoice,value){
 check(exact(value,['invoice','purposeCommitment','agreements'])&&canonicalJSON(value.invoice)===canonicalJSON(invoice)&&value.purposeCommitment===holderIntentPurpose(intent)&&exact(value.agreements,[invoice.payer,invoice.payee]));
 for(const identity of [intent.owner,intent.recipient]){
  const consent=value.agreements[identity.member];check(exact(consent,['publicKey','signature'])&&consent.publicKey===identity.publicKey&&memberAddress(key(consent.publicKey))===identity.member);signature(consent.publicKey,consent.signature,paymentAgreementBytes(invoice,value.purposeCommitment));
 }
 return value;
}
export function verifyReviewerInvoiceBinding(intent,invoice,result,value){
 check(exact(value,['publicKey','signature','independentlyInspected'])&&value.independentlyInspected===true&&memberAddress(key(value.publicKey))===result.payload.approval.reviewer&&result.payload.approval.reviewer===intent.reviewer&&result.payload.approval.purpose_commitment===holderIntentPurpose(intent));
 signature(value.publicKey,value.signature,paymentReviewerBindingBytes({...invoice,purposeCommitment:holderIntentPurpose(intent)},{effects:result.payload.approval.effects,reviewer:result.payload.approval.reviewer}));return value;
}
export async function readCourierJSON(path,limit=1024*1024){
 const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const info=await fd.stat();check(info.isFile()&&!(info.mode&0o077)&&(!process.getuid||info.uid===process.getuid())&&info.size<=limit);
  // The no-clobber publisher briefly has its private temporary hardlink while
  // fsync completes. Never read linked bytes; only the bounded waiter may retry.
  if(info.nlink===2){const error=Error('Private courier publication is pending');error.code='HOLDER_COURIER_PUBLISHING';throw error;}check(info.nlink===1);
  const buffer=Buffer.alloc(limit+1);let size=0;while(size<buffer.length){const {bytesRead}=await fd.read(buffer,size,buffer.length-size,null);if(!bytesRead)break;size+=bytesRead;}check(size<=limit);return JSON.parse(buffer.subarray(0,size).toString('utf8'));}finally{await fd.close();}
}
/** Explicit journal recovery only. The ordinary courier reader still refuses
 * linked files. A dead publisher may leave its one private temporary link;
 * complete its cleanup only when the publisher directory and inode match.
 */
export async function readRecoverableCourierJSON(path,limit=1024*1024){
 try{return await readCourierJSON(path,limit);}catch(error){if(error.code!=='HOLDER_COURIER_PUBLISHING')throw error;}
 const parent=await privateDirectory(resolve(path,'..')),visible=await lstat(path);
 check(visible.isFile()&&visible.nlink<=2);
 for(const entry of await readdir(parent,{withFileTypes:true})){
  if(!entry.isDirectory()||!/^\.courier-[A-Za-z0-9]{6}$/.test(entry.name))continue;
  const temporary=join(parent,entry.name),pending=join(temporary,'value.json');let fd;
  try{
   await privateDirectory(temporary);const info=await lstat(pending);
   if(!info.isFile()||info.dev!==visible.dev||info.ino!==visible.ino)continue;
   check(!(info.mode&0o077)&&(!process.getuid||info.uid===process.getuid())&&info.nlink<=2);
   fd=await open(temporary,'r');await unlink(pending);await fd.sync();
  }catch(error){if(error.code!=='ENOENT')throw error;}finally{await fd?.close();}
 }
 // Also covers a live publisher finishing between the original read and scan.
 const dir=await open(parent,'r');try{await dir.sync();}finally{await dir.close();}
 return readCourierJSON(path,limit);
}
export async function writeCourierJSON(path,value){
 const parent=resolve(path,'..'),temporary=await mkdtemp(join(parent,'.courier-'));
 try{const pending=join(temporary,'value.json'),fd=await open(pending,'wx',0o600);try{const raw=JSON.stringify(value)+'\n';check(Buffer.byteLength(raw)<=1024*1024);await fd.writeFile(raw);await fd.sync();}finally{await fd.close();}await link(pending,path);const dir=await open(parent,'r');try{await dir.sync();}finally{await dir.close();}}finally{await rm(temporary,{recursive:true,force:true});}
}
async function pause(signal){aborted(signal);await new Promise((resolve,reject)=>{const timer=setTimeout(done,50);function done(){signal?.removeEventListener('abort',abort);resolve();}function abort(){clearTimeout(timer);reject(new Error('Private courier cancelled'));}signal?.addEventListener('abort',abort,{once:true});});}
export async function waitForCourier(path,signal){
 for(;;){aborted(signal);try{return await readCourierJSON(path);}catch(error){if(error.code!=='ENOENT'&&error.code!=='HOLDER_COURIER_PUBLISHING'&&!(error instanceof SyntaxError))throw error;}await pause(signal);}
}
function killGroup(child){try{if(process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}}
/** Dedicated process group makes cancellation terminate the Node worker and
 * native proof children without modifying the existing signed client modules. */
export async function runProofWorker({intent,reader,tools,pins,spendingKeyFile,source,timeoutMs,callbacks,signal}){
 aborted(signal);const child=spawn(process.execPath,[fileURLToPath(new URL('./produce-worker.mjs',import.meta.url))],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
 try{return await new Promise((resolve,reject)=>{
  let settled=false;const finish=(error,result)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);};
  const abort=()=>{killGroup(child);finish(new Error('Private proof cancelled'));};signal?.addEventListener('abort',abort,{once:true});
  child.once('error',()=>finish(new Error('Private proof worker unavailable')));child.once('exit',()=>finish(new Error('Private proof worker did not complete')));
  child.on('message',message=>{
   if(settled)return;
   if(!message||Buffer.byteLength(JSON.stringify(message))>1024*1024){killGroup(child);finish(new Error('Private proof worker bound exceeded'));return;}
   if(message.type==='result'){finish(null,message.result);return;}
   if(message.type==='error'){finish(new Error('Private proof refused'));return;}
   if(message.type!=='request'||typeof message.id!=='string'||!['signature','recipientConsent','certificate','review'].includes(message.kind)){killGroup(child);finish(new Error('Private proof protocol refused'));return;}
   Promise.resolve().then(()=>{aborted(signal);return callbacks[message.kind](message.value);}).then(value=>{if(child.connected&&!settled)child.send({type:'response',id:message.id,value});}).catch(()=>{if(child.connected&&!settled)child.send({type:'response',id:message.id,error:true});});
  });
  child.send({type:'start',intent,reader,tools,pins,spendingKeyFile,source,timeoutMs});
 });}finally{killGroup(child);}
}
export class HolderCourierTimeout extends Error{constructor(){super('Holder courier deadline exceeded');this.name='HolderCourierTimeout';this.code='HOLDER_COURIER_TIMEOUT';}}
export function createCourierExecutor({exchangeRoot,tools,reader,timeoutMs=360000,onExchange=async()=>{},provenance=null}={}, {runProducer=runProofWorker,readState=readPrivateState}={}){
 check(typeof exchangeRoot==='string'&&typeof onExchange==='function'&&typeof runProducer==='function'&&typeof readState==='function'&&reader&&tools&&Number.isInteger(timeoutMs)&&timeoutMs>=1000&&timeoutMs<=600000);
 reader=structuredClone(reader);tools=structuredClone(tools);const exchanges=new Map(),hash=value=>createHash('sha256').update(value).digest('hex'),uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
 const lookup=({operationId,intent})=>{check(typeof operationId==='string'&&uuid.test(operationId));holderIntentPurpose(intent);const entry=exchanges.get(operationId);if(entry){check(canonicalJSON(entry.intent)===canonicalJSON(intent));aborted(entry.signal);}return entry;};
 const writeFixed=async(path,value)=>{try{await writeCourierJSON(path,value);}catch(error){if(error.code!=='EEXIST')throw error;let old;for(let n=0;n<21;n++){try{old=await readCourierJSON(path);break;}catch(readError){if(readError.code!=='HOLDER_COURIER_PUBLISHING'||n===20)throw readError;await pause();}}check(canonicalJSON(old)===canonicalJSON(value));}};
 const deliverInvoice=async(entry,agreement,purposeEvidence)=>{
  const invoice=parseCanonicalInvoice(entry.intent,reader);verifyAgreedInvoice(entry.intent,invoice,agreement);aborted(entry.signal);
  if(purposeEvidence!==undefined){validatePurposeEvidence(invoice,purposeEvidence);await writeFixed(join(entry.directory,'purpose-evidence.json'),purposeEvidence);}
  aborted(entry.signal);await writeFixed(join(entry.directory,'agreed-invoice.json'),agreement);return{accepted:true};
 };
 const executeIntent=async function({adapter,intent,source,spendingKeyFile,signal,operationId=randomUUID(),agreedInvoice,purposeEvidence}){
  check(typeof operationId==='string'&&uuid.test(operationId));intent=structuredClone(intent);
  holderIntentPurpose(intent);aborted(signal);check(!exchanges.has(operationId)&&exchanges.size<16);const root=await privateDirectory(exchangeRoot),jobId=randomUUID(),directory=join(root,jobId);await mkdir(directory,{mode:0o700});
  check(!exchanges.has(operationId)&&exchanges.size<16);const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();const timer=setTimeout(()=>controller.abort(new HolderCourierTimeout()),timeoutMs);timer.unref?.();const active=controller.signal;
  const entry={intent,directory,jobId,signal:active,request:null,responded:false};exchanges.set(operationId,entry);
  try{
   aborted(active);
   const invoice=intent.operation==='private_payment'?parseCanonicalInvoice(intent,reader):null;
   await writeCourierJSON(join(directory,'operation.json'),{schema:'baink-holder-private-operation-v1',jobId,intent});
   if(invoice)await writeCourierJSON(join(directory,'invoice-request.json'),{schema:'baink-holder-invoice-request-v1',invoice,purposeCommitment:holderIntentPurpose(intent),requires:[invoice.payer,invoice.payee]});
   if(agreedInvoice!==undefined){check(invoice!==null);await deliverInvoice(entry,agreedInvoice,purposeEvidence);}else check(purposeEvidence===undefined);
   await onExchange({jobId,directory,intentId:intent.id});aborted(active);
   if(invoice)verifyAgreedInvoice(intent,invoice,await waitForCourier(join(directory,'agreed-invoice.json'),active));
   const callbacks={
    signature:async request=>{aborted(active);check(request.kind==='party_consent'&&canonicalJSON(request.intent)===canonicalJSON(intent));const consent=await adapter.signConsent(intent,{context:request.context,address:request.address});aborted(active);return{publicKey:intent.owner.publicKey,signature:consent.signature};},
    recipientConsent:async request=>{
     aborted(active);check(intent.operation==='private_payment'&&canonicalJSON(request.intent)===canonicalJSON(intent)&&request.address===intent.recipient.address&&request.context?.chain===invoice.chainId&&request.context.purpose===holderIntentPurpose(intent));privatePartyConsentSigningBytes(request.context,request.address);
     check(HASH.test(request.context.reviewer)&&'uain1'+hash(Buffer.from(request.context.reviewer,'hex')).slice(0,40)===intent.reviewer);
     const exported={schema:'baink-holder-recipient-consent-request-v1',chainId:invoice.chainId,genesisSha256:reader.genesisSha256,intent:structuredClone(intent),context:structuredClone(request.context),address:request.address};
     await writeCourierJSON(join(directory,'recipient-consent-request.json'),exported);entry.request=exported;
     return waitForCourier(join(directory,'recipient-consent.json'),active);
    },
    certificate:async context=>{await writeCourierJSON(join(directory,'certificate-request.json'),{context});return waitForCourier(join(directory,'certificate.json'),active);},
    review:async envelope=>{await writeCourierJSON(join(directory,'review-envelope.json'),envelope);return waitForCourier(join(directory,'review-approval.json'),active);},
   };
   // The existing pinned reader derives the native chain from this private
   // request. OTC also checks it against the externally agreed canonical invoice.
   const request=intent.operation==='private_payment'?{skip_witness:true,reviewer:intent.reviewer,parties:[intent.owner.member,intent.recipient.member]}:{skip_witness:true,reviewer:intent.reviewer,parties:[],boundary_member:intent.owner.member};
   const state=await readState({...reader,request}),chainId=state.chain_id;entry.chainId=chainId;check(typeof chainId==='string'&&/^[A-Za-z0-9._-]{1,96}$/.test(chainId));if(invoice)check(chainId===invoice.chainId);
   const result=await runProducer({intent,reader,tools,pins:{chainId,genesisSha256:reader.genesisSha256},spendingKeyFile,source,timeoutMs,callbacks,signal:active});aborted(active);
   check(result.operation===intent.operation&&result.payload?.approval?.purpose_commitment===holderIntentPurpose(intent)&&result.local_receipt?.effects===result.payload.approval.effects);
   await writeCourierJSON(join(directory,'private-result.json'),result);let output;
   if(invoice){
    const reviewerBinding=verifyReviewerInvoiceBinding(intent,invoice,result,await waitForCourier(join(directory,'reviewer-invoice-binding.json'),active));
    const relayRequest=await adapter.relayRequest(intent,result);await writeCourierJSON(join(directory,'relay-request.json'),relayRequest);
    const envelope=await adapter.verifyRelayEnvelope(intent,result,await waitForCourier(join(directory,'relay-envelope.json'),active));aborted(active);
    output={effects:result.payload.approval.effects,envelope,reviewerBinding};
   }else output={effects:result.payload.approval.effects,envelope:await adapter.signBoundary(intent,result)};
   aborted(active);await writeCourierJSON(join(directory,'public-output.json'),output);return output;
  }catch(error){if(active.reason instanceof HolderCourierTimeout&&!signal?.aborted)throw active.reason;throw error;}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();exchanges.delete(operationId);}
 };
 const optional=async(entry,name,limit=1024*1024)=>{try{return await readCourierJSON(join(entry.directory,name),limit);}catch(error){if(error.code==='ENOENT'||error.code==='HOLDER_COURIER_PUBLISHING')return null;throw error;}};
 const publicOnly=value=>{if(Array.isArray(value)){for(const x of value)publicOnly(x);return;}if(value&&typeof value==='object')for(const[k,v]of Object.entries(value)){check(!['local_receipt','privateKey','private_key','seed','spendingKeyFile','signingKeyFile','key_file','path','directory','filename'].includes(k),'Private courier output refused');publicOnly(v);}};
 const contextFor=async entry=>{const wrapper=await optional(entry,'certificate-request.json',16384);if(wrapper===null)return null;check(exact(wrapper,['context']));const c=wrapper.context;check(exact(c,['version','chain','expires','licenceRevision','effects','purpose','reviewer'])&&c.version===1&&c.chain===entry.chainId&&/^[1-9][0-9]{0,18}$/.test(c.expires)&&BigInt(c.expires)<=0x7fffffffffffffffn&&/^(0|[1-9][0-9]{0,19})$/.test(c.licenceRevision)&&BigInt(c.licenceRevision)<=0xffffffffffffffffn&&HASH.test(c.effects)&&c.purpose===holderIntentPurpose(entry.intent)&&HASH.test(c.reviewer)&&memberAddress(Buffer.from(c.reviewer,'hex'))===entry.intent.reviewer);return c;};
 const reviewerKey=c=>publicKey(Buffer.from(c.reviewer,'hex').toString('base64url'));
 const certificateFor=(entry,c,certificate)=>{check(exact(certificate,['context','encryptionKey','signature'])&&canonicalJSON(certificate.context)===canonicalJSON(c));verifyReviewCertificate(certificate,reviewerKey(c),c.expires,c.chain);};
 const envelopeFor=(entry,c,envelope)=>{check(exact(envelope,['certificate','ephemeralKey','nonce','ciphertext','tag'])&&HASH.test(envelope.ephemeralKey)&&/^[a-f0-9]{24}$/.test(envelope.nonce)&&/^[a-f0-9]{32}$/.test(envelope.tag)&&typeof envelope.ciphertext==='string'&&/^[A-Za-z0-9_-]+$/.test(envelope.ciphertext)&&Buffer.from(envelope.ciphertext,'base64url').length<=256*1024);certificateFor(entry,c,envelope.certificate);};
 const approvalFor=(entry,c,approval)=>verifyPrivateTradeApproval({approval,context:c,boundary:entry.intent.operation==='private_payment'?null:{direction:entry.intent.operation==='coin_shield'?'shield':'exit',member:entry.intent.owner.member,amount:entry.intent.amount},reviewerPublicKey:reviewerKey(c)});
 const relayFor=(entry,c,value)=>{check(entry.intent.operation==='private_payment'&&exact(value,['schema','chainId','genesisSha256','operation','payload','signer','expiresHeight'])&&value.schema==='baink-holder-relay-request-v1'&&value.chainId===c.chain&&value.genesisSha256===reader.genesisSha256&&value.operation==='private_payment'&&exact(value.payload,['bundle','approval'])&&typeof value.payload.bundle==='string'&&value.payload.bundle.length<=32768&&exact(value.signer,['member','publicKey','sequence'])&&memberAddress(key(value.signer.publicKey))===value.signer.member&&![entry.intent.owner.member,entry.intent.recipient.member].includes(value.signer.member)&&/^(0|[1-9][0-9]{0,19})$/.test(value.signer.sequence)&&BigInt(value.signer.sequence)<0xffffffffffffffffn&&value.expiresHeight===c.expires);approvalFor(entry,c,value.payload.approval);};
 executeIntent.publicReviewRequest=async value=>{
  check(exact(value,['operationId','intent']));const entry=lookup(value),empty={context:null,envelope:null,agreedInvoice:null,purposeEvidence:null,relayRequest:null,artifacts:{certificate:false,review:false,reviewerBinding:false,relay:false}};if(!entry)return empty;
  const context=await contextFor(entry);const envelope=await optional(entry,'review-envelope.json');if(envelope!==null){check(context!==null);envelopeFor(entry,context,envelope);}
  const agreedInvoice=await optional(entry,'agreed-invoice.json',65536),purposeEvidence=agreedInvoice===null?null:await optional(entry,'purpose-evidence.json',65536);if(agreedInvoice!==null){check(entry.intent.operation==='private_payment');verifyAgreedInvoice(entry.intent,parseCanonicalInvoice(entry.intent,reader),agreedInvoice);}if(purposeEvidence!==null){check(agreedInvoice!==null);validatePurposeEvidence(agreedInvoice.invoice,purposeEvidence);}
  const relayRequest=await optional(entry,'relay-request.json',65536);if(relayRequest!==null){check(context!==null);relayFor(entry,context,relayRequest);}
  const artifacts={certificate:(await optional(entry,'certificate.json',16384))!==null,review:(await optional(entry,'review-approval.json',16384))!==null,reviewerBinding:(await optional(entry,'reviewer-invoice-binding.json',16384))!==null,relay:(await optional(entry,'relay-envelope.json',65536))!==null};
  const out={context,envelope,agreedInvoice,purposeEvidence,relayRequest,artifacts};publicOnly(out);check(Buffer.byteLength(JSON.stringify(out))<=1024*1024);aborted(entry.signal);return structuredClone(out);
 };
 executeIntent.publicReviewProvenanceAvailable=typeof provenance?.admit==='function';
 executeIntent.acceptPublicReviewProvenance=async value=>{
  check(exact(value,['operationId','intent','createRequest','createReceipt']));const v=structuredClone(value),entry=lookup(v);check(entry&&entry.intent.operation==='private_payment'&&typeof provenance?.admit==='function');aborted(entry.signal);
  const operation=await readCourierJSON(join(entry.directory,'operation.json'),65536);check(exact(operation,['schema','jobId','intent'])&&operation.schema==='baink-holder-private-operation-v1'&&operation.jobId===entry.jobId&&canonicalJSON(operation.intent)===canonicalJSON(entry.intent));
  const context=await contextFor(entry);check(context!==null&&canonicalJSON(v.createRequest?.body?.context)===canonicalJSON(context));
  aborted(entry.signal);
  await provenance.admit({operationId:v.operationId,exchangeId:entry.jobId,intent:structuredClone(entry.intent),context,createRequest:v.createRequest,createReceipt:v.createReceipt});aborted(entry.signal);return{accepted:true};
 };
 executeIntent.acceptPublicReviewArtifact=async value=>{
  check(exact(value,['operationId','intent','kind','artifact']));const v=structuredClone(value),entry=lookup(v);check(entry&&['certificate','review','relay'].includes(v.kind));publicOnly(v.artifact);check(Buffer.byteLength(JSON.stringify(v.artifact))<=65536);const c=await contextFor(entry);check(c!==null);aborted(entry.signal);
  if(v.kind==='certificate'){check(exact(v.artifact,['certificate']));certificateFor(entry,c,v.artifact.certificate);aborted(entry.signal);await writeFixed(join(entry.directory,'certificate.json'),v.artifact.certificate);}
  if(v.kind==='review'){
   check(exact(v.artifact,['approval','reviewerBinding']));const encrypted=await optional(entry,'review-envelope.json');check(encrypted!==null);envelopeFor(entry,c,encrypted);approvalFor(entry,c,v.artifact.approval);
   if(entry.intent.operation==='private_payment'){check(v.artifact.reviewerBinding!==null);const invoice=parseCanonicalInvoice(entry.intent,reader);verifyReviewerInvoiceBinding(entry.intent,invoice,{payload:{approval:v.artifact.approval}},v.artifact.reviewerBinding);aborted(entry.signal);await writeFixed(join(entry.directory,'reviewer-invoice-binding.json'),v.artifact.reviewerBinding);}else check(v.artifact.reviewerBinding===null);
   aborted(entry.signal);await writeFixed(join(entry.directory,'review-approval.json'),v.artifact.approval);
  }
  if(v.kind==='relay'){
   check(exact(v.artifact,['envelope']));const request=await optional(entry,'relay-request.json',65536);check(request!==null);relayFor(entry,c,request);const e=v.artifact.envelope,command=e?.command;check(exact(e,['command','public_key','signature'])&&exact(command,['version','chain_id','member','sequence','expires_height','operation','payload'])&&command.version===1&&command.chain_id===c.chain&&command.operation==='private_payment'&&command.member===request.signer.member&&e.public_key===request.signer.publicKey&&canonicalJSON(command.payload)===canonicalJSON(request.payload)&&command.expires_height===request.expiresHeight&&/^(0|[1-9][0-9]{0,19})$/.test(command.sequence)&&BigInt(command.sequence)>=BigInt(request.signer.sequence)&&BigInt(command.sequence)<0xffffffffffffffffn);signature(e.public_key,e.signature,signingBytes(command));aborted(entry.signal);await writeFixed(join(entry.directory,'relay-envelope.json'),e);
  }
  aborted(entry.signal);return{accepted:true};
 };
 executeIntent.recipientConsentRequest=async value=>{check(exact(value,['operationId','intent']));const entry=lookup(value);if(!entry?.request||entry.responded)return null;const request=structuredClone(entry.request);return{request,requestDigest:hash(canonicalJSON(request))};};
 executeIntent.acceptInvoiceAgreement=async value=>{check(exact(value,['operationId','intent','agreement'])||exact(value,['operationId','intent','agreement','purposeEvidence']));const entry=lookup(value);check(entry?.intent.operation==='private_payment');return deliverInvoice(entry,structuredClone(value.agreement),value.purposeEvidence===undefined?undefined:structuredClone(value.purposeEvidence));};
 executeIntent.acceptRecipientConsent=async value=>{
  check(exact(value,['operationId','intent','requestDigest','consent']));const entry=lookup(value);check(entry?.request&&typeof value.requestDigest==='string'&&value.requestDigest===hash(canonicalJSON(entry.request)));
  const consent=structuredClone(value.consent);check(exact(consent,['publicKey','address','signature'])&&consent.publicKey===key(entry.intent.recipient.publicKey).toString('hex')&&consent.address===entry.request.address);verifyPrivatePartyConsent(entry.request.context,consent,publicKey(entry.intent.recipient.publicKey));aborted(entry.signal);
  const path=join(entry.directory,'recipient-consent.json');try{await writeCourierJSON(path,consent);}catch(error){if(error.code!=='EEXIST')throw error;check(canonicalJSON(await readCourierJSON(path))===canonicalJSON(consent));}entry.responded=true;return{accepted:true};
 };
 return Object.freeze(executeIntent);
}
