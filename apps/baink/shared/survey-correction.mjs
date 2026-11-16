/** Pure author-correction wire codec. This module grants no execution authority. */
const MAX_ENVELOPE_BYTES=24576;
const encoder=new TextEncoder();
const requireValue=value=>{if(!value)throw Error('survey_correction_refused');};
function wellFormed(value){for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const n=value.charCodeAt(++i);if(!(n>=0xdc00&&n<=0xdfff))return false;}else if(c>=0xdc00&&c<=0xdfff)return false;}return true;}
function snapshot(value,depth=0){
 requireValue(depth<=64);
 if(value===null||typeof value==='boolean')return value;
 if(typeof value==='string'){requireValue(wellFormed(value));return value;}
 if(typeof value==='number'){requireValue(Number.isSafeInteger(value)&&!Object.is(value,-0));return value;}
 requireValue(value&&typeof value==='object');
 if(Array.isArray(value)){
  requireValue(Object.getPrototypeOf(value)===Array.prototype&&Reflect.ownKeys(value).length===value.length+1);
  return Array.from({length:value.length},(_,i)=>{const d=Object.getOwnPropertyDescriptor(value,String(i));requireValue(d&&Object.hasOwn(d,'value'));return snapshot(d.value,depth+1);});
 }
 requireValue(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
 return Object.fromEntries(Reflect.ownKeys(value).map(key=>{requireValue(typeof key==='string'&&wellFormed(key));const d=Object.getOwnPropertyDescriptor(value,key);requireValue(d&&d.enumerable&&Object.hasOwn(d,'value'));return[key,snapshot(d.value,depth+1)];}));
}
function canonical(value){return value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';}
export function parseAuthorEnvelope(raw){
 requireValue(typeof raw==='string'||raw instanceof Uint8Array);
 if(typeof raw==='string')requireValue(wellFormed(raw));
 const bytes=typeof raw==='string'?encoder.encode(raw):new Uint8Array(raw);
 requireValue(bytes.length>0&&bytes.length<=MAX_ENVELOPE_BYTES&&!(bytes[0]===239&&bytes[1]===187&&bytes[2]===191));
 let text,value;
 try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);value=strictJSON(text);}catch(error){if(error instanceof SyntaxError||error instanceof TypeError)throw Error('survey_correction_refused');throw error;}
 requireValue(canonical(value)===text);return envelopeShape(value);
}
const HASH=/^[a-f0-9]{64}$/,ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/,MEMBER=/^uain1[a-f0-9]{40}$/;
const ORIGINAL=['nativeEvidenceDigest','canonicalArtifactDigest','criteriaDigest','policyDigest','attestationDigest'];
const PRIOR=['executionId','verificationDigest','reviewRecordDigest','feedbackDecisionDigest'];
const BODY=['schema','chainId','genesisSha256','author','projectId','taskId','submissionId','original','priorReview','correctionIndex','previousCorrectionDigest','edits','correctedArtifactDigest','consent'];
const identifierPatterns={doi:/^10\.[0-9]{4,9}\/[-._;()/:a-z0-9<>[\]]{1,200}$/,arxiv:/^(?:[0-9]{4}\.[0-9]{4,5}|[a-z-]{2,20}(?:\.[a-z]{2})?\/[0-9]{7})$/,github:/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/,pubmed:/^[1-9][0-9]{0,9}$/,nct:/^NCT[0-9]{8}$/,wikidata:/^Q[1-9][0-9]{0,11}$/};
function exact(value,keys){requireValue(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k)));}
function identifier(kind,id){requireValue(typeof kind==='string'&&Object.hasOwn(identifierPatterns,kind)&&typeof id==='string'&&identifierPatterns[kind].test(id)&&!(kind==='github'&&id.endsWith('.git')));}
function stamp(value){requireValue(typeof value==='string'&&/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value)&&Number(value.slice(0,4))>=1);const ms=Date.parse(value);requireValue(Number.isFinite(ms)&&new Date(ms).toISOString()===value);return ms;}
function bytes64(value,size){requireValue(typeof value==='string'&&/^[A-Za-z0-9_-]+$/.test(value));const raw=Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4)),c=>c.charCodeAt(0));requireValue(raw.length===size&&btoa(String.fromCharCode(...raw)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')===value);return raw;}
function bodyShape(body){
 exact(body,BODY);requireValue(body.schema==='uain-survey-author-correction-v1'&&typeof body.chainId==='string'&&/^[A-Za-z0-9._-]{1,96}$/.test(body.chainId)&&typeof body.genesisSha256==='string'&&HASH.test(body.genesisSha256));
 exact(body.author,['member','instance']);requireValue(typeof body.author.member==='string'&&MEMBER.test(body.author.member)&&(body.author.instance===null||typeof body.author.instance==='string'&&ID.test(body.author.instance)));
 for(const key of ['projectId','taskId','submissionId'])requireValue(typeof body[key]==='string'&&ID.test(body[key]));
 exact(body.original,ORIGINAL);for(const key of ORIGINAL)requireValue(typeof body.original[key]==='string'&&HASH.test(body.original[key]));
 exact(body.priorReview,PRIOR);requireValue(typeof body.priorReview.executionId==='string'&&ID.test(body.priorReview.executionId));for(const key of PRIOR.slice(1))requireValue(typeof body.priorReview[key]==='string'&&HASH.test(body.priorReview[key]));requireValue(body.priorReview.verificationDigest===body.priorReview.feedbackDecisionDigest);
 requireValue(Number.isInteger(body.correctionIndex)&&body.correctionIndex>=1&&body.correctionIndex<=32&&(body.correctionIndex===1?body.previousCorrectionDigest===null:typeof body.previousCorrectionDigest==='string'&&HASH.test(body.previousCorrectionDigest))&&typeof body.correctedArtifactDigest==='string'&&HASH.test(body.correctedArtifactDigest));
 requireValue(Array.isArray(body.edits)&&body.edits.length>=1&&body.edits.length<=2);const seen=new Set(),references=new Set();
 for(const edit of body.edits){exact(edit,['kind','id','oldNoteSha256','newNote','sourceRefs']);identifier(edit.kind,edit.id);const key=edit.kind+':'+edit.id;requireValue(!seen.has(key));seen.add(key);requireValue(typeof edit.oldNoteSha256==='string'&&HASH.test(edit.oldNoteSha256)&&typeof edit.newNote==='string'&&edit.newNote===edit.newNote.trim()&&encoder.encode(edit.newNote).length>=10&&encoder.encode(edit.newNote).length<=400&&!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(edit.newNote)&&Array.isArray(edit.sourceRefs)&&edit.sourceRefs.length>=1&&edit.sourceRefs.length<=2);const local=new Set();for(const ref of edit.sourceRefs){exact(ref,['kind','id']);requireValue(['doi','nct'].includes(ref.kind));identifier(ref.kind,ref.id);const k=ref.kind+':'+ref.id;requireValue(!local.has(k));local.add(k);references.add(k);}}
 requireValue(references.size<=4);exact(body.consent,['nonce','issuedAt','expiresAt']);requireValue(typeof body.consent.nonce==='string'&&/^[a-f0-9]{32}$/.test(body.consent.nonce));const start=stamp(body.consent.issuedAt),end=stamp(body.consent.expiresAt);requireValue(end>start&&end-start<=600000);
}
function envelopeShape(envelope){exact(envelope,['schema','body','publicKey','signature']);requireValue(envelope.schema==='uain-survey-author-envelope-v1');bodyShape(envelope.body);bytes64(envelope.publicKey,32);bytes64(envelope.signature,64);return envelope;}
const AUTHOR_DOMAIN='UAIN/central-survey-correction/author/v1';
const ENVELOPE_DOMAIN='UAIN/central-survey-correction/author-envelope/v1';
async function digestBytes(bytes){return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');}
function validatedEnvelope(value){const envelope=envelopeShape(snapshot(value));requireValue(encoder.encode(canonical(envelope)).length<=MAX_ENVELOPE_BYTES);return envelope;}
export function authorCorrectionSigningBytes(body){const value=snapshot(body);bodyShape(value);return encoder.encode(AUTHOR_DOMAIN+'\n'+canonical(value));}
export async function authorBodyDigest(body){return digestBytes(authorCorrectionSigningBytes(body));}
export async function authorCorrectionDigest(envelope){const value=validatedEnvelope(envelope);return digestBytes(encoder.encode(ENVELOPE_DOMAIN+'\n'+canonical(value)));}
function consentNow(consent,now){requireValue(Number.isSafeInteger(now)&&now>=0&&stamp(consent.issuedAt)<=now+30000&&now<stamp(consent.expiresAt));}
async function verifyEnvelopeSignature(envelope){
 const pub=bytes64(envelope.publicKey,32),signature=bytes64(envelope.signature,64),bytes=authorCorrectionSigningBytes(envelope.body);
 requireValue(envelope.body.author.member==='uain1'+(await digestBytes(pub)).slice(0,40));
 const key=await globalThis.crypto.subtle.importKey('raw',pub,{name:'Ed25519'},false,['verify']);
 requireValue(await globalThis.crypto.subtle.verify('Ed25519',key,signature,bytes));
}
export async function validateAuthorCorrection(value,context,{now=Date.now}={}){
 const envelope=validatedEnvelope(value),expected=snapshot(context),body=envelope.body;
 requireValue(typeof now==='function');exact(expected,['chainId','genesisSha256','author','projectId','taskId','submissionId','original','priorReview','chainHead']);exact(expected.author,['member','instance','publicKey']);exact(expected.original,ORIGINAL);exact(expected.priorReview,[...PRIOR,'verdict','finalized']);
 requireValue(expected.author.publicKey===envelope.publicKey&&expected.author.member===body.author.member&&expected.author.instance===body.author.instance&&expected.priorReview.verdict==='needs_evidence'&&expected.priorReview.finalized===true);
 for(const key of ['chainId','genesisSha256','projectId','taskId','submissionId'])requireValue(body[key]===expected[key]);
 requireValue(canonical(body.original)===canonical(expected.original));for(const key of PRIOR)requireValue(body.priorReview[key]===expected.priorReview[key]);
 if(body.correctionIndex===1)requireValue(expected.chainHead===null);
 else{
  const head=expected.chainHead;exact(head,['index','authorEnvelopeDigest','correctedArtifactDigest','reviewExecutionId','reviewVerificationDigest','status']);requireValue(Number.isInteger(head.index)&&head.index>=1&&head.index<32&&body.correctionIndex===head.index+1&&body.previousCorrectionDigest===head.authorEnvelopeDigest&&typeof head.authorEnvelopeDigest==='string'&&HASH.test(head.authorEnvelopeDigest)&&typeof head.correctedArtifactDigest==='string'&&HASH.test(head.correctedArtifactDigest)&&head.status==='finalized-needs-evidence'&&head.reviewExecutionId===body.priorReview.executionId&&head.reviewVerificationDigest===body.priorReview.verificationDigest);
 }
 consentNow(body.consent,now());await verifyEnvelopeSignature(envelope);consentNow(body.consent,now());return envelope;
}
function strictJSON(text){
 const value=snapshot(JSON.parse(text)),stack=[];
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(c==='"'){
   const start=i;for(i++;i<text.length;i++){if(text[i]==='\\'){i++;continue;}if(text[i]==='"')break;}
   const word=JSON.parse(text.slice(start,i+1));let next=i+1;while(/\s/.test(text[next]??'')&&next<text.length)next++;
   if(text[next]===':'){const keys=stack.at(-1);requireValue(keys instanceof Set&&!keys.has(word));keys.add(word);}
  }else if(c==='{'){stack.push(new Set());requireValue(stack.length<=65);}
  else if(c==='['){stack.push(null);requireValue(stack.length<=65);}
  else if(c==='}'||c===']')stack.pop();
  else if(c==='-'||c>='0'&&c<='9'){const start=i;while(/[0-9eE+.\-]/.test(text[i+1]??'')&&i+1<text.length)i++;const number=text.slice(start,i+1);requireValue(/^-?(?:0|[1-9][0-9]*)$/.test(number)&&number!=='-0');}
 }
 return value;
}
function originalArtifact(raw){
 requireValue(typeof raw==='string'||raw instanceof Uint8Array);if(typeof raw==='string')requireValue(wellFormed(raw));const bytes=typeof raw==='string'?encoder.encode(raw):new Uint8Array(raw);requireValue(bytes.length>0&&bytes.length<=16384);
 const value=strictJSON(new TextDecoder('utf-8',{fatal:true}).decode(bytes));requireValue(value&&typeof value==='object'&&!Array.isArray(value)&&value.schema==='uain-evidence-artifact-v1'&&['taskId','submissionId','author','survey'].every(k=>Object.hasOwn(value,k)));
 exact(value.survey,['mainKpi','asOf','items','conclusion']);requireValue(Array.isArray(value.survey.items)&&value.survey.items.length>=1&&value.survey.items.length<=60);const seen=new Set();
 for(const item of value.survey.items){exact(item,['kind','id','title','relation','note']);identifier(item.kind,item.id);requireValue(typeof item.note==='string');const key=item.kind+':'+item.id;requireValue(!seen.has(key));seen.add(key);}
 return{bytes,artifact:value,identifiers:seen};
}
export async function deriveCorrectedArtifact(rawOriginal,current,{previousEnvelopes=[]}={}){
 const envelope=validatedEnvelope(current),previous=snapshot(previousEnvelopes);requireValue(Array.isArray(previous)&&previous.length===envelope.body.correctionIndex-1&&previous.length<=31);
 const chain=previous.map(validatedEnvelope);chain.push(envelope);const chainBytes=encoder.encode(canonical(chain));requireValue(chainBytes.length<=786432);
 const original=originalArtifact(rawOriginal),body=envelope.body;requireValue(original.artifact.author===body.author.member&&original.artifact.taskId===body.taskId&&original.artifact.submissionId===body.submissionId&&await digestBytes(original.bytes)===body.original.nativeEvidenceDigest&&await digestBytes(encoder.encode(canonical(original.artifact)))===body.original.canonicalArtifactDigest);
 const view=snapshot(original.artifact),nonces=new Set(),reviews=new Set();let parent=null;
 for(let i=0;i<chain.length;i++){
  const item=chain[i],b=item.body;requireValue(b.correctionIndex===i+1&&b.previousCorrectionDigest===(parent?await authorCorrectionDigest(parent):null)&&item.publicKey===envelope.publicKey&&canonical(b.author)===canonical(body.author)&&canonical(b.original)===canonical(body.original));
  for(const key of ['chainId','genesisSha256','projectId','taskId','submissionId'])requireValue(b[key]===body[key]);
  requireValue(!nonces.has(b.consent.nonce)&&!reviews.has(b.priorReview.executionId));nonces.add(b.consent.nonce);reviews.add(b.priorReview.executionId);await verifyEnvelopeSignature(item);
  for(const edit of b.edits){
   const target=view.survey.items.find(x=>x.kind===edit.kind&&x.id===edit.id);requireValue(target&&target.note!==edit.newNote&&await digestBytes(encoder.encode(target.note))===edit.oldNoteSha256&&edit.sourceRefs.every(ref=>original.identifiers.has(ref.kind+':'+ref.id)));target.note=edit.newNote;
  }
  const encoded=encoder.encode(canonical(view));requireValue(encoded.length<=16384&&await digestBytes(encoded)===b.correctedArtifactDigest);parent=item;
 }
 const canonicalArtifact=canonical(view);return{artifact:view,canonicalArtifact,correctedArtifactDigest:await digestBytes(encoder.encode(canonicalArtifact)),chainDigest:await digestBytes(encoder.encode('UAIN/central-survey-correction/author-chain/v1\n'+canonical(chain)))};
}
export async function priorReviewRecordDigest(record){
 const value=snapshot(record);exact(value,['submission','execution_id','criteria_digest','evidence_digest','verification_digest','reviewer','height','verdict']);
 requireValue(typeof value.submission==='string'&&ID.test(value.submission)&&typeof value.execution_id==='string'&&ID.test(value.execution_id)&&typeof value.reviewer==='string'&&MEMBER.test(value.reviewer)&&['accept','reject','needs_evidence'].includes(value.verdict));
 for(const key of ['criteria_digest','evidence_digest','verification_digest'])requireValue(typeof value[key]==='string'&&HASH.test(value[key]));
 requireValue(typeof value.height==='string'&&/^[1-9][0-9]{0,18}$/.test(value.height)&&BigInt(value.height)<=9223372036854775807n);
 return digestBytes(encoder.encode('UAIN/central-survey-correction/prior-native-record/v1\n'+canonical(value)));
}
