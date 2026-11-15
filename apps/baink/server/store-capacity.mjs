/** Only the store constructs hints. Final persistence calls without a hint and
 * independently serializes/revalidates the complete state before its fsync. */
export function createCapacityValidator({maxStoreBytes,maxMetadataBytes,fail}){
 const cache=new WeakMap(),length=value=>Buffer.byteLength(value);
 // Required version/accounts/requests/history/nonces ensure another root member
 // always exists, so an optional peerMessages field contributes one comma.
 const peerBytes=value=>{const json=JSON.stringify(value);return json===undefined?0:length('"peerMessages":'+json)+1;};
 function validate(next,hint){
  const nonceBytes=length(JSON.stringify(next.nonces)),prior=hint&&cache.get(hint.base);let measured,serialized;
  if(prior&&hint.nonceOnly===true)measured={...prior};
  else if(prior&&hint.requestAppend===true){
   const priorRequestCount=prior.requestCount??Object.keys(JSON.parse(JSON.stringify(hint.base.requests))).length;
   let added=0,requestDelta=0;
   for(const key of Object.keys(next.requests))if(!Object.hasOwn(hint.base.requests,key)){const value=JSON.stringify(next.requests[key]);if(value!==undefined){requestDelta+=length(JSON.stringify(key))+1+length(value);added++;}}
   if(added)requestDelta+=added-(priorRequestCount===0?1:0);
   const tail=next.history.slice(hint.base.history.length),historyDelta=length(JSON.stringify(tail))-2+(tail.length&&hint.base.history.length?1:0);
   measured={...prior,metadata:prior.metadata+requestDelta+historyDelta,requestCount:priorRequestCount+added};
  }else if(prior&&hint.messageOnly===true){const peer=peerBytes(next.peerMessages),oldPeer=prior.peer??peerBytes(hint.base.peerMessages);measured={...prior,metadata:prior.metadata+peer-oldPeer,peer};}
  else{
   serialized=JSON.stringify(next);
   measured={metadata:length(serialized)-nonceBytes+2};
  }
  const all=measured.metadata+nonceBytes-2;
  if(all>maxStoreBytes||measured.metadata>maxMetadataBytes)fail(503,'storage_capacity','Metadata storage capacity has been reached. Existing records are preserved; contact the operator.');
  cache.set(next,measured);return serialized;
 }
 // Observability returns numbers only, never mutable cache or state references.
 validate.measure=state=>{const value=cache.get(state);return value?{all:value.metadata+length(JSON.stringify(state.nonces))-2,metadata:value.metadata}:undefined;};
 return validate;
}
