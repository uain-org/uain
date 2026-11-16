import {createHash,sign} from 'node:crypto';

function jsonString(value){
 if(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))throw Error('unpaired Unicode surrogate');
 return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
}
export function canonicalJSON(value){
 if(value===null)return 'null';
 if(typeof value==='string')return jsonString(value);
 if(typeof value==='boolean')return String(value);
 if(typeof value==='number'){if(!Number.isSafeInteger(value))throw Error('numbers must be safe integers; use decimal strings for amounts');return String(value);}
 if(Array.isArray(value))return '['+value.map(canonicalJSON).join(',')+']';
 if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype){
  const keys=Object.keys(value).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
  return '{'+keys.map(key=>jsonString(key)+':'+canonicalJSON(value[key])).join(',')+'}';
 }
 throw Error('unsupported JSON value');
}
export function signingBytes(command){
 const fields=['version','chain_id','member','sequence','expires_height','operation','payload'];
 if(Object.hasOwn(command,'instance')){
  if(typeof command.instance!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(command.instance))throw Error('invalid instance');
  fields.push('instance');
 }
 if(Object.keys(command).length!==fields.length||fields.some(key=>!Object.hasOwn(command,key)))throw Error('invalid command fields');
 if(command.version!==1||typeof command.chain_id!=='string'||!/^uain1[0-9a-f]{40}$/.test(command.member))throw Error('invalid command identity');
 if(!/^(0|[1-9][0-9]*)$/.test(command.sequence)||BigInt(command.sequence)>18446744073709551615n)throw Error('invalid sequence');
 if(!/^[1-9][0-9]*$/.test(command.expires_height)||BigInt(command.expires_height)>9223372036854775807n)throw Error('invalid expiration height');
 // Typed command fields have a fixed order. Only payload object keys are sorted.
 return Buffer.from('uain:chain-command:v1\n{'+fields.map(field=>jsonString(field)+':'+canonicalJSON(command[field])).join(',')+'}');
}
export function memberAddress(rawPublicKey){if(rawPublicKey.length!==32)throw Error('Ed25519 key must be 32 bytes');return 'uain1'+createHash('sha256').update(rawPublicKey).digest('hex').slice(0,40);}
// The caller supplies a locally held signing object. This helper neither reads
// key files nor sends the private key to any server.
export function signedEnvelope(command,publicKey,privateKey){return {command,public_key:publicKey.toString('base64url'),signature:sign(null,signingBytes(command),privateKey).toString('base64url')};}
