/** Narrow native signing protocol. No key export or arbitrary governance writes. */
import {createHash,createPublicKey,verify} from 'node:crypto';
const ADDRESS=/^uain1[0-9a-f]{40}$/,HASH=/^[0-9a-f]{64}$/,ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const OPS=new Set(['coin_quote','coin_reserve','coin_claim','private_payment']);
function check(ok){if(!ok)throw Error('Invalid supported native financial command');}
function exact(value,fields){return value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Object.keys(value).length===fields.length&&fields.every(k=>Object.hasOwn(value,k));}
function str(value){check(typeof value==='string'&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value));return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));}
function json(value,depth=0){check(depth<=16);if(typeof value==='string')return str(value);if(typeof value==='number'){check(Number.isSafeInteger(value));return String(value);}if(typeof value==='boolean')return String(value);if(value===null)return 'null';check(value&&typeof value==='object');if(Array.isArray(value))return '['+value.map(v=>json(v,depth+1)).join(',')+']';check([Object.prototype,null].includes(Object.getPrototypeOf(value)));return '{'+Object.keys(value).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))).map(k=>str(k)+':'+json(value[k],depth+1)).join(',')+'}';}
function uint(value,max=18446744073709551615n){return typeof value==='string'&&/^(0|[1-9][0-9]{0,20})$/.test(value)&&BigInt(value)<=max;}
function validPayload(operation,p){
 if(operation==='coin_quote'){check(exact(p,['task','open_event','amount','evidence_digest'])&&typeof p.task==='string'&&ID.test(p.task)&&typeof p.open_event==='string'&&/^[0-9]{20}$/.test(p.open_event)&&BigInt(p.open_event)>0n&&uint(p.amount,108000000000000000000n)&&BigInt(p.amount)>0n&&HASH.test(p.evidence_digest));return;}
 if(operation==='coin_reserve'){check(exact(p,['task','evidence_digest'])&&typeof p.task==='string'&&ID.test(p.task)&&typeof p.evidence_digest==='string'&&HASH.test(p.evidence_digest));return;}
 if(operation==='coin_claim'){check(exact(p,['contribution'])&&typeof p.contribution==='string'&&ID.test(p.contribution));return;}
 check(exact(p,['bundle','approval'])&&typeof p.bundle==='string'&&p.bundle.length>0&&p.bundle.length<=22000&&/^[A-Za-z0-9_-]+$/.test(p.bundle)&&Buffer.from(p.bundle,'base64url').toString('base64url')===p.bundle);
 const a=p.approval;check(exact(a,['reviewer','effects','purpose_commitment','class','expires_height','licence_revision','signature'])&&typeof a.reviewer==='string'&&ADDRESS.test(a.reviewer)&&typeof a.effects==='string'&&HASH.test(a.effects)&&typeof a.purpose_commitment==='string'&&HASH.test(a.purpose_commitment)&&['benevolent','neutral'].includes(a.class)&&uint(a.expires_height,9223372036854775807n)&&BigInt(a.expires_height)>0n&&uint(a.licence_revision)&&typeof a.signature==='string'&&/^[A-Za-z0-9_-]{86}$/.test(a.signature)&&Buffer.from(a.signature,'base64url').toString('base64url')===a.signature);
}
export function nativeFinancialSigningBytes(command){
 const fields=['version','chain_id','member','sequence','expires_height','operation','payload'];if(Object.hasOwn(command??{},'instance'))fields.push('instance');
 check(exact(command,fields)&&command.version===1&&typeof command.chain_id==='string'&&/^[A-Za-z0-9._-]{1,96}$/.test(command.chain_id)&&typeof command.member==='string'&&ADDRESS.test(command.member)&&uint(command.sequence)&&BigInt(command.sequence)<18446744073709551615n&&uint(command.expires_height,9223372036854775807n)&&BigInt(command.expires_height)>0n&&OPS.has(command.operation));
 if(fields.includes('instance'))check(command.operation!=='private_payment'&&typeof command.instance==='string'&&ID.test(command.instance));
 validPayload(command.operation,command.payload);const bytes=Buffer.from('uain:chain-command:v1\n{'+fields.map(k=>str(k)+':'+json(command[k])).join(',')+'}');check(bytes.length<=65536);return bytes;
}
export function verifyNativeFinancialEnvelope(envelope,{chainId,operations}){
 check(exact(envelope,['command','public_key','signature'])&&Array.isArray(operations)&&operations.length>0&&operations.every(op=>OPS.has(op))&&operations.includes(envelope.command?.operation)&&envelope.command.chain_id===chainId);
 const bytes=nativeFinancialSigningBytes(envelope.command);check(typeof envelope.public_key==='string'&&typeof envelope.signature==='string');const pub=Buffer.from(envelope.public_key,'base64url'),sig=Buffer.from(envelope.signature,'base64url');check(pub.length===32&&pub.toString('base64url')===envelope.public_key&&sig.length===64&&sig.toString('base64url')===envelope.signature&&'uain1'+createHash('sha256').update(pub).digest('hex').slice(0,40)===envelope.command.member&&verify(null,bytes,createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:envelope.public_key},format:'jwk'}),sig));return true;
}
export const canonicalJSON=json;
export function memberAddress(raw){check(raw instanceof Uint8Array&&raw.length===32);return 'uain1'+createHash('sha256').update(raw).digest('hex').slice(0,40);}
