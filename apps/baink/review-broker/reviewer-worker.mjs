/** Fixed custody subprocess. Sensitive stdin/stdout is piped only to the root
 * custody wrapper; never expose this process as an HTTP or generic signer. */
import {createHash,createPrivateKey,createPublicKey,generateKeyPairSync,sign,verify} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {canonicalJSON,memberAddress,signingBytes} from '../../../chain/client/signing.mjs';
import {readPrivateState,assertPrivateStateContext} from '../../../chain/client/private-state.mjs';
import {certificateForPrivateState,reviewEncryptedPrivateTrade,signPrivateTradeCommand} from '../../../chain/client/private-workflow.mjs';
import {decryptPrivateReview,verifyPrivatePartyConsent} from '../../../chain/client/private-review.mjs';
import {paymentAgreementBytes,paymentReviewerBindingBytes} from '../server/native-payments.mjs';
import {coinBoundaryApprovalBytes,coinPolicy} from '../../../chain/client/coin-boundary.mjs';
import {SEND_INTENT_FIELDS,sendIntentBytes,sendIntentId,receivingAddressBytes,receivingKeyBytes,sendPurposeCommitment,checkSendInspection} from '../server/server-send-check.mjs';
import {spawn} from 'node:child_process';
import {mkdtemp,open as openFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{32}$/;
const check=(ok,message='Private custody action refused')=>{if(!ok)throw Error(message);};
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const hash=v=>createHash('sha256').update(v).digest('hex');
const pub=v=>createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:v},format:'jwk'});
const raw=v=>Buffer.from(createPublicKey(v).export({type:'spki',format:'der'})).subarray(-32);
function key(seed,expected){const b=Buffer.from(seed,'base64url');check(b.length===32&&b.toString('base64url')===seed);const key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),b]),format:'der',type:'pkcs8'});b.fill(0);check(memberAddress(raw(key))===expected);return key;}
function signature(publicKey,bytes,value){const b=Buffer.from(value??'','base64url');check(b.length===64&&b.toString('base64url')===value&&verify(null,bytes,pub(publicKey),b));}
export const privateAIMessageBytes=payload=>Buffer.from('BAINK/private-ai-decision/v1\n'+canonicalJSON(payload));
export function verifyPrivateAIDecision({attestation,report,request,response,publicKey,now=Date.now()}){
 check(exact(attestation,['payload','signature']));const p=attestation.payload;
 check(exact(p,['schema','jobId','inspectionDigest','provider','model','completedAt','requestSha256','responseSha256','decision'])&&p.schema==='baink-private-ai-decision-v1'&&p.jobId===report.jobId&&p.inspectionDigest===report.inspectionDigest&&p.provider==='claude-code'&&['claude-sonnet-5-5','claude-opus-5-5'].includes(p.model));
 check(typeof request==='string'&&typeof response==='string'&&Buffer.byteLength(request)<=262144&&Buffer.byteLength(response)<=262144&&p.requestSha256===hash(request)&&p.responseSha256===hash(response));
 const parsed=JSON.parse(request);check(exact(parsed,['schema','jobId','inspectionDigest','report'])&&parsed.schema==='baink-private-ai-request-v1'&&parsed.jobId===report.jobId&&parsed.inspectionDigest===report.inspectionDigest&&canonicalJSON(parsed.report)===canonicalJSON(report));
 const actual=JSON.parse(response);check(actual.type==='result'&&actual.subtype==='success'&&actual.is_error===false&&canonicalJSON(actual.structured_output)===canonicalJSON(p.decision));
 const age=now-Date.parse(p.completedAt);check(typeof p.completedAt==='string'&&Number.isFinite(age)&&age>=-60000&&age<=120000);
 const d=p.decision;check(exact(d,['class','statement','checkedPurpose','ownerLicenceChecked','bothLicencesChecked'])&&['neutral','benevolent','refuse'].includes(d.class)&&typeof d.statement==='string'&&d.statement.length>=20&&d.statement.length<=4000&&d.checkedPurpose===report.inspection.context.purpose&&typeof d.ownerLicenceChecked==='boolean'&&typeof d.bothLicencesChecked==='boolean');
 check(report.inspection.checks&&d.ownerLicenceChecked===report.inspection.checks.ownerLicenceChecked&&d.bothLicencesChecked===report.inspection.checks.bothLicencesChecked);
 signature(publicKey,privateAIMessageBytes(p),attestation.signature);return structuredClone(d);
}
export function validatePurposeEvidence(invoice,value){
 check(value&&typeof value==='object'&&hash(canonicalJSON(value))===invoice.requestDigest&&typeof value.memo==='string'&&value.memo.trim().length>0&&value.memo.length<=500&&value.memo.isWellFormed());
 if(Object.hasOwn(value,'clientRequestId'))check(exact(value,['payer','payee','amountUnits','clientRequestId','memo'])&&value.payer===invoice.payer&&value.payee===invoice.payee&&value.amountUnits===invoice.amountUnits&&typeof value.clientRequestId==='string'&&/^[A-Za-z0-9_-]{8,100}$/.test(value.clientRequestId));
 else{
  check(exact(value,['id','from','to','amount','memo','currency','createdAt','updatedAt'])&&typeof value.id==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value.id)&&value.from===invoice.payee&&value.to===invoice.payer&&value.currency==='AI$'&&typeof value.amount==='string'&&/^(0|[1-9][0-9]{0,14})(\.[0-9]{1,6})?$/.test(value.amount)&&typeof value.createdAt==='string'&&typeof value.updatedAt==='string'&&Number.isFinite(Date.parse(value.createdAt))&&Number.isFinite(Date.parse(value.updatedAt)));
  const [whole,part='']=value.amount.split('.');check(String(BigInt(whole)*1000000n+BigInt(part.padEnd(6,'0')))===invoice.amountUnits);
 }
 return structuredClone(value);
}
export function validateInspectedInvoice({packet,inspected,agreedInvoice,purposeEvidence=null,pins}){
 const {context,state,inspection}=inspected;
 check(packet.operation===inspected.operation&&packet.amount===inspected.amount&&canonicalJSON(packet.agreement)===canonicalJSON(inspected.agreement));
 if(packet.operation!=='private_payment'){
  check(agreedInvoice===null&&purposeEvidence===null&&state.coin?.owner&&Array.isArray(packet.consents)&&packet.consents.length>=1&&packet.consents.length<=2);
  const owner=state.coin.owner;for(const consent of packet.consents)verifyPrivatePartyConsent(context,consent,pub(owner.public_key));
  check(Buffer.from(owner.public_key,'base64url').toString('hex')!==context.reviewer);
  const expected=packet.operation==='coin_shield'?-BigInt(packet.amount):BigInt(packet.amount);
  check(inspection.value_balance===String(expected)&&inspection.outputs.length===2&&inspection.outputs.every(n=>typeof n.amount==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(n.amount)&&BigInt(n.amount)<=0x7fffffffffffffffn&&packet.consents.some(c=>c.address===n.address)));
  if(packet.operation==='coin_shield')check(inspection.outputs.reduce((sum,n)=>sum+BigInt(n.amount),0n)===BigInt(packet.amount));
  return null;
 }
 const invoice=JSON.parse(packet.agreement.text);
 check(exact(invoice,['schema','id','chainId','genesisSha256','payer','payee','amountUnits','requestDigest'])&&invoice.schema==='baink-private-invoice-v1'&&canonicalJSON(invoice)===packet.agreement.text&&typeof invoice.id==='string'&&/^[A-Za-z0-9_-]{8,100}$/.test(invoice.id)&&invoice.chainId===pins.chainId&&invoice.genesisSha256===pins.genesisSha256&&HASH.test(invoice.requestDigest)&&invoice.amountUnits===packet.amount);
 check(state.parties.length===2&&state.parties[0].member===invoice.payer&&state.parties[1].member===invoice.payee&&invoice.payer!==invoice.payee&&Array.isArray(packet.consents)&&packet.consents.length===2);
 check(exact(agreedInvoice,['invoice','purposeCommitment','agreements'])&&canonicalJSON(agreedInvoice.invoice)===canonicalJSON(invoice)&&agreedInvoice.purposeCommitment===context.purpose&&exact(agreedInvoice.agreements,[invoice.payer,invoice.payee]));
 for(const [i,party]of state.parties.entries()){
  verifyPrivatePartyConsent(context,packet.consents[i],pub(party.public_key));const consent=agreedInvoice.agreements[party.member];check(exact(consent,['publicKey','signature'])&&consent.publicKey===party.public_key);signature(consent.publicKey,paymentAgreementBytes(invoice,context.purpose),consent.signature);
 }
 const [sender,recipient]=packet.consents;check(sender.publicKey!==recipient.publicKey&&![sender.publicKey,recipient.publicKey].includes(context.reviewer)&&state.relayer&&![invoice.payer,invoice.payee].includes(state.relayer.member)&&sender.address!==recipient.address&&inspection.outputs.length===2&&inspection.outputs.every(n=>typeof n.amount==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(n.amount)&&BigInt(n.amount)<=0x7fffffffffffffffn)&&inspection.outputs.filter(n=>n.address===recipient.address&&n.amount===packet.amount).length===1&&inspection.outputs.filter(n=>n.address===sender.address).length===1);
 validatePurposeEvidence(invoice,purposeEvidence);
 return invoice;
}
function inspectedReport(jobId,inspected,invoice,purposeEvidence){
 const state=inspected.state,inspection={context:inspected.context,operation:inspected.operation,amount:inspected.amount,agreement:inspected.agreement,invoice,purposeEvidence,parties:state.coin?.owner?[{member:state.coin.owner.member,publicKey:state.coin.owner.public_key}]:state.parties.map(p=>({member:p.member,publicKey:p.public_key})),outputs:inspected.inspection.outputs,valueBalance:inspected.inspection.value_balance??null};
 // This projection is created only inside the existing pinned-state workflow,
 // after actual licensed identities, appointment, signatures and outputs passed.
 inspection.checks={ownerLicenceChecked:Boolean(state.coin?.owner)||state.parties.length===2,bothLicencesChecked:!state.coin?.owner&&state.parties.length===2,reviewerAppointed:true,consentsVerified:true,invoiceAgreed:invoice!==null,purposeEvidenceVerified:invoice!==null};
 return{schema:'baink-private-service-inspection-v1',jobId,inspectionDigest:hash(canonicalJSON(inspection)),inspection,proof:{chainId:state.chain_id,height:state.height,appHash:state.app_hash,headerTime:state.header_time,licenceRevision:state.licence_revision}};
}
/* No-install sends (server-built coin_shield to the payee's registered address).
 * Custody verifies the payer's own signed intent and the payee's own signed
 * receiving address (or its signed receiving key, whose address custody derives
 * itself with the pinned coin wallet), proves the payer's licence, key and balance from pinned
 * state, decrypts both outputs with the one-time key and applies the output rule.
 * The approval is signed only in send-finalize, after a non-refusing AI decision. */
