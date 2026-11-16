/** Public capability heartbeat from the separately pinned local broker. */
import{createPublicKey,verify}from'node:crypto';
import{canonicalJSON}from'../../../chain/client/signing.mjs';
import{readCourierJSON}from'./courier-executor.mjs';
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export function verifyReviewServiceHealth({value,publicKey,pins,reviewer,relay,now=Date.now()}){
 const unavailable={configured:false,reviewer:null,relay:null};
 try{const p=value.payload;
 if(!exact(value,['payload','signature'])||!exact(p,['schema','chainId','genesisSha256','reviewer','relay','checkedAt','rootReady','modelQualified'])||p.schema!=='baink-private-service-health-v1'||p.chainId!==pins.chainId||p.genesisSha256!==pins.genesisSha256||p.reviewer!==reviewer||p.relay!==relay||typeof p.rootReady!=='boolean'||typeof p.modelQualified!=='boolean')return unavailable;
 const age=now-Date.parse(p.checkedAt);if(!Number.isFinite(age)||age< -60000||age>120000)return unavailable;
 const raw=Buffer.from(publicKey,'base64url'),sig=Buffer.from(value.signature,'base64url');if(raw.length!==32||raw.toString('base64url')!==publicKey||sig.length!==64||sig.toString('base64url')!==value.signature)return unavailable;
 const key=createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:publicKey},format:'jwk'});if(!verify(null,Buffer.from('BAINK/private-service-health/v1\n'+canonicalJSON(p)),key,sig))return unavailable;
 return{configured:p.rootReady&&p.modelQualified,reviewer:p.reviewer,relay:p.relay,checkedAt:p.checkedAt,perPaymentReviewRequired:true,model:'claude-sonnet-5-5'};
 }catch{return unavailable;}
}

export async function readReviewServiceHealth(options){try{return verifyReviewServiceHealth({...options,value:await readCourierJSON(options.file,8192)});}catch{return{configured:false,reviewer:null,relay:null};}}
