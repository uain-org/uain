import {base64} from './identity.js';
import {nativeProofFreshness} from './native-balance.js';
import {canonicalJSON,nativeResearchSigningBytes} from '../integrations/native-research-codec.mjs';
const url64=s=>s.replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
function need(ok,message){if(!ok)throw Error(message);}
/** Only the frozen pilot action reviewed by the holder may reach local signing. */
export async function signNativeProjectPilotIntent(identity,intent,{config,operation,instance,payload,now=Date.now()}={}){
 need(intent?.status==='prepared'&&config?.enabled===true,'Pilot signing is not available.');
 const c=intent.command,p=intent.proof;
 need(c?.member===identity.address&&c.operation===operation&&c.instance===instance&&canonicalJSON(c.payload)===canonicalJSON(payload),'The action changed since your review.');
 need(c.chain_id===config.chainId&&p?.chainId===config.chainId&&p.epoch===config.epoch&&p.genesisSha256===config.epoch&&/^[a-f0-9]{64}$/.test(p.verifierSha256??'')&&nativeProofFreshness(p,{now}).fresh,'Refresh the native proof before signing.');
 need(intent.sourceDigest===config.sourceDigest,'The source proposal changed.');
 const height=BigInt(p.height),expiry=BigInt(c.expires_height);need(expiry>height&&expiry<=height+100n,'The signing window has closed.');
 const bytes=nativeResearchSigningBytes(c);need(base64(bytes)===intent.signingBytesBase64,'The signing bytes do not match the reviewed action.');
 const raw=new Uint8Array(await crypto.subtle.exportKey('raw',identity.publicKey));
 const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',raw));
 need('uain1'+Array.from(hash,b=>b.toString(16).padStart(2,'0')).join('').slice(0,40)===identity.address&&base64(raw)===identity.publicKeyBase64&&url64(base64(raw))===intent.publicKey,'The signing identity changed.');
 const signature=await crypto.subtle.sign('Ed25519',identity.privateKey,bytes);
 need(await crypto.subtle.verify('Ed25519',identity.publicKey,signature,bytes),'The local key does not match.');
 return {command:structuredClone(c),public_key:intent.publicKey,signature:url64(base64(signature))};
}