export const SEND_AI_ABOVE_UNITS=10_000n*1_000_000n;
const SEND_ADDRESS=/^uain1[a-f0-9]{40}$/,SEND_ORCHARD=/^[a-f0-9]{86}$/,SEND_FVK=/^[a-f0-9]{192}$/,SEND_UNITS=/^[1-9][0-9]{0,18}$/;
function edKey(value){check(typeof value==='string');const b=Buffer.from(value,'base64');check(b.length===32&&(b.toString('base64')===value||b.toString('base64url')===value));return b;}
function sendSignature(publicRaw,bytes,value){const b=Buffer.from(value??'','base64url');check(typeof value==='string'&&b.length===64&&b.toString('base64url')===value&&verify(null,bytes,pub(publicRaw.toString('base64url')),b));}
async function pinnedFile(path,pin){const f=await openFile(path,'r');try{const h=createHash('sha256');for await(const chunk of f.createReadStream({autoClose:false}))h.update(chunk);check(h.digest('hex')===pin,'pinned tool differs');}finally{await f.close();}}
/** The default external address of a payee's signed raw full viewing key, from the pinned tool. */
export async function addressFromViewingKey(tool,fullViewingKey){
 check(typeof fullViewingKey==='string'&&SEND_FVK.test(fullViewingKey));await pinnedFile(tool.executable,tool.executableSha256);
 return await new Promise((resolve,reject)=>{const child=spawn(tool.executable,['address-from-fvk'],{stdio:['pipe','pipe','ignore'],env:{PATH:'/usr/bin:/bin'}});let out='';const timer=setTimeout(()=>child.kill('SIGKILL'),30000);child.stdout.on('data',b=>{out+=b;if(out.length>4096)child.kill('SIGKILL');});child.once('error',reject);child.stdin.on('error',()=>{});child.once('close',code=>{clearTimeout(timer);if(code!==0)return reject(Error('address-from-fvk refused'));try{const v=JSON.parse(out);check(exact(v,['address'])&&SEND_ORCHARD.test(v.address));resolve(v.address);}catch(e){reject(e);}});child.stdin.end(JSON.stringify({full_viewing_key:fullViewingKey})+'\n');});
}
async function inspectPacket(tool,packet){
 await pinnedFile(tool.executable,tool.executableSha256);const directory=await mkdtemp(join(tmpdir(),'send-review-'));
 try{const file=join(directory,'review.json'),f=await openFile(file,'wx',0o600);try{await f.writeFile(JSON.stringify(packet));await f.sync();}finally{await f.close();}
  return await new Promise((resolve,reject)=>{const child=spawn(tool.executable,['inspect-review',file],{stdio:['ignore','pipe','ignore'],env:{PATH:'/usr/bin:/bin'}});let out='';const timer=setTimeout(()=>child.kill('SIGKILL'),30000);child.stdout.on('data',b=>{out+=b;if(out.length>65536)child.kill('SIGKILL');});child.once('error',reject);child.once('close',code=>{clearTimeout(timer);if(code!==0)return reject(Error('inspect-review refused'));try{resolve(JSON.parse(out));}catch(e){reject(e);}});});
 }finally{await rm(directory,{recursive:true,force:true});}
}
export function validateSendEvidence({context,send,pins,now=Date.now()}){
 check(exact(send,['packet','intent','signature','publicKey','registration']));const{intent,registration:reg,packet}=send;
 check(exact(intent,SEND_INTENT_FIELDS)&&intent.schema==='baink-send-intent-v1'&&intent.chainId===pins.chainId&&intent.genesisSha256===pins.genesisSha256&&context.chain===pins.chainId);
 check(SEND_ADDRESS.test(intent.from)&&SEND_ADDRESS.test(intent.to)&&intent.from!==intent.to&&SEND_ORCHARD.test(intent.recipientAddress)&&typeof intent.amountUnits==='string'&&SEND_UNITS.test(intent.amountUnits)&&BigInt(intent.amountUnits)<=0x7fffffffffffffffn);
 check(typeof intent.memo==='string'&&Buffer.byteLength(intent.memo)<=200&&intent.memo.isWellFormed()&&(intent.requestId===null||typeof intent.requestId==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(intent.requestId))&&typeof intent.notAfter==='string'&&Date.parse(intent.notAfter)>now);
 const payer=edKey(send.publicKey);check(memberAddress(payer)===intent.from);sendSignature(payer,sendIntentBytes(intent),send.signature);
 const intentId=sendIntentId(intent);check(context.purpose===sendPurposeCommitment(intentId));
 // The payee consents either to an address or to a receiving key; for a key the
 // caller derives the address with the pinned tool (sendInspection) and requires it.
 const keyed=exact(reg,['kind','fullViewingKey','publicKey','signature'])&&reg.kind==='key';
 check(keyed?SEND_FVK.test(reg.fullViewingKey):exact(reg,['address','publicKey','signature'])&&reg.address===intent.recipientAddress);const payee=edKey(reg.publicKey);check(memberAddress(payee)===intent.to&&!payee.equals(payer));
 sendSignature(payee,keyed?receivingKeyBytes({member:intent.to,fullViewingKey:reg.fullViewingKey,chainId:intent.chainId}):receivingAddressBytes({member:intent.to,address:reg.address,chainId:intent.chainId}),reg.signature);
 check(exact(packet,['request','chain_id','reviewer_public_key','effects','effects_wire_hex','one_time_viewing_key'])&&packet.chain_id===context.chain&&packet.reviewer_public_key===context.reviewer&&packet.effects===context.effects&&typeof packet.effects_wire_hex==='string'&&packet.effects_wire_hex.length<=65536);
 const r=packet.request;check(exact(r,['version','effects','purpose_commitment','expires_height','licence_revision','direction','member','amount'])&&r.version===1&&r.effects===context.effects&&r.purpose_commitment===context.purpose&&r.expires_height===context.expires&&r.licence_revision===context.licenceRevision&&r.direction==='shield'&&r.member===intent.from&&r.amount===intent.amountUnits);
 return{intent,intentId,payer:payer.toString('base64url'),payee:payee.toString('base64url'),receivingKey:keyed?reg.fullViewingKey:null};
}
async function sendInspection(input){
 const{profile,context}=input,send=input.send,checked=validateSendEvidence({context,send,pins:profile.pins});const{intent}=checked;
 if(checked.receivingKey!==null)check(await addressFromViewingKey(profile.tools.coinWallet,checked.receivingKey)===intent.recipientAddress,'recipient address is not the payee\'s signed receiving key');
 const state=await readPrivateState({...profile.reader,request:{skip_witness:true,reviewer:profile.reviewer,parties:[],boundary_member:intent.from}});
 assertPrivateStateContext(state,context);
 check(state.chain_id===profile.pins.chainId&&state.reviewer.member===profile.reviewer&&state.reviewer.public_key===profile.reviewerPublicKey&&state.coin?.policy===coinPolicy&&state.coin.owner?.member===intent.from&&state.coin.owner.public_key===checked.payer&&BigInt(intent.amountUnits)<=BigInt(state.coin.balance)&&checked.payer!==profile.reviewerPublicKey);
 const inspected=await inspectPacket(profile.tools.coinWallet,send.packet);check(inspected.effects===context.effects);
 try{checkSendInspection(inspected,{recipientAddress:intent.recipientAddress,amountUnits:intent.amountUnits});}catch{check(false,'send outputs differ from the registered recipient and amount');}
 const inspection={context,operation:'server_send',amount:intent.amountUnits,agreement:{text:intent.memo},invoice:null,
  purposeEvidence:{schema:'baink-server-send-purpose-v1',intentId:checked.intentId,purposeCommitment:context.purpose,from:intent.from,to:intent.to,amountUnits:intent.amountUnits,requestId:intent.requestId,memo:intent.memo,notAfter:intent.notAfter,explanation:checked.receivingKey===null?'The payer signed this send intent with their own member key; the payee signed this receiving address with theirs. The paid note goes to that address for exactly the amount, debited from the payer\'s public AI$ balance.':'The payer signed this send intent with their own member key; the payee signed its receiving key with theirs, and custody derived this receiving address from that key. The paid note goes to that address for exactly the amount, debited from the payer\'s public AI$ balance.'},
  parties:[{member:intent.from,publicKey:checked.payer},{member:intent.to,publicKey:checked.payee}],outputs:inspected.outputs.map(o=>({address:o.address,amount:o.amount})),valueBalance:inspected.value_balance,
  checks:{ownerLicenceChecked:true,bothLicencesChecked:false,reviewerAppointed:true,consentsVerified:true,invoiceAgreed:false,purposeEvidenceVerified:true,payerIntentSigned:true,payeeAddressSigned:true,recipientAndAmountMatch:true}};
 return{schema:'baink-private-service-inspection-v1',jobId:input.jobId,inspectionDigest:hash(canonicalJSON(inspection)),inspection,proof:{chainId:state.chain_id,height:state.height,appHash:state.app_hash,headerTime:state.header_time,licenceRevision:state.licence_revision}};
}
export async function runReviewerAction(input){
 check(input&&UUID.test(input.jobId)&&['certificate','inspect','finalize','relay','attest','reconcile','health','send-inspect','send-finalize'].includes(input.action));const {profile}=input;
 check(profile&&exact(profile.pins,['chainId','genesisSha256'])&&HASH.test(profile.pins.genesisSha256)&&typeof profile.reviewer==='string'&&typeof profile.relay==='string');
 if(input.action==='attest')return{decision:verifyPrivateAIDecision({...input.audit,report:input.report,publicKey:profile.decisionPublicKey})};
 if(input.action==='send-inspect')return{report:await sendInspection(input)};
 if(input.action==='reconcile'){
  const e=input.envelope,c=e.command;check(c.chain_id===profile.pins.chainId&&c.operation==='private_payment'&&c.member===profile.relay&&memberAddress(Buffer.from(e.public_key,'base64url'))===profile.relay);signature(e.public_key,signingBytes(c),e.signature);
  const policy=await readPrivateState({...profile.reader,request:{policy_only:true,reviewer:profile.reviewer}});check(policy.chain_id===profile.pins.chainId&&policy.relayer.member===profile.relay&&BigInt(policy.relayer.sequence)>BigInt(c.sequence));
  const state=await readPrivateState({...profile.reader,request:{record_only:true,source_payments:[c.payload.approval.effects]}}),record=state.payments.find(p=>p.id===c.payload.approval.effects);check(state.chain_id===profile.pins.chainId&&record?.bundle===c.payload.bundle);
  const age=Date.now()-Date.parse(state.header_time);check(Number.isFinite(age)&&age>=-60000&&age<=120000);return{status:'recorded',effects:record.id,height:record.height,transactionHash:hash(JSON.stringify(e)).toUpperCase(),transactionInclusionVerified:false,paid:false};
 }
 const reviewerKey=key(input.reviewerSeed,profile.reviewer);check(raw(reviewerKey).toString('base64url')===profile.reviewerPublicKey);
 if(input.action==='send-finalize'){
  const report=await sendInspection(input);check(report.inspectionDigest===input.report.inspectionDigest&&canonicalJSON(report.inspection)===canonicalJSON(input.report.inspection));
  // P1 (9 Nov 2026): rule checks approve sends up to 10,000 AI$ that custody
  // routed to the rules; anything above, or flagged, needs the AI decision.
  const intent=input.send.intent,byRules=input.rules===true&&input.audit===null;
  if(byRules)check(BigInt(intent.amountUnits)<=SEND_AI_ABOVE_UNITS,'sends above 10,000 AI$ need the AI checker');
  const decision=byRules?{class:'neutral'}:verifyPrivateAIDecision({...input.audit,report:input.report,publicKey:profile.decisionPublicKey});check(decision.class!=='refuse'&&(byRules||decision.ownerLicenceChecked===true));
  const c=input.context;check(c.reviewer===raw(reviewerKey).toString('hex'));
  const signature=sign(null,coinBoundaryApprovalBytes(c,{direction:'shield',member:intent.from,amount:intent.amountUnits},decision.class),reviewerKey).toString('base64url');
  return{approval:{reviewer:profile.reviewer,effects:c.effects,purpose_commitment:c.purpose,class:decision.class,expires_height:c.expires,licence_revision:c.licenceRevision,signature,direction:'shield',member:intent.from,amount:intent.amountUnits},reviewerBinding:null};
 }
 if(input.action==='health'){
  key(input.relaySeed,profile.relay);
  check(typeof profile.healthOwner==='string'&&![profile.reviewer,profile.relay].includes(profile.healthOwner));
  const state=await readPrivateState({...profile.reader,request:{skip_witness:true,reviewer:profile.reviewer,parties:[],boundary_member:profile.healthOwner}});
  const age=Date.now()-Date.parse(state.header_time);check(state.chain_id===profile.pins.chainId&&state.reviewer.member===profile.reviewer&&state.reviewer.public_key===profile.reviewerPublicKey&&state.relayer.member===profile.relay&&state.coin?.owner?.member===profile.healthOwner&&state.coin.policy==='verified-bounties-108t-micro-v1'&&Number.isFinite(age)&&age>=-60000&&age<=120000);
  return{status:'ready',reviewer:profile.reviewer,relay:profile.relay,chainId:profile.pins.chainId,genesisSha256:profile.pins.genesisSha256,height:state.height,headerTime:state.header_time,privateActive:true,coinActive:true};
 }
 if(input.action==='certificate'){
  check(exact(input.context,['version','chain','expires','licenceRevision','effects','purpose','reviewer'])&&input.context.chain===profile.pins.chainId&&input.context.reviewer===raw(reviewerKey).toString('hex'));
  const encryption=generateKeyPairSync('x25519'),certificate=await certificateForPrivateState({reader:profile.reader,context:input.context,reviewerSigningKey:reviewerKey,encryptionPublicKey:encryption.publicKey});
  return{certificate,encryptionPrivateKey:encryption.privateKey.export({format:'der',type:'pkcs8'}).toString('base64')};
 }
 if(input.action==='relay'){
  const result=input.result;check(exact(result,['operation','payload'])&&result.operation==='private_payment'&&exact(result.payload,['bundle','approval'])&&canonicalJSON(result.payload.approval)===canonicalJSON(input.finalized.approval)&&canonicalJSON(input.reviewerBinding)===canonicalJSON(input.finalized.reviewerBinding)&&input.reviewerBinding!==null);
  const relayKey=key(input.relaySeed,profile.relay);return{envelope:await signPrivateTradeCommand({reader:profile.reader,result,signingKey:relayKey})};
 }
 check(canonicalJSON(input.envelope.certificate)===canonicalJSON(input.certificate));
 const encryptionKey=createPrivateKey({key:Buffer.from(input.encryptionPrivateKey,'base64'),format:'der',type:'pkcs8'});
 const policy=await readPrivateState({...profile.reader,request:{policy_only:true,reviewer:profile.reviewer}}),context=input.envelope.certificate.context;
 check(policy.chain_id===profile.pins.chainId);assertPrivateStateContext(policy,context);
 const packet=decryptPrivateReview({envelope:input.envelope,reviewerEncryptionKey:encryptionKey,trustedReviewerPublicKey:createPublicKey(reviewerKey),currentHeight:policy.height,chain:policy.chain_id});
 let report,approval;const stop=new Error('Inspection captured without signing');
 try{
  approval=await reviewEncryptedPrivateTrade({reader:profile.reader,envelope:input.envelope,reviewerSigningKey:reviewerKey,reviewerEncryptionKey:encryptionKey,tools:profile.tools,decide:async inspected=>{
   const invoice=validateInspectedInvoice({packet,inspected,agreedInvoice:input.agreedInvoice,purposeEvidence:input.purposeEvidence??null,pins:profile.pins});report=inspectedReport(input.jobId,inspected,invoice,input.purposeEvidence??null);
   if(input.action==='inspect')throw stop;
   check(input.report.inspectionDigest===report.inspectionDigest&&canonicalJSON(input.report.inspection)===canonicalJSON(report.inspection));
   const decision=verifyPrivateAIDecision({...input.audit,report:input.report,publicKey:profile.decisionPublicKey});check(decision.class!=='refuse'&&(invoice?decision.bothLicencesChecked:decision.ownerLicenceChecked));return decision;
  }});
 }catch(error){if(error!==stop)throw error;}
 check(report);
 if(input.action==='inspect')return{report};
 check(approval);let reviewerBinding=null;
 if(report.inspection.invoice){const invoice=report.inspection.invoice;reviewerBinding={publicKey:profile.reviewerPublicKey,independentlyInspected:true,signature:sign(null,paymentReviewerBindingBytes({...invoice,purposeCommitment:context.purpose},{effects:context.effects,reviewer:profile.reviewer}),reviewerKey).toString('base64url')};}
 return{approval,reviewerBinding};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const chunks=[];let size=0;for await(const part of process.stdin){size+=part.length;check(size<=2*1024*1024);chunks.push(part);}process.stdout.write(JSON.stringify(await runReviewerAction(JSON.parse(Buffer.concat(chunks).toString('utf8'))))+'\n');}
 catch{process.stderr.write('Private custody worker refused.\n');process.exitCode=1;}
}
