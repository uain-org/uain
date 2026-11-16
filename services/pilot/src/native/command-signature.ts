/** A native command envelope's own signature, checked without a proof process.
 * The signing bytes are the chain's command encoding, built with the evidence
 * canonicaliser; archive.ts verifies retained submissions through this same
 * routine, so there is one encoding. A pass says only that the envelope's key
 * signed these bytes and that the key is the member the command names; whether
 * the chain recorded the command is for the proof. */
import {createHash,createPublicKey,verify} from 'node:crypto';
import {canonical} from './evidence.ts';

const COMMAND_FIELDS=['version','chain_id','member','sequence','expires_height','operation','payload'];
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');

/** The signed bytes and member of a well-formed, validly signed envelope, or null. */
export function verifiedCommand(envelope:any):{bytes:Buffer;member:string;command:any}|null{
 try{
  if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)||Object.keys(envelope).sort().join(',')!=='command,public_key,signature')return null;
  if(typeof envelope.public_key!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(envelope.public_key)||typeof envelope.signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(envelope.signature))return null;
  const command=envelope.command;if(!command||typeof command!=='object'||Array.isArray(command))return null;
  const fields=[...COMMAND_FIELDS];
  if(Object.hasOwn(command,'instance')){if(typeof command.instance!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(command.instance))return null;fields.push('instance')}
  if(Object.keys(command).length!==fields.length||!fields.every(field=>Object.hasOwn(command,field)))return null;
  if(typeof command.member!=='string'||!/^uain1[a-f0-9]{40}$/.test(command.member))return null;
  const raw=Buffer.from(envelope.public_key,'base64url'),signature=Buffer.from(envelope.signature,'base64url');
  if(raw.length!==32||raw.toString('base64url')!==envelope.public_key||signature.length!==64||signature.toString('base64url')!==envelope.signature||'uain1'+sha(raw).slice(0,40)!==command.member)return null;
  const bytes=Buffer.from('uain:chain-command:v1\n{'+fields.map(field=>canonical(field)+':'+canonical(command[field])).join(',')+'}'),key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),raw]),format:'der',type:'spki'});
  return verify(null,bytes,key,signature)?{bytes,member:command.member,command}:null;
 }catch{return null}
}

/** A validly signed submission: what a research publication must carry. Checked
 * before any proof process starts; the proof decides whether it was recorded. */
export function publishableCommand(envelope:any){
 const signed=verifiedCommand(envelope);
 return signed&&signed.command.operation==='submit'?signed:null;
}
